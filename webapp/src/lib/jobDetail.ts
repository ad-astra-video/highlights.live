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
  // ADAAAA-6798 Inc 2: link to the JobCandidate that started this highlight and
  // the de-normalized trigger metadata (kind + timestamp + eventType) so the
  // detail can show "what trigger started this". Absent on legacy rows without
  // a candidate — those degrade to "trigger unknown".
  candidateId?: string;
  trigger?: HighlightTrigger;
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
    decideCalls?: number;
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
  traces: JobTrace[];
  sections: FrameSection[];
  /** Capacity budget the job ran under (3 live / 8 VOD). */
  maxTraces: number;
}

/**
 * Human label for one summary-log entry's timestamp (ADAAAA-7466). Prefers the
 * video-relative `windowTs` (seconds into the stream, `T+Ns`) when known,
 * falling back to the wall-clock append time `ts` (HH:MM:SS, or the raw string
 * when unparseable). Deterministic across SSR + client so the growing-log
 * assertions are stable.
 */
export function summaryEntryTimestamp(e: SummaryLogEntry): string {
  if (e.windowTs !== undefined) return `T+${e.windowTs}s`;
  const d = new Date(e.ts);
  if (!Number.isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  return e.ts;
}

/** Fetch the composite job-detail payload for one job. */
export async function fetchJobDetail(id: string): Promise<JobDetail> {
  return api<JobDetail>(`/jobs/${id}/detail`);
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

export function sectionLabel(s: FrameSection): string {
  return `T+${s.startS.toFixed(0)}s – T+${s.endS.toFixed(0)}s`;
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
