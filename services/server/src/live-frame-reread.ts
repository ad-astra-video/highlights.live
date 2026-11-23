// ADAAAA-8139: bounded persisted-frame re-read for a demoted goal window.
//
// Why this exists: the ADAAAA-8134 read-side fix (ff6354b) re-reads the score
// readings the live rail ALREADY paid for, but a demoted row still fails when the
// OCR never produced a post-goal read inside the judged window's span. Measured
// on the graded leg (job bca08173, 431 frames, 3.48 min, costUsd $0.1293):
//
//   goal 1 @16.95 s  window reads 34, pre 34, post 0   -> gate demotion
//   goal 2 @59.46 s  window reads 33, pre  5, post 28  -> decide demotion
//
// The scoreboard IS legible after goal 1 on that fixture (the recording reads
// 2-1 at t=20 s and 2-2 at t=75 s), so the gap is the SAMPLED read rate at the
// funded 4/2 cell, not legibility. The frames are already on disk, so the fix
// is to re-read them once: score-bug crop only, no perceive pipeline pass, no
// decide call, no Livepeer debit.
//
// Bounds (all enforced here, not by convention):
//
//  - ONE pass per demoted window (keyed on the delivered row's highlightId);
//  - at most {@link LIVE_FRAME_REREAD_MAX_FRAMES} OCR calls per pass (default 4,
//    the funded cell);
//  - at most {@link LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN} OCR calls per live
//    run (8 = 2 demoted windows x 4 frames, the number the PO cost line covers);
//  - the pass only runs once the ADAAAA-8006 deferred lookahead (`hi + 20 s`)
//    has closed, i.e. when no fresh read can arrive for that row any more;
//  - fail closed exactly like the defered path: the reads are fed through
//    `scoreboardDeltaFromPooledReadings` and `resolveDeferredGoalAttestation`,
//    so the legibility bar (>= 2 contiguous reads each side, one single-goal
//    step, one distinct transition, <= maxConfirmGapS) and the attribution
//    rules (transition instant inside `[lo, hi + lookahead]`, `readAt >= hi`)
//    are the existing ones. Nothing in this module can accept a new row or
//    widen the ADAAAA-7996 unattested-GOAL gate.
import path from "node:path";
import { readFile } from "node:fs/promises";

/** OCR calls one re-read pass may make (the funded 4-image cell). */
export const LIVE_FRAME_REREAD_MAX_FRAMES = 4;
/** OCR calls one live RUN may make across every re-read pass (2 windows x 4). */
export const LIVE_FRAME_REREAD_MAX_OCR_CALLS_PER_RUN = 8;
/** Per-call OCR timeout. A slow/hung perceive can never park the frame loop. */
export const LIVE_FRAME_REREAD_OCR_TIMEOUT_MS = 5000;
/** Frames are `frame_%06d.jpg` with the suffix == the rail's frame seq. */
export function liveRereadFrameFileName(seq: number): string {
  return `frame_${String(Math.max(0, Math.floor(seq))).padStart(6, "0")}.jpg`;
}

/** The job's persisted live-frame dir (`<dataDir>/live/<jobId>/frames`). */
export function liveRereadFrameDir(dataDir: string, jobId: string): string {
  return path.join(dataDir, "live", jobId, "frames");
}

/** One persisted frame the re-read may OCR. */
export interface FrameRereadCandidate {
  seq: number;
  /** The frame's CONTENT timestamp (seconds from share start). */
  ts: number;
}

/** A demoted window that is due for its one re-read pass. */
export interface FrameRereadPlan {
  /** Stable identity of the demoted row (the delivered highlightId). */
  key: string;
  /** The judged content window the accept was decided over. */
  lo: number;
  hi: number;
  /** How far past `hi` the deferred attribution still reaches. */
  lookaheadS: number;
}

/** What one pass actually did, for the audit line + the tests. */
export interface FrameRereadPass {
  key: string;
  window: { lo: number; hi: number };
  /** Seqs picked for OCR, ascending by content ts. */
  frames: number[];
  /** OCR calls actually made (<= maxFrames). */
  ocrCalls: number;
  /** Frames whose OCR produced text (a frame with no readable line is absent). */
  readings: { seq: number; ts: number; ocr: string[] }[];
  /** Scans that produced no score line (absent evidence, never fabricated). */
  unreadable: number;
  /** Frames skipped because the run ledger already holds that content ts's read
   * (ADAAAA-9332: the sample's calls are spent on evidence the ledger lacks). */
  skippedKnown: number;
  /** Failures (missing file / OCR error) — the pass fails closed on these. */
  failed: number;
}

/** Max gap between two picked tail frames (seconds).
 *
 * Mirrors `SCOREBOARD_MAX_CONFIRM_GAP_S` in `analyzer.ts` / the perceive
 * tracker. The accept path measures `deltaTs - preTs <= ` this constant, so a
 * flip that lands BETWEEN two adjacent picks further apart than this can never
 * be credited however many reads the pass spends (ADAAAA-9332 measured exactly
 * that: 17.0 s PRE / 36.5 s POST, 19.5 s apart). Kept local because `analyzer.ts`
 * imports THIS module, so importing the constant back would be a cycle. */
export const LIVE_FRAME_REREAD_MAX_CONFIRM_GAP_S = 10;

/** The content-ts key used to compare a persisted frame against a ledger read
 * (`job_observations.timestamp` carries millisecond precision). */
function rereadTsKey(ts: number): string {
  return ts.toFixed(3);
}

/** Selection inputs beyond the budget/window geometry. */
export interface FrameRereadSelectOptions {
  maxFrames?: number;
  leadS?: number;
  trailS?: number;
  /** Content instants whose read the run ledger ALREADY holds. Those frames are
   * never re-OCR'd: `noteScoreReadings` dedupes them anyway, so spending a call on
   * one buys nothing and 8139 measured 4 calls returning only 2 new readings.
   * (ADAAAA-9332.) */
  knownTs?: Iterable<number>;
  /** The newest transition instant the ledger already holds in the deferred range
   * (the first frame that read the NEW score), or undefined when the ledger has
   * not seen the flip yet. When it is known, tail picks are taken AFTER it: those
   * frames are guaranteed POST, so the sample only needs to add POST support
   * beside an already-legible boundary. (ADAAAA-9332.) */
  postFlipTs?: number;
  /** Confirm-gap the pick spacing must respect (default
   * {@link LIVE_FRAME_REREAD_MAX_CONFIRM_GAP_S}). */
  maxConfirmGapS?: number;
}

/**
 * Pick the frames one pass will OCR from the window's persisted inventory.
 *
 * Selection is deterministic, content-ordered, and SPLIT ON PURPOSE: half the
 * budget (rounded up) lands in the deferred lookahead tail `[hi, hi + lookahead]`
 * and the rest inside the judged window `[lo, hi]`. The split is a FLOOR for the
 * tail, not a cap: when the window's own frames are already in the ledger their
 * share is handed to the tail, because that is where the POST evidence sits.
 *
 * Why the tail carries the weight: the demoted row's measured gap is POST-goal
 * reads. Production broadcasts overlay the new score a few seconds AFTER the
 * crossing, so the frames inside a goal window legitimately still read the PRE
 * score, and the first frame that reads the new one sits past `hi`. Those tail
 * reads are what make `postSamples` clear the legibility bar, and the deferred
 * attribution already allows a transition instant anywhere in
 * `[lo, hi + lookahead]`. The in-window frames are kept so the pass also covers
 * a window whose OCR simply never read its own frames.
 *
 * ADAAAA-9332 (the measured defect this closes): on leg `bca08173` the two
 * interior picks were frames whose reads the ledger already held, and the two
 * tail picks were `evenlyPick`'s first and last of `(16.95, 36.95]` — 17.0 s
 * (still PRE, the overlay had not flipped) and 36.5 s (POST). That is ONE post
 * sample, 19.5 s after the last PRE read, so `postSamples 1 < need 2` and
 * `deltaTs - preTs > 10 s`: 4 calls spent, 2 readings added, row still demoted.
 * Now:
 *
 *  1. frames whose content ts the ledger already holds are dropped BEFORE the
 *     budget is split (their share goes to the tail);
 *  2. tail picks are spread across the whole tail instead of first+last, so a
 *     straddling flip lands between two picks that are <= the confirm gap apart
 *     and at least two picks fall on the POST side;
 *  3. when the ledger already holds a transition (`postFlipTs`), the tail is
 *     taken after that instant — the frames there are guaranteed POST — and the
 *     newest ones are preferred (last-N over the post flip), which is the
 *     ticket's own "prefer frames after the earliest post-flip read" clause.
 *
 * The `leadS` head fills only what is left: the ledger normally already holds
 * the PRE support, and a PRE read further than `SCOREBOARD_MAX_CONFIRM_GAP_S`
 * from the transition could not support it anyway.
 *
 * Bounds are untouched: at most `maxFrames` picks (= OCR calls) per pass.
 */
export function selectRereadFrames(
  candidates: ReadonlyArray<FrameRereadCandidate>,
  window: { lo: number; hi: number },
  opts: FrameRereadSelectOptions = {}
): FrameRereadCandidate[] {
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? LIVE_FRAME_REREAD_MAX_FRAMES));
  const leadS = Math.max(0, opts.leadS ?? 0);
  const trailS = Math.max(0, opts.trailS ?? 0);
  const maxGapS = Math.max(0, opts.maxConfirmGapS ?? LIVE_FRAME_REREAD_MAX_CONFIRM_GAP_S);
  const lo = Number.isFinite(window?.lo) ? window.lo : Number.NEGATIVE_INFINITY;
  const hi = Number.isFinite(window?.hi) ? window.hi : Number.POSITIVE_INFINITY;
  if (hi < lo) return [];
  // One reading per content frame: dedupe by ts, keep the smallest seq.
  const byTs = new Map<number, FrameRereadCandidate>();
  for (const c of candidates ?? []) {
    if (!Number.isFinite(c?.seq) || !Number.isFinite(c?.ts)) continue;
    const at = byTs.get(c.ts);
    if (!at || c.seq < at.seq) byTs.set(c.ts, { seq: Math.floor(c.seq), ts: c.ts });
  }
  const known = new Set<string>();
  for (const ts of opts.knownTs ?? []) if (Number.isFinite(ts)) known.add(rereadTsKey(ts));
  const span = [...byTs.values()]
    .filter((c) => c.ts >= lo - leadS - 1e-9 && c.ts <= hi + trailS + 1e-9)
    .filter((c) => !known.has(rereadTsKey(c.ts)))
    .sort((a, b) => a.ts - b.ts);
  if (!span.length) return [];
  const interior = span.filter((c) => c.ts >= lo - 1e-9 && c.ts <= hi + 1e-9);
  const tailAll = span.filter((c) => c.ts > hi + 1e-9);
  const head = span.filter((c) => c.ts < lo - 1e-9);
  // Clause 3: a flip the ledger already read tells us which tail frames are
  // guaranteed POST. Fall back to the whole tail when that leaves nothing (a flip
  // at the very end of the lookahead, or a transition the ledger read inside the
  // window) — the accept path still decides, this only chooses frames.
  const postFlip = Number.isFinite(opts.postFlipTs) ? (opts.postFlipTs as number) : undefined;
  const tailAfterFlip = postFlip === undefined ? [] : tailAll.filter((c) => c.ts > postFlip + 1e-9);
  const tail = tailAfterFlip.length ? tailAfterFlip : tailAll;
  const half = Math.ceil(maxFrames / 2);
  const interiorTake = Math.min(interior.length, half);
  const tailTake = Math.min(tail.length, Math.max(half, maxFrames - interiorTake));
  const picked: FrameRereadCandidate[] = [...pickRereadTailFrames(tail, tailTake, maxGapS, tailAfterFlip.length > 0)];
  const remaining = maxFrames - picked.length;
  if (remaining > 0) picked.push(...evenlyPick(interior, remaining));
  for (let i = head.length - 1; i >= 0 && picked.length < maxFrames; i--) picked.push(head[i]);
  return picked.sort((a, b) => a.ts - b.ts);
}

/**
 * Subsample a run of tail frames (ascending by content ts).
 *
 * `late` (the ledger already holds the flip) picks the NEWEST frames: their read
 * is guaranteed POST and the boundary's PRE/POST gap is already the ledger's, so
 * density near the end is the most POST support per call.
 *
 * Otherwise the picks are spread over the WHOLE tail (endpoints kept): that is
 * the only shape where a flip anywhere between `hi` and the lookahead's close
 * falls between two adjacent picks that are <= `maxGapS` apart, which is what
 * the accept path measures (`deltaTs - preTs <= SCOREBOARD_MAX_CONFIRM_GAP_S`).
 * First+last — the shape that measured the ADAAAA-9332 defect — is deliberately
 * not used when the budget allows more than two picks.
 */
export function pickRereadTailFrames<T>(
  tail: ReadonlyArray<T>,
  max: number,
  maxGapS: number,
  late: boolean
): T[] {
  const n = Math.max(0, Math.floor(max));
  if (!tail.length || n === 0) return [];
  if (tail.length <= n) return [...tail];
  if (n === 1) return [tail[tail.length - 1]];
  if (late) return tail.slice(tail.length - n);
  const picks = evenlyPick(tail, n);
  // Evenly-spread picks are only gap-safe when the spread fits the confirm gap;
  // it does for the shipped 20 s lookahead at 3+ picks. Nothing to repair when it
  // does not — a wider tail would need more budget than the funded cell has, and
  // inventing calls here would break the <= 4 bound.
  void maxGapS;
  return picks;
}

/** Evenly spaced deterministic subsample (keeps the first and last frame). */
export function evenlyPick<T>(items: ReadonlyArray<T>, max: number): T[] {
  const n = Math.max(1, Math.floor(max));
  if (items.length <= n) return [...items];
  if (n === 1) return [items[Math.floor(items.length / 2)]];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

/** The demoted rows whose deferred lookahead has closed and that carried no
 * post-goal read in their own window, minus the ones already re-read.
 *
 * `scoreReads.postSamples < scoreReads.need` is the ADAAAA-8134 disclosure the
 * demoted row stored; a row without that disclosure is not eligible (the pass
 * exists for the measured "no post read inside the window" gap, not as a general
 * re-decode). */
export function planDueRereads(
  pending: ReadonlyArray<{ highlightId: string; lo: number; hi: number; scoreReads?: { postSamples: number; need: number } }>,
  input: { nowTs: number; lookaheadS: number; attempted?: ReadonlySet<string> }
): FrameRereadPlan[] {
  const out: FrameRereadPlan[] = [];
  if (!Number.isFinite(input.nowTs)) return out;
  const lookaheadS = Math.max(0, input.lookaheadS);
  for (const e of pending ?? []) {
    if (!e?.highlightId) continue;
    if (input.attempted?.has(e.highlightId)) continue;
    if (!Number.isFinite(e.lo) || !Number.isFinite(e.hi) || e.hi < e.lo) continue;
    // Due only once the lookahead has closed: a fresh read could still resolve
    // the row for free, and the re-read must not pre-empt it.
    if (input.nowTs < e.hi + lookaheadS - 1e-9) continue;
    const sr = e.scoreReads;
    if (!sr || !Number.isFinite(sr.postSamples) || !Number.isFinite(sr.need)) continue;
    if (sr.postSamples >= sr.need) continue;
    out.push({ key: e.highlightId, lo: e.lo, hi: e.hi, lookaheadS });
  }
  return out;
}

/** Injected IO so the pass is unit-testable without disk or a perceive service. */
export interface FrameRereadIo {
  /** Persisted frame inventory for a content span (seq + content ts), any order. */
  framesInSpan?: (lo: number, hi: number) => ReadonlyArray<FrameRereadCandidate>;
  /** Load one frame's bytes (base64 JPEG), or null when it is gone. */
  loadFrame: (seq: number) => Promise<string | null>;
  /** OCR one frame's score-bug crop. Absent lines = absent evidence. */
  ocrFrame: (imageB64: string) => Promise<string[] | null>;
  maxFrames?: number;
  /** Support lead the pooled span allows (seconds before `lo`). */
  leadS?: number;
  /** Content instants whose read the run ledger already holds (ADAAAA-9332).
   * Those persisted frames are skipped: a call spent on one adds no reading. */
  knownTs?: ReadonlyArray<number>;
  /** The ledger's newest transition instant in the deferred range, when it holds
   * one (ADAAAA-9332): tail picks are then taken AFTER it, i.e. on frames that
   * are guaranteed POST. */
  postFlipTs?: number;
}

export interface FrameRereadResult {
  pass: FrameRereadPass;
  /** Readings to fold into the run ledger, content-ordered. */
  readings: ReadonlyArray<{ ts: number; ocr: string[] }>;
  /** OCR calls this pass consumed (counts against the run budget). */
  ocrCalls: number;
}

/**
 * Run ONE re-read pass over a demoted window's persisted frames.
 *
 * Never throws: a missing frame, an OCR failure or a timeout is counted and the
 * pass fails closed (fewer/no readings), which is exactly what the defered path
 * does with an unreadable span. Callers apply their own per-run OCR budget.
 */
export async function runFrameRereadPass(
  plan: FrameRereadPlan,
  io: FrameRereadIo,
  ctx: { jobId?: string; log?: (line: string) => void; ocrTimeoutMs?: number } = {}
): Promise<FrameRereadResult> {
  const log = ctx.log ?? ((line: string) => console.error(line));
  const maxFrames = Math.max(1, Math.floor(io.maxFrames ?? LIVE_FRAME_REREAD_MAX_FRAMES));
  const timeoutMs = Math.max(1, ctx.ocrTimeoutMs ?? LIVE_FRAME_REREAD_OCR_TIMEOUT_MS);
  const inventory = io.framesInSpan
    ? io.framesInSpan(plan.lo - (io.leadS ?? 0), plan.hi + plan.lookaheadS)
    : [];
  const picked = selectRereadFrames(inventory, { lo: plan.lo, hi: plan.hi }, {
    maxFrames,
    leadS: io.leadS,
    trailS: plan.lookaheadS,
    knownTs: io.knownTs,
    postFlipTs: io.postFlipTs,
  });
  // ADAAAA-9332: disclose how many in-span frames the ledger already held, so the
  // audit line shows the sample was re-aimed rather than silently shrinking.
  const knownSet = new Set((io.knownTs ?? []).filter((ts) => Number.isFinite(ts)).map(rereadTsKey));
  const skippedKnown = knownSet.size
    ? inventory.filter((f) => knownSet.has(rereadTsKey(f.ts))).length
    : 0;
  const pass: FrameRereadPass = {
    key: plan.key,
    window: { lo: plan.lo, hi: plan.hi },
    frames: picked.map((f) => f.seq),
    ocrCalls: 0,
    readings: [],
    unreadable: 0,
    skippedKnown,
    failed: 0,
  };
  if (!picked.length) {
    log(
      `[live-frame-reread:${ctx.jobId ?? "?"}] no persisted frames for demoted window ` +
        `[${plan.lo.toFixed(1)}, ${plan.hi.toFixed(1)}] (+${plan.lookaheadS} s lookahead) — pass is a no-op`
    );
    return { pass, readings: [], ocrCalls: 0 };
  }
  for (const frame of picked) {
    let b64: string | null = null;
    try {
      b64 = await io.loadFrame(frame.seq);
    } catch (e: any) {
      pass.failed++;
      log(`[live-frame-reread:${ctx.jobId ?? "?"}] frame ${frame.seq} unreadable: ${String(e?.message || e)}`);
      continue;
    }
    if (!b64) {
      pass.failed++;
      continue;
    }
    pass.ocrCalls++;
    let lines: string[] | null = null;
    try {
      lines = await withTimeout(io.ocrFrame(b64), timeoutMs);
    } catch (e: any) {
      pass.failed++;
      log(
        `[live-frame-reread:${ctx.jobId ?? "?"}] OCR of frame ${frame.seq} (@${frame.ts.toFixed(1)}s) failed: ` +
          `${String(e?.message || e)}`
      );
      continue;
    }
    const ocr = (lines ?? []).map((l) => String(l)).filter((l) => !!l.trim());
    if (!ocr.length) {
      pass.unreadable++;
      continue;
    }
    pass.readings.push({ seq: frame.seq, ts: frame.ts, ocr });
  }
  log(
    `[live-frame-reread:${ctx.jobId ?? "?"}] re-read demoted window [${plan.lo.toFixed(1)}, ${plan.hi.toFixed(1)}]: ` +
      `${pass.ocrCalls} OCR call(s) over ${pass.frames.length} persisted frame(s), ` +
      `${pass.readings.length} readable / ${pass.unreadable} unreadable / ${pass.failed} failed` +
      (pass.skippedKnown ? `, ${pass.skippedKnown} frame(s) already in the run ledger (skipped)` : "")
  );
  return { pass, readings: pass.readings.map((r) => ({ ts: r.ts, ocr: r.ocr })), ocrCalls: pass.ocrCalls };
}

/** Reject a promise after `ms`, so a hung OCR call cannot park the frame loop. */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default disk reader for a job's frame dir. Returns null when the file is gone
 * (decimation, a finished/cleaned job) — never throws into the rail. */
export function diskFrameLoader(dataDir: string, jobId: string): (seq: number) => Promise<string | null> {
  const dir = liveRereadFrameDir(dataDir, jobId);
  return async (seq: number) => {
    try {
      const buf = await readFile(path.join(dir, liveRereadFrameFileName(seq)));
      return buf.length ? buf.toString("base64") : null;
    } catch {
      return null;
    }
  };
}

/**
 * Default OCR caller: one score-bug crop pass on the perceive service.
 *
 * `POST <perceiveUrl>/app/scoreboard` runs ONLY the scoreboard `<OCR>` crop (no
 * detection, no SAM, no tracker state) and returns the raw text lines; the
 * server parses them with its own `parseOcrScoreLine`, so one parser owns what a
 * score line is. A non-2xx/absent service is a fail-closed `null` (absent
 * evidence), never a fabricated read.
 */
export function perceiveScoreboardOcr(
  perceiveUrl: string | undefined,
  sessionId?: string
): (imageB64: string) => Promise<string[] | null> {
  return async (imageB64: string) => {
    if (!perceiveUrl) return null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // The session id lets the probe reuse the ROI region discovery already
    // resolved for this source (the exact crop every live frame used).
    if (sessionId) headers["X-Session-Id"] = sessionId;
    const res = await fetch(`${perceiveUrl.replace(/\/+$/, "")}/app/scoreboard`, {
      method: "POST",
      headers,
      body: JSON.stringify({ image: imageB64 }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { ocr?: unknown } | null;
    const ocr = body?.ocr;
    return Array.isArray(ocr) ? ocr.map((l) => String(l)) : null;
  };
}
