// Client for the composite Job-detail payload (ADAAAA-6851 Inc 3:
// GET /jobs/:id/detail). The backend returns { job, highlights, traces,
// sections, maxTraces } with frames grouped into fixed 3 s sections (section
// index = floor(timestamp/3)) and decide notes attached to the section that
// contains their trigger timestamp. Image bytes stay lazy (metadata only here);
// the detail view loads each frame via its `uri` (auth-fetched as a blob).
//
// Types are mirrored locally (NOT imported from @highlights/events) so the
// webapp stays self-contained and compiles against any backend state. They are
// additive-only, so no contract version bump.
import { api, type HighlightTrigger } from "./api";

export type BBox = [number, number, number, number]; // [x1,y1,x2,y2] normalized 0..1

export interface TrackObservation {
  trackId: string;
  slot: number;
  bbox: BBox;
  kind: string;
  label?: string;
  lostFrames: number;
  selected?: boolean;
  onScreen?: boolean;
  ontoFrames?: number;
  accuracy?: number;
}

// ADAAAA-7156 Increment B / ADAAAA-7157 Increment C: the per-window LLM analysis
// payload (exactly what the decide LLM was fed + what it returned) + the
// Stage-2 confirm (deep-dive) record, mirrored locally from
// @highlights/events (WindowAnalysis / ConfirmRecord). Additive + optional —
// absent on legacy decide notes that predate the capture.
export interface AnalysisDataItem {
  type: string;
  label: string;
  value?: string | number | boolean | null;
}
export interface AnalysisMediaRef {
  seq: number;
  uri: string;
}
export interface AnalysisAudio {
  uri?: string;
  sampleRate?: number;
  path?: "input_audio" | "asr_text" | "none";
}
export interface AnalysisAsr {
  transcript?: string;
  url?: string;
  latencyS?: number;
}
/** One per-chunk audio energy-vs-baseline inspection point (ADAAAA-7255):
 * ``t`` seconds over the stream, ``energy`` and ``baseline`` both 0..1. */
export interface AudioSeriesPoint {
  t: number;
  energy: number;
  baseline: number;
}
export interface AnalysisResponse {
  isHighlight?: boolean;
  score?: number;
  eventType?: string;
  reason?: string;
  outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
  nearMiss?: boolean;
  reasoning?: string;
  verdict?: unknown;
  evidenceAttested: string[];
  audioContext?: unknown;
  runningSummary?: string;
  source?: string;
}
/** Per-window capture of exactly what was fed to the decide LLM + what it returned. */
export interface WindowAnalysis {
  prompt: string;
  dataItems: AnalysisDataItem[];
  frames: AnalysisMediaRef[];
  images: AnalysisMediaRef[];
  audio?: AnalysisAudio;
  asr?: AnalysisAsr;
  response?: AnalysisResponse;
  // ADAAAA-7255: the bounded per-chunk (t, energy, baseline) audio-gate series
  // for this window, for the energy-vs-baseline graph. Absent when the audio tap
  // produced nothing for the window.
  audioSeries?: AudioSeriesPoint[];
}
export interface ConfirmRequest {
  prompt: string;
  dataItems: AnalysisDataItem[];
  frames: AnalysisMediaRef[];
  keyframes: AnalysisMediaRef[];
  trajectories: string[];
  opticalFlowMagnitude?: number;
  audioLevels: number[];
  transcript?: string;
  stage1?: unknown;
}
export interface ConfirmDecisionBlock {
  enabled?: boolean;
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal" | null;
  confidence?: number;
  reason?: string;
  evidence?: unknown;
  stage1Disagreed?: boolean;
  outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
}
/** Stage-2 confirmation-pass record (request context + ConfirmDecision). */
export interface ConfirmRecord {
  request: ConfirmRequest;
  decision: ConfirmDecisionBlock;
}

/** A decide-LLM note anchored to its trigger timestamp (ADAAAA-6851 Inc 2). */
export interface DecideNote {
  seq: number;
  timestamp: number;
  eventType: string;
  score: number;
  outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
  nearMiss?: boolean;
  isHighlight: boolean;
  status: "accepted" | "suppressed" | "rejected";
  reason?: string;
  // ADAAAA-7156 Increment B: the per-window LLM analysis (prompt / dataItems /
  // media refs / full response) + the Stage-2 confirm (deep-dive) record for
  // this section's decide note. Additive optional — absent on legacy notes
  // without a capture (the UI renders an explicit "not captured" state).
  analysis?: WindowAnalysis;
  confirm?: ConfirmRecord;
}

/**
 * One entry in the append-only per-pass summary time log (ADAAAA-7466). Each
 * cadence decide pass appends a new entry; past entries are never overwritten,
 * dropped, or reordered. `ts` is the wall-clock time the entry was appended;
 * `windowTs` (when known) is the video timestamp (seconds) of the summarize
 * window / observe tick it maps to. Mirrors `SummaryLogEntrySchema` in
 * @highlights/events. Additive optional — absent on jobs that predate it.
 */
export interface SummaryLogEntry {
  seq: number;
  ts: string;
  windowTs?: number;
  text: string;
}

/**
 * ADAAAA-7623: the summary LADDER — the high-level layer above the flat
 * per-window `summaryLog`, derived server-side at read time from STORED rows
 * only (`services/server/src/summary-ladder.ts`). Mirrored locally from
 * `SummaryLadderSchema` in @highlights/events; additive + optional, so legacy
 * jobs without a ladder render exactly as before.
 *
 * Rungs, broadest first: match summary -> chapters -> window narratives
 * (a chapter's `entries`) -> the existing Analysis windows (frame/decide audit).
 */
export interface SummaryChapterGoal {
  index: number;
  ts: number;
  verified: boolean;
}

export interface SummaryChapter {
  index: number;
  kind: "build-up" | "goal-cluster" | "lull" | "phase";
  title: string;
  startS: number;
  endS: number;
  /** One-line chapter rollup (the rung-2 text). */
  summary: string;
  goalCount: number;
  goals: SummaryChapterGoal[];
  seqFrom: number;
  seqTo: number;
  /** The window narratives this chapter covers, in time order. */
  entries: { seq: number; windowTs: number; text: string }[];
}

export interface MatchSummary {
  text: string;
  charCount: number;
  chapterCount: number;
  goalCount: number;
  verifiedGoalCount: number;
  goalTimeline: SummaryChapterGoal[];
  /** Scoreboard strings the fact gate refused to emit (audit trail). */
  refusedScoreClaims: string[];
}

export interface SummaryLadder {
  chapters: SummaryChapter[];
  matchSummary: MatchSummary;
  derivedFrom: { summaryLogEntries: number; acceptedHighlights: number };
}

/** Stage-A (audio noise-change gate) counters (ADAAAA-7624). Mirrors
 * `StageAMetricsSnapshotSchema` in @highlights/events. Present only when
 * `stageAMetricsStatus === "measured"`. */
export interface StageAMetricsSnapshot {
  totalCandidates: number;
  accepted: number;
  rejected: number;
  fpRate: number;
  meanOnsetLatencyS: number;
  maxOnsetLatencyS: number;
  p50LatencyS?: number;
  p95LatencyS?: number;
  fpRateWithinBudget?: boolean;
}

/** Metadata for one frame in a section (image bytes stay lazy via `uri`). */
export interface JobDetailFrame {
  seq: number;
  timestamp: number;
  uri: string;
  tracks: TrackObservation[];
}

/** A fixed 3 s bucket of frames + the decide notes whose trigger falls in it. */
export interface FrameSection {
  index: number;
  startS: number;
  endS: number;
  frames: JobDetailFrame[];
  decideNotes: DecideNote[];
}

/** One aggregated tracked-object identity for a job. */
export interface JobTrace {
  trackId: string;
  slot: number;
  kind: string;
  label?: string;
  onScreen: number;
  ontoFrames?: number;
  lostFrames?: number;
  accuracy?: number;
  selected?: boolean;
}

export interface JobDetailHighlight {
  id: string;
  jobId: string;
  clipUri: string;
  start: number;
  end: number;
  eventType?: string;
  score: number;
  reason?: string;
  outcome?: string;
  nearMiss?: boolean;
  status: string;
  clipError?: string;
  // ADAAAA-7248: whether the source this highlight's clip was cut from carried
  // an audio stream. `false` => silent clip (source had no audio track); the
  // card shows an explicit "no audio captured" state. Absent when unknown.
  hasAudio?: boolean;
  // ADAAAA-7248: ASR transcript surfaced on the card for corroboration.
  asrTranscript?: string;
  createdAt: string;
  // ADAAAA-7622: the deterministic localized highlight instant (seconds from
  // stream start) the delivered clip is centered on, plus the signal that
  // produced it. Declared here so the posting caption can seed from the
  // summary-log window at that instant. Additive optional — legacy rows carry
  // neither (mirrors HighlightRecordSchema in @highlights/events).
  localizedTs?: number;
  localizeSignal?: "peak_frame" | "peak_audio" | "trigger";
  // ADAAAA-6798 Inc 2: link to the JobCandidate that started this highlight and
  // the de-normalized trigger metadata (kind + timestamp + eventType) so the
  // detail can show "what trigger started this". Absent on legacy rows without
  // a candidate — those degrade to "trigger unknown".
  candidateId?: string;
  trigger?: HighlightTrigger;
  // ADAAAA-7621: overlap dedupe of the postable list. The winning clip of a
  // merged moment carries `duplicateCount` (clips folded into it) plus
  // `mergedIds`; a folded-away clip — returned in `duplicateHighlights`, never
  // in the postable list — carries `duplicateOf` = the id of the moment that
  // owns the footage. Absent on legacy rows and single-clip moments.
  duplicateOf?: string;
  duplicateCount?: number;
  mergedIds?: string[];
}

export interface JobDetail {
  job: {
    id: string;
    ownerId?: string;
    source: string;
    sourceUrl?: string;
    gameHint?: string;
    preferLabels?: string[];
    // ADAAAA-6989: VOD jobs are NOT just queued/active during processing. The
    // server (runVodJob) persists distinct processing stages as the job status —
    // `extracting` → `analyzing` → `finalizing` — before `done`/`failed`, and the
    // detail endpoint returns that raw status. Mirror the full events contract
    // (packages/events JobSchema) so every non-terminal stage keeps the poll +
    // SSE alive while the job is in flight.
    status:
      | "queued"
      | "active"
      | "extracting"
      | "analyzing"
      | "finalizing"
      | "done"
      | "failed"
      | "cancelled";
    error?: string;
    // ADAAAA-7700: machine-readable failure attribution (see packages/events).
    // A share that died with the media node is `media-session-lost`, NOT a user
    // stop — the detail header renders it as its own chip.
    failureReason?: "media-session-lost" | "server-restart" | "user-stop" | "pipeline-error";
    // Short human-readable job title (ADAAAA-6798 Inc 1); absent on legacy jobs
    // where the UI falls back to `<gameHint/source> · <n> highlights · <date>`.
    title?: string;
    // ADAAAA-7135 (Tier-1): the observe-loop running action narrative
    // ("watch + notes") that the continuous decide observer accumulates as the
    // video progresses — distinct from `candidates` (now confirmed highlights
    // only). Absent on jobs that never ran the observe cadence / older records.
    runningSummary?: string;
    summaryLog?: SummaryLogEntry[];
    sampleFps?: number;
    framesAnalyzed?: number;
    candidatesTriggered?: number;
    // ADAAAA-7624: which trigger path produced `candidatesTriggered`. `observe`
    // = the cadence decide observer that actually runs; `perceive_gate` = the
    // legacy perceive candidate trigger; `none` = no candidate path ran.
    candidatePath?: "observe" | "perceive_gate" | "none";
    // ADAAAA-7624: Stage-A audio-gate snapshot + whether it is a real
    // measurement. `n/a` (or an absent status on legacy rows) means the audio
    // gate judged nothing — the counters must render `n/a`, never `0`.
    stageAMetrics?: StageAMetricsSnapshot;
    stageAMetricsStatus?: "measured" | "n/a";
    decideCalls?: number;
    // ADAAAA-7854: server-derived clip counts. `postableHighlights` is the
    // canonical user-facing clip count (deduped postable moments) and always
    // equals `highlights.length` on this payload; `mergedHighlights` counts the
    // overlapping duplicates folded away; `rawHighlights` is the audit row total.
    rawHighlights?: number;
    postableHighlights?: number;
    mergedHighlights?: number;
    // ADAAAA-7664: a LIVE job records its decide invocations in the observe
    // snapshot (`observeMetrics.decideCalls`) rather than the job-level
    // `decideCalls` field, which only the VOD path wrote. The header must fall
    // back to it, else a live job with N real decides renders `0`.
    observeMetrics?: { decideCalls?: number };
    perceiveSessionS?: number;
    costUsd?: number;
    durationMs?: number;
    scheduledAt?: string;
    completedAt?: string;
    progress?: number;
    progressLabel?: string;
    createdAt: string;
  };
  highlights: JobDetailHighlight[];
  /** ADAAAA-7621: "notable, not a goal" lane — non-rejected near_miss /
   * big_play clips, which the precision gate keeps OUT of the postable list.
   * Absent on servers that predate the gate. */
  notableHighlights?: JobDetailHighlight[];
  /** ADAAAA-7621: clips the overlap dedupe folded into a moment that stays in
   * `highlights`; each carries `duplicateOf` = the owning moment's id. */
  duplicateHighlights?: JobDetailHighlight[];
  traces: JobTrace[];
  sections: FrameSection[];
  /** Capacity budget the job ran under (3 live / 8 VOD). */
  maxTraces: number;
  // ADAAAA-7623: the high-level summary ladder (match summary + chapters +
  // their window narratives). Absent on jobs that predate the derivation or
  // carry no stored `summaryLog`.
  summaryLadder?: SummaryLadder;
  // ADAAAA-7741: the customer-facing "how live is this" projection derived at
  // read time from stored data. Mirrors LiveProgressSchema in @highlights/events
  // — additive optional, absent on servers that predate it.
  liveProgress?: LiveProgress;
  // ADAAAA-7750: WHY the window list is empty, when it is — derived read-time
  // from stored counters. Additive optional, absent on servers that predate it.
  capture?: LiveCapture;
}

/** ADAAAA-7750: capture-state projection for a zero-window job. Mirrors
 * LiveCaptureSchema in @highlights/events. `cause`/`action` are the customer
 * copy; the counters are the same ones the job page already renders. */
export interface LiveCapture {
  state:
    | "connecting"
    | "waiting_first_window"
    | "capturing"
    | "interrupted"
    | "no_capture"
    | "no_highlights"
    | "unknown";
  frames: number;
  windows: number;
  highlights: number;
  firstWindowInS: number | null;
  cause: string | null;
  action: string | null;
  updatedAt: string;
}

/** ADAAAA-7741: processing-lag projection on GET /jobs/:id and
 * GET /jobs/:id/detail. It carries only the customer's own lag reading — never
 * `observeMetrics`, `costUsd`, `decideCalls` or `stageAMetrics`. */
export interface LiveProgress {
  /** Content seconds available at the tap. */
  liveEdgeTs: number;
  /** Content ts of the newest decided window. */
  processedThroughTs: number;
  /** liveEdgeTs - processedThroughTs, clamped >= 0. */
  lagSec: number;
  /** Cadence windows dropped past the lag budget on this run. */
  skippedWindows: number;
  /** `unknown` before the first decided window and on a terminal job. */
  state: "caught_up" | "behind" | "unknown";
  updatedAt: string;
}

/**
 * Human label for one summary-log entry's timestamp (ADAAAA-7466). Prefers the
 * video-relative `windowTs` (seconds into the stream, `T+Ns`) when known,
 * falling back to the wall-clock append time `ts` (HH:MM:SS, or the raw string
 * when unparseable). Deterministic across SSR + client so the growing-log
 * assertions are stable.
 */
export function summaryEntryTimestamp(e: SummaryLogEntry): string {
  // ADAAAA-7711: `windowTs` is a float whenever the observe window centre is
  // not a whole second (e.g. 11.666666666666666). The stored value keeps that
  // fidelity for the summary ladder; the time log rounds only for display so a
  // user never sees `T+11.666666666666666s`.
  if (e.windowTs !== undefined) return `T+${Math.round(e.windowTs)}s`;
  const d = new Date(e.ts);
  if (!Number.isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  return e.ts;
}

/** Fetch the composite job-detail payload for one job.
 *
 * ADAAAA-7838: `opts.inspect` adds `?inspect=1`, which is the ONLY way the
 * payload carries the per-window LLM capture (`analysis` / `confirm`). Without
 * it the response is measurably smaller and each decide note ships without its
 * internals; the page turns it on only while the owner asked for `See detail`.
 */
export async function fetchJobDetail(id: string, opts: { inspect?: boolean } = {}): Promise<JobDetail> {
  return api<JobDetail>(`/jobs/${id}/detail${opts.inspect ? "?inspect=1" : ""}`);
}

/**
 * ADAAAA-7742: the fixed bucket width the server partitions frames into
 * (`SECTION_WINDOW` in services/server/src/job-detail.ts). Section index =
 * floor(timestamp / SECTION_WINDOW_S), so the index is stable and monotonic and
 * an open live page can ask the server for "everything after bucket N" instead
 * of re-fetching the whole accumulated composite payload.
 */
export const SECTION_WINDOW_S = 3;

/**
 * ADAAAA-7742: the tail of an open job's composite detail — only the sections
 * after `afterIndex`, plus the small mutable companions the same page renders
 * (job status/summary, postable highlights, the summary ladder). This is the
 * incremental response of `/jobs/:id/sections-delta`; the composite
 * `/jobs/:id/detail` stays the contract for the initial load and for recovery
 * after a dropped SSE socket.
 */
export interface SectionsDelta {
  jobId: string;
  /** The bucket index the client asked to continue after (-1 = from the top). */
  afterIndex: number;
  /** Highest bucket index the server holds for this job (-1 when empty). */
  maxIndex: number;
  /** Total buckets the server holds (append-vs-replace audit). */
  sectionCount: number;
  sections: FrameSection[];
  job: JobDetail["job"];
  highlights: JobDetailHighlight[];
  notableHighlights?: JobDetailHighlight[];
  duplicateHighlights?: JobDetailHighlight[];
  maxTraces: number;
  summaryLadder?: SummaryLadder;
}

/**
 * Fetch only the sections an open live detail page does not already hold.
 * `afterIndex = -1` returns the whole section list (used when the page has no
 * baseline yet); any other value returns buckets strictly greater than it.
 *
 * ADAAAA-7838: `opts.inspect` adds `&inspect=1` so an open live page keeps
 * streaming per-window internals only while `See detail` is on — turning the
 * toggle off makes the NEXT poll omit the flag (and the internals with it).
 */
export async function fetchSectionsDelta(
  id: string,
  afterIndex: number,
  opts: { inspect?: boolean } = {}
): Promise<SectionsDelta> {
  const after = Number.isInteger(afterIndex) && afterIndex >= 0 ? afterIndex : -1;
  return api<SectionsDelta>(`/jobs/${id}/sections-delta?afterIndex=${after}${opts.inspect ? "&inspect=1" : ""}`);
}

/**
 * ADAAAA-7838: one window's inspection detail — its decide notes WITH the full
 * per-window capture (`analysis` prompt/dataItems/media/response/audioSeries and
 * the Stage-2 `confirm` record), keyed by the 3 s bucket index. This is the lazy
 * read behind the per-row `Inspect` button: one request per window the owner
 * opens, instead of the whole accumulated payload.
 */
export interface SectionInspect {
  jobId: string;
  /** The 3 s bucket index this window covers (the client key). */
  index: number;
  startS: number;
  endS: number;
  decideNotes: DecideNote[];
}

/** Fetch the inspection detail for exactly one Analysis window (bucket index). */
export async function fetchSectionInspect(id: string, index: number): Promise<SectionInspect> {
  return api<SectionInspect>(`/jobs/${id}/sections/${index}/inspect`);
}

/**
 * Merge a sections-delta into the sections already rendered. Buckets keep their
 * 3 s order, an incoming bucket REPLACES the stale copy with the same index (the
 * server re-sends the tail bucket so a decide note that landed into it still
 * shows), and every bucket the client already had but the delta did not return
 * is left untouched. Keyed by bucket index, so the frame partition invariant
 * (each frame seq in exactly one bucket) still holds afterwards.
 */
export function mergeSections(existing: FrameSection[], incoming: FrameSection[]): FrameSection[] {
  if (!incoming.length) return existing;
  const byIndex = new Map<number, FrameSection>();
  for (const s of existing) byIndex.set(s.index, s);
  for (const s of incoming) byIndex.set(s.index, s);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * `M:SS` clock for a ladder timestamp (seconds into the match). Rounds down so
 * a chapter boundary and the goal it contains never disagree about the minute.
 */
export function ladderClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Human label for a chapter kind. */
export function chapterKindLabel(kind: SummaryChapter["kind"]): string {
  switch (kind) {
    case "goal-cluster":
      return "Goal cluster";
    case "build-up":
      return "Build-up";
    case "lull":
      return "Lull";
    case "phase":
      return "Phase";
  }
}

/**
 * Detail-on-demand hop: the Analysis window that covers a ladder entry.
 * Job-detail sections are fixed 3 s buckets (`index = floor(timestamp / 3)`),
 * so a window narrative at `windowTs` drills into `floor(windowTs / 3)`, which
 * carries the frames + decide-note audit for that same instant.
 */
export function ladderSectionIndex(windowTs: number): number {
  return Math.max(0, Math.floor(windowTs / 3));
}

/**
 * Drill-down hop (used by the job page): scroll the Analysis window that covers
 * `sectionIndex` into view and flash a ring on it, so the frame/decide-audit
 * panel for that instant is unmistakable.
 *
 * Instant, not smooth: the Analysis list is >100k px tall on a 260-window job
 * and an rAF-driven smooth animation is suspended in a background tab (it
 * silently scrolls nowhere — measured on the live `d61e52f6` page).
 */
export function focusAnalysisWindow(
  root: Pick<Document, "querySelector">,
  sectionIndex: number,
  flashMs = 1600
): HTMLElement | null {
  const el = root.querySelector<HTMLElement>(`[data-analysis-window][data-section-index="${sectionIndex}"]`);
  if (!el) return null;
  el.scrollIntoView({ block: "center" });
  el.classList.add("ring-2", "ring-neon");
  if (flashMs > 0 && typeof window !== "undefined") {
    window.setTimeout(() => el.classList.remove("ring-2", "ring-neon"), flashMs);
  }
  return el;
}

/**
 * True while a job still has background work outstanding (not terminal).
 *
 * ADAAAA-6989: the server persists distinct VOD processing stages as the job
 * status (`extracting` → `analyzing` → `finalizing`) between `active` and
 * `done`. A job in any of those stages is still in flight — the detail view
 * must keep its SSE subscription + 5s reconciling poll alive so progress and
 * the eventual terminal status render without a manual refresh. Only the
 * terminal states (`done`, `failed`) stop the poll/SSE. `undefined` (legacy /
 * missing status) is treated as not in flight.
 */
export function isJobInFlight(status: string | undefined): boolean {
  return (
    status === "queued" ||
    status === "active" ||
    status === "extracting" ||
    status === "analyzing" ||
    status === "finalizing"
  );
}

/**
 * Partition invariant (plan §6 Inc 4/5): every frame's `seq` must appear in
 * exactly one 3 s section — no frame duplicated across sections and none
 * missing. `sections` is the server-side partition, but the webapp re-asserts
 * it so a rendering bug (or an overlapping backend partition) can never show a
 * frame twice. Returns the verdict plus the offending seqs for a clean report.
 */
export function assertFramePartition(
  sections: FrameSection[]
): { ok: boolean; duplicates: number[]; missingFromAny: number[]; total: number } {
  const seen = new Map<number, number>();
  for (const s of sections) {
    for (const f of s.frames) {
      seen.set(f.seq, (seen.get(f.seq) ?? 0) + 1);
    }
  }
  const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([seq]) => seq);
  // A seq must belong to the section whose index is floor(timestamp/3); a frame
  // placed in a section inconsistent with its timestamp is counted too.
  const misplaced: number[] = [];
  for (const s of sections) {
    for (const f of s.frames) {
      const expected = Math.floor(f.timestamp / 3);
      if (expected !== s.index) misplaced.push(f.seq);
    }
  }
  const duplicatesAll = [...new Set([...duplicates, ...misplaced])];
  return {
    ok: duplicatesAll.length === 0,
    duplicates: duplicatesAll,
    missingFromAny: [],
    total: seen.size,
  };
}

/** Count of frames across all sections (the "frames visible" metric). */
export function sectionFrameCount(sections: FrameSection[]): number {
  return sections.reduce((n, s) => n + s.frames.length, 0);
}

/**
 * Header candidate-count label (ADAAAA-7624). Returns the count the path that
 * actually ran produced, or `n/a` when the record carries no count at all
 * (legacy row) — never a fabricated `0` for "not recorded".
 */
export function candidateCountLabel(job: { candidatesTriggered?: number }): string {
  if (job.candidatesTriggered === undefined || job.candidatesTriggered === null) return "n/a";
  return String(job.candidatesTriggered);
}

/**
 * Audio Stage-A counter label (ADAAAA-7624). The audio noise-change gate is not
 * the path that runs on the observe pipeline (ADAAAA-7007/7008), so its
 * counters must read `n/a` rather than `0` unless the job carries a MEASURED
 * snapshot (`stageAMetricsStatus: "measured"` with at least one judged
 * candidate). Legacy rows have no status -> `n/a`.
 */
export function stageACountLabel(job: {
  stageAMetrics?: StageAMetricsSnapshot;
  stageAMetricsStatus?: "measured" | "n/a";
}): string {
  const m = job.stageAMetrics;
  if (job.stageAMetricsStatus !== "measured" || !m) return "n/a";
  const total = m.totalCandidates ?? 0;
  if (total === 0) return "n/a";
  const fpPct = Math.round((m.fpRate ?? 0) * 1000) / 10;
  return `${total} judged · ${fpPct}% FP`;
}

export function sectionLabel(s: FrameSection): string {
  return `T+${s.startS.toFixed(0)}s – T+${s.endS.toFixed(0)}s`;
}

/**
 * Decide-call count for a job header/tile (ADAAAA-7664).
 *
 * The two paths record the count in different places: the VOD pass writes the
 * job-level `decideCalls`, the LIVE observe pass writes
 * `observeMetrics.decideCalls`. Reading only `job.decideCalls` made a live job
 * with 17 real decides (and 16 decide-audit rows) render "Decide calls 0".
 * Prefer the job-level field, then the observe snapshot, and fall back to 0 only
 * when neither is recorded (a job that never ran a decide pass).
 */
export function decideCallsCount(job: {
  decideCalls?: number | null;
  observeMetrics?: { decideCalls?: number | null } | null;
}): number {
  if (typeof job.decideCalls === "number" && Number.isFinite(job.decideCalls)) return job.decideCalls;
  const observed = job.observeMetrics?.decideCalls;
  if (typeof observed === "number" && Number.isFinite(observed)) return observed;
  return 0;
}

/**
 * The three Analysis filter/window types the board asked for
 * (ADAAAA-7274): a decide-note window classifies as a `highlight`, a
 * `suppressed` (candidate gated off but logged), or `not_highlight`. These
 * drive the Analysis section filter chips and the color-coded collapsed
 * summary.
 */
export type NoteKind = "highlight" | "suppressed" | "not_highlight";

/** Human label for a window type (used by the filter chips + collapsed lines). */
export function noteKindLabel(kind: NoteKind): string {
  switch (kind) {
    case "highlight":
      return "highlight";
    case "suppressed":
      return "suppressed";
    case "not_highlight":
      return "not highlight";
  }
}

/**
 * Classify one decide note into an Analysis window type. A note whose outcome is
 * `not_highlight` (or whose `isHighlight` is false) is `not_highlight`; a note
 * that was gated off (`status === "suppressed"`) is `suppressed`; anything else
 * (accepted / rejected highlight) counts as a `highlight`. This is the single
 * source of truth for the collapsible summary + filter so both stay in lockstep.
 */
export function noteKind(note: DecideNote): NoteKind {
  if (note.outcome === "not_highlight" || note.isHighlight === false) return "not_highlight";
  if (note.status === "suppressed") return "suppressed";
  return "highlight";
}

/**
 * Short single-line summary of one decide note — the text shown in the
 * collapsed time-window summary (type · score · status, plus the reason) so an
 * operator can scan windows without expanding them.
 */
export function noteSummaryText(note: DecideNote): string {
  const bits = [note.eventType || "event", `${Math.round(note.score)}`, note.status];
  if (note.outcome && note.outcome !== "not_highlight") bits.push(note.outcome);
  return bits.join(" · ") + (note.reason ? ` — ${note.reason}` : "");
}

/**
 * The collapsed summary text for one time window (frame section): the window's
 * time range + each decide note's summary line. A window with no decide notes
 * reads as having no analysis.
 */
export function sectionSummaryText(s: FrameSection): string {
  if (s.decideNotes.length === 0) return `${sectionLabel(s)} — no analysis`;
  return `${sectionLabel(s)} · ${s.decideNotes.map(noteSummaryText).join(" | ")}`;
}

/**
 * Whether a window has at least one decide note matching any active filter
 * type. An empty `active` set (no filter applied) matches every window; a
 * window with no decide notes matches nothing once a filter is applied.
 */
export function sectionMatchesFilter(s: FrameSection, active: NoteKind[]): boolean {
  if (active.length === 0) return true;
  return s.decideNotes.some((n) => active.includes(noteKind(n)));
}

/**
 * Whether a window's summary text matches a search query (case-insensitive,
 * trimmed). An empty query matches every window. Used by the Analysis search
 * bar to filter windows by their text content.
 */
export function sectionMatchesSearch(s: FrameSection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return sectionSummaryText(s).toLowerCase().includes(q);
}

/** The Analysis window types in canonical display order (filter chip order). */
export const NOTE_KINDS: NoteKind[] = ["highlight", "suppressed", "not_highlight"];

/**
 * The distinct window types present in one time window (frame section), in
 * canonical order. A window holding multiple decide notes of different kinds
 * shows all of their type marks, so the collapsed summary still communicates
 * every type in the window at a glance.
 */
export function sectionKinds(s: FrameSection): NoteKind[] {
  const set = new Set<NoteKind>();
  for (const n of s.decideNotes) set.add(noteKind(n));
  return NOTE_KINDS.filter((k) => set.has(k));
}

/** Combine the type filter + text search for one window (single source for the
 *  Analysis list so both controls stay in lockstep). */
export function sectionMatches(s: FrameSection, active: NoteKind[], query: string): boolean {
  return sectionMatchesFilter(s, active) && sectionMatchesSearch(s, query);
}

/**
 * Human label for the trigger that started an analysis (ADAAAA-6798 Inc 2),
 * e.g. `audio burst @ T+12.4s · KILL`. Absent/null on legacy rows without a
 * persisted candidate → `trigger unknown`.
 */
export function triggerLabel(trigger: HighlightTrigger | undefined): string {
  if (!trigger) return "trigger unknown";
  const kind = trigger.kind.replace(/_/g, " ");
  const where = ` @ T+${trigger.timestamp.toFixed(1)}s`;
  const what = trigger.eventType ? ` · ${trigger.eventType}` : "";
  return `${kind}${where}${what}`;
}

/**
 * Resolve a lazy analysis media ref to a fetchable frame URI. The decide layer
 * may leave `uri` empty (bytes not resolved at the decide layer); fall back to
 * the canonical job-detail frame delivery route so thumbnails still render
 * (ADAAAA-7157 Increment C).
 */
export function frameUriFor(ref: { seq: number; uri?: string }, jobId: string): string {
  if (ref.uri && ref.uri.length > 0) return ref.uri;
  return `/jobs/${jobId}/frames/${ref.seq}`;
}

/**
 * Human text for an analysis data item's value (null/undefined → "—", boolean →
 * yes/no, numbers as-is, strings verbatim). The UI renders each item's value as
 * a plain string so a malformed / absent value degrades to "—", never a crash.
 */
export function dataItemValueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * Stable label for a verdict tri-state (confirmed_goal / near_miss / not_goal)
 * used by the Stage-2 confirm pass. Null/absent → "not decided".
 */
export function goalConfirmedLabel(
  v: "confirmed_goal" | "near_miss" | "not_goal" | null | undefined
): string {
  switch (v) {
    case "confirmed_goal":
      return "confirmed goal";
    case "near_miss":
      return "near miss";
    case "not_goal":
      return "not a goal";
    case null:
      return "not decided (null)";
    default:
      return "not decided";
  }
}

/**
 * Lazy auth-fetched frame image as a blob object URL. `<img>` cannot send the
 * Authorization header, so the detail timeline loads each frame by hand (mirrors
 * the FrameDebugger filmstrip). Returns a revocable object URL (the caller must
 * revoke it on unmount).
 */
export async function authFetchFrame(uri: string, token: string | null): Promise<string> {
  const res = await fetch(uri, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`frame fetch failed: HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
