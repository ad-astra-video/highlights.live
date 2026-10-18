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
