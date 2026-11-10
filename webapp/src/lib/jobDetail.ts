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
import type { ResumeView } from "./resume";

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
  /** The client never validates the wire, so this is `unknown` on purpose: a
   *  non-scalar value must be formatted (never `String()`-ed) and must never
   *  reach React as a bare child (ADAAAA-8187). */
  value?: unknown;
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

/**
 * ADAAAA-8287: which acceptance lane confirmed this window (mirrors
 * `WindowConfirmationSchema` in @highlights/events). Derived server-side at read
 * time from the stored candidate — two lanes accept a VOD highlight and only the
 * Stage-2 dive leaves a confirm panel, so a lane-1 (measured attestation) accept
 * used to be indistinguishable from an unconfirmed one.
 *
 * `label` is the row-body sentence. `flags` / `dive` are the inspector half
 * (`?inspect=1` / `/sections/:index/inspect`) and are absent from the default
 * payload.
 */
export type ConfirmationLane = "measured" | "dive" | "dive_disagreed" | "dive_held" | "unconfirmed";
export type ConfirmationMeasurement = "goal_line" | "ball_in_net" | "score" | "ball_outcome" | "dive" | "none";
export interface ConfirmationFlags {
  scoreboardChanged: boolean | null;
  ballCrossedLineBetweenPosts: boolean | null;
  ballInNet: boolean | null;
  crowdErupted: boolean | null;
}
export interface ConfirmationDive {
  goalConfirmed: "confirmed_goal" | "near_miss" | "not_goal" | null;
  confidence: number | null;
  stage1Disagreed: boolean | null;
  outcome: string | null;
  corroborated: boolean;
}
export interface WindowConfirmation {
  lane: ConfirmationLane;
  label: string;
  measurement: ConfirmationMeasurement;
  detail?: string;
  flags?: ConfirmationFlags;
  flagsSource?: "stage1_verdict" | "dive_evidence" | "trigger";
  dive?: ConfirmationDive;
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
  // ADAAAA-8287: the derived acceptance lane (lane + row-body label), so the
  // row itself can say whether a measured attestation or the Stage-2 dive
  // confirmed it. Inspector half (flags / dive) rides the inspect payload only.
  confirmation?: WindowConfirmation;
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

/**
 * ADAAAA-8419: a frame the live consume stride refused, as audit evidence for the
 * admin window view. Timestamp only — a skipped frame never had a stored image,
 * so it carries no `seq`/`uri`/`tracks` and never enters the enlarged gallery.
 */
export interface SkippedFrame {
  timestamp: number;
  reason: "stride";
}

/** A fixed 3 s bucket of frames + the decide notes whose trigger falls in it. */
export interface FrameSection {
  index: number;
  startS: number;
  endS: number;
  frames: JobDetailFrame[];
  decideNotes: DecideNote[];
  /** ADAAAA-8419: frames the consume stride refused inside `[startS, endS)`.
   *  Absent = no skip evidence for this window (unknown — never a fabricated 0). */
  skipped?: SkippedFrame[];
  /** ADAAAA-8419: skipped frames in the window BEFORE the per-section cap, so a
   *  trimmed audit can state `+N more` instead of hiding the remainder. */
  skippedTotal?: number;
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

/**
 * ADAAAA-7984: a celebration/replay clip delivered as an ALTERNATIVE of a goal
 * highlight (the clip that follows the goal — replay or celebration). It is not a
 * highlight: the payload groups it under its owning highlight
 * (`highlightId` + `relation: "alternative_of"`) and it never enters the postable
 * list or the notable lane. Mirrors HighlightAlternativeSchema in
 * `@highlights/events`.
 */
export interface JobDetailAlternative {
  id: string;
  jobId: string;
  highlightId: string;
  relation: "alternative_of";
  /** `celebration` or (ADAAAA-8321) `replay` — never `GOAL`. */
  eventType: string;
  /** Non-scoring verdict class (`big_play` / `near_miss`), never `scoring_play`. */
  outcome?: string;
  windowAnchorTs: number;
  distanceToGoalEndS?: number;
  score?: number;
  start: number;
  end: number;
  clipId?: string;
  clipUri: string;
  clipError?: string;
  dedupeKey?: string;
  createdAt: string;
  /** ADAAAA-8321: set on a replay alternative — the moment it repeats. */
  replayOf?: string;
  /** ADAAAA-8321: the detector's measured evidence behind the attach. */
  replayEvidence?: { kind: string; matches: number; compared: number; gapS: number; phase?: "live" | "replay" };
  /** ADAAAA-8325 (Inc 2): the alternative window's footage phase from the decide
   * verdict. Operator-facing provenance only. */
  phase?: "live" | "replay";
  /** ADAAAA-8321: the stored replay window this alternative came from. */
  sourceHighlightId?: string;
}

/**
 * ADAAAA-8422 (N1): a sibling clip of a notable moment — another STORED,
 * already-cut window of the same moment. Read-only on the card's clip rail in
 * P1: it plays and downloads its own footage, and it is not pickable (pick/serve
 * for a notable moment is the P2 follow-on). Mirrors NotableMomentClipSchema in
 * `@highlights/events`.
 */
export interface JobDetailSiblingClip {
  /** The sibling's own stored highlight row id. */
  id: string;
  start: number;
  end: number;
  clipUri: string;
  clipError?: string;
  /** Operator-only label; never customer copy. */
  eventType?: string;
  /** Per-caller export URL for THIS clip (playback stays `clipUri`). */
  exportUri?: string;
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
  // ADAAAA-7958 (contract v3 §3.4): the stored corroboration flag — `true` only
  // when an independent signal backed the scoring read — plus the Stage-2 confirm
  // verdict, which corroborates a goal in its own right. Together they are the
  // ladder banner's OWN `verified` rule, so a page that says "N accepted goals are
  // not corroborated ... counted, never asserted as scored" can never seed a
  // caption or title asserting one. Absent on legacy rows and on a job whose
  // confirm pass did not run.
  corroborated?: boolean;
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal" | null;
  status: string;
  clipError?: string;
  /** ADAAAA-7984: the celebration/replay clips delivered as alternatives OF this
   * highlight (grouped by the payload). Absent when none were delivered. */
  alternatives?: JobDetailAlternative[];
  /** ADAAAA-8422 (N1): the moment's other windows, offered read-only on the clip
   * rail (play/download each own clip). Absent on a single-window moment, which
   * renders no rail. Mirrors NotableMomentClipSchema in `@highlights/events`. */
  siblingClips?: JobDetailSiblingClip[];
  /** ADAAAA-8422 (N1): rows the moment holds (anchor-gap cluster; 1 = a lone
   * window). Lets a reader tell a rail-capped moment from a dropped row. */
  siblingCount?: number;
  /** ADAAAA-8321 (AC6): the alternative clip this moment SERVES. Absent = its
   * own original cut. The payload's `clipUri` already resolves the pick, so the
   * card, download and post all serve the chosen footage. */
  clipChoice?: { alternativeId: string; clipUri: string; start: number; end: number; chosenAt: string };
  // ADAAAA-7248: whether the source this highlight's clip was cut from carried
  // an audio stream. `false` => silent clip (source had no audio track); the
  // card shows an explicit "no audio captured" state. Absent when unknown.
  hasAudio?: boolean;
  // ADAAAA-7248: ASR transcript surfaced on the card for corroboration.
  asrTranscript?: string;
  // ADAAAA-7965 (contract v5 §3.5, R22): the STORED caption and card options for
  // this highlight, written by the gate at the write seam. The card renders them
  // byte-for-byte, so a read can never truncate, drop a colour clause or drop a
  // period on a string the gate approved. Absent on legacy/VOD rows, which keep
  // the derived render path.
  caption?: string;
  cardTitles?: string[];
  /** ADAAAA-8318 (ADAAAA-8302 Option 2): the card's COPY TARGET — the post title
   * the "Suggested caption" / "Use as caption" affordance carries, served by the
   * detail route on EVERY clip row (stored when the decide gate accepted the
   * model's title, deterministic `LABEL · m:ss · subject` otherwise). Absent on
   * payloads from a server that predates it, where the card derives the same
   * deterministic title from this row's stored facts. No `T+` prefix. */
  postTitle?: string;
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
  // ADAAAA-7896: export state stamp — set the first time the clip left the app.
  // The owner-facing Reject control is locked when it is present; an operator
  // (admin) keeps Reject and the transition records `rejectedAfterExport`.
  exportedAt?: string;
  exportedVia?: "download" | "copy_link" | "batch_zip" | "copy_urls";
  rejectedAfterExport?: boolean;
  // ADAAAA-7896: the server-minted EXPORT URL (clip path + per-highlight token).
  // The download anchor, the copy payload and the batch fetches use it so the
  // server can mark the clip as exported; `clipUri` stays the public playback
  // URL and never marks anything. Absent on servers that predate it (fall back
  // to `clipUri`).
  exportUri?: string;
  /** ADAAAA-8530: which lane confirmed this row's window, derived read-side by
   * the server from the row's own decide window (`measured | dive |
   * dive_disagreed | unconfirmed`) with the same sentence the decide note cites.
   * Absent when nothing could be derived — the card then reads UNCONFIRMED,
   * never a guessed lane. Drives the ONE badge the card carries. */
  confirmation?: HighlightConfirmation;
  // ADAAAA-8139 (interim step): a demoted LIVE goal window whose ASR / frames /
  // crowd reaction carried a goal cue but whose scoreboard change had not landed
  // when the window closed. The row stays a non-postable celebration and the
  // marker clears on the SAME row id when the deferred re-attestation confirms
  // the goal. Absent on legacy/VOD rows and on every attested goal.
  provisionalGoal?: {
    status: "provisional";
    cues: Array<"asr_goal_call" | "frame_celebration" | "crowd_reaction">;
    declaredTs: number;
    note: string;
  };
}

/**
 * ADAAAA-8425: the observe snapshot's skip split + decide ceiling, as persisted
 * on a job record (mirrors `ObserveMetricsSnapshotSchema` in @highlights/events).
 * Additive optional fields: a record written before a counter existed simply has
 * no value for it, and the audit renders that as "not measured" only when the
 * whole snapshot is absent.
 */
export interface ObserveSkipSplit {
  decideCalls?: number;
  /** Content was late past the lag budget (dropped, never decided late). */
  skippedStaleWindows?: number;
  /** This stream's own decide queue was full. */
  backpressureSkippedWindows?: number;
  /** Another live job held the box's decide slot. */
  admissionSkippedWindows?: number;
  /** The funded rate cap dropped the opportunity (a spend decision). */
  throttleSkippedWindows?: number;
  /** The RUNNER refused the decide (503 no capacity) — issued, never judged. */
  capacityDroppedWindows?: number;
  /** The SUPPLY total the customer chip shows (stale + backpressure + admission). */
  supplySkippedWindows?: number;
  /** The decide ceiling the job ran at, latched at job start (ADAAAA-8254/8262). */
  decideCapacity?: {
    advertised: number;
    funded: number;
    effective: number;
    probeOk?: boolean;
    runners?: number;
    source?: "probe" | "last-known" | "funded";
  };
}

/**
 * ADAAAA-8425: the admin window-audit readout (mirrors `WindowSkipAuditSchema`
 * in @highlights/events). Server-derived from the stored record; the payload
 * carries it for an admin caller only.
 */
export interface WindowSkipAudit {
  jobId: string;
  status: string;
  source: string;
  decideCalls: number;
  /** SUPPLY total = stale + backpressure + admission (the chip's number). */
  skippedWindows: number;
  staleSkippedWindows: number;
  backpressureSkippedWindows: number;
  admissionSkippedWindows: number;
  throttleSkippedWindows: number;
  /** NULL = the record predates the counter: "not recorded", not a measured 0. */
  capacityDroppedWindows: number | null;
  /** False = the record has no observe snapshot at all (counts not measured). */
  observeRecorded: boolean;
  decideCapacity: ObserveSkipSplit["decideCapacity"] | null;
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
    failureReason?:
      | "media-session-lost"
      | "server-restart"
      | "user-stop"
      | "pipeline-error"
      // ADAAAA-7906: the resume-classified VOD failures.
      | "decide-unavailable"
      | "perceive-session-lost"
      | "capacity-exhausted";
    // ADAAAA-7907 (VOD resume): the durable checkpoint, projected for the caller
    // (a non-admin gets it without the spend accumulators). The header renders
    // "resumed from T+12:30 · attempt 2 of 3" from it, and the FAILED state
    // offers Resume only when it is present.
    resume?: ResumeView;
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
    // ADAAAA-8549 (AC3 of ADAAAA-8542): the remaining buckets of the row
    // identity `raw = postable + merged + rejected + notScoring + contradicting
    // (+ replay)`. The server computed them read-time all along but the payload
    // schema stripped them, so a page could not reconcile its own counters.
    // Additive optional — absent on servers that predate them.
    rejectedHighlights?: number;
    notScoringHighlights?: number;
    contradictingHighlights?: number;
    replayHighlights?: number;
    // ADAAAA-7664: a LIVE job records its decide invocations in the observe
    // snapshot (`observeMetrics.decideCalls`) rather than the job-level
    // `decideCalls` field, which only the VOD path wrote. The header must fall
    // back to it, else a live job with N real decides renders `0`.
    // ADAAAA-8425: the same snapshot carries the five skip causes + the decide
    // ceiling. Additive optional — absent on records written before a counter.
    observeMetrics?: ObserveSkipSplit;
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
  /** ADAAAA-8542 (AC3) / ADAAAA-8549: where every persisted highlight row lands
   * on THIS payload — either `served` (the surface that leads to it) or
   * `unrepresented` (with the reason). Additive optional, absent on servers that
   * predate it; a legacy payload fabricates nothing. Mirrors `rowAccounting` in
   * JobDetailSchema (`@highlights/events`). */
  rowAccounting?: JobDetailRowAccounting;
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
  // ADAAAA-8425: the admin-only window audit (five skip causes + decide ceiling).
  // Absent for a `role=user` caller AND on servers that predate it, so the
  // customer payload — and the live chip's supply-only semantics — are unchanged.
  windowAudit?: WindowSkipAudit;
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
    /** ADAAAA-8105: live share, frames arriving, no video bytes stored. */
    | "recording_missing"
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
  /** ADAAAA-8121: content ts of the newest ANALYSED frame — where the analysis
   * is inside the live stream, read from the job's own consume evidence. Absent
   * when no position is known (never a fabricated 0). */
  analysedPositionTs?: number;
  /** ADAAAA-8121: `liveEdgeTs - analysedPositionTs` on the content clock, so the
   * value is unchanged by a 1 fps -> 2 fps consume rate. */
  analysedLagSec?: number;
  /** ADAAAA-8121: frames the ingest delivered (count). */
  strideFramesSeen?: number;
  /** ADAAAA-8121: frames the stride SKIPPED — a COUNT, never a position marker. */
  strideFramesSkipped?: number;
  /** ADAAAA-8121: resolved content consume rate. */
  strideAnalysisFps?: number;
  /** ADAAAA-8121: `false` when the record carries no consume/stride evidence
   * (the knob was unset on that run) — the indicator degrades to "no stride
   * data" instead of inventing a position. */
  strideData?: boolean;
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
 * ADAAAA-7915 (increment 3): the RAW highlight audit rows for one job.
 *
 * `fetchJobDetail` cannot answer "which clips did I reject?" — its `highlights`
 * is the POSTABLE projection (`buildPostableHighlights` drops every
 * `status === "rejected"` row). `GET /jobs/:id` returns
 * `store.highlightsForJob(job.id)` owner-or-admin scoped, so the page reads the
 * same rows the review endpoint writes and a rejected clip stays reachable
 * after a reload. Read-only: no new server route, no GPU.
 */
export async function fetchJobHighlights(id: string): Promise<JobDetailHighlight[]> {
  const r = await api<{ highlights?: JobDetailHighlight[] }>(`/jobs/${id}`);
  return r?.highlights ?? [];
}

/**
 * ADAAAA-7915: the rows the hidden-clip strip renders — the caller's own
 * rejected rows, minus anything the accepted feed already shows (a stale raw
 * read must never double-render one clip). Pure so the reject -> strip and
 * undo -> back-in-feed transitions are unit-testable without a DOM.
 */
export function rejectedStripRows(
  raw: JobDetailHighlight[] | null | undefined,
  acceptedFeed: JobDetailHighlight[] | null | undefined,
): JobDetailHighlight[] {
  const inFeed = new Set((acceptedFeed ?? []).map((h) => h.id));
  return (raw ?? []).filter((h) => h.status === "rejected" && !inFeed.has(h.id));
}

/**
 * ADAAAA-7915: apply a just-submitted review to the raw rows so the strip moves
 * on the same tick as the click (the authoritative re-read reconciles after).
 * A restore flips the row to `accepted` and the strip filter drops it; a reject
 * inserts the row when the raw cache predates it.
 */
export function applyReviewToRawRows(
  raw: JobDetailHighlight[] | null | undefined,
  reviewed: JobDetailHighlight,
  status: "accepted" | "rejected",
): JobDetailHighlight[] {
  const rows = raw ?? [];
  const hit = rows.some((h) => h.id === reviewed.id);
  return hit
    ? rows.map((h) => (h.id === reviewed.id ? { ...h, status } : h))
    : [...rows, { ...reviewed, status }];
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
  /** ADAAAA-8419: the window's skipped-frame evidence (absent = none recorded),
   *  so a window opened after the composite read renders its greyed tiles. */
  skipped?: SkippedFrame[];
  skippedTotal?: number;
  decideNotes: DecideNote[];
}

/** Fetch the inspection detail for exactly one Analysis window (bucket index). */
export async function fetchSectionInspect(id: string, index: number): Promise<SectionInspect> {
  return api<SectionInspect>(`/jobs/${id}/sections/${index}/inspect`);
}

/**
 * ADAAAA-7997: the bucket index an incremental refresh asks from, given how far
 * the page has already rendered (`lastSectionIndex`) and the lowest index a
 * queued SSE event asked for (`queued`).
 *
 * A page that mounted before the job produced its FIRST window (the live case —
 * the page opens on the POST /jobs 202) holds no baseline: the composite load
 * carried zero sections, so `lastSectionIndex` is -1. The composite recovery
 * poll is muted while the SSE channel is live, so the delta path is the only
 * way the first highlight card and the first summary-log line can reach that
 * page. It therefore asks from the top (-1) instead of standing down, and
 * `mergeDelta` establishes the baseline from the response.
 *
 * Otherwise the newest known bucket is always re-requested (`last - 1`) so a
 * decide note persisted into it is picked up, and a queued event naming an
 * earlier bucket (a note whose trigger trails the newest bucket) widens that.
 */
export function deltaRequestAfter(lastSectionIndex: number, queued: number | null): number {
  const tail = lastSectionIndex < 0 ? -1 : Math.max(-1, lastSectionIndex - 1);
  return queued === null ? tail : Math.min(tail, queued);
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
 * One posted moment that absorbed overlapping clips, mapped onto the Analysis
 * window list (ADAAAA-7881).
 *
 * ADAAAA-7621's overlap dedupe folds several clips into one moment and the wire
 * payload reports them twice — `duplicateCount` / `mergedIds` on the winner and
 * a `duplicateHighlights` row per folded-away clip carrying `duplicateOf`. The
 * card used to say "N merged" instead of showing WHERE the footage came from, so
 * the Analysis list now draws the folded windows as one connected group.
 */
export interface MergedMomentGroup {
  /** The moment (winning highlight) that owns the footage. */
  momentId: string;
  /** Clips in the moment, the winner included. */
  clipCount: number;
  /** Group label, e.g. `One moment · 2 clips`. */
  label: string;
  /** Accessible group name, e.g. `Windows T+341s–T+375s are one highlight`. */
  ariaLabel: string;
  /** `FrameSection.index` values of the windows that carry the moment's footage. */
  memberIndexes: number[];
}

/** Overlap test for a clip window `[start, end]` against a section `[startS, endS]`. */
function windowCarriesClip(section: FrameSection, clip: Pick<JobDetailHighlight, "start" | "end">): boolean {
  return section.startS < clip.end && clip.start < section.endS;
}

/**
 * Derive the merged-moment groups the Analysis window list renders (ADAAAA-7881).
 *
 * Client-side and pure: for each postable highlight that absorbed clips
 * (`duplicateCount > 0`), take its folded clips from `duplicateHighlights`
 * (`duplicateOf` === the moment id) and map the moment + each folded clip onto
 * every window whose `[startS, endS]` overlaps the clip's `[start, end]`. The
 * moment's own window is included, so a chain (`a` overlaps `b` overlaps `c`)
 * reads as one connected group. A job with no `duplicateHighlights` (legacy
 * payloads) yields no groups and renders exactly as before.
 */
export function mergedMomentGroups(
  highlights: JobDetailHighlight[] | undefined,
  duplicates: JobDetailHighlight[] | undefined,
  sections: FrameSection[] | undefined
): MergedMomentGroup[] {
  const moments = highlights ?? [];
  const folded = duplicates ?? [];
  const windows = sections ?? [];
  if (folded.length === 0 || windows.length === 0) return [];
  const groups: MergedMomentGroup[] = [];
  for (const moment of moments) {
    if ((moment.duplicateCount ?? 0) <= 0) continue;
    const clips = [moment, ...folded.filter((d) => d.duplicateOf === moment.id)];
    if (clips.length < 2) continue;
    const memberIndexes = windows.filter((s) => clips.some((c) => windowCarriesClip(s, c))).map((s) => s.index);
    if (memberIndexes.length === 0) continue;
    const startS = Math.min(...clips.map((c) => c.start));
    const endS = Math.max(...clips.map((c) => c.end));
    groups.push({
      momentId: moment.id,
      clipCount: clips.length,
      label: `One moment · ${clips.length} clips`,
      ariaLabel: `Windows T+${Math.round(startS)}s–T+${Math.round(endS)}s are one highlight`,
      memberIndexes,
    });
  }
  return groups;
}

/** `FrameSection.index` → the merged group that window belongs to. */
export function mergedGroupsByWindow(groups: MergedMomentGroup[]): Map<number, MergedMomentGroup> {
  const map = new Map<number, MergedMomentGroup>();
  for (const group of groups) for (const index of group.memberIndexes) map.set(index, group);
  return map;
}

/**
 * Everything the detail page can show under "Highlights" (ADAAAA-8034).
 *
 * The postable gallery is only ONE of those surfaces: ADAAAA-7621 put two
 * secondary lanes beside it (merged-away clips + notable non-scoring plays) and
 * ADAAAA-7466 added the stored per-pass summary log. A job whose only accepted
 * highlight has not been precision-passed yet has zero postable cards while its
 * notable lane and summary log are populated — so "no postable cards" is NOT the
 * same question as "nothing to show".
 */
export interface HighlightContentCounts {
  /** Postable cards: `detail.highlights` minus any rejected row. */
  postable: number;
  /** Rows in the "Notable — not a goal" lane. */
  notable: number;
  /** Rows in the "Merged into a highlight" lane. */
  merged: number;
  /** Entries in the stored per-pass summary log (the Video Summary badge). */
  summaries: number;
}

/**
 * ADAAAA-8034: true when the page holds ANY highlight content — a postable
 * card, a notable-lane row, a merged-lane row, or a summary-log entry. The
 * "No accepted highlights for this job." empty state renders only when this is
 * false, so it can never sit beside a populated notable lane.
 */
export function hasHighlightContent(c: HighlightContentCounts): boolean {
  return c.postable > 0 || c.notable > 0 || c.merged > 0 || c.summaries > 0;
}

/** ADAAAA-8542 (AC3) / ADAAAA-8549: where a persisted row lands on the page.
 * `card` = a postable card, `notable_card` = a notable card's owner,
 * `sibling_clip` = a notable card's rail option, `replay_alternative` = a replay
 * clip under its owner's alternatives; every other value is a reason a row has
 * NO page representation (`merged_duplicate` is deduped by design,
 * `notable_option_over_rail_cap` is beyond the rail, `unaccounted` is the
 * fail-closed value a shipped projection must never emit). */
export type JobDetailRowRepresentation =
  | "card"
  | "notable_card"
  | "sibling_clip"
  | "replay_alternative"
  | "merged_duplicate"
  | "notable_option_over_rail_cap"
  | "rejected"
  | "not_scoring"
  | "contradicting"
  | "replay_owner_missing"
  | "unaccounted";

export interface JobDetailRowAccounting {
  /** Every persisted row the page leads to, and the surface that leads to it. */
  served: { id: string; representation: JobDetailRowRepresentation }[];
  /** Every persisted row with NO page representation, with the reason. */
  unrepresented: { id: string; reason: JobDetailRowRepresentation }[];
}

/**
 * ADAAAA-8549 (AC3 of ADAAAA-8542): the webapp's own cross-check of the served
 * row accounting against the arrays the page actually renders.
 *
 * A page that counts cards under-reports a job whose notable moment carries
 * `siblingClips`: browser job 50b7aed6 delivered 4 rows and served 3 notable
 * cards, and the 4th id was a sibling option of the second card — it looked
 * "lost" only to a reader that scanned `highlights[]` and `notableHighlights[]`.
 * `rendered` is every id the arrays below reach (the merged lane included, since
 * those rows render inside their owner's merged group); `unreachable` is any id
 * the payload CLAIMS is served but no rendered lane carries — it must be empty,
 * and a non-empty list means the payload and the page disagree.
 *
 * Pure and read-only; `highlightMomentEntries` stays the single grid list (this
 * is a diagnostic projection, not a second rendering lane).
 */
export function servedHighlightRowIds(
  detail: Pick<JobDetail, "highlights" | "notableHighlights"> &
    Partial<Pick<JobDetail, "duplicateHighlights" | "rowAccounting">>
): {
  lanes: { postable: string[]; notable: string[]; sibling: string[]; alternative: string[]; merged: string[] };
  rendered: string[];
  declaredServed: string[];
  unrepresented: string[];
  unreachable: string[];
} {
  const postableRows = detail.highlights ?? [];
  const notableMoments = detail.notableHighlights ?? [];
  const lanes = {
    postable: postableRows.map((h) => h.id),
    notable: notableMoments.map((m) => m.id),
    sibling: notableMoments.flatMap((m) => (m.siblingClips ?? []).map((s) => s.id)),
    alternative: postableRows.flatMap((h) => (h.alternatives ?? []).map((a) => a.id)),
    merged: (detail.duplicateHighlights ?? []).map((h) => h.id),
  };
  const rendered = [
    ...new Set([
      ...lanes.postable,
      ...lanes.notable,
      ...lanes.sibling,
      ...lanes.alternative,
      ...lanes.merged,
    ]),
  ];
  const declaredServed = (detail.rowAccounting?.served ?? []).map((r) => r.id);
  const renderedSet = new Set(rendered);
  return {
    lanes,
    rendered,
    declaredServed,
    unrepresented: (detail.rowAccounting?.unrepresented ?? []).map((r) => r.id),
    unreachable: declaredServed.filter((id) => !renderedSet.has(id)),
  };
}

/**
 * ADAAAA-8034: derive the counts above from one composite detail payload. The
 * postable count is recomputed from `highlights` (rejected rows filtered) so the
 * predicate stays correct even if a caller passes a raw list that still carries
 * a rejected row; `summaryLog` is optional on legacy jobs.
 */
export function highlightContentCounts(
  detail: Pick<JobDetail, "highlights" | "notableHighlights" | "duplicateHighlights"> & {
    job: { summaryLog?: SummaryLogEntry[] };
  }
): HighlightContentCounts {
  return {
    postable: detail.highlights.filter((h) => h.status !== "rejected").length,
    notable: (detail.notableHighlights ?? []).length,
    merged: (detail.duplicateHighlights ?? []).length,
    summaries: (detail.job.summaryLog ?? []).length,
  };
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
  const skippedClause = skippedSummaryClause(s);
  if (s.decideNotes.length === 0) return `${sectionLabel(s)} — no analysis${skippedClause}`;
  return `${sectionLabel(s)} · ${s.decideNotes.map(noteSummaryText).join(" | ")}${skippedClause}`;
}

/**
 * ADAAAA-8419: the collapsed-window clause naming the frames the consume stride
 * refused, so a skipped window is visible without expanding it. `+N more` states
 * the per-section display cap instead of silently hiding the remainder; a window
 * with no skip evidence adds nothing at all (never `· 0 skipped`).
 */
export function skippedSummaryClause(s: FrameSection): string {
  const shown = s.skipped?.length ?? 0;
  if (shown === 0) return "";
  const total = Math.max(shown, Math.round(Number(s.skippedTotal ?? shown) || shown));
  return ` · ${shown} skipped${total > shown ? ` +${total - shown} more` : ""}`;
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
 * Human text for an OPAQUE wire value — the decide `verdict` rationale, an
 * attested-evidence entry, or a data item's value. The webapp does not validate
 * these payloads, so the value may be a scalar OR an object/array.
 *
 * `String({...})` is `"[object Object]"` (ADAAAA-8186/8187): it silently loses
 * the whole object, and a bare object as a React child throws and blanks the
 * panel. This formatter never coerces an object through `String`:
 *   • null / undefined / ""            → "—"
 *   • boolean → yes/no, number → as-is, string → verbatim
 *   • array   → the formatted items joined with ", "
 *   • object  → a compact `key: value` summary (one nesting level deep); a
 *               value it cannot walk (cycle, throwing getter, too deep) falls
 *               back to compact JSON — never "[object Object]".
 */
export function verdictText(value: unknown): string {
  return opaqueText(value, 0);
}

/** Depth at which an opaque object stops nesting and renders as JSON. */
const OPAQUE_MAX_DEPTH = 2;

function opaqueText(value: unknown, depth: number): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map((item) => opaqueText(item, depth + 1)).join(", ");
  }
  if (typeof value === "object") {
    if (depth >= OPAQUE_MAX_DEPTH) return opaqueJson(value);
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value as Record<string, unknown>);
    } catch {
      return opaqueJson(value);
    }
    if (entries.length === 0) return "—";
    return entries.map(([key, item]) => `${key}: ${opaqueText(item, depth + 1)}`).join(", ");
  }
  // symbol / function: a last resort that can still never be an object.
  return String(value);
}

function opaqueJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? "—" : json;
  } catch {
    return "—";
  }
}

/**
 * Human text for an analysis data item's value. Scalars keep the documented
 * wording (null/undefined → "—", boolean → yes/no, numbers as-is, strings
 * verbatim); an unvalidated non-scalar value goes through the same opaque-value
 * formatter so it can never print "[object Object]" or crash the row.
 */
export function dataItemValueText(value: unknown): string {
  return verdictText(value);
}

/**
 * The tri-state wording for one goal criterion on the I1 `Verdict` rationale.
 * The wire is strict: `true` = seen, `false` = plainly contradicted (not seen),
 * `null`/absent = unverifiable (`VerdictCriteria` docstring, decide
 * `services/decide/app/__init__.py`). An out-of-contract value is formatted
 * rather than coerced.
 */
export function verdictCriterionText(value: unknown): string {
  if (value === true) return "seen";
  if (value === false) return "not seen";
  if (value === null || value === undefined) return "unverifiable";
  return verdictText(value);
}

/** A parsed audio-energy level curve for one analysis data item (ADAAAA-7932). */
export interface AudioLevelCurve {
  /** The sample values in order (0..1 energy, rounded by the decide layer). */
  values: number[];
  /** Peak level: the server-declared one when the text header carries it, else
   *  the max of `values`. */
  peak: number;
  /** Mean level: the server-declared one when the header carries it, else the
   *  arithmetic mean of `values`. */
  mean: number;
  /** True when peak/mean were read from the header (server-computed) rather
   *  than recomputed from the samples that survived parsing. */
  declared: boolean;
}

const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

function numbersIn(text: string): number[] {
  const found = text.match(NUMBER_RE);
  if (!found) return [];
  return found
    .map((s) => Number(s))
    .filter((v) => Number.isFinite(v));
}

/**
 * Parse the `audio_level` analysis data item into a numeric level curve so the
 * panel can draw it as a graph instead of dumping the raw prompt text
 * (ADAAAA-7932).
 *
 * The decide layer sends this item in two shapes:
 *  • Stage-1 (`services/decide/app/gemma.py`): the text line
 *    `audio energy level curve (48 samples, peak=0.82, mean=0.33): [0.12,0.14,…]`
 *  • Stage-2 confirm (`services/decide/app/confirm.py`): a rounded number array.
 *
 * Returns null when the value carries no usable series (fewer than 2 samples),
 * so the row degrades to the raw text rather than an axis-less blank plot.
 */
export function parseAudioLevelCurve(value: unknown): AudioLevelCurve | null {
  let values: number[] = [];
  let peak: number | undefined;
  let mean: number | undefined;

  if (Array.isArray(value)) {
    values = value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  } else if (typeof value === "number") {
    values = [value];
  } else if (typeof value === "string") {
    // Prefer the bracketed series (the part actually sent to the model) so the
    // header's sample count / peak / mean digits never leak into the samples.
    const open = value.lastIndexOf("[");
    const close = value.indexOf("]", open === -1 ? 0 : open);
    const seriesText = open !== -1 && close > open ? value.slice(open + 1, close) : "";
    values = numbersIn(seriesText);
    if (values.length === 0) values = numbersIn(value);

    const head = open === -1 ? value : value.slice(0, open);
    const peakM = /peak\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(head);
    const meanM = /mean\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(head);
    if (peakM) peak = Number(peakM[1]);
    if (meanM) mean = Number(meanM[1]);
  } else if (value && typeof value === "object") {
    // Tolerate a structured {"values":[…]}/{"levels":[…]} payload.
    const obj = value as Record<string, unknown>;
    const arr = Array.isArray(obj.values) ? obj.values : Array.isArray(obj.levels) ? obj.levels : null;
    if (arr) values = arr.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (typeof obj.peak === "number") peak = obj.peak;
    if (typeof obj.mean === "number") mean = obj.mean;
  }

  if (values.length < 2) return null;
  const declaredPeak = peak !== undefined && Number.isFinite(peak) ? peak : undefined;
  const declaredMean = mean !== undefined && Number.isFinite(mean) ? mean : undefined;
  return {
    values,
    peak: declaredPeak ?? Math.max(...values),
    mean: declaredMean ?? values.reduce((a, b) => a + b, 0) / values.length,
    declared: declaredPeak !== undefined && declaredMean !== undefined,
  };
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
 * ADAAAA-8530 (D1 = option A, confirmation state): the confirmation state a
 * SERVED highlight row carries. `deriveConfirmation()` on the server attaches
 * `confirmation = { lane, label }` — lane + label only, the inspector half of
 * `WindowConfirmation` never leaves the decide note — to every row of
 * `highlights[]` and `notableHighlights[]`. The webapp only RENDERS it, so a card
 * can never invent a lane the pipeline did not derive.
 */
export type HighlightConfirmation = Pick<WindowConfirmation, "lane" | "label">;

/**
 * ADAAAA-8530: THE badge on every Highlights card — confirmation state, not play
 * taxonomy. CONFIRMED only when a pipeline lane actually confirmed the window
 * (`measured` or `dive`); UNCONFIRMED for `dive_disagreed`, `unconfirmed`, or a
 * row whose lane could not be derived (absent). Fail-closed by construction: a
 * row with no corroboration can never read CONFIRMED.
 */
export function confirmationBadge(
  h: Pick<JobDetailHighlight, "confirmation">
): { lane: ConfirmationLane | null; confirmed: boolean; text: "CONFIRMED" | "HELD" | "UNCONFIRMED" } {
  const lane = h.confirmation?.lane ?? null;
  // ADAAAA-8542: `dive_held` is a THIRD state. The dive confirmed the goal but
  // the row's own window measured no transition, so the moment is neither
  // confirmed nor refuted — rendering it as CONFIRMED contradicted the stored
  // `refuted` marker, and rendering it as UNCONFIRMED hid a confirmed goal.
  const held = lane === "dive_held";
  const confirmed = !held && (lane === "measured" || lane === "dive");
  return { lane, confirmed, text: held ? "HELD" : confirmed ? "CONFIRMED" : "UNCONFIRMED" };
}

/**
 * ADAAAA-8530: play type (big play / near miss / goal-shaped) as PLAIN DETAIL
 * TEXT. It moved off the badge — the badge is confirmation state only — and it
 * is never an assertion that a goal was scored: a demoted row reads
 * "goal-shaped play", not "GOAL". Lower-case words only, so no outcome code
 * (`big_play`, ADAAAA-7737's markup guard) reaches a customer session.
 */
export function playTypeText(
  h: Pick<JobDetailHighlight, "provisionalGoal" | "outcome">
): string | null {
  if (h.provisionalGoal || h.outcome === "big_play") {
    return h.provisionalGoal ? "goal-shaped play" : "big play";
  }
  if (h.outcome === "near_miss") return "near miss";
  return null;
}

/** ADAAAA-8530: one row of the single Highlights list. */
export interface HighlightMomentEntry {
  highlight: JobDetailHighlight;
  /** True for a notable moment (never postable, no verdict slot/checkbox). */
  notable: boolean;
  /** True for a notable row with neither `clipUri` nor `clipError`: a text row
   *  INSIDE the list, never a card with an empty player. */
  textRow: boolean;
}

/**
 * ADAAAA-8530: the ONE Highlights list. Postable moments and notable moments are
 * the same list, ordered by moment start (ties broken by id so the order is
 * deterministic). A notable row that carries footage (or a named clip failure)
 * is a card; a row with neither stays a text row in the same list. Pure: no
 * count is derived here and nothing is filtered out of the caller's lists.
 */
export function highlightMomentEntries(
  postable: JobDetailHighlight[],
  notable: JobDetailHighlight[]
): HighlightMomentEntry[] {
  const entries: HighlightMomentEntry[] = [
    ...postable.map((highlight) => ({ highlight, notable: false, textRow: false })),
    ...notable.map((highlight) => ({
      highlight,
      notable: true,
      textRow: !(highlight.clipUri || highlight.clipError),
    })),
  ];
  return entries.sort(
    (a, b) => a.highlight.start - b.highlight.start || a.highlight.id.localeCompare(b.highlight.id)
  );
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
