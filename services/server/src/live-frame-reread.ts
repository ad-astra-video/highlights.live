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
  /** Failures (missing file / OCR error) — the pass fails closed on these. */
  failed: number;
}

/**
 * Pick the frames one pass will OCR from the window's persisted inventory.
 *
 * Selection is deterministic, content-ordered, and SPLIT ON PURPOSE: half the
 * budget (rounded up) lands in the deferred lookahead tail `[hi, hi + lookahead]`
 * and the rest inside the judged window `[lo, hi]`.
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
 * The `leadS` head fills only what is left: the ledger normally already holds
 * the PRE support, and a PRE read further than `SCOREBOARD_MAX_CONFIRM_GAP_S`
 * from the transition could not support it anyway.
 */
export function selectRereadFrames(
  candidates: ReadonlyArray<FrameRereadCandidate>,
  window: { lo: number; hi: number },
  opts: { maxFrames?: number; leadS?: number; trailS?: number } = {}
): FrameRereadCandidate[] {
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? LIVE_FRAME_REREAD_MAX_FRAMES));
  const leadS = Math.max(0, opts.leadS ?? 0);
  const trailS = Math.max(0, opts.trailS ?? 0);
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
  const span = [...byTs.values()]
    .filter((c) => c.ts >= lo - leadS - 1e-9 && c.ts <= hi + trailS + 1e-9)
    .sort((a, b) => a.ts - b.ts);
  if (!span.length) return [];
  const interior = span.filter((c) => c.ts >= lo - 1e-9 && c.ts <= hi + 1e-9);
  const tail = span.filter((c) => c.ts > hi + 1e-9);
  const head = span.filter((c) => c.ts < lo - 1e-9);
  const tailBudget = Math.min(tail.length, Math.ceil(maxFrames / 2));
  const picked: FrameRereadCandidate[] = [...evenlyPick(tail, tailBudget)];
  const remaining = maxFrames - picked.length;
  if (remaining > 0) picked.push(...evenlyPick(interior, remaining));
  for (let i = head.length - 1; i >= 0 && picked.length < maxFrames; i--) picked.push(head[i]);
  return picked.sort((a, b) => a.ts - b.ts);
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
  });
  const pass: FrameRereadPass = {
    key: plan.key,
    window: { lo: plan.lo, hi: plan.hi },
    frames: picked.map((f) => f.seq),
    ocrCalls: 0,
    readings: [],
    unreadable: 0,
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
      `${pass.readings.length} readable / ${pass.unreadable} unreadable / ${pass.failed} failed`
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
