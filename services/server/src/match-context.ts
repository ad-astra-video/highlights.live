// Match-context resolver orchestration for VOD jobs (ADAAAA-7855).
//
// The parent plan (ADAAAA-7849 §3) splits the work: the once-per-job resolver
// decides WHO is playing and which colour each team wears, persists it on the
// job (`matchContext`), and every later LLM call reads it instead of inventing a
// team ("German defender" on a Portugal vs Spain job).
//
// This module owns the SERVER half of the evidence pack:
//
// - Stage 0 metadata hints: the stored title / gameHint / source filename.
// - Stage 2 commentary probe: ONE bounded CPU transcribe per job (default first
//   90 s of the audio track, env-tunable, hard byte cap). The audio decode reuses
//   the VOD tap's ffmpeg form; the transcript goes through the same `/transcribe`
//   contract the decide path already uses. Never billed to the Livepeer GPU.
//
// Perceive owns the GPU-free half it already computes (ROI-gated scorebug OCR
// lines per anchor frame, torso kit samples, scoreboard kit swatches) and folds
// both halves through `POST /app/match-context` — the pure resolver lives in
// `services/perceive/app/match_context.py`, so the fold + monotonic guard are
// unit-tested in Python and this file only carries I/O.
//
// Budget discipline: at most THREE resolve calls per job (job start, >=25%,
// >=50%), no per-window inference, no gemma call. The re-checks exist so
// confidence can rise as evidence accumulates while the monotonic guard keeps an
// attributed team's name frozen (AC4).
import { spawn } from "node:child_process";
import {
  MatchContextEvidenceSchema,
  type Job,
  type MatchContextEvidence,
} from "@highlights/events";

/** One team attribution as persisted on the job record (plan §3 Stage 5). */
export interface MatchContextTeam {
  name: string;
  side: "home" | "away" | "unknown";
  kitColors: { primary: string; secondary?: string }[];
  confidence: number;
  evidence: { source: string; snippet: string }[];
}

/** The persisted `matchContext` contract (additive optional on JobSchema). */
export interface MatchContext {
  sport: string;
  teams: MatchContextTeam[];
  inferredAt: string;
  resolverVersion: number;
  ambiguous: boolean;
  /** AC4 audit: one bounded entry per resolver pass (start + 25% + 50%). */
  trail: {
    at: string;
    progressPct: number;
    names: { side?: string; name?: string; confidence?: number }[];
    action: string[];
  }[];
}

/**
 * The resolver's `evidenceStatus`, as persisted on the job record
 * (`matchContextEvidence`, ADAAAA-7868). The shape is OWNED by the contract
 * package — `MatchContextEvidenceSchema` in `packages/events` — so the server
 * and the stored record cannot drift apart; this alias keeps the historical
 * server-side name.
 */
export type MatchContextEvidenceStatus = MatchContextEvidence;

export interface MatchContextResolveResult {
  matchContext: MatchContext;
  evidenceStatus?: MatchContextEvidenceStatus;
}

/**
 * Progress points at which the resolver re-reads the evidence (bounded).
 *
 * ADAAAA-8076: a late checkpoint is required, not cosmetic. The perceive kit
 * sampler only yields a usable crop when a player box passes the single-player
 * contract, and on a wide first half that box rarely qualifies (measured on
 * `757d3422`, the same 90 s Portugal v Spain source as e58bcef7): the fold at
 * 50 % held 29 crops — white 24, cyan 3, orange 1, red 1 — so the home cluster
 * was named by a junk cyan/orange seed and the served record published
 * `home cyan`. The red shirts are sampled at seq 132-144 and 213-216 (the
 * celebration close-ups); the 90 % fold holds 41 crops (red 5, white 28) and
 * publishes `home red / away white`. Stopping at 50 % therefore published an
 * artefact of the fold window, not an observation about the kit.
 *
 * 90 and not 75: at 75 % the junk cluster is still named `black` (8 crops,
 * red 3) and home stays unresolved. The late checkpoint still runs inside the
 * frame loop, so the perceive session is alive (see `finish()`), and the
 * resolve is CPU-only — no GPU work, no decide call.
 */
export const MATCH_CONTEXT_RECHECKS: readonly number[] = [0, 25, 50, 90];
/** Default commentary probe length (plan §3 Stage 2: "first 90 s"). */
export const DEFAULT_MATCH_CONTEXT_ASR_SECONDS = 90;
/** Hard cap on the wav bytes we are willing to base64 + POST (≈ 8 MB ≈ 4 min). */
export const DEFAULT_MATCH_CONTEXT_ASR_MAX_BYTES = 8 * 1024 * 1024;
/** Concurrent resolves allowed in flight (the checkpoints are 4, but a long
 * job can fire them close together when frames land fast). */
const MAX_INFLIGHT_RESOLVES = 1;

export interface MatchContextResolverCfg {
  ffmpegPath: string;
  /** ASR service base url (POST {asrUrl}/transcribe). Unset => no ASR source. */
  asrUrl?: string;
  /** Commentary probe length in seconds (MATCH_CONTEXT_ASR_SECONDS). */
  asrSeconds: number;
  /** Hard byte cap on the decoded prefix (MATCH_CONTEXT_ASR_MAX_BYTES). */
  asrMaxBytes: number;
}

export interface MatchContextClient {
  /** Perceive fold call; optional so a FAKE/older client simply never resolves.
   * The shape is the loose JSON contract (the PipelineClient implementation
   * returns `Record<string, unknown>`); `JobSchema.parse` validates it on write. */
  postMatchContext?: (
    sessionId: string,
    payload: Record<string, unknown>
  ) => Promise<{ matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null>;
}

export interface MatchContextResolverDeps {
  jobId: string;
  videoPath: string;
  cfg: MatchContextResolverCfg;
  client: MatchContextClient;
  /** Perceive session id the evidence lives on (the pass's live session). */
  sessionId: string;
  /** ADAAAA-7861: the pass may RE-RESERVE a fresh perceive session mid-run
   * (SessionLostError recovery in `analyzeJob` -> `slotRef.onReserve`). A
   * resolver pinned to the first session then posts every later re-check at a
   * dead session, the orchestrator app-call 404s, `postMatchContext` answers
   * null and the fold is dropped SILENTLY — measured on the first deployed VOD
   * job: 3 checkpoints queued, 1 contract landed. Prefer this getter so the
   * re-check always reads the CURRENT session. */
  getSessionId?: () => string;
  hints: { title?: string; gameHint?: string; filename?: string };
  /** Job store write-through (patchJob parses through JobSchema). */
  getJob: (id: string) => Job | undefined;
  patchJob: (id: string, patch: Partial<Omit<Job, "id">>) => Promise<Job>;
  log?: (msg: string) => void;
  /** Test/QA seam: replace the ffmpeg+ASR probe (default = the real bounded
   * probe). One probe per resolver instance, shared by every checkpoint. */
  probeCommentary?: () => Promise<TranscriptProbe>;
}

export interface MatchContextResolver {
  /** Start the one bounded transcription probe (no await — runs with extraction). */
  begin(): void;
  /** Call from the frame loop; fires the bounded re-checks on threshold cross. */
  onProgress(pct: number): void;
  /** Await every fired resolve (never starts one on a possibly-closed session). */
  finish(): Promise<void>;
}

interface TranscriptProbe {
  text: string;
  seconds: number;
  bytes: number;
  error?: string;
}

/**
 * Decode a bounded prefix of the source's audio track to a 16 kHz mono WAV.
 *
 * Mirrors `vod-audio.ts` (`-map 0:a:0?`, mono, s16le) but stops at
 * `seconds`/`maxBytes`, because the commentary probe is deliberately flat per
 * job instead of proportional to runtime. Best-effort: a missing audio track or
 * a decode failure yields `b64: ""` and never throws.
 */
export function extractCommentaryWav(
  ffmpegPath: string,
  source: string,
  seconds: number,
  maxBytes: number
): Promise<{ b64: string; bytes: number; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      resolve({ b64: buf.length ? buf.toString("base64") : "", bytes: buf.length, truncated });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-map",
        "0:a:0?",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-t",
        String(Math.max(1, Math.floor(seconds))),
        "-f",
        "wav",
        "-",
      ]);
    } catch {
      resolve({ b64: "", bytes: 0, truncated: false });
      return;
    }
    proc.stdout?.on("data", (data: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        proc.kill("SIGKILL");
        return;
      }
      const room = maxBytes - bytes;
      const slice = data.length > room ? data.subarray(0, room) : data;
      chunks.push(slice);
      bytes += slice.length;
      if (data.length > room) {
        truncated = true;
        proc.kill("SIGKILL");
      }
    });
    proc.stderr?.on("data", () => {
      /* swallowed — the probe is best-effort, errors never abort the job */
    });
    proc.on("error", () => done());
    proc.on("close", () => done());
  });
}

/**
 * One bounded CPU transcription (`POST {asrUrl}/transcribe`).
 *
 * Same contract as `services/decide/app/gemma.py::transcribe_audio`: the ASR
 * service answers 200 with `{text}` for any payload problem (never 5xx), so a
 * silent or undecodable prefix simply yields no commentary evidence. Returns
 * `{text: ""}` on any transport failure — the resolver then reports the ASR
 * source as `not_captured` instead of failing the job.
 */
export async function transcribeCommentary(
  asrUrl: string | undefined,
  wavB64: string,
  timeoutMs = 120_000
): Promise<{ text: string; error?: string }> {
  if (!asrUrl || !wavB64) return { text: "", error: asrUrl ? "no audio prefix" : "ASR_URL unset" };
  const url = `${asrUrl.replace(/\/$/, "")}/transcribe`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: wavB64, sample_rate: 16000, task: "transcribe" }),
      signal: ctl.signal,
    });
    if (!res.ok) return { text: "", error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { text?: string } | null;
    return { text: String(body?.text || "").trim() };
  } catch (e: any) {
    return { text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the resolver is enabled for this deployment (MATCH_CONTEXT). */
export function matchContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.MATCH_CONTEXT ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Validate + copy a resolver `evidenceStatus` for persistence (ADAAAA-7868).
 *
 * Returns `{ value: undefined }` — and the caller writes no field — when the
 * pass produced no status at all (E2) or when the status fails validation.
 * A validation failure is reported through `error` so the resolver can log WHY
 * the markers were dropped while still persisting `matchContext` (E3); it is
 * never thrown, because the primary contract must survive a marker problem.
 *
 * Pure and IO-free: the same schema (`MatchContextEvidenceSchema` in
 * `packages/events`) validates the write here and on `JobSchema.parse`, so the
 * pre-check can never disagree with the store.
 */
export function toMatchContextEvidence(
  status: Record<string, unknown> | undefined | null
): { value?: MatchContextEvidence; error?: string } {
  if (!status || typeof status !== "object") return {};
  if (Object.keys(status).length === 0) return {};
  const parsed = MatchContextEvidenceSchema.safeParse(status);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { value: parsed.data as MatchContextEvidence };
}

// ---------------------------------------------------------------------------
// ADAAAA-7912: match-context evidence must survive a VOD RESUME.
//
// Measured on job ddf5c47f (deployed box, ADAAAA-7900 Leg A): the pre-deploy
// attempts resolved Portugal@0.95 / Spain@0.65 from 24 scorebug OCR lines, a
// concurrent deploy recreated highlights-server + highlights-perceive, and the
// auto-resumed attempt re-ran the evidence pass over only the resumed tail
// (81 s -> 90 s, `warmupFrames 24`). The fold it published had NO scorebug
// evidence, so the same-named away team came back from the metadata channel
// alone at 0.15 and the resolver's own evidence counters reset to 0:
//
//   final: channelOutcomes.scorebug_ocr {frames 0, lines 0, teamLines 0}
//          sources ["scorebug_ocr:not_captured","asr","metadata"]
//          fold.away {name Spain, confidence 0.15, sources ["metadata"]}
//          ambiguous false            <- below usable 0.60, still publishable
//   trail: 0.65 (25%) -> 0.65 (50%) -> 0.15 (resumed attempt 0%)
//
// The persisted record is the durable accumulator: `matchContext` and
// `matchContextEvidence` are written by every resolver pass and are NOT touched
// by the resume checkpoint, so a resumed attempt already reads them through
// `getJob` (that is why the trail above carries the earlier entries). What was
// missing is the rule that a resumed pass may never publish LESS than the
// record already knows. Two pure helpers supply it:
//
// - `mergeMatchContextEvidence` folds this pass's evidence counters into the
//   persisted ones (high-water per counter, union per provenance list, the
//   strongest fold per side), so a resumed tail cannot erase channel evidence
//   an earlier attempt paid for.
// - `guardMatchContextRegression` refuses a weaker attribution for a side the
//   record already resolved and forces `ambiguous: true` on any published
//   attribution below the resolver's usable floor, so a below-floor name can
//   never reach a caption while the record claims the match is unambiguous.
// ---------------------------------------------------------------------------

/** The resolver's usable floor (mirrors `USABLE_CONFIDENCE` in
 * `services/perceive/app/match_context.py`). A published attribution below it
 * is not a team the resolver considers usable. */
export const MATCH_CONTEXT_USABLE_CONFIDENCE = 0.6;

/** Bound on the persisted recompute trail (mirrors `MAX_TRAIL` in
 * `services/perceive/app/match_context.py`), so a long job cannot grow the
 * record. The server appends at most one entry per resumed pass. */
export const MATCH_CONTEXT_MAX_TRAIL = 12;

/** Caps mirroring the resolver's own status caps, so a record that accumulates
 * evidence across attempts cannot grow without bound. */
const EVIDENCE_ARRAY_CAP = 50;
const EVIDENCE_RAW_LINES_CAP = 5;
const EVIDENCE_TEAMS_CAP = 8;
const EVIDENCE_MENTIONS_CAP = 12;

/** Counters that describe how much of the clip a channel covered: the evidence
 * pass is monotone within a job, so the high-water mark is the honest value
 * (a resumed tail reports 0 frames for content the job already read). */
const EVIDENCE_HIGH_WATER_KEYS = [
  "scorebugOcrFrames",
  "commentaryChars",
  "kitSamples",
  "kitSampleFrames",
  "kitSampleTracks",
  "scorebugSwatches",
] as const;

/** Provenance lists: an earlier attempt's observation is still a true statement
 * about the job, so the merged record is the union (deduped, capped). */
const EVIDENCE_UNION_KEYS = [
  "suppressedCandidates",
  "kitClusterColors",
  "kitColorsUnattributed",
  "kitClustersUnattributed",
  "kitPriorUsed",
  "kitPriorMiss",
  "kitPriorConflict",
] as const;

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function unionStrings(
  previous: string[] | undefined,
  incoming: string[] | undefined,
  cap = EVIDENCE_ARRAY_CAP
): string[] | undefined {
  const out: string[] = [];
  for (const raw of [...(previous ?? []), ...(incoming ?? [])]) {
    const value = String(raw);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= cap) break;
  }
  return out.length ? out : undefined;
}

function unionObjects<T>(
  previous: T[] | undefined,
  incoming: T[] | undefined,
  key: (value: T) => string,
  cap: number
): T[] | undefined {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const value of [...(previous ?? []), ...(incoming ?? [])]) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
    if (out.length >= cap) break;
  }
  return out.length ? out : undefined;
}

/**
 * Merge the per-source availability markers of two passes.
 *
 * A source that was captured by ANY attempt stays captured: the resumed attempt
 * sees only the tail, so its `scorebug_ocr:not_captured` describes that pass,
 * not the job. This is what keeps a resumed record from reading
 * `sources ["scorebug_ocr:not_captured","asr","metadata"]` while the job really
 * did read 24 scorebug OCR lines.
 */
export function mergeEvidenceSources(
  previous: string[] | undefined,
  incoming: string[] | undefined
): string[] | undefined {
  const order: string[] = [];
  const captured = new Map<string, boolean>();
  const label = new Map<string, string>();
  const add = (entry: string) => {
    const name = entry.split(":")[0];
    if (!name) return;
    const isCaptured = !entry.slice(name.length).includes("not_captured");
    if (!order.includes(name)) order.push(name);
    captured.set(name, (captured.get(name) ?? false) || isCaptured);
    if (isCaptured) label.set(name, name);
    else if (!label.has(name)) label.set(name, entry);
  };
  for (const entry of previous ?? []) add(String(entry));
  for (const entry of incoming ?? []) add(String(entry));
  return order.length ? order.map((name) => label.get(name) ?? name) : undefined;
}

function mergeChannelOutcomes(
  previous: MatchContextEvidence["channelOutcomes"],
  incoming: MatchContextEvidence["channelOutcomes"]
): MatchContextEvidence["channelOutcomes"] {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const out: Record<string, any> = { ...previous, ...incoming };
  const ocrPrev = previous.scorebug_ocr;
  const ocrNext = incoming.scorebug_ocr;
  if (ocrPrev || ocrNext) {
    out.scorebug_ocr = {
      ...ocrPrev,
      ...ocrNext,
      frames: maxDefined(ocrPrev?.frames, ocrNext?.frames),
      lines: maxDefined(ocrPrev?.lines, ocrNext?.lines),
      teamLines: maxDefined(ocrPrev?.teamLines, ocrNext?.teamLines),
      teams: unionObjects(ocrPrev?.teams, ocrNext?.teams, (t: any) => `${t?.name}|${t?.side}`, EVIDENCE_TEAMS_CAP),
      rawLines: unionStrings(ocrPrev?.rawLines, ocrNext?.rawLines, EVIDENCE_RAW_LINES_CAP),
    };
  }
  const asrPrev = previous.asr;
  const asrNext = incoming.asr;
  if (asrPrev || asrNext) {
    out.asr = {
      ...asrPrev,
      ...asrNext,
      chars: maxDefined(asrPrev?.chars, asrNext?.chars),
      mentions: unionObjects(
        asrPrev?.mentions,
        asrNext?.mentions,
        (m: any) => `${m?.name}|${m?.snippet}`,
        EVIDENCE_MENTIONS_CAP
      ),
    };
  }
  const metaPrev = previous.metadata;
  const metaNext = incoming.metadata;
  if (metaPrev || metaNext) {
    out.metadata = {
      ...metaPrev,
      ...metaNext,
      candidates: unionObjects(
        metaPrev?.candidates,
        metaNext?.candidates,
        (c: any) => `${c?.name}|${c?.side}|${c?.field}`,
        EVIDENCE_TEAMS_CAP
      ),
    };
  }
  const foldPrev = previous.fold;
  const foldNext = incoming.fold;
  if (foldPrev || foldNext) {
    const strongest = (a: any, b: any) => {
      if (!a) return b ?? null;
      if (!b) return a;
      return Number(b.confidence ?? 0) > Number(a.confidence ?? 0) ? b : a;
    };
    out.fold = {
      ...foldPrev,
      ...foldNext,
      // The published record's fold is the strongest fold the JOB saw, so the
      // evidence block agrees with the guarded `matchContext` teams.
      home: strongest(foldPrev?.home, foldNext?.home),
      away: strongest(foldPrev?.away, foldNext?.away),
    };
  }
  return out as MatchContextEvidence["channelOutcomes"];
}

/**
 * Fold this pass's evidence into the evidence the record already carries.
 *
 * Used on a resumed attempt (and on any re-check after one): a pass that only
 * covered the resumed tail must not reset the counters or the `not_captured`
 * markers an earlier attempt established. Counters take the high-water mark,
 * provenance lists take the union, `channelOutcomes` merges per channel, and
 * the fold keeps the strongest claim per side. Everything else (sessionId,
 * sport, ...) follows the CURRENT pass, because it describes the live session.
 */
export function mergeMatchContextEvidence(
  previous: MatchContextEvidence | undefined,
  incoming: MatchContextEvidence
): MatchContextEvidence {
  if (!previous) return incoming;
  const out: Record<string, unknown> = { ...previous };
  for (const key of EVIDENCE_HIGH_WATER_KEYS) {
    const value = maxDefined(
      previous[key] as number | undefined,
      incoming[key] as number | undefined
    );
    if (value !== undefined) out[key] = value;
  }
  const sources = mergeEvidenceSources(previous.sources, incoming.sources);
  if (sources) out.sources = sources;
  for (const key of EVIDENCE_UNION_KEYS) {
    const value = unionStrings(previous[key] as string[] | undefined, incoming[key] as string[] | undefined);
    if (value) out[key] = value;
  }
  const channels = mergeChannelOutcomes(previous.channelOutcomes, incoming.channelOutcomes);
  if (channels) out.channelOutcomes = channels;
  // The live-session fields and the per-pass reason describe THIS pass only.
  for (const key of ["sessionId", "sessionEvidence", "sport", "unknownReason", "genericNameCandidates"]) {
    const value = (incoming as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
    else delete out[key];
  }
  return out as MatchContextEvidence;
}

/**
 * Refuse a match-context regression, and never publish a below-floor name as
 * an unambiguous match.
 *
 * - Per side (home/away), the record keeps the STRONGER of the persisted and
 *   the incoming team: a thinner pass (the resumed tail, a late re-check on a
 *   stretch without the score graphic) cannot lower a confidence the job
 *   already earned. Keeping the previous team object also keeps its evidence,
 *   which is what made 0.65 -> 0.15 lose `scorebug_ocr`.
 * - ADAAAA-7981: the carried identity does NOT carry the previous KIT COLOURS
 *   when the incoming pass observed kit clusters of its own. A colour this pass
 *   did not attribute to the side is unverifiable now, and re-publishing it was
 *   the measured fe0e3efc defect (away Spain@0.65 "orange" resurrected onto a
 *   pass that reported `kitColorsUnattributed: ["away"]`). With NO observed
 *   cluster (resume tail / no player crops) the stored colours still survive.
 * - A side the record resolved at/above the usable floor is carried forward
 *   when the incoming pass dropped it entirely.
 * - Any published attribution below `MATCH_CONTEXT_USABLE_CONFIDENCE` forces
 *   `ambiguous: true`, so a caption can never name a team the resolver itself
 *   does not consider usable while the record claims the match is unambiguous.
 */
export function guardMatchContextRegression(
  previous: MatchContext | undefined,
  incoming: MatchContext,
  observedClusters: string[] = []
): MatchContext {
  const usable = MATCH_CONTEXT_USABLE_CONFIDENCE;
  const prevBySide = new Map<string, MatchContextTeam>();
  for (const team of previous?.teams ?? []) {
    if (team.side === "home" || team.side === "away") prevBySide.set(team.side, team);
  }
  const teams: MatchContextTeam[] = incoming.teams.map((team) => {
    const prev = prevBySide.get(team.side);
    if (prev && prev.name && Number(prev.confidence) > Number(team.confidence)) {
      const kitColors =
        observedClusters.length > 0
          ? team.kitColors ?? []
          : (team.kitColors?.length ? team.kitColors : prev.kitColors);
      return { ...prev, confidence: Number(prev.confidence), kitColors };
    }
    return team;
  });
  for (const side of ["home", "away"] as const) {
    if (teams.some((team) => team.side === side)) continue;
    const prev = prevBySide.get(side);
    if (prev && Number(prev.confidence) >= usable) {
      // The pass dropped the side entirely; restore the identity. Its colours
      // are only restored when the pass saw no kit clusters at all (ADAAAA-7981).
      teams.push(observedClusters.length > 0 ? { ...prev, kitColors: [] } : { ...prev });
    }
  }
  const belowFloor = teams.some(
    (team) => (team.side === "home" || team.side === "away") && Number(team.confidence ?? 0) < usable
  );
  return { ...incoming, teams, ambiguous: Boolean(incoming.ambiguous) || belowFloor };
}

/** Format a confidence the way the persisted trail already does (`0.65`). */
function trailConfidence(value: number | undefined): string {
  return Number(value ?? 0).toFixed(2);
}

/**
 * ADAAAA-7921: describe the guard's decision as ONE trail entry.
 *
 * The ADAAAA-7912 guard keeps the stronger attribution on a resumed pass but
 * wrote no trail entry for it, so the record ended with `trail: away
 * Spain@0.15` beside `teams: away Spain@0.65` — the two halves of the same
 * record disagreed and a reader could not tell the guard fired. This returns
 * the entry to append whenever the guard published something the pass did not
 * read (kept a stronger side, or restored a dropped one), and `null` when the
 * pass's own read is what gets published.
 *
 * `names` is the PUBLISHED attribution (the guarded teams), never the rejected
 * read, so the trailing trail entry always agrees with `teams`.
 */
export function carryForwardTrailEntry(
  incoming: MatchContext,
  guarded: MatchContext,
  progressPct: number
): MatchContext["trail"][number] | null {
  const readBySide = new Map<string, MatchContextTeam>();
  for (const team of incoming.teams) {
    if (team.side === "home" || team.side === "away") readBySide.set(team.side, team);
  }
  const actions: string[] = [];
  for (const team of guarded.teams) {
    if (team.side !== "home" && team.side !== "away") continue;
    const read = readBySide.get(team.side);
    if (!read) {
      actions.push(
        `carry-forward: restored ${team.side} ${team.name}@${trailConfidence(team.confidence)}, pass dropped the side`
      );
      continue;
    }
    if (read.name === team.name && Number(read.confidence) >= Number(team.confidence)) continue;
    const rejected =
      read.name === team.name
        ? trailConfidence(read.confidence)
        : `${read.name}@${trailConfidence(read.confidence)}`;
    const belowFloor =
      Number(read.confidence) < MATCH_CONTEXT_USABLE_CONFIDENCE
        ? ` below floor ${trailConfidence(MATCH_CONTEXT_USABLE_CONFIDENCE)}`
        : "";
    actions.push(
      `carry-forward: kept ${team.side} ${team.name}@${trailConfidence(team.confidence)}, pass read ${rejected}${belowFloor}`
    );
  }
  if (!actions.length) return null;
  return {
    at: incoming.inferredAt || new Date().toISOString(),
    progressPct,
    names: guarded.teams.map((team) => ({ side: team.side, name: team.name, confidence: team.confidence })),
    action: actions,
  };
}

/**
 * Apply the resume carry-forward to a pass: the ADAAAA-7912 regression guard
 * plus the ADAAAA-7921 trail entry that explains it.
 *
 * The pair is one function on purpose. A record whose `trail` still ends at a
 * rejected below-floor read while `teams` carry the stronger one is the bug
 * ADAAAA-7921 measured; composing both steps here means the resolver cannot
 * publish the guarded teams without the entry that names the rejected read.
 */
export function applyResumeCarryForward(
  previous: MatchContext | undefined,
  incoming: MatchContext,
  progressPct: number,
  observedClusters: string[] = []
): MatchContext {
  const guarded = guardMatchContextRegression(previous, incoming, observedClusters);
  const entry = carryForwardTrailEntry(incoming, guarded, progressPct);
  if (!entry) return guarded;
  return {
    ...guarded,
    trail: [...(guarded.trail ?? []), entry].slice(-MATCH_CONTEXT_MAX_TRAIL),
  };
}

/**
 * AC-A2 (ADAAAA-7981): one kit colour can never describe BOTH named sides.
 *
 * Two sides publishing the SAME primary is a guaranteed-wrong colour for at
 * least one of them, and the resolver has no evidence saying which. Measured on
 * job fe0e3efc: `kitColors: [{primary:"orange"}]` on Portugal AND Spain at
 * confidence 0.95/0.65 with `ambiguous: false`, on a pitch with no orange shirt.
 * The record therefore publishes NO colour for either side, says the match is
 * ambiguous, and appends one trail entry naming the collapsed colour — an honest
 * miss instead of a wrong colour.
 */
export function collapseDuplicateKitColors(ctx: MatchContext, progressPct = 0): MatchContext {
  const home = ctx.teams.find((team) => team.side === "home");
  const away = ctx.teams.find((team) => team.side === "away");
  const primaryOf = (team: MatchContextTeam | undefined) =>
    String(team?.kitColors?.[0]?.primary ?? "").trim().toLowerCase();
  const homePrimary = primaryOf(home);
  const awayPrimary = primaryOf(away);
  if (!homePrimary || !awayPrimary || homePrimary !== awayPrimary) return ctx;
  const teams = ctx.teams.map((team) =>
    team.side === "home" || team.side === "away" ? { ...team, kitColors: [] } : team
  );
  return {
    ...ctx,
    teams,
    ambiguous: true,
    trail: [
      ...(ctx.trail ?? []),
      {
        at: ctx.inferredAt || new Date().toISOString(),
        progressPct,
        names: teams.map((team) => ({ side: team.side, name: team.name, confidence: team.confidence })),
        action: [`collapsed: dropped identical kit colour ${homePrimary} published for both sides`],
      },
    ].slice(-MATCH_CONTEXT_MAX_TRAIL),
  };
}

/** True when the job record says this pass is a RESUME (attempt 2+). */
export function isResumedAttempt(job: Job | undefined): boolean {
  const attemptNo = Number(job?.attempts ?? 0);
  const totalAttempts = Number(job?.resume?.totalAttempts ?? 0);
  return attemptNo > 1 || totalAttempts > 1 || Boolean(job?.resume?.resumedAt);
}

/**
 * Build the once-per-job VOD match-context resolver.
 *
 * Wiring (in `runVodJob`): `begin()` right after the perceive session is
 * reserved (the transcript probe costs CPU while frame extraction runs),
 * `onProgress(pct)` from the frame loop, `finish()` before the finalizing
 * transition. Every write is best-effort: a resolve failure leaves the job
 * without `matchContext` (which the sibling prompt-injection issue treats as
 * "no block", i.e. the current behaviour) and never fails the job.
 */
export function createVodMatchContextResolver(deps: MatchContextResolverDeps): MatchContextResolver {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  let transcript: Promise<TranscriptProbe> | null = null;
  const fired = new Set<number>();
  const pending: Promise<void>[] = [];
  let inflight = 0;
  const queue: number[] = [];

  const probe = (): Promise<TranscriptProbe> => {
    if (transcript) return transcript;
    transcript = (async (): Promise<TranscriptProbe> => {
      if (deps.probeCommentary) return deps.probeCommentary();
      if (!deps.cfg.asrUrl) {
        log(`[match-context:${deps.jobId}] ASR_URL unset — commentary source not_captured`);
        return { text: "", seconds: 0, bytes: 0, error: "ASR_URL unset" };
      }
      const wav = await extractCommentaryWav(
        deps.cfg.ffmpegPath,
        deps.videoPath,
        deps.cfg.asrSeconds,
        deps.cfg.asrMaxBytes
      );
      if (!wav.b64) {
        log(`[match-context:${deps.jobId}] no audio prefix (silent or no track) — commentary not_captured`);
        return { text: "", seconds: 0, bytes: 0, error: "no audio prefix" };
      }
      const asr = await transcribeCommentary(deps.cfg.asrUrl, wav.b64);
      const seconds = wav.bytes > 44 ? (wav.bytes - 44) / (16000 * 2) : 0;
      log(
        `[match-context:${deps.jobId}] ASR prefix ${seconds.toFixed(1)}s (${(wav.bytes / 1024).toFixed(0)} KB` +
          `${wav.truncated ? ", truncated at cap" : ""}) -> ${asr.text.length} chars${asr.error ? ` (${asr.error})` : ""}`
      );
      return { text: asr.text, seconds, bytes: wav.bytes, error: asr.error };
    })();
    return transcript;
  };

  const resolveOnce = async (progressPct: number): Promise<void> => {
    if (!deps.client.postMatchContext) return;
    const job = deps.getJob(deps.jobId);
    const previous = job?.matchContext as MatchContext | undefined;
    const asr = await probe();
    // ADAAAA-7861: read the session lazily, and retry once on a null contract
    // (a re-reserved session 404s the first app-call; the second lands on the
    // live session). Before this, a null result returned with no log at all,
    // which is how 2 of 3 checkpoints disappeared without a trace.
    const currentSession = () => (deps.getSessionId ? deps.getSessionId() : deps.sessionId);
    const body = {
      gameHint: deps.hints.gameHint || job?.gameHint || undefined,
      title: deps.hints.title || job?.title || undefined,
      filename: deps.hints.filename,
      transcript: asr.text || undefined,
      previous,
      progressPct,
    };
    let result: { matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await deps.client.postMatchContext(currentSession(), body);
        if (result?.matchContext) break;
      } catch (e: any) {
        log(`[match-context:${deps.jobId}] resolve at ${progressPct}% failed: ${String(e?.message || e)}`);
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
    const ctx = result?.matchContext as MatchContext | undefined;
    if (!ctx) {
      log(
        `[match-context:${deps.jobId}] no contract at ${progressPct}% (session ${currentSession()}) — keeping the stored context`
      );
      return;
    }
    // ADAAAA-7868 (AC-P8): persist the resolver's evidence status BESIDE the
    // context in the SAME patchJob, so a stored job explains its own kit
    // attribution (which clusters were seen, which sides stayed unattributed,
    // what the curated prior did) without a server-log read. It is a copy of
    // what the resolver already returned — nothing is recomputed here (E4), and
    // a pass that returned no status writes no field at all (E2).
    //
    // ADAAAA-7912: on a RESUMED attempt the pass only covered the tail
    // (`[vod-resume] ... cursorTs=81 warmupFrames=24`), so its evidence status
    // counts zero scorebug frames and its fold can come back thinner than the
    // record. Carry the persisted evidence forward (high-water counters, union
    // provenance, strongest fold) and refuse a weaker attribution per side —
    // the persisted record is the durable accumulator, so no resume-checkpoint
    // field has to duplicate it. A pass that returns NO status on a resume
    // keeps the persisted evidence instead of erasing it.
    const resumed = isResumedAttempt(job);
    const previousEvidence = job?.matchContextEvidence as MatchContextEvidence | undefined;
    // ADAAAA-7981: the kit clusters THIS pass observed decide whether a stored
    // kit colour may be carried onto a side the pass attributed none to. Parsed
    // BEFORE the guard because the guard needs the pass's own observation; the
    // persisted (merged) evidence is still what gets written.
    const evidence = toMatchContextEvidence(result?.evidenceStatus);
    const observedClusters = ((evidence.value as MatchContextEvidence | undefined)?.kitClusterColors ?? []) as string[];
    // ADAAAA-7921: on a resume the guard and its trail annotation travel
    // together, so a record that publishes the carried-forward team always
    // says so in its trail.
    const guarded = resumed
      ? applyResumeCarryForward(previous, ctx, progressPct, observedClusters)
      : guardMatchContextRegression(previous, ctx, observedClusters);
    // AC-A2: one kit colour can never describe both named sides — the last gate
    // before the record, so no carry-forward can publish the collapse.
    const published = collapseDuplicateKitColors(guarded, progressPct);
    let evidenceValue = evidence.value;
    if (resumed) {
      evidenceValue = evidenceValue
        ? mergeMatchContextEvidence(previousEvidence, evidenceValue)
        : previousEvidence;
    }
    if (resumed) {
      const trailAction = published.trail?.[published.trail.length - 1]?.action ?? [];
      const carried = trailAction.filter((a) => a.startsWith("carry-forward:"));
      log(
        `[match-context:${deps.jobId}] resume carry-forward at ${progressPct}% (attempt ${job?.attempts ?? "?"}): ` +
          `teams ${published.teams.map((t) => `${t.side}=${t.name}@${Number(t.confidence).toFixed(2)}`).join(" ") || "none"}` +
          ` ambiguous=${published.ambiguous}` +
          ` evidence ${(evidenceValue?.sources ?? []).join(",") || "none"}` +
          ` scorebugOcrFrames=${evidenceValue?.scorebugOcrFrames ?? "unset"}` +
          ` trail=${carried.join("; ") || "read as published"}`
      );
    }
    if (evidence.error) {
      log(
        `[match-context:${deps.jobId}] evidence status rejected at ${progressPct}% (${evidence.error}) — ` +
          `persisting matchContext only`
      );
    }
    try {
      // JobSchema.parse in store.patchJob is the validator: a malformed context
      // is rejected there and the job keeps no matchContext (never a bad record).
      await deps.patchJob(
        deps.jobId,
        evidenceValue
          ? { matchContext: published, matchContextEvidence: evidenceValue }
          : { matchContext: published }
      );
      const status = result?.evidenceStatus;
      log(
        `[match-context:${deps.jobId}] persisted at ${progressPct}%: ` +
          published.teams.map((t) => `${t.side}=${t.name}@${t.confidence.toFixed(2)}`).join(" ") +
          ` ambiguous=${published.ambiguous} sources=${((evidenceValue?.sources as string[] | undefined) ?? (status?.sources as string[] | undefined) ?? []).join(",")}`
      );
    } catch (e: any) {
      // E3 failure isolation: the evidence field must never take the primary
      // matchContext contract down. Retry ONCE with the context alone — the
      // evidence is an explainability marker, not the record's purpose.
      if (!evidenceValue) {
        log(`[match-context:${deps.jobId}] persist failed: ${String(e?.message || e)}`);
        return;
      }
      log(
        `[match-context:${deps.jobId}] combined persist rejected (${String(e?.message || e)}) — ` +
          `retrying with matchContext only`
      );
      try {
        await deps.patchJob(deps.jobId, { matchContext: published });
      } catch (e2: any) {
        log(`[match-context:${deps.jobId}] persist failed: ${String(e2?.message || e2)}`);
      }
    }
  };

  const start = (checkpoint: number) => {
    if (fired.has(checkpoint)) return;
    fired.add(checkpoint);
    // ADAAAA-7861: one line per checkpoint so a dropped re-check is visible in
    // the job log (before this, only a successful persist ever logged).
    log(
      `[match-context:${deps.jobId}] re-check queued at ${checkpoint}% (session ${
        deps.getSessionId ? deps.getSessionId() : deps.sessionId
      })`
    );
    queue.push(checkpoint);
    pump();
  };

  const pump = () => {
    while (inflight < MAX_INFLIGHT_RESOLVES && queue.length) {
      const checkpoint = queue.shift() as number;
      inflight++;
      const p = resolveOnce(checkpoint)
        .catch(() => {})
        .finally(() => {
          inflight--;
          pump();
        });
      pending.push(p);
    }
  };

  return {
    begin() {
      // Fire the transcription probe immediately: it runs on CPU in parallel
      // with frame extraction, which is what keeps the wall-clock delta inside
      // the +3% budget.
      void probe();
    },
    onProgress(pct: number) {
      for (const checkpoint of MATCH_CONTEXT_RECHECKS) {
        if (pct >= checkpoint) start(checkpoint);
      }
    },
    async finish() {
      // Never starts a new resolve here: the perceive session may already be
      // closed by analyzeJob's finally, and a late call would answer with no
      // session evidence. The 50% checkpoint always fires inside the loop.
      // Drain the serialized queue as well: a checkpoint queued behind an
      // in-flight resolve is still launched by pump(), so awaiting only the
      // snapshot of `pending` would leave the final checkpoint unresolved.
      while (queue.length > 0 || inflight > 0) {
        await Promise.all(pending.slice());
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ADAAAA-8408 (W2 actor grounding): the LIVE rail's writer.
//
// Measured on the phase-C legs (ADAAAA-8359): `matchContext` was `{}` on 5/5
// graded live legs, so the decide prompt carried no team to ground a caption or
// a deterministic title subject on, and 173/255 titles opened on a bare role
// word. The read path was never the problem — both live rails already forward
// `store.getJob(id)?.matchContext` per window (api.ts) and the analyzer omits
// the whole key when it holds nothing usable (`toDecideMatchContext`). Nothing
// WROTE it on the live rail: `createVodMatchContextResolver` above owns a file
// plus one bounded ffmpeg/ASR probe, neither of which exists for a stream.
//
// The live rail already holds the evidence the fold needs:
//
// - commentary: the per-window ASR prefetch transcript (`asr-prefetch.ts`, the
//   lane 95-97 % of stored live rows already used) — accumulated here, bounded;
// - scorebug OCR lines, kit samples and scoreboard swatches: perceive session
//   state. `POST /app/match-context` fills them from the session when the body
//   omits them, so the writer posts no OCR and samples nothing itself.
//
// So this writer adds NO ASR probe, NO OCR call, NO decide call and NO GPU
// work: it forwards the transcript it was handed to the same CPU-only fold the
// VOD rail uses, on a bounded schedule, single-flight, off the decide path.
// Measured cost of a populated context on the live (compact) prompt: +123 tokens
// per window for two teams (capped at ~176 by `MAX_BLOCK_CHARS` in
// `match_context_prompt.py`) and ~+36 ms prefill on a ~2.2 s decide — zero added
// inferences (design doc §2, artifact on ADAAAA-8408).
//
// Schedule: content seconds since the run's first observed window, not percent.
// A live run has no known length (a stream ends when the operator stops it), so
// a percentage checkpoint would either fire below its threshold on a long stream
// or never fire on a short one. Four fixed folds cover a 300 s leg at
// 0/20/40/80 % — the coverage the $0 replay measured at 75-76 % of emitted rows
// (85-86 % with eight) — and stop growing on an hours-long stream, where the
// first fold is the one that matters (context is needed EARLY).
// ---------------------------------------------------------------------------

/** Fold schedule for the live rail, in content seconds from the run's first
 *  observed window. Four folds per run, hard-bounded: a stream of any length
 *  never folds more than this. */
export const LIVE_MATCH_CONTEXT_FOLDS_S: readonly number[] = [0, 60, 120, 240];

/** Bound on the commentary carried into one live fold (the same 1 200 chars the
 *  $0 replay used, so the measured token cost holds). */
export const LIVE_MATCH_CONTEXT_MAX_TRANSCRIPT_CHARS = 1200;

export interface LiveMatchContextWriterDeps {
  jobId: string;
  /** Perceive fold proxy (`postMatchContext`), same contract as the VOD
   *  resolver: absent client => the writer is inert. */
  client: MatchContextClient;
  /** Read lazily: a live pass may re-reserve its perceive session mid-run
   *  (SessionLostError recovery), and a fold must post at the CURRENT one. */
  getSessionId: () => string;
  hints: { title?: string; gameHint?: string; filename?: string };
  getJob: (id: string) => Job | undefined;
  patchJob: (id: string, patch: Partial<Omit<Job, "id">>) => Promise<Job>;
  log?: (msg: string) => void;
  /** Test/QA seam: override the fold schedule (content seconds). */
  foldsAtS?: readonly number[];
  /** Test/QA seam: override the accumulated-transcript bound. */
  maxTranscriptChars?: number;
}

export interface LiveMatchContextWriter {
  /**
   * Call once per observe window, with the window's own transcript and its
   * content clock (`payload.centerTs`). Cheap and synchronous: it accumulates
   * commentary and, when the clock crosses a fold checkpoint, queues ONE fold.
   * Never awaited on the decide path.
   */
  noteWindow(input: { centerTs: number; transcript?: string }): void;
  /**
   * Await every already-fired fold. Never starts one: a fold that has not fired
   * by the last window would post at a session that may already be closed.
   */
  finish(): Promise<void>;
}

/**
 * ADAAAA-8736: the session a LIVE match-context fold must post to.
 *
 * The `browser` source runs two rails and they carry the perceive session in
 * DIFFERENT fields:
 *
 *  - the media-node share (`POST /jobs/:id/media` -> `bj.mediaSessionId`) relays
 *    every frame through the media node and never calls `/jobs/:id/ingest`, so
 *    `bj.sessionId` stays undefined and the record persists no
 *    `perceiveSessionId`;
 *  - the WS `/jobs/:id/ingest` rail reserves its own perceive session into
 *    `bj.sessionId` and has no media session.
 *
 * The fold target is the session perceive accumulated this share's scorebug OCR /
 * kit samples / frame seeds under, i.e. the session the rail itself passes to
 * `observeOnDecide` / `observeDecideOnly`. Reading only `bj.sessionId` +
 * `perceiveSessionId` (the pre-fix expression) therefore posted every browser
 * fold at session `""` and dropped it silently: measured 0/11 browser jobs with
 * a `matchContext` against 10/18 rtmp jobs on the same build (ADAAAA-8736).
 *
 * `bj.sessionId` keeps precedence so the ingest rail is untouched; the media
 * session is the added fallback; the persisted `perceiveSessionId` (the rtmp
 * shape) stays last.
 */
export function liveMatchContextSession(
  bj: { sessionId?: string; mediaSessionId?: string } | undefined | null,
  job?: { perceiveSessionId?: string } | undefined | null
): string {
  return bj?.sessionId || bj?.mediaSessionId || job?.perceiveSessionId || "";
}

/**
 * Build the live rail's once-per-run match-context writer.
 *
 * Wiring: constructed next to the live analyzer config (`ensureMediaRail` /
 * `runLiveJob` in api.ts) only when `matchContextEnabled()`, its hook is handed
 * to the analyzer as `onObserveWindowEvidence`, and `finish()` is awaited before
 * the job's terminal patch. Every write is best-effort: a fold failure leaves
 * the job without `matchContext` (pre-feature behaviour, byte-identical prompt)
 * and never fails the job or the decide.
 */
export function createLiveMatchContextWriter(deps: LiveMatchContextWriterDeps): LiveMatchContextWriter {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const folds = deps.foldsAtS ?? LIVE_MATCH_CONTEXT_FOLDS_S;
  const maxChars = deps.maxTranscriptChars ?? LIVE_MATCH_CONTEXT_MAX_TRANSCRIPT_CHARS;
  const lastFoldS = folds.length ? folds[folds.length - 1] : 0;
  let transcript = "";
  const fired = new Set<number>();
  const pending: Promise<void>[] = [];
  let inflight = 0;
  const queue: number[] = [];

  /** Elapsed share of the fold schedule. Live has no known run length, so this
   *  is an annotation for the persisted trail, never a claim about the run. */
  const progressFor = (checkpoint: number): number => {
    if (!lastFoldS) return 0;
    return Math.max(0, Math.min(100, Math.round((checkpoint / lastFoldS) * 100)));
  };

  const resolveOnce = async (checkpoint: number): Promise<void> => {
    if (!deps.client.postMatchContext) return;
    // ADAAAA-8736: a fold with no session would post at `""`, get a null back
    // and leave the record silently untouched (the browser-rail defect). Name it
    // in the log instead, so the next "job has no matchContext" grade has a
    // signal rather than a best-effort dead end.
    const sessionId = deps.getSessionId();
    if (!sessionId) {
      log(
        `[match-context:live:${deps.jobId}] no perceive session at ${checkpoint}s — fold skipped (matchContext stays as stored)`
      );
      return;
    }
    const job = deps.getJob(deps.jobId);
    const previous = job?.matchContext as MatchContext | undefined;
    const progressPct = progressFor(checkpoint);
    const body = {
      gameHint: deps.hints.gameHint || job?.gameHint || undefined,
      title: deps.hints.title || job?.title || undefined,
      filename: deps.hints.filename,
      // Perceive fills scorebug OCR / kit samples / swatches from the live
      // session when these are omitted — no extra OCR, no kit sampling here.
      transcript: transcript || undefined,
      previous,
      progressPct,
    };
    let result: { matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await deps.client.postMatchContext(sessionId, body);
        if (result?.matchContext) break;
      } catch (e: any) {
        log(`[match-context:live:${deps.jobId}] fold at ${checkpoint}s failed: ${String(e?.message || e)}`);
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
    }
    const ctx = result?.matchContext as MatchContext | undefined;
    if (!ctx) {
      log(
        `[match-context:live:${deps.jobId}] no contract at ${checkpoint}s (session ${deps.getSessionId()}) — keeping the stored context`
      );
      return;
    }
    // Monotonic guard: a later fold cannot LOWER a name/confidence the record
    // already earned nor publish a below-floor name as unambiguous, and one kit
    // colour can never describe both sides (the VOD resolver's two gates).
    const evidence = toMatchContextEvidence(result?.evidenceStatus);
    const observedClusters = ((evidence.value as MatchContextEvidence | undefined)?.kitClusterColors ?? []) as string[];
    const guarded = guardMatchContextRegression(previous, ctx, observedClusters);
    const published = collapseDuplicateKitColors(guarded, progressPct);
    // Folds accumulate over ONE session, so the evidence record is a running
    // high-water union rather than a per-pass snapshot (identical to the VOD
    // resume merge — the persisted record is the durable accumulator).
    const previousEvidence = job?.matchContextEvidence as MatchContextEvidence | undefined;
    const evidenceValue = evidence.value
      ? mergeMatchContextEvidence(previousEvidence, evidence.value)
      : previousEvidence;
    if (evidence.error) {
      log(
        `[match-context:live:${deps.jobId}] evidence status rejected at ${checkpoint}s (${evidence.error}) — ` +
          `persisting matchContext only`
      );
    }
    try {
      await deps.patchJob(
        deps.jobId,
        evidenceValue
          ? { matchContext: published, matchContextEvidence: evidenceValue }
          : { matchContext: published }
      );
      log(
        `[match-context:live:${deps.jobId}] persisted at ${checkpoint}s: ` +
          (published.teams.map((t) => `${t.side}=${t.name}@${Number(t.confidence).toFixed(2)}`).join(" ") || "none") +
          ` ambiguous=${published.ambiguous} sources=${(evidenceValue?.sources ?? []).join(",") || "none"}`
      );
    } catch (e: any) {
      if (!evidenceValue) {
        log(`[match-context:live:${deps.jobId}] persist failed: ${String(e?.message || e)}`);
        return;
      }
      log(
        `[match-context:live:${deps.jobId}] combined persist rejected (${String(e?.message || e)}) — ` +
          `retrying with matchContext only`
      );
      try {
        await deps.patchJob(deps.jobId, { matchContext: published });
      } catch (e2: any) {
        log(`[match-context:live:${deps.jobId}] persist failed: ${String(e2?.message || e2)}`);
      }
    }
  };

  const pump = () => {
    while (inflight < MAX_INFLIGHT_RESOLVES && queue.length) {
      const checkpoint = queue.shift() as number;
      inflight++;
      const p = resolveOnce(checkpoint)
        .catch(() => {})
        .finally(() => {
          inflight--;
          pump();
        });
      pending.push(p);
    }
  };

  const start = (checkpoint: number) => {
    if (fired.has(checkpoint)) return;
    fired.add(checkpoint);
    queue.push(checkpoint);
    pump();
  };

  return {
    noteWindow({ centerTs, transcript: windowText }) {
      const text = typeof windowText === "string" ? windowText.trim() : "";
      if (text) {
        transcript = (transcript ? `${transcript} ${text}` : text).slice(-maxChars);
      }
      const at = Number(centerTs);
      if (!Number.isFinite(at) || at < 0) return;
      for (const checkpoint of folds) {
        if (at >= checkpoint) start(checkpoint);
      }
    },
    async finish() {
      while (queue.length > 0 || inflight > 0) {
        await Promise.all(pending.slice());
      }
    },
  };
}
