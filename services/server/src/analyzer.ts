// Worker orchestration: one persistent perceive session per job, sample 1fps,
// feed frames to perceive, compute evidence, call decide on candidates, cut a
// clip on each highlight, and stop the session in `finally`.
import { randomUUID, createHash } from "node:crypto";
import { WindowAnalysisSchema, ConfirmRecordSchema } from "@highlights/events";
import type { HighlightRecord, HighlightTrigger, JobCandidate, TrackObservation, WindowAnalysis, ConfirmRecord } from "@highlights/events";
import type { CaptionGroundingContext, ColourSignal } from "@highlights/events";
import {
  captionColour,
  groundCaption,
  humanEventLabel,
  isQuietVerdict,
  regateServedSentence,
  placePhraseOf,
  quietShape,
  restoreTerminalPunctuation,
  servedShapeViolations,
  storedCardSurface,
  stripInternalTokens,
  wholeStoredSentence,
  windowCorroborated,
} from "@highlights/events";
import { StageAMetrics, StageAOutcomeLedger } from "./stage-a-metrics";
import type { TrainArtifact } from "./db";
import type { PerceiveCalibration } from "./perceive-calibration";
import { clipWindow } from "./config";
import {
  ObserveDecider,
  LiveObserver,
  IngestGapTracker,
  applyOnDemandRecall,
  GOAL_OUTCOMES,
  type ObserveDecidePayload,
  type PerFrameSeed,
  type PerFrameSignal,
  type ObserveBiasHint,
  type SignalGateOptions,
  OBSERVE_MAX_FRAMES,
  LIVE_OBSERVE_MAX_FRAMES,
  LIVE_OBSERVE_LAG_BUDGET_S,
  OBSERVE_CONTENT_FPS,
  OBSERVE_WINDOW_S,
} from "./observe-loop";
import { PerceiveCadence, type PerceiveCadenceOptions } from "./perceive-cadence";
// ADAAAA-8005 (gate 3): the per-row trigger -> delivered metric collector. One
// per run, shared by the observer (fire/settle/accept clocks) and the server's
// persist path (delivered clock).
import { LiveDeliveryTracker, type LiveDeliveredLatencySnapshot } from "./live-delivery";
import { describeInterruption } from "./job-failure";
// ADAAAA-7988: live goal recall from a celebration/reaction window (the goal
// instant falls between 1 fps media-node samples). Live rail only.
import {
  LiveWindowLedger,
  applyLiveGoalRecall,
  isLiveGoalRecallCandidate,
  type LiveGoalRecall,
} from "./live-goal-recall";
import { liveDecideAdmission } from "./live-decide-admission";
import type { AudioTriggerRecord, TriggerSchedulerStats } from "./audio-trigger";
import type { TriggerFamilyLatency } from "./observe-loop";
import { isStageBTrigger, triggerFamily, type WhistleFireBlock } from "./audio-trigger";
import { isGoalRefutingReason } from "./highlight-postable";

/** ADAAAA-7774: the fraction of wall clock the LIVE observe pass may spend in
 * blocking `client.analyze`. Perceive is GPU-bound and shared with the decide
 * workers (measured on the box: ~1.9 s/call at 1 stream and ~4.1 s/call at 2 at
 * decide depth 4), so awaiting every consumed frame's perceive ran the cadence
 * windows late and lost 16-19 windows per 300 s per stream. Budgeting perceive
 * to 60 % of the clock leaves the rest for the decide/recall path and lets the
 * frame loop consume at the analysis fps. `LIVE_PERCEIVE_UTILIZATION`. */
export const LIVE_PERCEIVE_UTILIZATION = 0.6;

/** ADAAAA-7795: the live ingest stride banks credit at the analysis fps and
 *  spends 1.0 per consumed frame. This caps what can be banked, in frames, so a
 *  long ingest stall cannot burst-consume a backlog of already-late frames. */
export const LIVE_STRIDE_CREDIT_CAP = 2;

export interface ReserveResult {
  sessionId: string;
  appUrl: string;
  controlUrl: string;
}
export interface ObservationResult {
  observation: {
    tracks: TrackObservation[];
    seq: number;
    timestamp: number;
    // I3 (ADAAAA-6360): the perceive OCR pass reads the scoreboard on candidate
    // anchor frames; the server folds the count into decide `ocrHits`.
    ocr?: string[];
    objects?: { label: string; confidence?: number; bbox: number[] }[];
    // ADAAAA-7145: perceive's additive per-frame `evidence` (goal/ball signal
    // fields: goalCrossed / ballOutcome / ballVelocity / ballPossession).
    // Consumed by the Tier-2 signal gate; absent when no goal-line/ball channel
    // judged the frame (recall-safe: the gate escalates).
    evidence?: PerFrameSignal;
  };
  candidate?: {
    eventType: string;
    timestamp: number;
    // INC-2 audio-gate signal and INC-2b ball signal ride the CandidateEvent
    // from perceive; the server folds them into decide() reaction evidence.
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
    // Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth
    // signal. Forwarded first-class to decide as a hard gate.
    goalCrossed?: boolean;
    ballOutcome?: string;
    // I3 (ADAAAA-6360): a scoreboard score change detected across the candidate
    // window — a hard, independent goal-confirmation signal.
    scoreBoardChanged?: boolean;
  };
}
/** People-reaction context (INC-4 / ADAAAA-4328) forwarded to decide() so the
 * Gemma prompt can reason about the humans' reaction. Corroborating evidence
 * only — never the highlight arbiter. All-zero == no reaction signal. */
export interface ReactionEvidence {
  crowdEnergy: number; // 0..1 peak of the INC-2 audio gate burst/swell
  audioKind: string; // "burst" | "swell" | "" when no audio reaction
  humansInMotion: number; // cheap visual celebration cue (tracked players counted)
  ballSpeedMps: number; // INC-2b ground-plane ball speed (0 when absent)
  ballPossessionId: string; // INC-2b possessor player id ("" when absent)
}
/** One per-detection geometry item forwarded to decide() (I4 / ADAAAA-6361) so
 * the prompt can cite concrete positions instead of guessing them from vision.
 * `bbox` is normalized [x1, y1, x2, y2] in 0..1 frame space. */
export interface DetectionEvidence {
  label: string;
  bbox: number[];
  confidence: number;
  trackId: string;
}
/** Normalized RMS energy (0..1) of a mono 16-bit PCM buffer — used to build the
 * audio-energy level curve (I4). Silent buffer -> 0. */
export function rmsNormalized(pcm: Buffer): number {
  if (!pcm || pcm.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
    n++;
  }
  if (!n) return 0;
  return Math.min(1, Math.sqrt(sum / n) / 32768);
}
/** Join one or more INDEPENDENTLY base64-encoded int16 PCM parts into a single
 * base64 string of the concatenated bytes.
 *
 * ADAAAA-7665 (verified on the box): the audio tap stores each ~100 ms chunk as
 * its own base64 string. 3200 bytes is not a multiple of 3, so every chunk
 * string carries trailing `=` padding — and `Buffer.from(parts.join(""), "base64")`
 * STOPS at the first `=`. Every window therefore sent only its first 100 ms to
 * the ASR endpoint, which is why whisper answered `""` (~80%) or a canonical
 * silence hallucination (`"What?"`, `"Go!"`, `"You"`). Decode each part, join
 * the BYTES, then encode once. Pure + unit-testable. */
export function joinPcmB64Parts(parts: string[]): string {
  const kept = (parts ?? []).filter((p) => typeof p === "string" && p.length > 0);
  if (!kept.length) return "";
  if (kept.length === 1) return kept[0];
  return Buffer.concat(kept.map((p) => Buffer.from(p, "base64"))).toString("base64");
}
/** Build the reaction evidence object for a candidate from whatever reaction
 * signals it carries (audio gate energy, ball velocity/possession) plus the
 * cheap visual cue (tracked-object count as humans-in-motion proxy). Fields
 * that are absent default to "no signal", so a candidate with no reaction data
 * forwards an all-zero reaction block (prompt renders without it). */
/** Clamp a numerical signal into the decide schema's accepted band. The decide
 * service enforces strict `le` bounds on crowdEnergy/trackCount (ADAAAA-4736):
 * real media sometimes reports peakEnergy > 1.0 or many tracked objects, and an
 * out-of-bounds value makes FastAPI reject the WHOLE request with HTTP 422,
 * killing the clip. The server is the owner of truth, so we clamp here to keep
 * the paid path inside schema bounds. */
export function clamp01(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
export function clampTrackCount(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.min(2, Math.max(0, Math.round(v)));
}
/**
 * ADAAAA-7145: map perceive's per-frame signal `evidence` (goal/ball fields)
 * into the Tier-2 gate's {@link PerFrameSignal}. An absent evidence => undefined
 * (no signal reported; the gate escalates — recall-safe). A goal-line judgment
 * (goalCrossed / ballOutcome / ballInNet present) is marked `goalInfra: true` so
 * an explicit non-goal frame can be suppressed by the gate.
 */
export function seedSignalFromEvidence(evidence: PerFrameSignal | undefined): PerFrameSignal | undefined {
  if (!evidence) return undefined;
  const out: PerFrameSignal = { ...evidence };
  if (evidence.goalCrossed !== undefined || evidence.ballOutcome !== undefined || evidence.ballInNet !== undefined) {
    out.goalInfra = true;
  }
  return out;
}
export function buildReactionEvidence(
  candidate: {
    audio?: AudioCandidate["audio"];
    ballVelocity?: { speedMps?: number };
    ballPossession?: { possessingPlayerId?: string };
  },
  humansInMotion: number
): ReactionEvidence {
  return {
    crowdEnergy: clamp01(candidate.audio?.peakEnergy),
    audioKind: candidate.audio?.kind ?? "",
    humansInMotion: clampTrackCount(humansInMotion),
    ballSpeedMps: candidate.ballVelocity?.speedMps ?? 0,
    ballPossessionId: candidate.ballPossession?.possessingPlayerId ?? "",
  };
}
/** ADAAAA-7844: a MEASURED, legible scoreboard delta carried alongside the
 * `scoreBoardChanged` boolean. Perceive only emits it when both sides parsed and
 * each side is supported by at least two contiguous OCR readings inside the
 * tracker window (so a single-frame misread cannot become a "score change").
 * `deltaTs` is the transition instant (the first frame showing the new score),
 * which is what time-ties the delta to the analysed window. */
export interface ScoreboardDeltaEvidence {
  /** Parsed (home, away) score before the transition. */
  pre: [number, number];
  /** Parsed (home, away) score at/after the transition. */
  post: [number, number];
  /** Timestamp of the last concrete reading of `pre`. */
  preTs: number;
  /** Timestamp of the first concrete reading of `post` (== `deltaTs`). */
  postTs: number;
  /** Transition instant (first frame reading the new score). */
  deltaTs: number;
  /** Contiguous concrete OCR readings supporting `pre`. */
  preSamples: number;
  /** Contiguous concrete OCR readings supporting `post`. */
  postSamples: number;
}

/** Mirrors `scoreboard_delta_legible` in services/decide/app/confirm.py: a delta
 * is credited only when both sides are parsed and consistent. Pure — used to
 * decide whether a window's attestation may carry the delta at all. */
export function scoreboardDeltaLegible(delta: ScoreboardDeltaEvidence | undefined | null): boolean {
  if (!delta) return false;
  const pair = (v: unknown): v is [number, number] =>
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 99);
  if (!pair(delta.pre) || !pair(delta.post)) return false;
  if (delta.pre[0] === delta.post[0] && delta.pre[1] === delta.post[1]) return false;
  if (!(delta.preSamples >= 2) || !(delta.postSamples >= 2)) return false;
  return delta.preTs <= delta.deltaTs && delta.deltaTs <= delta.postTs;
}
/**
 * The candidate signal shape a trigger is derived from (ADAAAA-6798 Inc 2).
 * Mirrors the candidate object produced by perceive / the video + audio legs so
 * the trigger provenance is a pure function of the candidate — no re-inference.
 */
export interface CandidateSignal {
  eventType: string;
  timestamp: number;
  seq?: number;
  audio?: AudioCandidate["audio"];
  ballVelocity?: { speedMps?: number };
  ballPossession?: { possessingPlayerId?: string };
  goalCrossed?: boolean;
  ballOutcome?: string;
  scoreBoardChanged?: boolean;
  /** ADAAAA-7844: the measured delta backing `scoreBoardChanged`, when one was
   * measured legibly inside the window. */
  scoreBoardDelta?: ScoreboardDeltaEvidence;
}

/**
 * Derive the trigger metadata for a candidate from the signal already computed
 * at decision time (ADAAAA-6798 Inc 2). Deterministic and purely derived from the
 * candidate object — NO new inference, no re-analysis. The `kind` is the
 * dominant trigger (or `corroborated` when >= 2 independent signals are present);
 * the raw reaction evidence is carried alongside so the UI can show provenance.
 */
export function deriveHighlightTrigger(c: CandidateSignal): HighlightTrigger {
  const audioKind = c.audio?.kind ?? "";
  const goalCrossed = c.goalCrossed === true;
  const scoreChanged = c.scoreBoardChanged === true;
  const ballSpeed = c.ballVelocity?.speedMps ?? 0;
  const ballPos = c.ballPossession?.possessingPlayerId ?? "";
  const signals: string[] = [];
  if (audioKind === "burst") signals.push("audio_burst");
  else if (audioKind === "swell") signals.push("audio_swell");
  if (goalCrossed) signals.push("goal_line");
  if (scoreChanged) signals.push("score_change");
  if (ballSpeed > 0 || ballPos) signals.push("ball_signal");
  let kind: HighlightTrigger["kind"];
  if (signals.length >= 2) kind = "corroborated";
  else if (signals.length === 1) kind = signals[0] as HighlightTrigger["kind"];
  else kind = "motion";
  return {
    kind,
    timestamp: c.timestamp,
    eventType: c.eventType,
    crowdEnergy: clamp01(c.audio?.peakEnergy) || undefined,
    audioKind: audioKind || undefined,
    ballSpeedMps: ballSpeed > 0 ? ballSpeed : undefined,
    ballPossessionId: ballPos || undefined,
    goalCrossed: goalCrossed || undefined,
    ballOutcome: c.ballOutcome || undefined,
    scoreBoardChanged: scoreChanged || undefined,
  };
}
/** ADAAAA-7028 Inc 2: the frame-group partition key for a candidate timestamp.
 * Mirrors the plan's 3 s frame-group window (FRAME_GROUP_WINDOW_S=3) so each
 * decide call resolves to a stable (sessionId, groupKey) and, once the
 * grouped-decide path lands, one decide_audit row per frame group. */
export function decideGroupKey(timestamp: number): string {
  return `g${Math.floor(timestamp / 3)}`;
}

/** ADAAAA-7856: the wire shape of the match context forwarded on a decide call.
 * Mirrors the additive `matchContext` field on the decide service's
 * `HighlightRequest` — the persisted job record minus the resolver audit
 * (`trail`, `evidence`, `inferredAt`), which the prompt does not use. */
export interface DecideMatchContext {
  sport: string;
  teams: { name: string; side: string; kitColors: { primary: string; secondary?: string }[]; confidence: number }[];
  ambiguous: boolean;
}

/** ADAAAA-7856: normalise the job's stored `matchContext` to the decide wire
 * shape, or `undefined` when it carries nothing usable.
 *
 * Read from persistence — NEVER recomputed here, so this change adds zero GPU
 * work per window (the resolver ran once per job, ADAAAA-7855). Unknown fields
 * are dropped and malformed entries are skipped: a bad stored context degrades
 * to "no context" (today's prompt), it never breaks the send path or 422s the
 * decide request. Pure, so it is cheap on the per-window hot path.
 */
export function toDecideMatchContext(raw: unknown): DecideMatchContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const src = raw as Record<string, any>;
  const text = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const teams: DecideMatchContext["teams"] = [];
  const seenSides = new Set<string>();
  for (const item of Array.isArray(src.teams) ? src.teams : []) {
    if (!item || typeof item !== "object") continue;
    const name = text(item.name, 60);
    // "unknown" is the resolver's explicit "could not attribute" marker; it is
    // never forwarded as a team name (that would invite a fabricated claim).
    if (!name || name.toLowerCase() === "unknown") continue;
    const sideRaw = text(item.side, 10).toLowerCase();
    const side = sideRaw === "home" || sideRaw === "away" ? sideRaw : "unknown";
    if (seenSides.has(side)) continue;
    seenSides.add(side);
    const kitColors: { primary: string; secondary?: string }[] = [];
    for (const c of Array.isArray(item.kitColors) ? item.kitColors : []) {
      if (!c || typeof c !== "object") continue;
      const primary = text(c.primary, 24);
      if (!primary) continue;
      const secondary = text(c.secondary, 24);
      kitColors.push(secondary ? { primary, secondary } : { primary });
      if (kitColors.length >= 2) break;
    }
    const n = Number(item.confidence);
    const confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    teams.push({ name, side, kitColors, confidence });
    if (teams.length >= 2) break;
  }
  if (!teams.length) return undefined;
  return {
    sport: text(src.sport, 40).toLowerCase(),
    teams,
    ambiguous: src.ambiguous === true,
  };
}
/** ADAAAA-7232: deterministic highlight-instant localization from the defined
 * per-frame/per-tap signal. Prefers the highest-RMS audio tap strictly AFTER
 * the trigger within `maxLookaheadS` (peak-audio post-trigger, Acc-2/Acc-3);
 * falls back to the trigger timestamp when no post-trigger tap is buffered yet
 * (e.g. the live latency-first path, where observation hasn't advanced past the
 * trigger). Pure — no inference, no new GPU calls (Acc-3 / Acc-6). */
export function localizeHighlightInstant(
  triggerTs: number,
  taps: { ts: number; rms: number }[] | undefined,
  maxLookaheadS: number
): { ts: number; signal: "peak_audio" | "trigger" } {
  if (taps?.length) {
    const upper = triggerTs + maxLookaheadS;
    let best: { ts: number; rms: number } | undefined;
    for (const t of taps) {
      if (t.ts > triggerTs && t.ts <= upper) {
        if (!best || t.rms > best.rms) best = t;
      }
    }
    if (best) return { ts: best.ts, signal: "peak_audio" };
  }
  return { ts: triggerTs, signal: "trigger" };
}
/** ADAAAA-7253 (ACC-3): one frame's input to frame-based VOD highlight
 * localization. `signal` is the perceive-derived per-frame goal/ball evidence
 * (ball-in-net / goal-crossed / scoreboard-change); `detectionConfidence` is the
 * frame's max tracked/object detection confidence (0 when none). Both values are
 * already-computed cached findings — frame localization reuses them with NO new
 * inference / GPU decide pass (Acc-6). */
export interface LocalizeFrameInput {
  ts: number;
  signal?: PerFrameSignal;
  detectionConfidence?: number;
}
/** ADAAAA-7253 (ACC-3): deterministic per-frame localization score. Ranks a
 * frame by the goal signal it carries — ball-in-net (peak) > goal-crossed >
 * goal-valued outcome > scoreboard-change — and adds a small tracking-detection
 * confidence term so a no-goal-channel window still localizes on the
 * confident-detection peak. Absent signal scores ~0 (never a localization peak).
 * Pure + deterministic (unit-testable). */
export function frameLocalizationScore(f: LocalizeFrameInput): number {
  const sig = f.signal;
  let channel = 0;
  if (sig) {
    if (sig.ballInNet === true) channel = 100;
    else if (sig.goalCrossed === true) channel = 80;
    else if (sig.ballOutcome !== undefined && GOAL_OUTCOMES.has(sig.ballOutcome)) channel = 70;
    else if (sig.scoreBoardChanged === true) channel = 60;
  }
  const conf = clamp01(f.detectionConfidence);
  return channel + conf * 0.1;
}
/** ADAAAA-7253 (ACC-3): frame-based deterministic VOD highlight-instant
 * localization. Within the dense window strictly AFTER the trigger within
 * `maxLookaheadS`, pick the frame maximizing {@link frameLocalizationScore};
 * ties break to the earliest qualifying frame (deterministic, and nearest the
 * trigger). Returns `{ts, signal: "peak_frame"}` when a signal-bearing
 * post-trigger frame exists, else `{ts: triggerTs, signal: "trigger"}`. Reuses
 * already-cached per-frame signals — no new decide/inference call (Acc-6). */
export function localizeHighlightInstantFrame(
  frames: LocalizeFrameInput[],
  triggerTs: number,
  maxLookaheadS: number
): { ts: number; signal: "peak_frame" | "trigger" } {
  if (frames?.length) {
    const upper = triggerTs + maxLookaheadS;
    // Ascending ts => earliest frame wins ties (deterministic).
    const candidates = frames
      .filter((f) => f.ts > triggerTs && f.ts <= upper)
      .sort((a, b) => a.ts - b.ts);
    let best: LocalizeFrameInput | undefined;
    let bestScore = 0;
    for (const f of candidates) {
      const s = frameLocalizationScore(f);
      if (best === undefined || s > bestScore) {
        best = f;
        bestScore = s;
      }
    }
    if (best && bestScore > 0) return { ts: best.ts, signal: "peak_frame" };
  }
  return { ts: triggerTs, signal: "trigger" };
}
/** ADAAAA-7845: how far (s) a post-trigger peak-audio instant may sit from the
 * accepting evidence instant before peak audio stops being the anchor on its
 * own. Peak audio is a SECONDARY cue: a far tap is commentary/narration energy,
 * not the moment the evidence accepted. Measured on job dee44c2f: the accepted
 * GOAL at trigger 117.0 anchored on a tap 6.1 s later that was a stat monologue,
 * and the delivered clip missed the goal entirely. */
export const PEAK_AUDIO_ANCHOR_TOLERANCE_S = 2;
/** ADAAAA-7845: a burst must clear this peak-to-baseline RMS ratio. Narration
 * holds a steadier level; a crowd/react swell stands well above the window's own
 * median. Measured on the dee44c2f tap fixture: the narration windows read
 * 1.66-1.75, a genuine crowd swell reads >= 2.3. */
export const AUDIO_BURST_MIN_PEAK_TO_BASELINE = 2.0;
/** ADAAAA-7845: and a burst must be SHORT — at most this share of the lookahead
 * window may sit at >= half the peak energy. Continuous narration keeps
 * 0.64-1.0 of an 8 s window elevated; react bursts hold <= ~0.35. */
export const AUDIO_BURST_MAX_SUSTAINED_FRACTION = 0.35;
/** ADAAAA-7845: an audio-energy peak assessed as reaction vs narration. */
export interface AudioBurstAssessment {
  /** Timestamp of the highest-RMS tap in the post-trigger lookahead window. */
  peakTs: number;
  peakRms: number;
  /** Median RMS of the taps in that window (the window's own baseline). */
  baselineRms: number;
  /** peakRms / baselineRms — how far the peak stands above the window baseline. */
  peakToBaseline: number;
  /** Share of window taps at >= half the peak energy (high = continuous). */
  sustainedFraction: number;
  /** True only when the energy is a short reaction burst, not narration. */
  isBurst: boolean;
}
/** ADAAAA-7845: assess whether the post-trigger audio energy is a crowd/react
 * BURST rather than continuous narration, using only the already-buffered taps
 * (no new inference, no GPU call). Pure + deterministic. Returns undefined when
 * no tap falls in the lookahead window. */
export function assessAudioBurst(
  taps: { ts: number; rms: number }[] | undefined,
  triggerTs: number,
  maxLookaheadS: number,
  opts?: { minPeakToBaseline?: number; maxSustainedFraction?: number }
): AudioBurstAssessment | undefined {
  if (!taps?.length) return undefined;
  const upper = triggerTs + maxLookaheadS;
  const win = taps.filter((t) => t.ts > triggerTs && t.ts <= upper);
  if (!win.length) return undefined;
  let peak = win[0];
  for (const t of win) if (t.rms > peak.rms) peak = t;
  const sorted = win.map((t) => t.rms).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const baseline = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const minRatio = opts?.minPeakToBaseline ?? AUDIO_BURST_MIN_PEAK_TO_BASELINE;
  const maxSustained = opts?.maxSustainedFraction ?? AUDIO_BURST_MAX_SUSTAINED_FRACTION;
  const ratio = peak.rms / Math.max(baseline, 0.005);
  const sustained = win.filter((t) => t.rms >= 0.5 * peak.rms).length / win.length;
  return {
    peakTs: peak.ts,
    peakRms: peak.rms,
    baselineRms: baseline,
    peakToBaseline: ratio,
    sustainedFraction: sustained,
    isBurst: ratio >= minRatio && sustained <= maxSustained,
  };
}
/** ADAAAA-7845: why the delivered clip sits where it does. Persisted on the
 * highlight so placement is auditable (AC2). */
export type LocalizeAnchorReason =
  | "frame_attestation"
  | "peak_audio_reaction"
  | "peak_audio_far_burst_capped"
  | "peak_audio_far_rejected"
  | "trigger_evidence";
/** ADAAAA-7845: the localization result plus the audit trail the highlight
 * record persists: the accepting evidence instant and how far the anchor is from
 * it. */
export interface VodLocalization {
  ts: number;
  signal: "peak_frame" | "peak_audio" | "trigger";
  anchorReason: LocalizeAnchorReason;
  /** The accepting evidence instant: the frame-attestation ts on the frame
   * path, else the Stage-A trigger timestamp. */
  evidenceTs: number;
  /** |ts - evidenceTs|. */
  deltaSec: number;
}
/** ADAAAA-7253 (ACC-3): VOD highlight-instant localization with a frame-based
 * path. Prefers frame-based localization when the pass carries a post-trigger
 * per-frame signal (records `peak_frame`); otherwise falls back to the
 * deterministic peak-audio tap, then the trigger.
 *
 * ADAAAA-7845: peak audio is only the ANCHOR when it agrees with the accepting
 * evidence instant (within `anchorToleranceS`, default 2 s). A peak further away
 * is a secondary cue: it moves the clip only when the energy reads as a
 * crowd/react burst (short + well above the window baseline); such a burst is
 * capped to the tolerance edge so the anchor never drifts more than ~2 s off the
 * evidence. Otherwise the evidence instant wins and the far peak is recorded as
 * rejected. Pure — no inference, no new GPU/decide calls (Acc-3 / Acc-6). */
export function localizeHighlightInstantVod(
  triggerTs: number,
  frames: LocalizeFrameInput[] | undefined,
  taps: { ts: number; rms: number }[] | undefined,
  maxLookaheadS: number,
  opts?: { anchorToleranceS?: number; burst?: { minPeakToBaseline?: number; maxSustainedFraction?: number } }
): VodLocalization {
  const tol = opts?.anchorToleranceS ?? PEAK_AUDIO_ANCHOR_TOLERANCE_S;
  const frame = localizeHighlightInstantFrame(frames ?? [], triggerTs, maxLookaheadS);
  if (frame.signal === "peak_frame") {
    // The attested frame IS the accepting evidence instant, so the degree of
    // freedom here is zero by construction.
    return { ts: frame.ts, signal: "peak_frame", anchorReason: "frame_attestation", evidenceTs: frame.ts, deltaSec: 0 };
  }
  const audio = localizeHighlightInstant(triggerTs, taps, maxLookaheadS);
  if (audio.signal === "trigger") {
    return { ts: triggerTs, signal: "trigger", anchorReason: "trigger_evidence", evidenceTs: triggerTs, deltaSec: 0 };
  }
  const delta = audio.ts - triggerTs;
  if (delta <= tol) {
    return { ts: audio.ts, signal: "peak_audio", anchorReason: "peak_audio_reaction", evidenceTs: triggerTs, deltaSec: delta };
  }
  const burst = assessAudioBurst(taps, triggerTs, maxLookaheadS, opts?.burst);
  if (burst?.isBurst) {
    const capped = triggerTs + tol;
    return {
      ts: capped,
      signal: "peak_audio",
      anchorReason: "peak_audio_far_burst_capped",
      evidenceTs: triggerTs,
      deltaSec: capped - triggerTs,
    };
  }
  return { ts: triggerTs, signal: "trigger", anchorReason: "peak_audio_far_rejected", evidenceTs: triggerTs, deltaSec: 0 };
}

// ---------------------------------------------------------------------------
// ADAAAA-7996: LIVE localization + scoring-lane attestation gate.
//
// Measured on live job 44aaeaf6 (file-sim of kids300_7935.mp4, GT goals at 100 s
// and 159 s, LIVE_OBSERVE_CONFIRM=0 posture):
//
// - every accept was dated at its TRAILING window's CENTRE (112.1 / 118.8 / 120.0
//   against a 100 s goal, +12.1 s worst), because `candidate.timestamp` is the
//   window's `nowTs` and the old localization only looked FORWARD from it. The
//   evidence (the scoreboard transition the window accepted on) sits at the
//   window's START, so the delivery was systematically later than the moment.
// - one lull window (@289.5 s, score steady 2-2, no score change in the window,
//   no goal-line attestation) shipped `scoring_play` off the model's read alone
//   ("The 'GOL' graphic appears") — a postable false GOAL. The Stage-2 confirm
//   dive is the only corroboration gate and it is OFF on the live rail
//   (LIVE_DECIDE_CONFIRM=0), so nothing else ever asked for a measured signal.
//
// Both rules read the SAME measured attestation (`scoreBoardChanged` /
// `goalCrossed` / `ballOutcome=goal` from the window's own seeds + hints, or a
// corroborated confirm), so a window that anchors the clip on its transition is
// exactly a window allowed to claim the goal.
// ---------------------------------------------------------------------------

/** ADAAAA-7996: a frame's measured goal-attestation channel (0 = none). Unlike
 * {@link frameLocalizationScore} this carries NO detection-confidence term, so a
 * window of confidently-tracked objects can never anchor a delivery or attest a
 * goal on its own. */
export function frameAttestationChannel(f: LocalizeFrameInput): number {
  const sig = f.signal;
  if (!sig) return 0;
  if (sig.ballInNet === true) return 100;
  if (sig.goalCrossed === true) return 80;
  if (sig.ballOutcome !== undefined && GOAL_OUTCOMES.has(sig.ballOutcome)) return 70;
  if (sig.scoreBoardChanged === true) return 60;
  return 0;
}

/** ADAAAA-7996: the EARLIEST frame in `[lo, hi]` that carries a measured goal
 * attestation, or undefined. The first attested frame is the earliest content
 * instant this window can prove the transition happened — the live window is
 * trailing, so that instants sits at its start, not at its centre. */
export function firstAttestedFrameTs(
  frames: LocalizeFrameInput[] | undefined,
  lo: number,
  hi: number
): number | undefined {
  let best: number | undefined;
  for (const f of frames ?? []) {
    if (!Number.isFinite(f?.ts)) continue;
    if (f.ts < lo || f.ts > hi) continue;
    if (frameAttestationChannel(f) <= 0) continue;
    if (best === undefined || f.ts < best) best = f.ts;
  }
  return best;
}

/**
 * ADAAAA-7996: live highlight-instant localization over the JUDGED window.
 *
 * Order of evidence, strongest first:
 *   1. the window's own legible scoreboard delta — `deltaTs` IS the transition
 *      instant (first frame reading the new score), clamped into the window;
 *   2. the earliest frame in the window carrying any measured goal attestation;
 *   3. the pre-existing trigger / peak-audio path
 *      ({@link localizeHighlightInstantVod}), unchanged.
 *
 * Pure: reads already-computed seeds + taps, no inference, no GPU call.
 */
export function localizeLiveWindowInstant(
  triggerTs: number,
  frames: LocalizeFrameInput[] | undefined,
  taps: { ts: number; rms: number }[] | undefined,
  maxLookaheadS: number,
  window: { lo: number; hi: number },
  scoreDelta?: ScoreboardDeltaEvidence,
  opts?: { anchorToleranceS?: number; burst?: { minPeakToBaseline?: number; maxSustainedFraction?: number } }
): VodLocalization {
  const lo = Number.isFinite(window.lo) ? window.lo : triggerTs;
  const hi = Number.isFinite(window.hi) ? window.hi : triggerTs;
  if (scoreboardDeltaLegible(scoreDelta)) {
    const ts = Math.min(Math.max((scoreDelta as ScoreboardDeltaEvidence).deltaTs, lo), hi);
    return { ts, signal: "peak_frame", anchorReason: "frame_attestation", evidenceTs: ts, deltaSec: 0 };
  }
  const attested = firstAttestedFrameTs(frames, lo, hi);
  if (attested !== undefined) {
    return { ts: attested, signal: "peak_frame", anchorReason: "frame_attestation", evidenceTs: attested, deltaSec: 0 };
  }
  return localizeHighlightInstantVod(triggerTs, frames, taps, maxLookaheadS, opts);
}

/**
 * ADAAAA-7996: does this live GOAL accept carry at least one MEASURED
 * attestation? Every field is a measurement, never model prose:
 *
 * - `scoreBoardChanged` — the perceive score tracker read a score transition in
 *   this window (the same signal that anchors the delivered clip);
 * - `goalCrossed` / `ballOutcome=goal` — the goal-line / net attestation;
 * - `corroborated` / `goalConfirmed=confirmed_goal` — the Stage-2 dive
 *   independently corroborated it (when the confirm pass runs).
 *
 * A model-only read is NOT evidence (ADAAAA-7938 already refuses it as a
 * transition signal for dedupe; the live scoring lane now refuses it too).
 */
export function liveGoalHasMeasuredEvidence(input: {
  scoreBoardChanged?: boolean;
  goalCrossed?: boolean;
  ballOutcome?: string;
  corroborated?: boolean;
  goalConfirmed?: string | null;
}): boolean {
  if (input.scoreBoardChanged === true) return true;
  if (input.goalCrossed === true) return true;
  if (typeof input.ballOutcome === "string" && /^goal$/i.test(input.ballOutcome.trim())) return true;
  if (input.corroborated === true) return true;
  if ((input.goalConfirmed ?? "").trim().toLowerCase() === "confirmed_goal") return true;
  return false;
}

/** ADAAAA-7996: the note a downgraded live GOAL accept carries. */
export const LIVE_UNATTESTED_GOAL_NOTE =
  "live scoring lane: no measured attestation in this window (no scoreboard change, no goal-line / net signal, no corroborated confirm) — delivered as a celebration, not a GOAL";

/**
 * ADAAAA-7996: downgrade a live GOAL accept with no measured attestation to a
 * non-scoring celebration. Same shape as the ADAAAA-7865 repeat-goal downgrade:
 * the clip is still cut and delivered (a legitimate moment stays on the board),
 * but its outcome leaves the scoring lane, so it can never be postable as a
 * GOAL (`isPostableHighlight` requires `scoring_play`).
 */
export function downgradeUnattestedLiveGoal(d: DecisionResult): DecisionResult {
  return {
    ...d,
    outcome: "big_play",
    eventType: "BIG_PLAY",
    reason: d.reason ? `${d.reason} | ${LIVE_UNATTESTED_GOAL_NOTE}` : LIVE_UNATTESTED_GOAL_NOTE,
  };
}

// ---------------------------------------------------------------------------
// ADAAAA-8006: deferred attestation re-emit (the score-change legibility gap).
//
// Regression source: live job b54366ac (file-sim of `kids300_7935.mp4`, GT goals
// at 100 s and 159 s, posture LIVE_DECIDE_CONFIRM=0). The ADAAAA-7996 gate was
// RIGHT — the 159 s GOAL accept carried no measured attestation inside its
// judged window and shipped as a `big_play` celebration. The defect is TIMING:
// `decide_audit` for the 18:04:05-18:04:18 windows reads `2-1` and never `2-2`;
// the first window to read `2-2` is 18:04:34.6Z, 17 s after the 159 s accept.
// The corroborating delta existed, but it landed OUTSIDE the window that could
// credit it, so postable goal recall was 1/2.
//
// The scoreboard read already happened — it is a measurement the live pass has
// already paid for — so a later window can re-attest an already-delivered row
// RETROACTIVELY: upgrade the demoted `big_play` row back into the scoring lane
// (`scoring_play` GOAL) with no added decide and no added GPU-second.
//
// This does NOT weaken the ADAAAA-7996 requirement. `liveGoalHasMeasuredEvidence`
// stays mandatory at the accept seam; the only evidence that can re-attest a row
// here is a MEASURED, legible scoreboard delta — model prose can never trigger an
// upgrade. The lookahead is deliberately tight (20 s) and the read must be
// unambiguous (a single-goal step, exactly one demoted window in reach, and no
// delivered scoring GOAL already owning that transition), which is what keeps the
// 159-299 s score-steady lull out of the scoring lane (0 postable GOALs, the
// ADAAAA-7996/8002 precision bar).
//
// Rejected alternatives (both cost GPU-seconds per stream, so both need a CEO
// cap decision before they can ship — see the issue): enabling the
// corroborated-confirm pass (~$2.97/h/stream, above the $2.75 cap) and widening
// the judged-window tail (same direction). Option 1 is the ~$0 lever.
// ---------------------------------------------------------------------------

/** ADAAAA-8006: how far past a judged window's close a later scoreboard read may
 * still re-attest it. 17 s was the measured gap on the regression fixture; 20 s
 * covers it with margin while staying well inside the range where a following
 * goal would have its own accept (which then owns the transition). */
export const LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S = 20;

/** ADAAAA-8006: a LIVE goal-shaped accept that was demoted for lack of a
 * measured attestation, kept so a later scoreboard read can still re-attest it.
 * The delivered row (and its surface copy) already exists — `highlightId` names
 * it, and the scoring-lane surface below is what the write-seam gate produced for
 * the pre-downgrade verdict, so the upgrade restores gated copy rather than
 * re-deriving it at read time. */
export interface DeferredGoalAttestation {
  /** The already-persisted (demoted) highlight row. */
  highlightId: string;
  jobId: string;
  /** The judged content window `[lo, hi]` the demoted accept was decided over. */
  lo: number;
  hi: number;
  /** The delivered (localized) instant of the demoted row. */
  anchorTs: number;
  /** The trigger kind of the demoted accept (audit only). */
  triggerKind: string;
  /** Write-seam surface for the PRE-downgrade (scoring_play) verdict. */
  reason?: string;
  caption?: string;
  cardTitles?: string[];
  colour?: ColourSignal;
  reasonRaw?: string;
}

/** ADAAAA-8006: the re-emit handed to the caller's persist hook. */
export interface DeferredGoalAttestationUpgrade extends DeferredGoalAttestation {
  /** The transition instant the later read measured (first read of the new score). */
  deltaTs: number;
  /** The content timestamp of the window whose read resolved it. */
  readAt: number;
  /** The measured delta itself (pre/post + sample counts). */
  delta: ScoreboardDeltaEvidence;
  /** The lookahead bound that was applied (audit). */
  lookaheadS: number;
}

/** ADAAAA-8006: is this delta a SINGLE goal step (exactly one side +1)?
 *
 * A jump of two goals, or a rewritten side, is ambiguous: the demoted window
 * could belong to either transition, and crediting the wrong one would put a
 * postable GOAL on the wrong moment. Ambiguity fails closed. */
export function scoreboardDeltaSingleGoalStep(delta: ScoreboardDeltaEvidence | undefined | null): boolean {
  if (!delta) return false;
  const dh = delta.post[0] - delta.pre[0];
  const da = delta.post[1] - delta.pre[1];
  return (dh === 1 && da === 0) || (dh === 0 && da === 1);
}

/** ADAAAA-8006: can a scoreboard delta read by a LATER window re-attest this
 * cancelled judged window?
 *
 * The predicate, in order (each one fail-closed):
 *  1. the delta is legible (both sides parsed, two contiguous reads each side —
 *     the same bar `scoreboardDeltaLegible` / perceive's tracker enforces);
 *  2. it is a single goal step (unambiguous);
 *  3. the transition instant lies INSIDE the judged window `[lo, hi]`, or up to
 *     `maxLookaheadS` after its close (ADAAAA-8017: `deltaTs` is a content
 *     timestamp, so a boundary transition is first legible just before `hi`
 *     while the read lands with a later window; the 8006 version declined that
 *     case and left a true goal demoted). A transition before `lo` belongs to an
 *     earlier window and is never credited;
 *  4. the resolving read really belongs to a later window (`readAt >= hi`).
 *
 * Known bound: a transition read within the lookahead of a demoted window is
 * attributed to it. The bound is what keeps that honest (20 s ~ five cadence
 * windows at the measured 3 s cadence), and a delivered scoring GOAL covering
 * the transition additionally cancels the re-emit (see the run ledger). A
 * transition CONTAINED in a demoted window is attributed to it too (ADAAAA-8017);
 * if it is contained in more than one demoted window the resolver fails closed as
 * ambiguous rather than guessing. */
export function scoreboardDeltaAttestsDeferredWindow(input: {
  window: { lo: number; hi: number };
  delta: ScoreboardDeltaEvidence | undefined | null;
  readAt: number;
  maxLookaheadS?: number;
}): boolean {
  const { window, delta, readAt } = input;
  if (!scoreboardDeltaLegible(delta)) return false;
  const d = delta as ScoreboardDeltaEvidence;
  if (!Number.isFinite(window.lo) || !Number.isFinite(window.hi) || window.hi < window.lo) return false;
  if (!scoreboardDeltaSingleGoalStep(d)) return false;
  if (!Number.isFinite(d.deltaTs) || !Number.isFinite(readAt)) return false;
  const maxLookaheadS = input.maxLookaheadS ?? LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S;
  // ADAAAA-8017: `deltaTs` is a CONTENT timestamp — the first frame that reads
  // the new score — so it routinely lands a fraction of a second BEFORE `hi`
  // while the read itself only reaches the server with a later window (the
  // judged window's payload is assembled behind live). The ADAAAA-8006 bound
  // (`lateBy = deltaTs - hi >= 0`) declined exactly that case, on the reasoning
  // that an in-window delta "is the normal attestation path's business". But this
  // resolver only ever holds rows the normal path FAILED to attest, so declining
  // there leaves a true goal demoted: goal 2 @159 s on `kids300_7935` (build
  // 0f7ef58) is first legible at the 159 s boundary (`2-1` -> `2-2`), the judged
  // window `[149, 159]` carried no attestation, and the row shipped `big_play`
  // with postable recall 1/2.
  // Attribution is therefore by CONTAINMENT plus lookahead: a transition whose
  // instant lies inside the judged window `[lo, hi]` is evidence ABOUT that
  // window's content; one up to `maxLookaheadS` after its close is still
  // attributable (ADAAAA-8006). A transition before `lo` belongs to an earlier
  // window and is never credited here. `readAt >= hi` keeps the resolving read
  // genuinely late — only a window at/after the close may consume a pending row —
  // and `deltaTs` still has to be a legible single goal step, so this cannot
  // widen the ADAAAA-7996 unattested-GOAL gate (it moves a demoted row's verdict,
  // it never accepts anything new).
  if (d.deltaTs < window.lo - 1e-9) return false;
  if (d.deltaTs - window.hi > maxLookaheadS) return false;
  return readAt >= window.hi - 1e-9;
}

// ---------------------------------------------------------------------------
// ADAAAA-7865: one score transition must yield one SCORING highlight.
//
// Job dee44c2f has exactly one score change in 300 s of footage (`POR 0-0 ESP`
// at 153.6 s -> `POR 1-0 ESP` at 159.0 s), yet the deployed VOD observe path
// accepted FOUR GOAL highlights for it (anchors 153.6, 159, 183.1, 190.6). The
// 183/190 windows are post-goal celebration: no score change inside the clip and
// no legible scorebug at the anchor. Each of them was still "corroborated" by
// the Stage-2 pass because `ballInNet` + `ballTrajectoryCrossedLine` are TRUE in
// a replay of the goal-net shot that follows the goal — i.e. the frame
// attestation was earned by celebrating the goal, not by scoring it.
//
// A burst window cannot express this: the duplicates are 24-37 s apart, beyond
// the ADAAAA-6610 30 s window (and any widening of it would swallow genuinely
// distinct goals). The unit that must stay unique is the EVENT, not a duration,
// so the rule is keyed on the already-accepted GOAL's delivered clip:
//
//   * a GOAL accept whose anchor sits inside an accepted GOAL's delivered clip
//     is the same event re-read across overlapping windows -> accepted;
//   * a GOAL accept that carries INDEPENDENT transition evidence (a measured
//     legible scoreboard delta, a goal-calling audio read, or the deep dive's
//     own score-change read of THIS window) opens a NEW event -> accepted;
//   * otherwise, when an accepted GOAL event is within `GOAL_DUPLICATE_REACH_S`,
//     the accept is DOWNGRADED to a non-scoring celebration highlight (still
//     delivered — a celebration window is a legitimate moment — but never a
//     second scoring event for the same transition).
//
// The reach bound keeps recall honest: a goal far from every accepted event is
// a new goal even with no measured evidence, so the rule cannot eat a second
// goal just because this footage's scoreboard is unreadable at 3 fps.
// ---------------------------------------------------------------------------

/** ADAAAA-7865: how far (seconds) a GOAL accept may sit from an accepted GOAL
 * event's anchor and still be treated as a celebration re-read of it. Chosen
 * from the observed footage (post-goal celebrations run 15-40 s past the goal)
 * and kept well inside the range where two DISTINCT goals would need
 * independent evidence to be distinguished anyway. */
export const GOAL_DUPLICATE_REACH_S = 60;

/** ADAAAA-7865: one accepted GOAL event in a run: the instant the delivered
 * clip is anchored on plus the clip window it covers. A later GOAL accept whose
 * anchor falls inside [start, end] is the same event. */
export interface AcceptedGoalEvent {
  /** The accepted highlight's id (audit trail for the downgraded sibling). */
  highlightId: string;
  /** `localizedTs` of the accepted highlight: the instant its clip covers. */
  anchorTs: number;
  /** Delivered clip window start (seconds from stream start). */
  start: number;
  /** Delivered clip window end. */
  end: number;
}

/** ADAAAA-7938 (Spec A): the compact prior-game-state the VOD decide pass
 * forwards into every window after the first.
 *
 * The CEO-visible defect (ADAAAA-7931): the 48 s celebration/replay window of
 * VOD job fe0e3efc was judged in ISOLATION — no story-so-far, no prior-window
 * ASR (the goal call lived in the 42 s window) and no scoreboard-transition
 * state — so the goal's aftermath was re-read as a fresh `scoring_play`. Every
 * field here is MEASURED (a prior decision's own summary/ASR, a legible
 * scoreboard delta, a scored decision's window instant) — never model prose.
 *
 * Bounded server-side before it reaches the prompt: `priorGameStateFor` trims
 * the story/ASR tails and drops the block entirely when nothing is known, so
 * the decide prompt stays byte-identical (AC-A2) and the per-window cost stays
 * inside the AC-A3 bound. VOD-only — the live rail never receives it. */
export interface PriorGameState {
  /** The running story-so-far (bounded tail of the prior decision's summary). */
  story: string;
  /** Tail of the PRIOR window's ASR transcript (where a goal call sits). */
  priorAsr: string;
  /** Measured score as "home-away", when a legible delta was credited. */
  score: string | null;
  /** Content instant of the last scored event (delta ts or decided score). */
  lastScoreTs: number | null;
  /** True when the last score is inside {@link PRIOR_GAME_STATE_REACH_S}: a new
   * goal in THIS window needs its own measured change. */
  needsNewScore: boolean;
  /** Seconds between the last score and this window's centre, when known. */
  sinceLastScoreS: number | null;
}

/** ADAAAA-7938: how far (seconds) the "needsNewScore" claim reaches. Mirrors
 * the deterministic ADAAAA-7865 `GOAL_DUPLICATE_REACH_S` so the prompt and the
 * accept-path rule agree on what counts as a celebration re-read; outside the
 * reach a later window is a candidate for a genuinely distinct goal (recall). */
export const PRIOR_GAME_STATE_REACH_S = GOAL_DUPLICATE_REACH_S;
/** ADAAAA-7938: bounded tails carried in the block (AC-A3 cost bound). */
export const PRIOR_GAME_STATE_STORY_MAX_CHARS = 150;
export const PRIOR_GAME_STATE_ASR_MAX_CHARS = 90;

/** ADAAAA-7938: keep the LAST `cap` chars of a single-lined string. The most
 * recent part of a summary/transcript is the part a celebration window needs. */
export function priorTail(text: unknown, cap: number): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= cap ? flat : "…" + flat.slice(-cap);
}

/** ADAAAA-7865: the evidence a GOAL accept must carry to open a NEW scoring
 * event when it is not covered by an already-accepted goal's clip. Each signal
 * is one that only a transition can produce, never a celebration:
 *
 * - `corroborationSource: "scoreboard"` — a measured, legible, time-tied
 *   scoreboard delta credited the accept (ADAAAA-7844 semantics).
 * - `corroborationSource: "audio_text"` — this window's own audio carried a
 *   goal CALL. Retrospective stat narration ("his 82nd goal ... 151st
 *   appearance") is excluded from that set by `audio_calls_goal`.
 * - a legible measured delta folded into this window's candidate hint.
 *
 * ADAAAA-7938 (guardrail): the Stage-2 dive's own `evidence.scoreboardChanged`
 * read is NOT one of these signals. It is model prose, and a celebration window
 * that merely DISPLAYS the new score makes the dive answer `true` — measured on
 * VOD job 4a0a149d, where the 89.7 s celebration still accepted a second
 * `scoring_play` off that read alone (no measured delta, no goal call). The
 * field stays on the input for audit/reason text; it no longer decides.
 */
export function goalHasIndependentTransitionEvidence(input: {
  corroborationSource?: "audio_text" | "scoreboard" | "frame_attestation" | null;
  scoreboardDeltaLegible?: boolean;
  confirmEvidenceScoreboardChanged?: boolean | null;
}): boolean {
  if (input.corroborationSource === "scoreboard") return true;
  if (input.corroborationSource === "audio_text") return true;
  if (input.scoreboardDeltaLegible === true) return true;
  // ADAAAA-7938: the Stage-2 dive's own `scoreboardChanged` read is NOT
  // independent transition evidence. It is model prose, and a celebration
  // window that merely DISPLAYS the new score ("POR 1-0 ESP" on the bug) makes
  // the dive answer true. Measured on VOD job 4a0a149d after the Spec A prompt
  // landed: the 89.7 s celebration accepted a SECOND scoring_play because the
  // dive read the static 1-0 board, while the window carried no measured delta
  // and no goal call. The transition must be MEASURED (perceive's legible
  // delta / a credited scoreboard source) or HEARD (a goal call in the audio).
  return false;
}

/** ADAAAA-7865: the already-accepted GOAL event this GOAL accept re-reads, or
 * `undefined` when the accept is a NEW scoring event (first goal, a window of an
 * accepted goal's own clip, or a window carrying independent transition
 * evidence). Pure — the caller owns the accepted-event ledger. */
export function findRepeatGoalEvent(
  accepted: readonly AcceptedGoalEvent[],
  input: {
    /** Where the delivered clip would be anchored (localizedTs). */
    anchorTs: number;
    /** The delivered clip window the accept would cover. A clip that OVERLAPS
     * an accepted goal's clip is the same footage — the same event re-read. */
    start: number;
    end: number;
    /** Only GOAL-class accepts are deduped; other event types pass through. */
    isGoal: boolean;
    corroborationSource?: "audio_text" | "scoreboard" | "frame_attestation" | null;
    scoreboardDeltaLegible?: boolean;
    confirmEvidenceScoreboardChanged?: boolean | null;
    /** Override for tests; defaults to {@link GOAL_DUPLICATE_REACH_S}. */
    reachS?: number;
  }
): AcceptedGoalEvent | undefined {
  if (!input.isGoal) return undefined;
  if (goalHasIndependentTransitionEvidence(input)) return undefined;
  const anchor = input.anchorTs;
  if (!Number.isFinite(anchor)) return undefined;
  const reach = input.reachS ?? GOAL_DUPLICATE_REACH_S;
  let nearest: AcceptedGoalEvent | undefined;
  let nearestDiff = Infinity;
  for (const ev of accepted) {
    // The event's own footage: an overlapping clip window is the same goal
    // re-read across neighbouring windows, never a second scoring event.
    const overlaps = input.start < ev.end && ev.start < input.end;
    if (overlaps) return undefined;
    const diff = Math.abs(anchor - ev.anchorTs);
    if (diff <= reach && diff < nearestDiff) {
      nearestDiff = diff;
      nearest = ev;
    }
  }
  return nearest;
}

/** ADAAAA-7865: downgrade a repeat GOAL accept to a non-scoring celebration
 * highlight. The clip is still cut and delivered (celebration windows stay
 * accepted — they are real moments), but its outcome leaves the scoring lane, so
 * it can never be posted as a second GOAL for one score transition. The original
 * decision's evidence fields stay on the record for audit. */
export function downgradeRepeatGoalCelebration(d: DecisionResult, repeat: AcceptedGoalEvent): DecisionResult {
  const note = `celebration of an already-delivered goal (anchor ${repeat.anchorTs.toFixed(1)}s, highlight ${repeat.highlightId}): no independent score-transition evidence in this window`;
  return {
    ...d,
    outcome: "big_play",
    eventType: "BIG_PLAY",
    reason: d.reason ? `${d.reason} | ${note}` : note,
  };
}

export interface DecisionResult {
  isHighlight: boolean;
  score: number;
  eventType?: string;
  reason?: string;
  // Increment F / ADAAAA-6465: outcome taxonomy member + near-miss flag. A
  // near miss is notable but NOT a scoring play — surfaced at a lower score and
  // flagged so the highlight-clip is labeled distinctly downstream.
  outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
  nearMiss?: boolean;
  // ADAAAA-7008 / ADAAAA-7012: when the verdict is uncertain and asks for MORE
  // evidence for this moment before finalizing, the server calls perceive
  // on-demand (`recallPerceive`) and folds the fresh context into the payload.
  // Absent / false => no recall (default). Optional + backward compatible.
  recall?: boolean;
  // ADAAAA-7111 (Increment D): the running video summary (story-so-far) the
  // decide brain updated for this window. The server persists it onto the job
  // and forwards it into the next cadence tick. Optional + additive.
  runningSummary?: string;
  // ADAAAA-7155 Increment A / ADAAAA-7156 Increment B: the per-window analysis
  // payload (exact prompt / ordered dataItems / media refs / full response)
  // returned by the decide service for this window. Carried across the adapter
  // boundary and persisted onto the JobCandidate so the job-detail API can
  // expose it. Observability only; no inference change. Absent on legacy
  // verdicts that predate the capture.
  analysis?: WindowAnalysis;
  // ADAAAA-7543: the reviewer-facing rationale the decide pass returned
  // (I1/ADAAAA-6358). The server forwards this whole Stage-1 object on the
  // confirm request, so ``verdict.criteria`` — ballInNet /
  // ballCrossedLineBetweenPosts — is what the decide /confirm two-signal
  // attestation check reads (ratified ADAAAA-7555 Option 1). Corroboration
  // INPUT only; never a server-side accept gate.
  verdict?: { criteria?: Record<string, boolean | null>; [key: string]: unknown };
  // ADAAAA-7988: present when this live window was promoted from a
  // celebration/reaction read to a goal candidate because it follows an
  // attack/shot window (the goal instant fell between 1 fps samples). Carries
  // the cited prior-window evidence so the note, the confirm request and the
  // job-detail view all name the same instants.
  goalRecall?: LiveGoalRecall;
}
/** ADAAAA-7938 (Spec A): did this window's verdict decide a SCORING play? Used
 * only to advance the prior-game state on the decide path (the accept path's
 * ledger lags it), so a later window knows a score already happened. Taxonomy
 * first; a legacy verdict with no outcome falls back to a GOAL/GOL label. */
export function isScoringDecision(d: Pick<DecisionResult, "isHighlight" | "outcome" | "eventType">): boolean {
  if (!d?.isHighlight) return false;
  if (d.outcome === "scoring_play") return true;
  if (d.outcome) return false;
  return /^(GOAL|GOL)$/i.test(String(d.eventType ?? "").trim());
}

// ADAAAA-6855: map job-requested highlight labels (preferLabels) to the
// outcome taxonomy members they authorize for export. A requested non-goal
// class may be recorded as a DISTINCT highlight even though it is not a
// scoring play. Conservative — never widens goal acceptance. Mirrors the
// decide service's NON_GOAL_LABEL_OUTCOMES in gemma.py (keep in sync).
const NON_GOAL_LABEL_OUTCOMES: Record<string, Set<string>> = {
  goals: new Set(["scoring_play"]),
  "near-misses": new Set(["near_miss"]),
  saves: new Set(["near_miss", "big_play"]),
  "red cards": new Set(["big_play"]),
  "counter-attacks": new Set(["big_play"]),
};

function requestedOutcomes(preferLabels?: string[]): Set<string> {
  const out = new Set<string>();
  for (const lab of preferLabels ?? []) {
    const mapped = NON_GOAL_LABEL_OUTCOMES[lab.trim().toLowerCase()];
    if (mapped) for (const m of mapped) out.add(m);
  }
  return out;
}

/** ADAAAA-6969: derive the TRUE public `eventType` label from the outcome
 * taxonomy member. A non-scoring highlight (`near_miss` / `big_play`) is never
 * published as "GOAL" — the label reflects the outcome class (NEAR_MISS /
 * BIG_PLAY), so a keeper save / near-miss surfaces as a distinct non-goal
 * highlight. A frame-confirmed `scoring_play` stays "GOAL". Any other / unknown
 * outcome defers to `fallback` (the candidate/model label).
 *
 * Kept in sync with `event_type_for_outcome` in services/decide/app/gemma.py
 * (ADAAAA-6969) so the public label and the decide-note always agree. */
export function eventTypeForOutcome(
  outcome: DecisionResult["outcome"],
  fallback?: string
): string | undefined {
  switch (outcome) {
    case "scoring_play":
      return "GOAL";
    case "near_miss":
      return "NEAR_MISS";
    case "big_play":
      return "BIG_PLAY";
    default:
      return fallback;
  }
}

/** ADAAAA-6969: the eventType a highlight carries: the outcome-derived label
 * when the outcome is known (never a stale candidate/model "GOAL" on a
 * non-scoring class), else the decision's own eventType / candidate type. */
function highlightEventType(decision: DecisionResult, fallback?: string): string {
  return eventTypeForOutcome(decision.outcome, decision.eventType ?? fallback) ?? "";
}

/**
 * ADAAAA-6598: the single server-side accept gate. ONLY a frame-confirmed
 * scoring_play is a board-accepted GOAL highlight. A near_miss / big_play /
 * not_highlight read is never surfaced as a scoring highlight, even when a
 * rogue/misconfigured decide verdict sets isHighlight=true — so no false
 * positive reaches the board. A legacy verdict with no `outcome` is treated
 * per its isHighlight (backward compatible). This is defense-in-depth on top of
 * the decide service's own finalize_goal_acceptance.
 *
 * ADAAAA-6855: when the job explicitly requested a non-goal class in
 * `preferLabels`, that class is accepted as a DISTINCT highlight (outcome /
 * eventType preserved, never a goal) so a correctly-detected near-miss / save /
 * red-card / counter-attack is exported rather than swallowed.
 */
export function isAcceptedHighlight(d: DecisionResult, preferLabels?: string[]): boolean {
  if (!d.isHighlight) return false;
  if (d.outcome === undefined) return true; // legacy verdict, trust isHighlight
  // ADAAAA-7621: precision gate — a scoring_play whose OWN verdict text refutes
  // the goal is not accepted, regardless of eventType. This is the false-positive
  // class found on job d61e52f6: a Stage-1 read said the ball "does not enter the
  // net", a later scoreboard/frame pass overrode it and handed back
  // isHighlight=true + outcome=scoring_play, and the clip was persisted as an
  // accepted GOAL. The record's own evidence wins over the aggregate verdict.
  if (d.outcome === "scoring_play") return !isGoalRefutingReason(d.reason);
  return requestedOutcomes(preferLabels).has(d.outcome);
}

// ---------------------------------------------------------------------------
// Stage-2 goal/near-miss CONFIRMATION pass (ADAAAA-6797) — server-side VOD
// driver. The decide /confirm endpoint (services/decide/app/confirm.py) is the
// owner of the actual deep-frame-dive verdict; this file only (1) detects the
// trigger population (goal-type + no independent attestation + Stage-1
// scoring_play accept), (2) assembles the higher-fidelity confirm context from
// data the server already holds (cached frame window / trajectories / audio
// tap), (3) routes the candidate through the adapter `confirm()` call, and
// (4) adopts the reconciled decision (or keeps Stage-1 on passthrough / any
// failure). It is gated by `cfg.confirmEnabled`, which BOTH the VOD and the live
// pass wire from `DECIDE_CONFIRM_ENABLED` (ADAAAA-7663 removed the VOD-only
// restriction), so the flag-off path is a strict no-op on both passes.
// ---------------------------------------------------------------------------

/** The Stage-2 confirmation-pass response (mirror of ConfirmDecision). */
export interface ConfirmDecision {
  /** Was the pass enabled on the decide side. */
  enabled: boolean;
  /** Structured verdict: confirmed_goal | near_miss | not_goal, or null on the
   * passthrough path (disabled / unparseable). */
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal" | null;
  /** Model self-confidence 0..1. */
  confidence: number;
  /** Short grounded reason naming the deciding evidence. */
  reason: string;
  /** Per-evidence tri-state read (true / false / null). */
  evidence: Record<string, boolean | null>;
  /** Whether this pass corrected the Stage-1 read (the core value metric). */
  stage1Disagreed: boolean;
  /** ADAAAA-7162/7185: whether an independent corroboration signal was present
   * (measured scoreboard change, goal-calling audio text, or the two-signal
   * frame attestation) and which one fired. Persisted so accepted ==
   * corroborated is queryable post hoc. */
  corroborated?: boolean;
  corroborationSource?: "audio_text" | "scoreboard" | "frame_attestation" | null;
  /** ADAAAA-7251 (ACC-3): the ASR transcript computed for the highlight's audio
   * context (Path 2, fallible), returned so the server can persist it on the
   * highlight record for human corroboration. "" / absent where no audio
   * context / ASR was not computed. */
  transcript?: string;
  /** ADAAAA-7844: the MEASURED, legible scoreboard delta the corroboration was
   * credited/labelled from (parsed pre/post + sample counts + transition
   * instant). Absent when no legible delta was measured. */
  scoreboardDelta?: ScoreboardDeltaEvidence;
  /** The reconciled HighlightDecision-shaped dict to adopt in place of the
   * Stage-1 verdict. On passthrough it is the (unchanged) Stage-1 verdict. */
  decision: DecisionResult;
  // ADAAAA-7155 Increment A / ADAAAA-7156 Increment B: the confirmation-pass
  // analysis record (exact confirm prompt + request context summary +
  // ConfirmDecision) returned by the decide /confirm endpoint. Carried across
  // the adapter boundary and persisted onto the JobCandidate's `confirm` block
  // so the job-detail API can expose the deep-frame dive. Observability only;
  // no inference change. Absent on passthroughs that never built a prompt.
  analysis?: ConfirmRecord;
}

/** The confirmation-pass request the adapter forwards to decide `/confirm`. */
export interface ConfirmRequest {
  eventType: string;
  timestamp: number;
  gameHint: string;
  /** Stage-1 primary-pass verdict, presented back to the model. */
  stage1: DecisionResult;
  /** Denser temporal frame window (~10-15 fps) around the event instant. */
  frames: { role: string; base64: string }[];
  /** Precise pre-event / event-instant / post-event keyframes. */
  keyframes: { role: string; base64: string }[];
  /** Object/ball trajectory tracks: { label, trackId, path: [[t,x,y],..] }. */
  trajectories: { label: string; trackId: string; path: number[][] }[];
  /** Motion / optical-flow magnitude at the event (0 when unavailable). */
  opticalFlowMagnitude: number;
  /** Motion magnitude series across the sample ([] when unavailable). */
  flowMagnitudes: number[];
  /** Short RMS audio-energy envelope ([] when unavailable). */
  audioLevels: number[];
  /** Surrounding audio clip (mono 16 kHz WAV base64) — "" when unavailable. */
  audioB64: string;
  /** Optional independent corroboration — INPUT only, never a gate. */
  ballOutcome?: string;
  goalCrossed?: boolean;
  scoreBoardChanged?: boolean;
  /** ADAAAA-7844: the measured, legible scoreboard delta behind
   * `scoreBoardChanged`. The decide pass credits a scoreboard corroboration only
   * when this is present and legible (both sides parsed, >= 2 OCR samples each,
   * time-tied), so a bare boolean can never be labelled "scoreboard". */
  scoreBoardDelta?: ScoreboardDeltaEvidence;
}
/** One audio chunk fed to the Stage-A noise-change gate (INC-2 / ADAAAA-4325).
 * Owned by the server's ffmpeg audio tap: short (default ~100 ms) mono int16
 * little-endian PCM, base64-encoded, matched to perceive's AudioChunkRequest. */
export interface AudioChunk {
  /** Optional chunk sequence; <0 -> perceive uses its per-session counter. */
  seq: number;
  /** Seconds from stream start (this chunk's end timestamp). */
  timestamp: number;
  /** base64 of planar mono int16 LE PCM (ffmpeg `-ac 1 -c:a pcm_s16le -f s16le`). */
  samples: string;
  streamId?: string;
}
/** The audio noise-change gate fired a Stage-A candidate (INC-2 / ADAAAA-4325).
 * Returned by perceive /audio when the gate tripped; ``null`` when it did not.
 * The gate marks a candidate only — it never decides a highlight. The server
 * routes this to ``decide()`` on the anchored frame (slice 4). */
export interface AudioCandidate {
  eventType: string;
  seq: number;
  timestamp: number;
  audio?: {
    kind: string;
    ts: number;
    firedAt: number;
    onsetLatencyS: number;
    peakEnergy: number;
    baselineEnergy: number;
  };
}
/** ADAAAA-7255: the perceive /audio response — the candidate the gate fired
 * (or null) plus the bounded per-chunk (t, energy, baseline) inspection series
 * used for the request-inspection energy-vs-baseline graph. Each point is
 * ``{t, energy, baseline}`` (seconds over the stream, energies 0..1). */
export interface AudioPostResult {
  candidate: AudioCandidate | null;
  series: { t: number; energy: number; baseline: number }[];
  /** ADAAAA-7707: the Stage-B whistle fire (`stageB/whistle/2.4-3.4k/5x/0.3s`)
   *  plus perceive's emit-switch state. Present whenever the whistle gate fired,
   *  emitted or not — the live loop gates on `emitted` so the config-only
   *  rollback is inert. `null` when no whistle fired on this chunk. */
  whistle?: WhistleFireBlock | null;
}
/** The decide brain's single-shot what-to-track plan (plan §4.4 / §7 D).
 * Returned by PipelineClient.plan(). `maxTracks` arrives already clamped to
 * the mode cap (3 live / 8 VOD) by the decide runner. */
export interface TrackingPlanResult {
  planVersion: number;
  category: string;
  intent: string;
  source: "planner" | "planner-fallback";
  plannedAt?: number;
  anchor?: Record<string, unknown>;
  targets?: { label: string; role?: string; slotPriority?: number; track?: boolean }[];
  zones?: Record<string, unknown>[];
  discovery?: Record<string, unknown> | null;
  maxTracks: number;
  reason?: string;
  [k: string]: unknown;
}

/** Perceive's `/app/control` ack (ADAAAA-7833). `track-player` answers with
 * `{type:"ack", ok:true, cmd, number, slot, trackId, selected, bbox}` on a
 * successful identification, or `{type:"ack", ok:false, cmd, number, retrying:true,
 * retryWindowFrames, retryStride, retryAttempts, error}` when the jersey was not
 * legible on the anchor frame and the bounded per-frame retry window is open.
 * Plain failures carry `ok:false` + `error` only. Indexable so the server can
 * forward the body verbatim without a lossy projection. */
export interface ControlAck {
  type?: string;
  ok?: boolean;
  cmd?: string;
  error?: string;
  retrying?: boolean;
  [k: string]: any;
}

export interface PlanRequest {
  intent: string;
  category: string;
  gameHint?: string;
  mode?: "live" | "vod";
  context?: Record<string, unknown>;
  /** ONE representative frame (base64 JPEG), never a sequence. */
  imageB64?: string;
}

/** ADAAAA-6489 / ADAAAA-7159 Gap 2: a REAL per-camera/per-clip goal-line
 * calibration delivered to perceive on every /analyze so the goal-line signal
 * (goalCrossed/ballOutcome) is genuine — never a fabricated uncalibrated flip.
 * `homography` is the row-major 3x3 image->field pitch homography (9 numbers)
 * for THIS session's camera/clip; `goalLine` is the goal-line plane spec in the
 * calibration's field coords `{axis, position, mouthMin, mouthMax}`. Absent ->
 * perceive falls back to image space / no goal-line signal (reported as
 * not_captured, never fabricated). */
export interface GoalLineCalibration {
  homography?: number[];
  goalLine?: { axis?: string; position?: number; mouthMin?: number; mouthMax?: number };
}

/** ADAAAA-6935: one Stage-A candidate trigger accumulated within a 3 s frame
 * group, carrying its own decide-evidence snapshot so a single merged group
 * review can return a per-trigger verdict (per-trigger accept / exactly-once
 * billing preserved, AC7). */
export interface GroupCandidate {
  /** The frame-group partition key: timestamp of the frame that fired it. */
  timestamp: number;
  eventType: string;
  /** Decide evidence snapshot captured at candidate fire time. */
  evidence: Parameters<PipelineClient["decide"]>[0];
}

/** ADAAAA-6935: the payload of ONE merged decide review over a 3 s frame
 * group. `frames` is the group's frame sequence (temporal order); the decide
 * service runs a SINGLE gemma review over them + every `candidates` entry and
 * returns one verdict per candidate (in order), so decide GPU calls drop from
 * ~#triggers to ~#groups-with-a-trigger. */
export interface GroupDecodeRequest {
  gameHint?: string;
  preferLabels?: string[];
  reasoningEffort?: string;
  /** ADAAAA-7626: audit identity for the merged group review. Without these the
   * decide service emits a descriptor with no job/group identity, so the merged
   * path would lose decide_audit attribution entirely. */
  jobId?: string;
  groupKey?: string;
  /** The whole group's frame sequence (full frames, temporal order). */
  frames?: { role: string; base64: string }[];
  /** Surrounding audio clip (mono 16 kHz WAV, base64) for the group. */
  audioB64?: string;
  /** ADAAAA-7856: the job's stored match context, forwarded so the merged group
   * review names the real teams too. Absent => unchanged group request. */
  matchContext?: DecideMatchContext;
  candidates: GroupCandidate[];
}

export interface PipelineClient {
  reservePerceive(): Promise<ReserveResult>;
  analyze(
    sessionId: string,
    frame: { seq: number; timestamp: number; imageB64: string; clipPath?: string },
    opts?: { gameHint?: string; preferLabels?: string[]; loraRef?: string; trackingPlan?: Record<string, unknown> } & GoalLineCalibration
  ): Promise<ObservationResult>;
  /** Single-shot what-to-track planner call (plan §4.4 / §7 D). The worker
   * fires this at stream-start warm-up + out-of-band re-check cadence — NEVER
   * from the per-frame hot path (the 1-5 s live budget rule). Priced like a
   * decide /highlight call. Returns a validated TrackingPlan or, on ANY
   * failure, a safe-default fallback (source "planner-fallback") — never an
   * exception, so a bad planner reply never kills a stream. */
  plan(req: PlanRequest): Promise<TrackingPlanResult>;
  /** Feed one audio chunk to the perceive session's Stage-A noise-change gate.
   * Pure DSP on the perceive side — never touches the detector/SAM/Gemma, so
   * this path bills no GPU. Fires a *candidate* only (returned to the caller so
   * the server can route it to ``decide()``); ``null`` when the gate didn't
   * trip. The gate never decides a highlight itself. */
  postAudio(sessionId: string, chunk: AudioChunk): Promise<AudioPostResult>;
  /**
   * Deliver an operator/find-and-track control intent (INC-6 / ADAAAA-4330) to
   * the perceive session over HTTP: `track`/`seed`/`lock`/`evict`, plus the
   * pre-existing configure/ping. The UI surfaces object selection (bbox) as a
   * `track` intent; perceive marks the slot selected and follows it.
   *
   * Returns perceive's `/app/control` ack body so a caller that needs the
   * outcome (`track-player`, ADAAAA-7833 — a jersey that is not legible on the
   * anchor frame is an `ok:false` ack plus a bounded retry window) can surface
   * it. `null` when the runner answered non-2xx (a 404 on a re-reserved session)
   * or the body was unparseable; best-effort callers ignore the value.
   */
  controlForward(sessionId: string, control: { type: string; [k: string]: any }): Promise<ControlAck | null>;
  /**
   * On-demand perceive recall (ADAAAA-7008 / ADAAAA-7012). When a decide verdict
   * requests more evidence for a moment, the server asks perceive for the
   * per-frame derived context (tracks / objects / ocr) ALREADY computed by
   * process_frame — WITHOUT re-running the detector — and the caller folds it
   * into the payload via `applyOnDemandRecall` before finalizing. `seeds` is `[]`
   * on a no-op (nothing cached / best-effort failure), which the caller treats
   * as "no new evidence" so a recall never regresses a decision. Optional so a
   * client/FAKE without recall support simply never recalls (no regression).
   */
  recallPerceive?(
    sessionId: string,
    req: { centerTs?: number; windowS?: number; startTs?: number; endTs?: number }
  ): Promise<{ centerTs?: number; seeds: PerFrameSeed[] }>;
  /**
   * ADAAAA-7855: resolve + persist the job's match context (who is playing,
   * which colour each team wears). Called at most THREE times per VOD job (job
   * start, >=25%, >=50%) with the server-side half of the evidence (bounded ASR
   * transcript + metadata hints + the previously stored context for the
   * monotonic guard). Perceive folds it against evidence it already computed,
   * so this adds NO GPU call. Optional so a FAKE/older client simply never
   * resolves — the job then has no `matchContext`, i.e. pre-feature behaviour.
   */
  postMatchContext?(
    sessionId: string,
    payload: Record<string, unknown>
  ): Promise<{ matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null>;
  /**
   * Decide whether a candidate is a highlight. `imageB64` is the candidate
   * frame so the Gemma 12B QAT decide runner sees the actual moment (vision),
   * not just scalar evidence. Adapt the call site to forward it.
   */
  decide(
    evidence: {
      eventType: string;
      trackCount: number;
      maxVelocity: number;
      ocrHits: number;
      reaction?: ReactionEvidence; // INC-4 people-reaction context
      // Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth
      // signal, forwarded first-class so decide can hard-gate on it.
      goalCrossed?: boolean;
      ballOutcome?: string;
      /** I3 (ADAAAA-6360): a scoreboard score change was detected across the
       * candidate window — a hard, independent goal-confirmation signal. The
       * decide runner must force isHighlight=true for a goal when set, and
       * treat absence as weak/absent evidence (never on its own a goal). */
      scoreBoardChanged?: boolean;
      // I4 / ADAAAA-6361: per-detection geometry + ball position + audio level
      // curve so the prompt can cite concrete evidence (all optional).
      detections?: DetectionEvidence[];
      ballPosition?: [number, number] | null;
      distanceToGoal?: number;
      goalLineDelta?: number;
      audioLevels?: number[];
    },
    opts?: {
      gameHint?: string;
      imageB64?: string;
      reasoningEffort?: string;
      /** Detail-first (ADAAAA-4954): temporal frame SEQUENCE the Gemma runner
       * reasons across (decideWindowN-length). Absent = single image (live).
       * ADAAAA-7734: `seq` is the frame's global rail position, forwarded so a
       * decide note's `analysis.frames[]` can name the exact frame file. The
       * decide service ignores it (ImageRef keeps role/base64); the server
       * rewrites the refs from the observe payload after the verdict. */
      frames?: { role: string; base64: string; seq?: number }[];
      /** Surrounding audio clip (mono 16 kHz WAV, base64) at the trigger. */
      audioB64?: string;
      /** The current 60 s window's already-computed facts as bounded text (A2,
       * ADAAAA-6029). Assembled on the server from cached findings — no
       * re-analysis. The decide-runner contract add (ADAAAA-6030) wires this
       * into the prompt; empty when the window has nothing to add. */
      priorContextText?: string;
      /** ADAAAA-7028 Inc 2 audit identity forwarded so the decide audit
       * descriptor keys the durable index by (sessionId, groupKey). */
      jobId?: string;
      groupKey?: string;
      /** ADAAAA-7111 (Increment D): the running video summary (story-so-far)
       * carried into this cadence decide so the model EXTENDS it. Empty on the
       * first tick. Absent = no prior summary (unchanged behaviour). */
      storySoFar?: string;
      /** ADAAAA-7781: ask the decide service for the COMPACT verdict contract on
       * the live rail (short prose, no evidenceAttested, 400-token cap). The live
       * pass is decode-bound, so output tokens per call IS its throughput
       * ceiling. Absent/false = the full long-form contract. */
      compact?: boolean;
      /** ADAAAA-7856: the job's persisted match context (teams + kit colours).
       * Read from storage via `AnalyzerConfig.getMatchContext` — never recomputed
       * per window. Absent = no MATCH CONTEXT prompt block (byte-identical
       * request/prompt to the pre-feature path). */
      matchContext?: DecideMatchContext;
      /** ADAAAA-7938 (Spec A): the VOD pass's compact prior-game-state block
       * (running story-so-far / prior-window ASR tail / measured scoreboard
       * transition). Absent = no PRIOR GAME STATE prompt block, so the request
       * and the rendered prompt are byte-identical to today (AC-A2). */
      priorGameState?: PriorGameState;
    }
  ): Promise<DecisionResult>;
  /**
   * Decide ALL candidates in one 3 s frame group with a SINGLE gemma review
   * (ADAAAA-6935). `req.frames` is the group's frame sequence; the decide
   * service runs ONE inference over them + every `req.candidates` entry and
   * returns a verdict per candidate, in candidate order. Per-trigger accept
   * side-effects (cut / highlight record / billing exactly once) are applied
   * by the caller, so merged grouping never drops a genuine highlight or
   * double-bills (AC7). Optional: a client (or test fake) that does not
   * implement the merged review falls back to a per-candidate `decide` loop,
   * preserving the old per-trigger behavior with no regression.
   */
  decideGroup?(req: GroupDecodeRequest): Promise<{ verdicts: DecisionResult[] }>;
  /**
   * Stage-2 goal/near-miss confirmation pass (ADAAAA-6797). For a goal-type
   * candidate that carried no independent attestation and read as a Stage-1
   * scoring_play, run the decide `/confirm` deep frame dive with the Stage-1
   * verdict + the higher-fidelity confirm context, and return the reconciled
   * verdict. Reuses the same fixed-price decide-runner path as `decide`/`
   * /highlight` (1 billable unit; 402 -> signer -> retry). The runner returns a
   * passthrough (goalConfirmed null) when disabled/unparseable, and a transport
   * failure is a rejected promise — either way the caller keeps Stage-1.
   */
  confirm(req: ConfirmRequest, opts?: { reasoningEffort?: string; jobId?: string }): Promise<ConfirmDecision>;
  /**
   * Submit a single-shot fine-tune job to the highlights-train runner
   * (Florence-2 <OD> LoRA). The runner blocks until the job finishes and the
   * 200 body carries the trained checkpoint path + eval delta report, which the
   * server folds into the surfaced TrainRun result.
   */
  train(request: TrainRunRequest): Promise<TrainResult>;
  stopPerceive(sessionId: string): Promise<void>;
}

/** Manifest + hyper-params for a highlights-train single-shot job. Mirrors the
 * env contract of the train-entrypoint (docker/train-entrypoint.sh). */
export interface TrainRunRequest {
  manifest: string; // JSONL DetectionTrainingSample manifest (newline-delimited JSON)
  val?: string; // optional held-out val manifest (JSONL)
  epochs?: number; // default 5
  batchSize?: number; // default 8
  lr?: number; // default 1e-4
  baseModel?: string; // default microsoft/Florence-2-base
}

/** Result of a completed highlights-train job (mirrors fine_tune_od.py output). */
export interface TrainResult {
  run?: string;
  checkpoint?: string;
  out?: string;
  adapter?: string;
  eval?: {
    eval?: string; // "skipped" when no val manifest
    reason?: string;
    precision?: number;
    recall?: number;
    f1?: number;
    [k: string]: unknown;
  };
  /** Run-scoped downloadable artifact metadata (fileName + integrity hash). */
  artifact?: TrainArtifact;
  epochs?: number;
  samples?: number;
  [k: string]: unknown;
}

export interface AnalyzerConfig {
  clipBeforeS: number;
  clipAfterS: number;
  /** Hard floor (seconds) on the delivered highlight clip length (ADAAAA-7232).
   * Guarantees Acc-1 (>=15 s) even when clipBeforeS/clipAfterS are tuned low. */
  clipWindowMinSec?: number;
  jobId: string;
  gameHint: string;
  /**
   /** Operator closed-vocabulary labels (ADAAAA-4109). Delivered to the perceive
    * session on every /analyze alongside gameHint so the paid VOD path activates
    * the closed soccer roster (`resolve_vocabulary`) instead of open-set OD.
    */
   preferLabels?: string[];
  /** Per-stream LoRA injection (ADAAAA-5324): optional ref to this job's
   * stream-attached merged Florence-2 model dir. When unset the perceive
   * session serves the base model (no regression on base-stream detection).
   * Flowed to perceive on every /analyze exactly like gameHint/preferLabels. */
  loraRef?: string;
  /** Per-camera/per-clip goal-line calibration (ADAAAA-6489 / ADAAAA-7159 Gap 2):
   * a REAL image->field pitch homography + goal-line plane spec for THIS
   * session's clip/camera, delivered to the perceive session on every /analyze
   * (with gameHint/preferLabels/trackingPlan) so the goal-line crossing signal
   * (goalCrossed/ballOutcome) is genuine, not a single static env value. When a
   * clip has no calibrated homography/spec the fields are simply absent, so
   * perceive emits no ballOutcome/goalCrossed and the metric reports
   * not_captured (never a fabricated signal). */
  calibration?: GoalLineCalibration;
  /** Detail-first VOD knobs (ADAAAA-4954, spec §1). When absent the pass runs at
    * the live/default depth (1 fps frames, 16-frame window, single decide image).
    * When `decideWindowN` is set the pass is "detail-first": the shared frame
    * window is that long, and each decide() call forwards the temporal
    * `frames[]` SEQUENCE (+ surrounding audio clip) so Gemma reasons deeper per
    * trigger than the single-image live baseline. `frameScale` is the extract
    * scale for OD + decide images. */
   sampleFps?: number;
   frameScale?: string;
   decideWindowN?: number;
   /** I7 / ADAAAA-6361: higher-FPS re-sample around a trigger. When set (detail-
    * first VOD), the decide call site re-samples frames around the candidate
    * timestamp at a higher FPS so the ball-goal-crossing instant is actually in
    * the decide window (a 1 FPS / low-fps sample can skip it). Returns absolute-
    * timestamped frames (always >= 1); a throw/[] degrades to the rolling window. */
   resampleFrames?: (timestamp: number) => Promise<{ timestamp: number; imageB64: string }[]>;
   /**
   * ADAAAA-6314 Path 2: forward the surrounding audio clip on the LIVE baseline
   * too (bounded to trigger candidates — never every frame; no `frames[]`
   * change, so live frame depth is untouched). The go-livepeer decide runner
   * (or the ASR endpoint it calls) transcribes it to text for the gemma prompt.
   * Default off so the deployed live baseline sends no new payload until an
   * operator enables it. `LIVE_AUDIO_CONTEXT`.
   */
   audioContext?: boolean;
  /**
   * ADAAAA-7777 (lever B, trim 2): include the window AUDIO CLIP on the observe
   * decide payload (`opts.audioB64`). `audioContext` still drives the audio-energy
   * level curve (`evidence.audioLevels` + reaction crowdEnergy) — that is the
   * shared noise-change detection contract, so it stays wired when this flag is
   * off. Only the raw clip (and the ASR transcript the decide service derives
   * from it) is gated here. Unset = include, the pre-trim behaviour.
   */
  decideAudioClip?: boolean;
  /** ADAAAA-7781: ask the decide service for the COMPACT verdict contract on the
   * live observe rail (short prose fields, no `evidenceAttested` list, 400-token
   * completion cap). Live decide throughput is decode-bound — decisions/s =
   * output tokens/s ÷ tokens per call — so the per-call token count IS the
   * ceiling: the full contract (~420 tokens) gives 0.36 decides/s at 2 streams
   * against a 0.66/s cadence demand, the compact one ~150 tokens. Unset = the
   * full contract, byte-identical to the pre-flag request. */
  liveDecideCompact?: boolean;
  /** Increment F / ADAAAA-6465 (plan §4.9): analysis FPS cap for the assembly
   * of the frame sequence the LLM watches per trigger. Default 5 (live). The
   * sequence is sampled at this rate around the trigger, always includes the
   * keyframe set, and is HARD-CAPPED at `maxFramesPerAnalysis`. Frames are the
   * PRIMARY evidence; audio is a cheap, fallible trigger/corroboration. Raising
   * the cap is a per-call Livepeer GPU cost decision. `ANALYSIS_FPS` /
   * `VOD_ANALYSIS_FPS` (VOD detail-first gets a higher cap). */
   analysisFps?: number;
  /** Hard cap on the number of frames that reach the LLM in ONE analysis call
   * (never exceeded — plan §4.9D). Live default ≈ 25 + 3 keyframes = 30.
   * `MAX_FRAMES_PER_ANALYSIS` / `VOD_MAX_FRAMES_PER_ANALYSIS`. */
   maxFramesPerAnalysis?: number;
  /** Pre/post window (seconds) around the trigger the assembler samples.
   * Default 2 s pre / 3 s post (plan §4.9A). VOD may lengthen these (detail-
   * first; speed secondary). `ANALYSIS_PRE_WINDOW_S` / `ANALYSIS_POST_WINDOW_S`. */
   preWindowS?: number;
   postWindowS?: number;
  /**
   * Max times the job will re-reserve a fresh perceive session after the
   * current one is lost mid-pass (HTTP 404 "runner not found" / "runner
   * session not found"). The perceive live-runner's health can flap and
   * go-livepeer then releases all its sessions, turning the in-flight
   * `/analyze` into a 404. Bounded re-reserve lets a VOD pass ride through a
   * transient perceive restart by reconnecting to the recovered runner;
   * beyond this we abort cleanly instead of spinning. Default 3.
   */
  maxReReserves?: number;
  /**
   * ADAAAA-6577: base delay (ms) of the bounded exponential backoff slept
   * between a session-lost re-reserve and the next retry of the same frame.
   * A flapping perceive runner 404s every /analyze; backing off (500ms -> 1s
   * -> 2s -> …, capped) keeps the re-reserve cadence near ~1/sec and lets the
   * pass ride through a brief runner recovery instead of hammering the
   * orchestrator. Wired from `VOD_SESSION_RETRY_BACKOFF_MS` (default 500).
   */
  sessionRetryBackoffMs?: number;
  /** ADAAAA-6577: upper bound (ms) of the exponential backoff above. The delay
   * never exceeds this, so a long-lived flap still re-reserves at most
   * `maxReReserves` times per frame at the capped cadence and then aborts.
   * Wired from `VOD_SESSION_RETRY_BACKOFF_MAX_MS` (default 8000). */
  sessionRetryBackoffMaxMs?: number;
  /** ADAAAA-7203: max attempts to reserve a fresh perceive session within ONE
   * re-reserve after a session-lost, retried with the bounded backoff when the
   * runner is momentarily unavailable (deploy-recreate / re-registration: the
   * orchestrator 404s "runner not found" or 503s "no capacity" while the runner
   * is down). A single immediate reserve 404s and would abort the whole pass;
   * retrying lets the pass ride through the recovery and resume. Bounded
   * (default 5) so it never spins. */
  reReserveAttempts?: number;
  /**
   * Increment D (ADAAAA-6467): the stream-start warm-up window (seconds)
   * within which exactly ONE planner call must deliver a valid TrackingPlan
   * before the per-frame loop begins steady-state tracking. The worker does
   * NOT block the per-frame loop on the planner; it applies a safe-default
   * interim roster (via the session's trackingPlan from perceive's canned
   * map) until the plan lands. Exceeding the window just means the plan
   * applies late — never a per-frame planner call. `WARMUP_SECONDS` (default
   * 3).
   */
  warmupSeconds?: number;
  /**
   * Increment D (ADAAAA-6467): the out-of-band re-check cadence (seconds).
   * A scheduler samples a few frames from the rolling frame window OFF the
   * per-frame path and re-plans the TrackingPlan, swapping the active roster
   * within (~) this interval when the brain detects a type change (scene cut
   * / different feed). Default 10. `RECHECK_INTERVAL_SECONDS`.
   */
  recheckIntervalSeconds?: number;
  /**
   * The pass mode (live | vod), forwarded to the planner so it proposes
   * within the correct cap (3 live / 8 VOD). The live path is "live"; the
   * detail-first VOD path is "vod". Default "live".
   */
  planMode?: "live" | "vod";
  /**
   * ADAAAA-6610 GOAL burst-suppression window (seconds) for this pass. At most
   * one GOAL highlight is accepted per this window so a start-of-clip burst of
   * confabulated goals cannot flood the accepted list. Default 30.
   */
  goalBurstWindowS?: number;
  /**
   * ADAAAA-6851 Inc 2: persist EVERY decide evaluation (accepted highlight,
   * burst-suppressed, near-miss, not-highlight) with its trigger timestamp +
   * reason/score/eventType/outcome. Wired in the server to a durable store
   * write-through so the full-screen job detail can show decide notes on every
   * trigger after a restart. Best-effort: a throwing callback is caught and
   * logged by the caller, never allowed to fail the frame loop.
   */
  onDecision?: (cand: JobCandidate) => void;
  /** ADAAAA-6797: run the Stage-2 goal/near-miss confirmation pass on this
   * pass. ADAAAA-7663: BOTH the VOD and the live pass set it from
   * `DECIDE_CONFIRM_ENABLED` — the live observe pass used to omit the wiring, so
   * `shouldRunConfirm()` early-returned and a live job could never emit a
   * `gNNN:confirm` decide-audit row. When set, an un-attested goal-type
   * candidate whose Stage-1 read is a scoring_play accept is routed through the
   * decide `/confirm` deep frame dive and the reconciled verdict is adopted in
   * its place. Off => strict no-op (Stage-1 path byte-identical). */
  confirmEnabled?: boolean;
  /**
   * ADAAAA-7162 (CEO feedback on ADAAAA-7134): extra seconds (each side) the
   * Stage-2 confirmation frame window is expanded beyond the Stage-1 pre/post
   * window, so the confirm pass sees the ball actually cross the line / enter
   * the net rather than a single boundary frame. Default 4 s (a 3-5 s window
   * per the requirement); `DECIDE_CONFIRM_EXTRA_WINDOW_S`.
   */
  confirmWindowExtraS?: number;
  /**
   * ADAAAA-7663: the LIVE pass's exactly-once horizon (seconds) for the Stage-2
   * confirm dive. The live observer decides over a ROLLING window whose center
   * slides with the cadence, so the same goal is re-read by several overlapping
   * windows and its center-based `confirmCandidateIdentity` differs each time.
   * When set, a goal-shaped candidate whose goal-event instant is within this
   * window of an already-confirmed goal REUSES that outcome instead of running
   * another `/confirm` dive — one dive per distinct goal (AC3). The horizon is
   * the same one the accept path uses to burst-suppress duplicate GOALs, so a
   * reuse never merges two goals that could both have been accepted. Only the
   * live pass sets it; VOD keeps the stable content-time identity (unset =>
   * exact-key behaviour, unchanged). */
  confirmReuseWindowS?: number;
  /**
   * ADAAAA-7007: enable the VOD decide-observer architecture. When set (with
   * `decideWindowN` also set, i.e. the VOD detail-first pass), the vision LLM
   * becomes the primary observer: decide is invoked on a ~3 s cadence with a
   * ~10 s overlapping reference window (<=30 frames), and perceive becomes a
   * data seeder + on-demand provider rather than the candidate on/off gate.
   * Default off; the candidate-gated path stays the live/default behavior until
   * the observer pass is validated end-to-end. Wired from
   * `VOD_OBSERVE_LOOP` (server config). */
  observeLoop?: boolean;
  /**
   * ADAAAA-7007: observe-loop cadence (content seconds) between decide
   * invocations. Default 3 (`OBSERVE_CADENCE_S`). Optional so the flag-on path
   * can be tuned without code change.
   */
  observeCadenceS?: number;
  /** ADAAAA-7799 (lever C addendum): LIVE-only decide HOP in content seconds.
   *  Unset => the shared observe cadence (`OBSERVE_CADENCE_S` = 3). A 5 s hop on
   *  the ~10 s rolling window keeps the span and gives ~5 s of overlap and ~60
   *  decides per 300 s per stream — the CEO 5 s-hop row. It touches neither the
   *  window span nor the audio noise-change trigger and leaves VOD alone.
   *  Wired from `LIVE_OBSERVE_CADENCE_S`. */
  liveObserveCadenceS?: number;
  /**
   * ADAAAA-7007: observe reference window length (content seconds) assembled
   * around the current moment. Default 10 (`OBSERVE_WINDOW_S`). Decides only
   * fire after the window cadence elapses so consecutive windows overlap.
   */
  observeWindowS?: number;
  /**
   * ADAAAA-7007: observe hard frame cap per decide invocation. Default 30
   * (`OBSERVE_MAX_FRAMES`). A denser window is subsampled to this cap.
   */
  observeMaxFrames?: number;
  /**
   * ADAAAA-7145: enable the Tier-2 signal gate on the decide-observer so a
   * billable decide call only fires on a window with a real highlight signal
   * (ball-in-net / goal-crossed / scoreboard change / confident motion+audio),
   * cutting per-job decide volume + latency. Recall-safe: an uncalibrated /
   * unsignaled window always escalates, so a genuine goal is never starved.
   * Default off (existing high-recall cadence unchanged) until box QA confirms
   * goal recall after the perceive goal-line/homography channels are enabled.
   * `OBSERVE_SIGNAL_GATE` (server config).
   */
  observeSignalGate?: boolean;
  /**
   * ADAAAA-7878: issue every observe decide OFF the frame-consume loop on both
   * rails, so ingest keeps feeding perceive while gemma judges a window.
   *
   * VOD: the window payload is queued and its decide runs at `maxInFlight` depth
   * (default 1 — the decide rate/concurrency is unchanged) while the loop keeps
   * calling `client.analyze`. LIVE: the depth-1 (crowded-box) fallback also
   * issues-and-does-not-await instead of deciding inline; depth > 1 is the
   * unchanged ADAAAA-7771 staged pass.
   *
   * Acceptance is still applied strictly in CONTENT order (the accept chain), so
   * burst suppression, highlight order and the running summary are unchanged.
   * Default ON; `false` reproduces the pre-7878 serial pass byte-for-byte, so a
   * measured regression can be reverted without a code revert.
   * `OBSERVE_DECIDE_OFFLOOP` (server config).
   */
  observeDecideOffLoop?: boolean;
  /**
   * ADAAAA-7878: VOD decide depth for the off-loop pass (default 1 = one decide
   * in flight, exactly the pre-fix decide rate). Raising it changes the decide
   * CONCURRENCY, which is ADAAAA-7773/7771 territory — ship a change only with a
   * measured pair. `OBSERVE_DECIDE_IN_FLIGHT` (server config).
   */
  observeDecideInFlight?: number;
  /**
   * ADAAAA-7878: hard bound on the VOD off-loop pending-window queue (default
   * 512). A full queue drops the window and counts it (`queueFullSkipCount`), so
   * the backlog is bounded and ingest is never blocked by it.
   * `OBSERVE_DECIDE_QUEUE_MAX` (server config).
   */
  observeDecideQueueMax?: number;
  /**
   * ADAAAA-7906 (VOD resume): content timestamp (seconds) of the last FULLY
   * decided window from a previous attempt. The observe-decider seeds its
   * cadence clock here, so it never fires a window whose centre is <= the
   * cursor; the frame iterator is separately started at
   * `cursorTs - warmupFrames/fps` so only the bounded warm-up is re-perceived.
   */
  resumeFromTs?: number;
  /** ADAAAA-7906: warm-up frames re-perceived before the cursor (the AC3
   * budget headroom: `warmupS * sampleFps`). Evidence only — the iterator owns
   * the actual skip. */
  warmupFrames?: number;
  /** ADAAAA-7906: fires with each APPLIED decide window's centre timestamp so
   * the caller persists the resume cursor (every Nth window + phase boundary).
   * Must be cheap; the worker's checkpoint write is throttled by the caller. */
  onDecidedWindow?: (centerTs: number) => void;
  /**
   * ADAAAA-7147: tuning for the Tier-2 signal gate's calibration-free
   * ball-velocity discriminator. `ballMinSpeedMps` is the image-space
   * `speedMps` at/above which a frame is a "meaningful ball"; `suppressQuiet`
   * drops a quiet uncalibrated no-signal window instead of recall-escalating
   * (the fix that makes the gate actually cut decide volume on a box with no
   * goal-line/homography/scoreboard channel). Both absent => the gate keeps the
   * recall-safe baseline. Wired from `OBSERVE_SIGNAL_GATE_BALL_MIN_SPEED` /
   * `OBSERVE_SIGNAL_GATE_SUPPRESS_QUIET`.
   */
  observeSignalGateOpts?: SignalGateOptions;
  /**
   * ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
   * When active, the per-frame `client.analyze` (the expensive perceive pass that
   * dominates VOD E2E) runs at a REDUCED cadence in "cool" (no-signal) regions
   * and at FULL cadence around any window the Tier-2 signal gate escalates, so
   * the escalated goal window is never starved and non-goal clips do not flood.
   * Tri-state: `true` forces on, `false` forces off, `undefined` auto-enables
   * exactly when the gap-1 target configuration is present (`observeLoop` AND
   * `observeSignalGate` both set with `decideWindowN`, i.e. the gated VOD
   * detail-first pass). Default undefined (auto). `PERCEIVE_CADENCE`.
   */
  perceiveCadence?: boolean;
  /** ADAAAA-7152 Gap 1: cool-region perceive stride (perceive every
   * `quietStride`-th frame where no signal escalated). 1 = full pass.
   * `PERCEIVE_QUIET_STRIDE` (default 2). */
  perceiveQuietStride?: number;
  /** ADAAAA-7152 Gap 1: seconds of FULL-perceive treatment after a frame
   * escalates the Tier-2 gate (covers the decide observer's reference window).
   * Default the observe window (`observeWindowS`). `PERCEIVE_HOT_AFTER_S`. */
  perceiveHotAfterS?: number;
  /**
   * ADAAAA-7152 (Gap 2): the per-camera pitch calibration (homography 3x3 +
   * goalLine spec) shipped to the perceive session for THIS job so perceive
   * emits a REAL `goalCrossed`/`ballOutcome` attestation that the decide
   * goal-attestation gate can fold into a `scoring_play` accept. Resolved per
   * camera from the server's `perceiveCalibration` map via
   * `resolvePerceiveCalibration`. Absent => the server sends no `configure`
   * calibration, the session stays uncalibrated (no goal channel) and the gate
   * keeps the recall-safe baseline. The server never fabricates a calibration.
   */
  perceiveCalibration?: PerceiveCalibration;
  /**
   * ADAAAA-7011: enable the LIVE decide-observer architecture. When set (with
   * `decideWindowN` UNSET, i.e. the live/default pass), decide is driven on the
   * ~3 s cadence REGARDLESS of whether perceive emitted a candidate, using the
   * `LiveObserver` (rolling PAST ~10 s window, <=30-frame cap). Perceive becomes
   * a data seeder + on-demand provider; candidate triggers are folded into
   * `biasHints` (provenance) and never gate decide, so trigger-FP gating no
   * longer limits recall. Accepts share `acceptVideoDecision` (clip cut + record
   * + SSE highlight + decision-time billing). Default off; the candidate-gated
   * live baseline stays the behavior until the observer pass is validated.
   * Wired from `LIVE_OBSERVE_LOOP` (server config).
   */
  liveObserveLoop?: boolean;
  /**
   * ADAAAA-7676: wall-clock lag budget for the LIVE observe pass. A frame whose
   * content time is further behind wall time than this is STALE — one decide
   * costs ~8–13 s wall per ~3 s of content, so the serial live loop fell ~5.7x
   * behind and a window labelled `T+42s` reached the feed at wall `+242s`. Once
   * the lag exceeds this budget the pass DROPS the stale frames/windows (counted
   * as `observeMetrics.skippedStaleWindows`) and samples the live edge at the
   * same ~3 s content cadence, instead of deciding them late. Before the decide
   * fires the threshold also reserves one measured `meanE2eMs` so the RESULT
   * lands inside the budget. Default 30 s (`LIVE_OBSERVE_LAG_BUDGET_S`); <= 0
   * disables the drop (legacy unbounded behaviour). Wired from
   * `LIVE_OBSERVE_LAG_BUDGET_S` (server config).
   */
  liveObserveLagBudgetS?: number;
  /**
   * ADAAAA-7771: how many LIVE observe decide windows may be IN FLIGHT per
   * stream (1 = the serial pass, which can only decide one window per decide
   * wall time). At the measured 5-9 s decide wall a serial stream lands ~25-33 %
   * of its 3 s cadence windows; a depth of 2-4 pipelines the decide work so the
   * stream keeps cadence (and therefore inside the lag budget) without changing
   * the cadence, the window, the decision payload or the accept gate. Bounded by
   * construction: a full in-flight queue is backpressure (the cadence stays due
   * and the next frame retries), and the lag budget still drops stale content.
   * Wired from `LIVE_OBSERVE_IN_FLIGHT` (server config, default 4).
   */
  liveObserveInFlight?: number;
  /**
   * ADAAAA-7771: how many decide app-calls the box ADMITS at once — the
   * orchestrated decide client's `DECIDE_CONCURRENCY` (default 2). The live
   * in-flight depth is shared out of this budget (`depth = admission /
   * activeLiveStreams`), so a crowded box degrades to the serial pass instead of
   * queueing every stream behind a 2-wide gate. Wired from `DECIDE_CONCURRENCY`.
   */
  liveDecideAdmission?: number;
  /** ADAAAA-7799 (lever C): decide-rate cap. Keep only a fraction (0 < r < 1)
   *  of the decide opportunities so the decided-window rate and the derived spend
   *  are bounded; 0.625 = 5 of every 8 windows (~67 of ~108 per 300 s at 2
   *  streams). `undefined`/1 = off. Wired from `LIVE_DECIDE_KEEP_RATIO`. */
  liveDecideKeepRatio?: number;
  /**
   * ADAAAA-7774: content fps the LIVE observe pass CONSUMES frames at (the
   * ingest-to-analysis stride). Live ingest runs at ~5 fps while the decide
   * window only carries `OBSERVE_CONTENT_FPS` (2) frames per content second, so
   * perceiving every ingested frame (measured `perceiveSessionS` 304.9 s for 847
   * frames = ~0.36 s of blocking `client.analyze` each) made the loop ~1.8x
   * slower than realtime and the lag budget dropped 3 of every 5 frames — which
   * is what consumed 56-86 of ~100 cadence windows per 300 s. Default 2; `<= 0`
   * disables the stride (perceive every ingested frame). Wired from
   * `LIVE_OBSERVE_CONTENT_FPS` (server config).
   */
  liveObserveContentFps?: number;
  /**
   * ADAAAA-7774: fraction of wall clock the LIVE pass may spend in blocking
   * perceive (`client.analyze`). Perceive shares the GPU with the decide workers,
   * so the pass budgets it instead of awaiting one call per consumed frame; the
   * frames it cannot afford are consumed with an EMPTY seed, which keeps the
   * decide window's ~2 fps frames and the 3 s cadence on time. Default 0.6
   * (`LIVE_PERCEIVE_UTILIZATION`).
   */
  livePerceiveUtilization?: number;
  /** ADAAAA-7028 Inc 2: persist the decide audit descriptor returned on the
   * decision (`_audit`) so the durable decide_audit index + decision-trail has
   * one row per frame group. Best-effort: a throwing onDecideAudit is caught
   * + logged, never a pipeline failure. */
  onDecideAudit?: (desc: unknown) => void;
  /** ADAAAA-7111 (Increment D): read the job's current running video summary
   * (story-so-far) so the next cadence decide request can carry it forward.
   * Absent => no prior summary (the decide runs without one). */
  getRunningSummary?: () => string;
  /** ADAAAA-7856: read the job's persisted `matchContext` (teams + kit colours,
   * resolved once per job by ADAAAA-7855) so every window inspection names the
   * real teams instead of inventing them. Mirrors `getRunningSummary`: a
   * persisted read, never a recompute — this must add NO GPU work per window.
   * Absent (or a context with nothing usable) => the decide request carries no
   * matchContext and the prompt is byte-identical to today (AC6). */
  getMatchContext?: () => unknown;
  /** ADAAAA-7111 (Increment D): persist the updated running video summary after
   * a cadence decide, so the job-detail endpoint + web UI surface it growing.
   * Best-effort: a throwing callback is caught + logged, never a pipeline
   * failure. */
  onRunningSummary?: (summary: string, meta?: { windowTs?: number; grounding?: CaptionGroundingContext }) => void;
  /** ADAAAA-8006: a LIVE goal-shaped accept the ADAAAA-7996 gate had to demote
   * (`big_play`) has been re-attested by a later scoreboard read inside the
   * bounded lookahead. The caller moves the already-persisted row back into the
   * scoring lane (`scoring_play` GOAL) with the scoring-lane surface carried by
   * the upgrade. Fired at most once per row; best-effort (a throwing hook is
   * caught + logged, never a pipeline failure). Unset => the re-emit is audited
   * and dropped (no persistence), which is the VOD/misconfigured-rail posture. */
  onDeferredGoalAttested?: (upgrade: DeferredGoalAttestationUpgrade) => void;
  /**
   * ADAAAA-7948 (Inc 3): ground every FAST caption before it is persisted —
   * gate goal claims on the window's own verdict, replace names the window's
   * `prompt_text` cannot corroborate, strip internal tokens. Set ONLY on the
   * live/fast rails (`buildLiveAnalyzerConfig`), so the VOD summary path stays
   * byte-identical (AC8). CPU-only, no inference change.
   */
  captionGrounding?: boolean;
}

/**
 * The perceive session/runner disappeared while a pass was in flight (the
 * orchestrator returned HTTP 404 "runner not found" / "runner session not
 * found" for our proxied analyze call — released because the static runner's
 * health flapped, or the session was explicitly released). A caller may safely
 * re-reserve a fresh session and retry the current frame. Any other analyze
 * error stays a plain Error and aborts the pass.
 */
export class SessionLostError extends Error {
  constructor(msg = "perceive session/runner lost (404)") {
    super(msg);
    this.name = "SessionLostError";
  }
}

/** ADAAAA-6577: sleep `ms` milliseconds (returns when the timeout elapses).
 * Pure async util so the bounded-backoff cadence is observable in tests. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ADAAAA-6577: bounded exponential backoff delay (ms) for the `attempt`-th
 * re-reserve of a lost perceive session. `baseMs` doubles per attempt and is
 * capped at `maxMs`, so a flapping runner never gets a request storm (base
 * 500ms -> 1s -> 2s -> 4s, cap 8s). Pure function — trivially unit-testable. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/** ADAAAA-7203: the perceive runner is momentarily unavailable — the
 * orchestrator proxies to it through the runner session and returns HTTP
 * 502/503/504 while the runner is down (deploy-recreate / re-registration),
 * and reserve returns 404 "runner not found" or 503 "no capacity" during the
 * recovery window. These are transient and retriable; a payment/auth/other
 * error is not. */
function isTransientRunnerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP (404|502|503|504)/.test(msg) || /runner not found/.test(msg) || /no capacity/.test(msg);
}

/** ADAAAA-7203: reserve a perceive session after a session-lost, retrying when
 * the runner is momentarily unavailable (deploy-recreate) with the bounded
 * exponential backoff. A single immediate reserve during the recreate window
 * 404s ("runner not found") and would abort the whole pass; retrying lets the
 * pass ride through the recovery and resume from the last observation. Bounded
 * by `attempts`; on exhaustion a typed `analyze interrupted
 * (perceive-session-lost)` verdict is thrown so the job is cheaply retriable
 * rather than a bare 502. A
 * non-transient (payment/auth) reserve error propagates immediately. */
export async function reservePerceiveWithRetry(
  client: PipelineClient,
  opts: { attempts?: number; baseMs?: number; maxMs?: number } = {}
): Promise<ReserveResult> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.reservePerceive();
    } catch (err) {
      if (!isTransientRunnerError(err)) throw err;
      // Last attempt done: surface the typed retriable verdict, not a bare 502.
      if (attempt + 1 >= attempts) {
        throw new DeployRecreateInterruptedError(
          describeInterruption(
            "perceive-session-lost",
            `perceive runner unavailable after ${attempts} reserve attempts; job is retriable`
          )
        );
      }
      await sleep(backoffDelayMs(attempt, baseMs, maxMs));
    }
  }
}

/** ADAAAA-7203: typed, retriable outcome when a perceive runner recreate
 * (staged deploy) drops the session and the bounded re-reserve could not
 * re-acquire a runner in the recovery window. Distinct from the generic
 * `SessionLostError` (which the pass re-reserves against) and from a bare
 * `analyze failed: HTTP 502` (which is not signal about WHY it dropped).
 *
 * ADAAAA-7921: the class name is kept because `classifyVodFailure` and the
 * retry table recognize it, but its MESSAGE follows the classified reason
 * (`perceive-session-lost`), never the deploy that originally prompted the
 * retry: the measured 43 s `docker stop highlights-perceive` published
 * "deploy-recreate" when nothing was deployed. */
export class DeployRecreateInterruptedError extends Error {
  constructor(msg = describeInterruption("perceive-session-lost", "perceive session lost")) {
    super(msg);
    this.name = "DeployRecreateInterruptedError";
  }
}

/** Compute per-job evidence from the observation stream. */
export class EvidenceTracker {
  private prev = new Map<string, { cx: number; cy: number }>();
  maxVelocity = 0;
  trackCount = 0;
  step(obs: { tracks: TrackObservation[] }): void {
    // Clamp into the decide schema's accepted band ([0,2], ADAAAA-4736): real
    // multi-player tracking can exceed 2 objects and an out-of-range value
    // makes FastAPI 422-reject the whole payload. Server is owner of truth.
    this.trackCount = clampTrackCount(obs.tracks.length);
    for (const t of obs.tracks) {
      const [bx1, by1, bx2, by2] = t.bbox;
      const cx = (bx1 + bx2) / 2;
      const cy = (by1 + by2) / 2;
      const p = this.prev.get(t.trackId);
      if (p) {
        const d = Math.abs(cx - p.cx) + Math.abs(cy - p.cy);
        if (d > this.maxVelocity) this.maxVelocity = d;
      }
      this.prev.set(t.trackId, { cx, cy });
    }
  }
}

export interface AnalyzeOutcome {
  sessionId: string;
  highlights: HighlightRecord[];
  framesAnalyzed: number;
  /** ADAAAA-7152 Gap 1: number of frames actually sent to perceive (<=
   * `framesAnalyzed` when the adaptive perceive cadence is active; equal to it
   * on the full pass). Metric for confirming the VOD perceive cost was cut. */
  perceiveCalls?: number;
  /** ADAAAA-7011: live decide-observer cadence + decide gemma E2E latency
   * snapshot (absent when the live observer was not enabled). Populated from
   * LiveObserver.latencySamples() so the Livepeer runner shows the ~30 s budget
   * utilization (cadence + gemma E2E). */
  observeMetrics?: LiveObserveMetricsSnapshot;
  /** ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot
   * (absent when the VOD observer was not enabled). Populated from
   * ObserveDecider so the VOD job record carries the <=30-frame cap-exercised
   * count + per-call decide input size for the -67% cost measure. */
  vodObserveMetrics?: VodObserveMetricsSnapshot;
}

/** ADAAAA-7011: live decide-observer cadence + decide gemma E2E latency
 * snapshot, recorded onto the live job so the cadence + gemma E2E latency are
 * inspectable on the Livepeer runner (the ~30 s budget = ~3 s cadence + the
 * gemma end-to-end latency). Mirrors the StageAMetrics snapshot convention. */
export interface LiveObserveMetricsSnapshot {
  /** Number of decide invocations that fired on the cadence. */
  decideCalls: number;
  /** Decisions that became an accepted highlight. */
  accepted: number;
  /** Max frames in a single decide payload (<= LIVE_OBSERVE_MAX_FRAMES). */
  maxFrames: number;
  /** Mean decide gemma end-to-end latency (ms). */
  meanE2eMs: number;
  /** Max decide gemma end-to-end latency (ms). */
  maxE2eMs: number;
  /** Mean content-time cadence between consecutive fired ticks (ms). */
  meanCadenceMs: number;
  /** Max content-time cadence between consecutive fired ticks (ms). */
  maxCadenceMs: number;
  /** ADAAAA-7658: decide fires scheduled by a fired audio trigger (anchored
   *  windows) vs the blind cadence. `trigger + cadence == decideCalls`. */
  triggerFires: number;
  cadenceFires: number;
  /** ADAAAA-7676: cadence windows DROPPED as stale (content time beyond the lag
   *  budget) instead of being decided late. Proves the live pass is bounded, not
   *  unbounded-queueing. */
  skippedStaleWindows?: number;
  /** ADAAAA-7758: cadence windows this run did NOT decide because ANOTHER live
   *  job held the box's single live decide slot (admission control). Zero when
   *  admission control is off (the shipped default) or when this job held the
   *  slot; a positive count means this stream was QUEUED behind another live
   *  stream, which is a different condition from a lag-driven stale skip. */
  admissionSkippedWindows?: number;
  /** ADAAAA-7676: worst / mean wall-clock content-vs-wall lag (ms) seen on a
   *  dropped frame. `maxLagMs <= budget + one frame` by construction. */
  maxLagMs?: number;
  meanLagMs?: number;
  /** ADAAAA-7676: worst completed wall lag (ms) of a DECIDED window — the
   *  content-vs-wall lag a live viewer actually experiences (`windowTs` vs wall
   *  `ts`). Bounded by the lag budget when the drop is active. */
  maxCompletedLagMs?: number;
  /** ADAAAA-7707: whistle triggers this live window emitted (Stage-B emission
   *  volume — the 2.0/min alert threshold's numerator, expected 0.0/min on
   *  ordinary play). */
  whistleFires?: number;
  /** ADAAAA-7707: decide windows anchored on a whistle trigger — the crowding
   *  numerator of the CEO tripwire (whistle share of a window's decides). */
  whistleDecides?: number;
  /** ADAAAA-7707: `whistleDecides / decideCalls`. The ADAAAA-7713 hard tripwire
   *  is > 0.25 -> flip `WhistleConfig.emitted = False`. Persisted so the share is
   *  measurable on a deployed window without a post-hoc audit. */
  whistleShare?: number;
  /** ADAAAA-7722: every decide invocation this run made — the explicit share
   *  DENOMINATOR, persisted next to `whistleDecides` so `whistleShare` is
   *  computable from two counts and `allDecides === decideCalls` is assertable
   *  on a finished job record. */
  allDecides?: number;
  /** ADAAAA-7722: the whistle-anchored window RECORDS (content ts + trigger
   *  identity/family), so a whistle decide is identifiable post-run instead of
   *  only inside the in-flight `ObserveDecidePayload.trigger`. */
  whistleWindows?: { centerTs: number; thresholdId: string; family: string }[];
  /** ADAAAA-7723 AC-1: the trigger LEDGER. Every trigger the scheduler accepted
   *  is accounted for — `accepted === fired + covered + expired + pending` —
   *  so a share can no longer report a healthy `triggers` count while silently
   *  dropping the anchored analysis of an audible event. */
  triggerWindows?: TriggerSchedulerStats;
  /** ADAAAA-7723 AC-1: whether that ledger balances (`unaccounted === 0`). */
  triggerReconciled?: boolean;
  /** ADAAAA-7723 AC-2: onset -> judging-window latency measured PER family
   *  (Stage-A roar, Stage-B whistle), split into anchored windows, triggers a
   *  decided window covered, and their pooled `judged` total. */
  triggerLatencyByFamily?: TriggerFamilyLatency[];
  /** ADAAAA-7771: deepest in-flight decide queue observed on the pass (1 = the
   *  serial loop, K = pipelined). Proves the configured depth was actually used
   *  — a depth that never exceeds 1 means the cadence, not the queue, was the
   *  limiter. */
  maxDecideInFlight?: number;
  /** ADAAAA-7771: cadence windows NOT decided because all K in-flight decide
   *  slots were busy. Zero on a healthy pipelined run (capacity 1.6 decides/s
   *  against 0.33/s demand); distinct from `skippedStaleWindows` (content was
   *  late) and `admissionSkippedWindows` (another live job held the box slot). */
  backpressureSkippedWindows?: number;
  /** ADAAAA-7799 (lever C): decide opportunities the rate cap DROPPED on its
   *  fixed stride. `decideCalls + throttleSkippedWindows + skippedStaleWindows +
   *  backpressureSkippedWindows + admissionSkippedWindows` accounts for the
   *  cadence windows, so the throttle gap is auditable instead of inferred from
   *  a coverage number. Absent when the cap is off (unset env). */
  throttleSkippedWindows?: number;
  /** ADAAAA-7808: stale FRAMES the lag budget dropped (the count the
   *  `[live-lag] summary` line prints as `droppedFrames`). Persisted so a ship
   *  row can quote it from the job record instead of grepping the container log. */
  droppedFrames?: number;
  /** ADAAAA-7808 (PO ruling on ADAAAA-7802): SUPPLY skips — the cadence windows
   *  the RAIL could not serve: stale lag drops + backpressure + admission.
   *  Deliberately EXCLUDES `throttleSkippedWindows`, which is a funded rate
   *  decision and must never be folded into the supply number. */
  supplySkippedWindows?: number;
  /** ADAAAA-7774: the LIVE perceive stride — the ingest-to-analysis frame rate
   *  the pass consumed at, plus the counts that prove the stride ran:
   *  `perceiveCalls < framesAnalyzed` in a cool region (the cadence skipped
   *  frames, each recorded with an EMPTY seed) and `framesStrided` of
   *  `framesSeen` never entered perceive at all. Absent on a pass that ran no
   *  stride (the media-rail share, whose perceive runs in the media node). */
  perceive?: LivePerceiveStrideSnapshot;
  /** ADAAAA-8005 (gate 3): the per-row trigger -> DELIVERED latency and its
   *  stage breakdown. This is the metric the gate-3 AC is graded from: one row
   *  per accepted-and-persisted highlight, `deliveredLatencyMs` = persistAck -
   *  (contentOrigin + triggerTs), i.e. the trigger-to-readable-on-the-delivered-
   *  surface number, with `fireLagMs` / `decideE2eMs` / `acceptWaitMs` /
   *  `acceptMs` / `persistAckMs` naming where the seconds went. Additive
   *  optional: absent when no highlight was delivered (and on older records). */
  deliveredLatency?: LiveDeliveredLatencySnapshot;
}

/** ADAAAA-7774: the LIVE observe pass's ingest -> analysis stride evidence. */
export interface LivePerceiveStrideSnapshot {
  /** Frames the ingest delivered (every loop iteration). */
  framesSeen: number;
  /** Frames the pass CONSUMED (recorded + decide-seeded) at `analysisFps`. */
  framesAnalyzed: number;
  /** Frames skipped by the ingest stride (never perceived/recorded/seeded). */
  framesStrided: number;
  /** Perceive invocations (<= framesAnalyzed; < in a cool region). */
  perceiveCalls: number;
  /** Consumed frames the cooler cadence did NOT perceive (empty seed). */
  perceiveSkipped: number;
  /** ADAAAA-7774: consumed frames the GPU BUDGET refused (empty seed) — the
   *  signal that the box could not perceive at the analysis fps and the pass
   *  decoupled perceive from the frame loop instead of running late. */
  perceiveBudgetSkipped?: number;
  /** Perceive invocations inside an armed full-perceive hot window. */
  perceiveHotCalls: number;
  /** Content fps the pass consumed at (0 = stride disabled). */
  analysisFps: number;
  /** ADAAAA-7774: mean measured `client.analyze` wall cost (ms). The cost-aware
   *  stride steps by this, so a value above `1000 / analysisFps` is the box's
   *  shared-GPU perceive limit rather than the ingest rate. */
  perceiveMeanCostMs?: number;
}

/** ADAAAA-7007: VOD decide-observer per-call input-size + cap snapshot, recorded
 * onto the VOD job so the acceptance criteria are inspectable per job: the
 * <=30-frame cap actually exercised (`subsampledCalls>0`) and the per-call
 * decide input-size distribution (`framesPerCall`, the -67% cost-measure
 * input). Mirrors the live {@link LiveObserveMetricsSnapshot} convention. */
export interface VodObserveMetricsSnapshot {
  /** Number of decide invocations that fired on the cadence. */
  decideCalls: number;
  /** Decisions that became an accepted highlight. */
  accepted: number;
  /** Max frames in a single decide payload (<= OBSERVE_MAX_FRAMES = 30). */
  maxFrames: number;
  /** Calls where the max-frames cap forced a subsample (proves cap exercised). */
  subsampledCalls: number;
  /** Per-call decide input-size distribution (frame count per invocation). */
  framesPerCall: number[];
}

/** Build the VOD decide-observer per-call input-size + cap snapshot from the
 * decider's report ticks (pure aggregation of {@link ObserveDecider}). */
export function buildVodObserveMetrics(obs: ObserveDecider): VodObserveMetricsSnapshot {
  return {
    decideCalls: obs.decideCalls(),
    accepted: obs.acceptedCount(),
    maxFrames: obs.maxFrameCount(),
    subsampledCalls: obs.subsampledCallCount(),
    framesPerCall: obs.inputSizeSamples(),
  };
}

/**
 * ADAAAA-7676: how much of the live lag budget to reserve for the decide that
 * has not landed yet.
 *
 * What a live viewer experiences is `lag_at_fire + decide_e2e`, so the stale
 * drop threshold is `budget - reserve` and the reserve must cover the WORST
 * decide seen so far — not the mean. Measured on job `4f8d47bd` (130 s rtmp,
 * `LIVE_OBSERVE_LAG_BUDGET_S=30`): a mean-based reserve (8.5 s) let an 11.7 s
 * decide land at a completed lag of 33.0 s, i.e. past the budget the drop
 * exists to enforce. Worst-based (11.7 s + 1 s of measurement margin) picks the
 * window at 17.3 s and lands the result at ~29 s.
 *
 * A worst-only reserve still under-covers a RAMP: on job `8b88a472` the startup
 * decides climbed 8.8 s -> 12.8 s, so worst+1 s (9.8 s) picked a window at
 * 19.3 s lag whose result landed at 32.1 s. The 1.5x-mean term tracks that ramp
 * (the observed spread on the runner is 1.35-1.5x the mean).
 *
 * The reserve is capped at half the budget so a very slow decide cannot starve
 * the pass into deciding nothing at all — dropping work is cheap, deciding
 * nothing is not.
 */
export function liveLagReserveS(maxE2eMs: number, meanE2eMs: number, budgetS: number): number {
  // Worst-so-far covers a steady box; 1.5x the mean covers the RAMP. Measured on
  // job `8b88a472` the startup decides climbed 8.8 s -> 12.8 s (1.45x the mean
  // seen so far), so a worst+1 s reserve still picked a window at 19.3 s lag that
  // landed at a completed 32.1 s. 1.5x the mean is the observed spread on the
  // runner (mean 8.5-9.6 s, max 11.7-12.8 s); +1 s absorbs measurement fenceposts.
  const worstE2e = Math.max(maxE2eMs / 1000, (meanE2eMs / 1000) * 1.5);
  return Math.min(worstE2e + 1, budgetS / 2);
}

/** Build the live decide-observer latency/cadence snapshot from the observer's
 * measured samples (pure aggregation of {@link LiveObserver.latencySamples}).
 * `stride` carries the ADAAAA-7774 ingest -> analysis frame counters from the
 * pass (absent for a pass that ran no stride). */
export function buildLiveObserveMetrics(
  obs: LiveObserver,
  stride?: LivePerceiveStrideSnapshot
): LiveObserveMetricsSnapshot {
  const samples = obs.latencySamples();
  const cadences = samples.map((s) => s.cadenceMs).filter((c) => c > 0);
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const decideCalls = obs.decideCalls();
  const whistleDecides = obs.whistleDecideCount();
  // ADAAAA-8005 (gate 3): the per-row delivered block (undefined until the first
  // highlight row is persisted and acked).
  const delivered = obs.deliveredLatencyStats();
  return {
    decideCalls,
    accepted: obs.acceptedCount(),
    maxFrames: obs.maxFrameCount(),
    meanE2eMs: Number(obs.meanE2eMs().toFixed(1)),
    maxE2eMs: Number(obs.maxE2eMs().toFixed(1)),
    meanCadenceMs: Number(avg(cadences).toFixed(1)),
    maxCadenceMs: cadences.length ? Number(Math.max(...cadences).toFixed(1)) : 0,
    triggerFires: obs.triggerFireCount(),
    cadenceFires: obs.cadenceFireCount(),
    skippedStaleWindows: obs.skippedStaleWindowCount(),
    // ADAAAA-7758: a queued stream's wait is its own counter, never folded into
    // the lag-driven stale drops above.
    admissionSkippedWindows: obs.admissionSkipCount(),
    maxLagMs: Math.round(obs.maxObservedLagMs()),
    meanLagMs: Number(obs.meanObservedLagMs().toFixed(1)),
    maxCompletedLagMs: Number((samples.length ? Math.max(...samples.map((s) => s.completedLagMs ?? 0)) : 0).toFixed(1)),
    // ADAAAA-7707: Stage-B crowding counters. Additive on every live record, so
    // the whistle share is measurable on a deployed window (ADAAAA-7713).
    whistleFires: obs.whistleFireCount(),
    whistleDecides,
    whistleShare: decideCalls === 0 ? 0 : Number((whistleDecides / decideCalls).toFixed(4)),
    // ADAAAA-7722: explicit crowding denominator + the anchored window records
    // (family identity), so the share is computable and the whistle decide is
    // identifiable on a FINISHED job record.
    allDecides: decideCalls,
    whistleWindows: obs.whistleWindows(),
    // ADAAAA-7723: the trigger ledger + per-family anchored latency. Both are
    // persisted on the job so a FINISHED share can be reconciled afterwards
    // (accepted == fired + covered + expired + pending) instead of only read
    // from a live log line.
    triggerWindows: obs.triggerStats(),
    triggerReconciled: obs.triggerReconciliation().ok,
    triggerLatencyByFamily: obs.anchoredLatencyByFamilyStats(),
    // ADAAAA-7771: pipelining proof. `maxDecideInFlight` > 1 on a finished job
    // means the pass really ran several windows at once (the serial pass reads
    // 1); `backpressureSkippedWindows` counts windows the depth itself refused —
    // keeping them distinct from stale drops (late content) and admission skips
    // (another live job held the slot).
    maxDecideInFlight: obs.maxInFlightDepth(),
    backpressureSkippedWindows: obs.backpressureSkipCount(),
    // ADAAAA-7799 (lever C): dropped decide opportunities from the rate cap.
    throttleSkippedWindows: obs.throttleSkipCount(),
    // ADAAAA-7808: the two numbers a ship row has to quote per stream. The
    // supply total is the rail's own shortfall (stale + backpressure +
    // admission) and NEVER includes the throttle: on the shipped rail the
    // throttle is a funded rate decision, so folding it in would read as
    // missing coverage the rail chose to spend less on.
    droppedFrames: obs.staleFrameCount(),
    supplySkippedWindows:
      obs.skippedStaleWindowCount() + obs.backpressureSkipCount() + obs.admissionSkipCount(),
    // ADAAAA-7774: the ingest -> analysis stride evidence (absent when the pass
    // ran no stride — e.g. the media-rail share, perceived in the media node).
    ...(stride ? { perceive: { ...stride } } : {}),
    // ADAAAA-8005 (gate 3): the per-row trigger -> delivered latency. One row
    // per delivered highlight, so the AC is readable off the record with no
    // `[live-lag]` + `[ingest-gap]` log join. Absent until a row is delivered.
    ...(delivered ? { deliveredLatency: delivered } : {}),
  };
}

/**
 * Rolling window of the most recent sampled frames (seq -> {timestamp, image}).
 * A tracker candidate may be ANCHORED at an earlier (peak-motion / strike) frame
 * than the one whose /analyze triggered it, so `decide` should see that anchored
 * frame's image — not the late post-strike frame — to judge the actual moment.
 */
const DECIDE_FRAME_WINDOW = 16;

/** Rolling cache window (seconds) — the "current-context buffer" (plan §A,
 * ADAAAA-6029). Frames (and their already-computed findings) older than this
 * drop out of the window and are no longer part of a decide() call's context.
 * Grows the legacy 16-frame default to a 60 s window. */
export const DECIDE_WINDOW_SECONDS = 60;
/** Hard memory bound for the cache: at ~1 fps, 60 s ≈ 60 frames. The cache
 * never grows on long streams — a higher-fps VOD pass is still hard-capped at
 * this many retained frames. */
export const CACHE_MAX_FRAMES = 60;
/** Token-budget cap for the assembled window-facts text (A2). ~2400 chars ≈
 * ~500–600 tokens; the prior-context the decide prompt is augmented with never
 * exceeds this. Content beyond the cap is dropped oldest-first at assembly. */
export const WINDOW_FACTS_MAX_CHARS = 2400;
/** ADAAAA-6610 temporal burst suppression window (seconds): at most one GOAL
 * highlight is accepted per this window in a run, so a start-of-clip burst of
 * confabulated goals cannot flood the accepted list. */
export const DEFAULT_GOAL_BURST_SUPPRESS_S = 30;
/** ADAAAA-7402 (shootout-aware follow-up to the AC2 recall fix): the TIGHT
 * same-kick dedup window (seconds) applied to a GOAL whose acceptance is
 * independently corroborated by a scoreboard change (`corroborationSource ===
 * "scoreboard"`). A penalty shootout is a sequence of DISTINCT converted kicks
 * ~13–18 s apart, each corroborated by a PENALTIS-tally increment on the
 * scoreboard — so an accepted goal with a scoreboard change is a DISTINCT event,
 * not a burst duplicate. But an ADJACENT window re-read of the SAME kick (the
 * decide pass samples the video at ~1 fps, so a single kick is seen across
 * neighbouring windows a few seconds apart) is a duplicate that must dedup to
 * one highlight (AC4). This window separates the two: a same-kick re-read is
 * < SHOOTOUT_KICK_DEDUP_S from the prior accepted conversion, a distinct
 * conversion is >= SHOOTOUT_KICK_DEDUP_S away. 8 s sits between the observed
 * same-kick re-read spacing (~1–5 s) and the distinct-conversion spacing
 * (>=12 s). Confabulated start-of-clip goals never carry a scoreboard change,
 * so they keep the full ADAAAA-6610 30 s suppression (this constant only narrows
 * the window for independently corroborated goals). */
export const SHOOTOUT_KICK_DEDUP_S = 8;

// ---------------------------------------------------------------------------
// Increment F / ADAAAA-6465: frame-watching assembler (plan §4.9C).
// The analysis LLM watches a bounded SEQUENCE of actual stream frames around
// each trigger — this is the PRIMARY evidence path; audio is a cheap, explicitly
// fallible trigger/corroboration (crowds erupt for near misses / wrong calls /
// replays). The sequence is sampled from the already-cached frame window at
// `analysis_fps` (default 5), always includes a keyframe set (trigger-onset,
// peak-audio, window-end), and is HARD-CAPPED at `max_frames_per_analysis`.
// ---------------------------------------------------------------------------

/** Default analysis FPS cap for the live pass (plan §4.9A): ~5 fps over a
 * ~5 s window ≈ 25 frames + 3 keyframes. Raising this is a per-call Livepeer
 * GPU cost decision, not a code change. */
export const DEFAULT_ANALYSIS_FPS = 5;
/** Hard cap on the number of frames that can reach the LLM in ONE analysis
 * call (plan §4.9D / §14.6). Never exceeded. Live default ≈ 25 + 3 keyframes. */
export const DEFAULT_MAX_FRAMES_PER_ANALYSIS = 30;
/** Pre/post window (seconds) around the trigger the assembler samples (plan
 * §4.9A: default ~2 s pre / ~3 s post — covers the play, the crossing/contact
 * moment, and the reaction). */
export const DEFAULT_PRE_WINDOW_S = 2;
export const DEFAULT_POST_WINDOW_S = 3;

/** A single candidate frame the assembler may select. `keyframe` is one of
 * "trigger" | "peak_audio" | "window_end" (plan §4.9A keyframe set) or null for
 * a regular sampled frame. */
export interface AssembledFrame {
  timestamp: number;
  base64: string;
  keyframe?: "trigger" | "peak_audio" | "window_end";
}

/** Assemble the capped frame sequence for one analysis call (increment F).
 *
 * Pure + deterministic so it is unit-testable. Input is the already-cached
 * rolling frame window (oldest -> newest, each with a timestamp + base64 image).
 * Selection rules (plan §4.9A):
 *   1. Keep only frames inside [triggerTs - preWindowS, triggerTs + postWindowS].
 *   2. Sample down to `analysis_fps` — pick frames whose timestamp is nearest to
 *      an even `1/analysis_fps` grid across the window (so a ~5 s window at 5 fps
 *      yields ~25 frames). Always keeps the first and last in-window frame.
 *   3. Add the keyframe set: trigger-onset (nearest frame to triggerTs),
 *      peak-audio (nearest frame to `peakAudioTs`, when supplied), window-end
 *      (the last in-window frame) — deduped.
 *   4. HARD-CAP at `maxFramesPerAnalysis` (default 30). If over, keep the
 *      keyframes and thin the regular sample oldest-first so the total never
 *      exceeds the cap.
 * Returns ImageRef-shaped `[{ role: "full", base64 }]` ordered oldest -> newest,
 * EXACTLY the shape gemma `ask(frames=...)` consumes. An empty window yields [].
 */
export function assembleFrameSequence(
  frames: { timestamp: number; imageB64: string }[],
  opts: {
    triggerTs: number;
    analysisFps?: number;
    maxFramesPerAnalysis?: number;
    preWindowS?: number;
    postWindowS?: number;
    peakAudioTs?: number;
  }
): { role: string; base64: string }[] {
  const {
    triggerTs,
    analysisFps = DEFAULT_ANALYSIS_FPS,
    maxFramesPerAnalysis = DEFAULT_MAX_FRAMES_PER_ANALYSIS,
    preWindowS = DEFAULT_PRE_WINDOW_S,
    postWindowS = DEFAULT_POST_WINDOW_S,
    peakAudioTs,
  } = opts;
  const inWindow = frames
    .filter((f) => f.timestamp >= triggerTs - preWindowS && f.timestamp <= triggerTs + postWindowS)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (!inWindow.length) return [];

  // --- keyframe set (always included) --------------------------------------
  const keyframes = new Map<string, AssembledFrame>();
  const nearest = (ts: number): AssembledFrame | undefined => {
    if (!Number.isFinite(ts)) return undefined;
    let best: AssembledFrame | undefined;
    let bestDiff = Infinity;
    for (const f of inWindow) {
      const d = Math.abs(f.timestamp - ts);
      if (d < bestDiff) {
        bestDiff = d;
        best = { timestamp: f.timestamp, base64: f.imageB64 };
      }
    }
    return best;
  };
  const trigger = nearest(triggerTs);
  if (trigger) keyframes.set(`trigger@${trigger.timestamp}`, { ...trigger, keyframe: "trigger" });
  if (peakAudioTs !== undefined) {
    const peak = nearest(peakAudioTs);
    if (peak && !keyframes.has(`trigger@${peak.timestamp}`)) {
      keyframes.set(`peak@${peak.timestamp}`, { ...peak, keyframe: "peak_audio" });
    }
  }
  const end = inWindow[inWindow.length - 1];
  if (!keyframes.has(`trigger@${end.timestamp}`) && !keyframes.has(`peak@${end.timestamp}`)) {
    keyframes.set(`end@${end.timestamp}`, { timestamp: end.timestamp, base64: end.imageB64, keyframe: "window_end" });
  }

  // --- regular sample at analysis_fps ---------------------------------------
  const step = analysisFps > 0 ? 1 / analysisFps : Infinity;
  const start = inWindow[0].timestamp;
  const endTs = inWindow[inWindow.length - 1].timestamp;
  const sampled: AssembledFrame[] = [];
  for (let t = start; t <= endTs + 1e-9; t += step) {
    const n = nearest(t);
    if (n) sampled.push(n);
  }
  // Dedupe by timestamp, keep first occurrence (grid order).
  const seen = new Set<number>();
  const grid: AssembledFrame[] = [];
  for (const s of sampled) {
    if (!seen.has(s.timestamp)) {
      seen.add(s.timestamp);
      grid.push(s);
    }
  }
  // Merge keyframes (they are decision-relevant even if the grid thinned them).
  const merged = new Map<number, AssembledFrame>();
  for (const s of grid) merged.set(s.timestamp, s);
  for (const k of keyframes.values()) merged.set(k.timestamp, k);
  let ordered = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);

  // --- hard cap ---------------------------------------------------------------
  if (ordered.length > maxFramesPerAnalysis) {
    const keepTs = new Set(ordered.filter((f) => f.keyframe).map((f) => f.timestamp));
    const nonKey = ordered.filter((f) => !keepTs.has(f.timestamp));
    let extra = maxFramesPerAnalysis - keepTs.size;
    if (extra < 0) extra = 0;
    const keptKey = ordered.filter((f) => keepTs.has(f.timestamp));
    // Spread the remaining budget evenly across the non-key frames oldest-first.
    const thinned = nonKey.filter((_, i) => i < extra);
    ordered = [...keptKey, ...thinned].sort((a, b) => a.timestamp - b.timestamp);
    // Final safety clamp (defensive; guarantees the hard cap is never breached).
    if (ordered.length > maxFramesPerAnalysis) ordered = ordered.slice(0, maxFramesPerAnalysis);
  }
  return ordered.map((f) => ({ role: "full", base64: f.base64 }));
}

/** Already-computed perception findings for one in-window sampled frame (A1).
 * These come from the `/analyze` result the server already paid for — cached
 * and REUSED by window-facts assembly, never re-analyzed (no extra GPU). */
export interface FrameFindings {
  /** Tracked-object bboxes + labels (ResNet/Florence + SAM tracking). */
  tracks: { trackId: string; label?: string; bbox: number[] }[];
  /** Open-set detections (label + confidence). */
  objects: { label: string; confidence?: number; bbox: number[] }[];
  /** OCR text (scoreboard / jersey / caption readings). */
  ocr: string[];
}
/** A candidate event observed inside the window (plan §A: candidate event
 * types + reaction signals are cached as findings). */
export interface WindowCandidate {
  timestamp: number;
  eventType: string;
  reaction?: ReactionEvidence;
}

function nearestFrameImage(
  window: ReadonlyMap<number, { timestamp: number; imageB64: string }>,
  ts: number
): string | undefined {
  let best: string | undefined;
  let bestDiff = Infinity;
  for (const v of window.values()) {
    const d = Math.abs(v.timestamp - ts);
    if (d < bestDiff) {
      bestDiff = d;
      best = v.imageB64;
    }
  }
  return best;
}

/**
 * Shared state for one run, used by BOTH legs that feed the same perceive
 * session (INC-2 / ADAAAA-4325 slice 4):
 *   - the video /analyze leg (inside analyzeJob), and
 *   - the Stage-A audio tap leg (POSTing chunks to /audio) — live and, since
 *     ADAAAA-4954, the detail-first VOD pass too.
 *
 * The audio gate fires on its own ~10 Hz cadence, decoupled from the 1 fps
 * video rail, so when an audio CandidateEvent lands the server must anchor it
 * to the video frame nearest the audio onset and hand that image + the current
 * video evidence to the Gemma decide runner. The two legs share this object so
 * decide sees the actual moment, not a bare scalar candidate.
 *
 * A VOD pass supplies one via `analyzeJob`'s `shared_` slot (exactly like the
 * live path) so its audio leg reuses the same anchor window. The decide window
 * length defaults to the legacy DECIDE_FRAME_WINDOW (16) — the live baseline —
 * and is raised by the detail-first `decideWindowN` knob (ADAAAA-4954).
 */
export class LiveRunShared {
  readonly evidence = new EvidenceTracker();
  readonly highlights: HighlightRecord[] = [];
  /** Stage-A audio-gate FP-rate + latency metric (INC-2 / ADAAAA-4325 slice 5).
   * Every audio gate outcome records here; the job runner snapshots it onto the
   * job at completion. */
  readonly stageA = new StageAMetrics();
  /** ADAAAA-7694: the Stage-A trigger timeline → decided-window verdict
   * mapping. Fed by the audio tap (`recordAudioTrigger`, both rails) and written
   * to by the decide observer that judges each trigger's onset, so
   * `stageA.snapshot()` is a real measurement instead of the all-zero one. */
  readonly stageAOutcomes = new StageAOutcomeLedger(this.stageA);
  /** ADAAAA-7707: the Stage-B (band-limited whistle) accumulator. The whistle
   * path gets its OWN counters so a whistle fire — accepted or rejected — can
   * never move the published Stage-A fidelity numbers (`stageAMetrics.fpRate` /
   * `meanOnsetLatencyS` / `totalCandidates`), which is the CEO spend guardrail
   * restated on ADAAAA-7713. `stageA/*` triggers feed `stageA` only; `stageB/*`
   * triggers feed this. */
  readonly stageB = new StageAMetrics();
  /** ADAAAA-7707: trigger timeline -> decided-window verdict mapping for the
   *  whistle family (same rules as `stageAOutcomes`, different ledger). */
  readonly stageBOutcomes = new StageAOutcomeLedger(this.stageB);
  /** ADAAAA-7707: whistle triggers this run recorded (one per emitted fire) —
   *  the emission-volume counter behind the 2.0/min alert threshold. */
  private whistleTriggerTally = 0;
  /** Stage-1 vs Stage-2 confirmation-pass metric (ADAAAA-6797). Every confirm
   * dive attempted records its outcome here; runVodJob snapshots it onto the
   * job at completion as `confirmMetrics` (disagreement rate = disagreed /
   * totalRuns). */
  readonly confirmMetrics = { totalRuns: 0, disagreed: 0 };
  /** ADAAAA-7365: already-processed goal candidates keyed on a STABLE goal-event
   * identity (the goal's content timestamp, NOT the observe-window center). The
   * VOD observe path re-produces the same goal-shaped decision across every
   * overlapping 10 s window that contains the goal, so without this the Stage-2
   * confirm dive re-fires ~5x per distinct candidate (60 confirms / 12 goals).
   * Caching the outcome lets a re-produced window reuse the FIRST dive's verdict
   * instead of re-billing / re-confirming / re-cutting it. Bounded.
   * ADAAAA-7663: each entry also carries the goal EVENT instant it was keyed on
   * so the LIVE pass — whose window center slides and therefore has no stable
   * content-time key — can reuse a confirmed goal within `confirmReuseWindowS`
   * (see `confirmedGoalNear`). */
  private readonly confirmedGoals = new Map<
    string,
    { ts: number; outcome: { decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision } }
  >();
  /** Rolling window of cached frames + their already-computed findings (plan
   * §A). Time-bounded to DECIDE_WINDOW_SECONDS and hard-capped at
   * CACHE_MAX_FRAMES, so it never grows on long streams. Findings are REUSED
   * by window-facts assembly — never re-analyzed. */
  private frames = new Map<number, { timestamp: number; imageB64: string; findings?: FrameFindings }>();
  /** Candidate events observed inside the current window (bounded, folded into
   * the assembled window facts). */
  private candidates: WindowCandidate[] = [];
  /** Detail-first decide window length (frames kept for the temporal SEQUENCE).
   * Defaults to the live baseline (DECIDE_FRAME_WINDOW); the VOD knob
   * `decideWindowN` raises it (ADAAAA-4954). */
  private readonly windowN: number;
  /** GOAL burst-suppression window (seconds, ADAAAA-6610). Default 30. */
  private readonly goalBurstWindowS: number;
  /** Raw mono 16 kHz int16 PCM taps (base64 per ~100 ms chunk) + end timestamp,
   * kept as a short rolling clip so the surrounding audio can be handed to
   * decide() (ADAAAA-4954 detail-first). */
  private audio: { ts: number; samples: string }[] = [];
  /** ADAAAA-7399: how many seconds of the tapped audio timeline to retain for
   * window-aligned slicing. Defaults to AUDIO_CLIP_KEEP_S (10 s) for the live
   * tap (audio arrives in real time alongside the frames, so a short rolling
   * clip IS the window). The VOD tap decodes the whole file FASTER than the
   * video pass, so it must retain the FULL timeline (capped) so the decide can
   * slice audio around each video-window center instead of the file end. */
  private readonly audioRetainS: number;
  /** ADAAAA-7671: the video rail's CONTENT position — the newest frame
   * timestamp the pipeline has actually processed. On a live run the decide
   * loop lags real time (one ~10 s gemma call per ~3 s of content), so the tap's
   * audio timeline runs far AHEAD of the window being analyzed. Pruning the
   * audio buffer relative to the newest TAP chunk (real time) therefore discards
   * exactly the audio the current window needs, and every window after the
   * first persisted `audio.path:"none"` / no `audioSeries` (measured: 1/9, 1/7,
   * 1/17 windows). Keep the retention window anchored HERE instead, so the
   * buffer always covers the pipeline's own position. `null` until the first
   * frame lands (and for a pure audio-tap run). */
  private analysisPosTs: number | null = null;
  /** ADAAAA-7255: the bounded per-chunk (t, energy, baseline) audio-gate
   * inspection series, as forwarded by perceive on the /audio event path. Kept
   * as the latest bounded snapshot (perceive already bounds it to its lookback
   * window), so it never grows on a long stream. Used to render the
   * energy-vs-baseline graph on the request-inspection view. */
  private audioSeries: { t: number; energy: number; baseline: number }[] = [];
  /** Timestamp of the last ACCEPTED GOAL highlight in this run (ADAAAA-6610
   * burst suppression). Used to drop a GOAL accepted within `goalBurstWindowS`
   * of a prior one. */
  private lastGoalHighlightTs: number | null = null;
  /** ADAAAA-7865: ACCEPTED scoring GOAL events in this run, in accept order
   * (anchor + delivered clip). A later GOAL accept whose anchor falls inside one
   * of these clips is the same goal re-read and is delivered as a celebration,
   * not as a second scoring event. Bounded — a run cannot grow it unboundedly. */
  private acceptedGoalEvents: AcceptedGoalEvent[] = [];
  /** ADAAAA-8006: LIVE goal-shaped accepts demoted for lack of a measured
   * attestation inside their judged window, waiting for a later scoreboard read
   * to re-attest them. Bounded (a run cannot hold unboundedly). */
  private deferredGoalAttestations: DeferredGoalAttestation[] = [];
  /** ADAAAA-7988: the live rail's bounded ledger of decided windows (their own
   * content instant + description class), used to cite the attack/shot window
   * that a celebration window follows. Fed on the DECIDE path; read on the
   * accept path. Empty on VOD, where the ledger is never fed. */
  readonly liveGoalRecall = new LiveWindowLedger();
  /** ADAAAA-7938 (Spec A): the measured prior-game state the NEXT decide window
   * must see (story-so-far / prior ASR / scoreboard transition). Note it on the
   * DECIDE path, not the accept path: the accept chain runs a paid Stage-2
   * confirm + clip cut per window, so it lags the decide chain — a summary
   * written on accept is invisible to the very next window's prompt (which is
   * why VOD job fe0e3efc carried no story-so-far at all). */
  private priorGame: {
    story: string;
    priorAsr: string;
    score: string | null;
    lastScoreTs: number | null;
    scored: boolean;
    lastNotedTs: number;
  } = { story: "", priorAsr: "", score: null, lastScoreTs: null, scored: false, lastNotedTs: -Infinity };

  constructor(opts: { decideWindowN?: number; goalBurstWindowS?: number; audioRetainS?: number; jobId?: string } = {}) {
    this.windowN = opts.decideWindowN ?? DECIDE_FRAME_WINDOW;
    this.goalBurstWindowS = opts.goalBurstWindowS ?? DEFAULT_GOAL_BURST_SUPPRESS_S;
    this.audioRetainS = opts.audioRetainS ?? AUDIO_CLIP_KEEP_S;
    this.delivery = new LiveDeliveryTracker(opts.jobId ?? "");
  }

  /** ADAAAA-8005 (gate 3): the per-row trigger -> delivered collector for this
   *  run. The live observers feed it the window stage clocks; the server's
   *  persist path completes each row when the store write-through acks. */
  readonly delivery: LiveDeliveryTracker;

  /** Record a sampled frame into the rolling window. The window is
   * time-bounded (DECIDE_WINDOW_SECONDS) and hard-capped (CACHE_MAX_FRAMES),
   * so it never grows on long streams. Frame findings arrive later (after the
   * /analyze round-trip) via setFindings(). */
  addFrame(seq: number, timestamp: number, imageB64: string): void {
    this.frames.set(seq, { timestamp, imageB64 });
    this.evictOldest(timestamp);
    // ADAAAA-7671: advance the analysis position so the audio tap's retention
    // follows the PIPELINE, not real time (see `analysisPosTs`).
    this.noteAnalysisPosition(timestamp);
  }
  /** Attach the already-computed perception findings to an in-window frame
   * (A1). The findings are produced by the `/analyze` call the server already
   * paid for and are cached for reuse — never re-analyzed, no extra GPU. */
  setFindings(
    seq: number,
    obs: {
      tracks: TrackObservation[];
      objects?: { label: string; confidence?: number; bbox: number[] }[];
      ocr?: string[];
    }
  ): void {
    const findings: FrameFindings = {
      tracks: obs.tracks.map((t) => ({ trackId: t.trackId, label: t.label, bbox: t.bbox as number[] })),
      objects: (obs.objects ?? []).map((o) => ({ label: o.label, confidence: o.confidence, bbox: o.bbox as number[] })),
      ocr: obs.ocr ?? [],
    };
    const existing = this.frames.get(seq);
    if (existing) existing.findings = findings;
    else this.frames.set(seq, { timestamp: seq, imageB64: "", findings });
  }
  /** OCR string count for the cached frame nearest ``ts`` (from already-computed
   * findings — never re-analyzed). Used to populate decide ``ocrHits`` evidence
   * (I3 / ADAAAA-6360); 0 when no OCR findings are cached for the moment. */
  ocrHitsAt(ts: number): number {
    let best: FrameFindings | undefined;
    let bestDiff = Infinity;
    for (const v of this.frames.values()) {
      if (!v.findings) continue;
      const d = Math.abs(v.timestamp - ts);
      if (d < bestDiff) {
        bestDiff = d;
        best = v.findings;
      }
    }
    return best?.ocr?.length ?? 0;
  }
  /** Cache a candidate event (type + timestamp + reaction signal) into the
   * window context, bounded so it never grows on long streams. */
  addCandidate(c: WindowCandidate): void {
    this.candidates.push(c);
    if (this.candidates.length > CACHE_MAX_FRAMES) this.candidates.shift();
  }
  /**
   * ADAAAA-6610 temporal burst suppression: at most ONE GOAL highlight is
   * accepted per `goalBurstWindowS` (default 30 s). The observed false-positive
   * run accepted 26 GOAL highlights, all templated, all within the first ~30 s
   * of a VOD (start-of-clip burst). Call ONLY for an already model-accepted
   * highlight (after `decision.isHighlight`): returns true when this GOAL is a
   * burst duplicate within the window and should be DROPPED (it does NOT
   * advance the last-accepted reference, so a burst cannot extend itself). A
   * non-GOAL event is never suppressed.
   *
   * ADAAAA-7402 (shootout-aware): when `corroborated` is true — the confirm
   * pass independently corroborated THIS goal's acceptance (a PENALTIS-tally
   * increment / ball-in-net attestation in a shootout, a main-score change in
   * regulation, or goal-calling audio) — the accepted goal is a DISTINCT
   * scoring event, so the effective window shrinks to the tight same-kick
   * dedup (`SHOOTOUT_KICK_DEDUP_S`): an adjacent window's re-read of the SAME
   * kick is still deduped (AC4), but the NEXT distinct conversion (>=
   * SHOOTOUT_KICK_DEDUP_S away) is no longer suppressed (AC2). A goal with NO
   * independent corroboration keeps the full 30 s ADAAAA-6610 window, so the
   * confabulated-burst guard is untouched.
   *
   * KEYING NOTE (ADAAAA-7420): key on the AGGREGATE `corroborated` flag, not on
   * `corroborationSource === "scoreboard"`. In the deployed ADAAAA-7402 flow a
   * converted penalty is corroborated via the model's ball-in-net /
   * `confirmed_goal` attestation (NOT a scoreboard change, since the aggregate
   * score is fixed in a shootout), so `corroborationSource` is typically
   * `null` for a converted penalty. Keying on the scoreboard source would miss
   * exactly the conversions we need to stop suppressing and re-break AC2.
   */
  suppressIfGoalBurst(ts: number, eventType?: string, opts: { corroborated?: boolean } = {}): boolean {
    const ev = (eventType || "").toUpperCase().trim();
    if (ev !== "GOAL" && ev !== "GOL") return false;
    const windowS = opts.corroborated ? SHOOTOUT_KICK_DEDUP_S : this.goalBurstWindowS;
    if (this.lastGoalHighlightTs != null && ts - this.lastGoalHighlightTs < windowS) {
      return true;
    }
    this.lastGoalHighlightTs = ts;
    return false;
  }
  /** ADAAAA-7865: does this GOAL accept re-read an already-accepted GOAL event?
   * Returns the covered event (so the caller can name it on the downgraded
   * record) or `undefined` for a NEW scoring event. Pure w.r.t. the ledger —
   * recording happens in {@link noteAcceptedGoalEvent} only for scoring
   * accepts, so a downgraded celebration never becomes an event itself. */
  repeatGoalEvent(input: {
    anchorTs: number;
    start: number;
    end: number;
    isGoal: boolean;
    corroborationSource?: "audio_text" | "scoreboard" | "frame_attestation" | null;
    scoreboardDeltaLegible?: boolean;
    confirmEvidenceScoreboardChanged?: boolean | null;
  }): AcceptedGoalEvent | undefined {
    return findRepeatGoalEvent(this.acceptedGoalEvents, input);
  }
  /** ADAAAA-7865: remember a delivered scoring GOAL's event coverage so a later
   * window that re-reads the same goal is recognised. Bounded to the most recent
   * events (a celebration re-read never follows its goal by hours). */
  noteAcceptedGoalEvent(ev: AcceptedGoalEvent): void {
    if (!Number.isFinite(ev.anchorTs)) return;
    this.acceptedGoalEvents.push(ev);
    if (this.acceptedGoalEvents.length > 128) this.acceptedGoalEvents.shift();
  }
  /** ADAAAA-7988: the anchors of GOAL accepts already delivered in this run, so
   * the live recall promotion cannot re-open a goal that is already on the
   * board (the ledger's own `acceptedGoalTs` check). Read-only + bounded. */
  acceptedGoalAnchors(): number[] {
    return this.acceptedGoalEvents.map((e) => e.anchorTs).filter((ts) => Number.isFinite(ts));
  }
  /** ADAAAA-8006: a LIVE goal-shaped accept that had to be demoted for lack of a
   * measured attestation inside its judged window. Kept (bounded) so a later
   * scoreboard read can still re-attest the delivered row; see
   * {@link scoreboardDeltaAttestsDeferredWindow} for the attribution predicate. */
  noteDeferredGoalAttestation(entry: DeferredGoalAttestation): void {
    if (!Number.isFinite(entry.lo) || !Number.isFinite(entry.hi) || entry.hi < entry.lo) return;
    if (!entry.highlightId) return;
    this.deferredGoalAttestations.push(entry);
    if (this.deferredGoalAttestations.length > 16) this.deferredGoalAttestations.shift();
  }
  /** ADAAAA-8006: the demoted rows this run still holds (read-only snapshot). */
  pendingDeferredGoalAttestations(): readonly DeferredGoalAttestation[] {
    return [...this.deferredGoalAttestations];
  }
  /** ADAAAA-8006: resolve ONE demoted row against a later window's scoreboard
   * read. Returns the re-emit to apply, or `[]` when nothing matches.
   *
   * Fails closed on ambiguity: when more than one demoted window is within the
   * lookahead of this transition, the read cannot say WHICH one it belongs to, so
   * none is re-attested. A delivered scoring GOAL that already owns the
   * transition (its clip window covers the transition instant, or it was
   * anchored between the demoted window's close and the read) also cancels the
   * re-emit — one score transition, one scoring row (the ADAAAA-7865 rule).
   * A resolved row is CONSUMED, so a re-decided window can never re-emit twice. */
  resolveDeferredGoalAttestation(input: {
    readAt: number;
    delta: ScoreboardDeltaEvidence | undefined | null;
    maxLookaheadS?: number;
  }): DeferredGoalAttestationUpgrade[] {
    const delta = input.delta;
    if (!scoreboardDeltaLegible(delta)) return [];
    const d = delta as ScoreboardDeltaEvidence;
    const maxLookaheadS = input.maxLookaheadS ?? LIVE_DEFERRED_ATTESTATION_LOOKAHEAD_S;
    const matches = this.deferredGoalAttestations.filter((e) =>
      scoreboardDeltaAttestsDeferredWindow({
        window: { lo: e.lo, hi: e.hi },
        delta: d,
        readAt: input.readAt,
        maxLookaheadS,
      })
    );
    if (matches.length === 0) return [];
    if (matches.length > 1) {
      console.error(
        `[live-goal-gate-upgrade:${matches[0].jobId}] ambiguous deferred attestation: the delta read at ` +
          `${d.deltaTs}s (${d.pre.join("-")} -> ${d.post.join("-")}) is within the lookahead of ` +
          `${matches.length} demoted windows [${matches.map((e) => `${e.lo}-${e.hi}`).join(", ")}] — no re-emit`
      );
      return [];
    }
    const entry = matches[0];
    const ownedByDeliveredGoal = this.acceptedGoalEvents.some(
      (ev) =>
        (ev.start <= d.deltaTs && d.deltaTs <= ev.end) || (ev.anchorTs > entry.hi && ev.anchorTs <= d.deltaTs)
    );
    if (ownedByDeliveredGoal) {
      this.deferredGoalAttestations = this.deferredGoalAttestations.filter((e) => e !== entry);
      console.error(
        `[live-goal-gate-upgrade:${entry.jobId}] refused: the transition read at ${d.deltaTs}s is already ` +
          `owned by a delivered scoring GOAL (demoted window [${entry.lo}, ${entry.hi}] stays a celebration)`
      );
      return [];
    }
    this.deferredGoalAttestations = this.deferredGoalAttestations.filter((e) => e !== entry);
    return [{ ...entry, deltaTs: d.deltaTs, readAt: input.readAt, delta: d, lookaheadS: maxLookaheadS }];
  }
  /** ADAAAA-7938 (Spec A): fold one RESOLVED decide window into the prior-game
   * state the next window inherits. Content-ordered (a re-produced older window
   * never overwrites a newer note) and MEASURED only: the prior decision's own
   * running summary / ASR, a legible scoreboard delta, and the window instant of
   * a decided scoring play. Never model prose that contradicts a measurement. */
  noteWindowGameState(
    centerTs: number,
    decision: DecisionResult,
    attestation?: { scoreBoardDelta?: ScoreboardDeltaEvidence }
  ): void {
    if (!Number.isFinite(centerTs) || centerTs <= this.priorGame.lastNotedTs) return;
    this.priorGame.lastNotedTs = centerTs;
    const story = typeof decision.runningSummary === "string" ? decision.runningSummary.trim() : "";
    if (story) this.priorGame.story = story;
    const asr = decision.analysis?.asr?.transcript;
    if (typeof asr === "string" && asr.trim()) this.priorGame.priorAsr = asr.trim();
    const delta = attestation?.scoreBoardDelta;
    if (delta && scoreboardDeltaLegible(delta)) {
      this.priorGame.score = `${delta.post[0]}-${delta.post[1]}`;
      this.priorGame.scored = true;
      this.priorGame.lastScoreTs = delta.deltaTs;
    }
    if (isScoringDecision(decision)) {
      this.priorGame.scored = true;
      if (this.priorGame.lastScoreTs === null || centerTs > this.priorGame.lastScoreTs) {
        this.priorGame.lastScoreTs = centerTs;
      }
    }
  }
  /** ADAAAA-7938 (Spec A): the bounded prior-game state for a window centred at
   * `centerTs`, or `undefined` when nothing is known yet (the first window, or a
   * run with no story/ASR/score) so the decide request stays byte-identical. */
  priorGameStateFor(centerTs: number): PriorGameState | undefined {
    const last = this.priorGame.lastScoreTs;
    const since = last === null || !Number.isFinite(centerTs) ? null : Math.max(0, centerTs - last);
    const needsNewScore =
      this.priorGame.scored && since !== null && since <= PRIOR_GAME_STATE_REACH_S;
    const story = priorTail(this.priorGame.story, PRIOR_GAME_STATE_STORY_MAX_CHARS);
    const priorAsr = priorTail(this.priorGame.priorAsr, PRIOR_GAME_STATE_ASR_MAX_CHARS);
    if (!story && !priorAsr && !needsNewScore && !this.priorGame.score) return undefined;
    return {
      story,
      priorAsr,
      score: this.priorGame.score,
      lastScoreTs: last,
      needsNewScore: needsNewScore === true,
      sinceLastScoreS: since,
    };
  }
  /** Drop frames (and stale candidates) outside the 60 s window and enforce the
   * hard size cap. Oldest entries are removed first. */
  private evictOldest(nowTs: number): void {
    const cutoff = nowTs - DECIDE_WINDOW_SECONDS;
    for (const [k, v] of this.frames) {
      if (v.timestamp < cutoff) this.frames.delete(k);
    }
    this.candidates = this.candidates.filter((c) => c.timestamp >= cutoff);
    while (this.frames.size > CACHE_MAX_FRAMES) {
      const oldest = this.frames.keys().next().value;
      if (oldest === undefined) break;
      this.frames.delete(oldest);
    }
    while (this.candidates.length > CACHE_MAX_FRAMES) this.candidates.shift();
  }
  /** Nearest sampled frame image to ``ts`` (for anchoring a candidate that
   * fired off-cycle, e.g. an audio onset between video samples), or undefined
   * when no frame is in the window yet. */
  anchor(timestamp: number): string | undefined {
    return nearestFrameImage(this.frames, timestamp);
  }
  /** Number of frames currently cached in the 60 s window (memory bound check:
   * never exceeds CACHE_MAX_FRAMES, and old frames fall off the time window). */
  cachedFrameCount(): number {
    return this.frames.size;
  }
  /** Timestamp of the newest cached frame (the representative frame for the
   * out-of-band re-check sampler), or 0 when the window is empty. */
  lastTimestamp(): number {
    let max = 0;
    for (const v of this.frames.values()) if (v.timestamp > max) max = v.timestamp;
    return max;
  }
  /** The rolling frame window as decide() `frames[]` ImageRefs (detail-first:
   * the temporal SEQUENCE Gemma reasons across). Ordered oldest -> newest, and
   * SLICED to the decide window length (legacy DECIDE_FRAME_WINDOW or the
   * detail-first `decideWindowN` knob) so a large 60 s cache never inflates the
   * per-decision vision sequence. */
  framesWindow(): { role: string; base64: string }[] {
    const all = [...this.frames.values()];
    const sliced = all.slice(-this.windowN);
    return sliced.map((f) => ({ role: "full", base64: f.imageB64 }));
  }
  /** Increment F / ADAAAA-6465: assemble the capped frame sequence for one
   * analysis call — sampled at `analysis_fps`, always including the keyframe
   * set (trigger-onset, peak-audio, window-end) and HARD-CAPPED at
   * `maxFramesPerAnalysis`. Frames are the PRIMARY evidence; audio is a cheap,
   * fallible trigger/corroboration. Samples from the already-cached window
   * (no re-extraction — no extra GPU). Empty when nothing is in the window. */
  frameSequenceFor(triggerTs: number, peakAudioTs?: number, opts: { analysisFps?: number; maxFramesPerAnalysis?: number; preWindowS?: number; postWindowS?: number } = {}): { role: string; base64: string }[] {
    const cached = [...this.frames.values()]
      .filter((f) => f.imageB64)
      .map((f) => ({ timestamp: f.timestamp, imageB64: f.imageB64 }));
    return assembleFrameSequence(cached, { triggerTs, peakAudioTs, ...opts });
  }
  /**
   * Assemble the current 60 s window's factual content as compact text (A2) —
   * the "current-context buffer" every decide() call for an in-window candidate
   * is augmented with. Pure server assembly from cached findings (tracks /
   * objects / OCR / candidates / confirmed highlights): no GPU inference, no
   * re-analysis. Returns "" when the window has nothing to add (behavior
   * identical to the pre-window baseline). Bounded by `maxChars`
   * (default WINDOW_FACTS_MAX_CHARS) — content is truncated oldest-first so
   * token growth is hard-capped.
   */
  windowFactsText(opts: { maxChars?: number; maxPerFrame?: number } = {}): string {
    const maxChars = opts.maxChars ?? WINDOW_FACTS_MAX_CHARS;
    const maxPerFrame = opts.maxPerFrame ?? 3;
    const frames = [...this.frames.values()].sort((a, b) => a.timestamp - b.timestamp);
    const lines: string[] = [];
    for (const f of frames) {
      if (!f.findings) continue; // frame with no cached findings contributes nothing
      const parts: string[] = [];
      const tracks = f.findings.tracks.slice(0, maxPerFrame);
      if (tracks.length) {
        parts.push(
          "tracks:" +
            tracks.map((t) => `${t.label || t.trackId}@${(t.bbox as number[]).map((b) => b.toFixed(2)).join(",")}`).join(";")
        );
      }
      const objs = f.findings.objects.slice(0, maxPerFrame);
      if (objs.length) parts.push("objs:" + objs.map((o) => o.label).join(";"));
      if (f.findings.ocr.length) parts.push("ocr:" + f.findings.ocr.slice(0, 3).join(" | "));
      if (parts.length) lines.push(`[t=${f.timestamp.toFixed(1)}s] ${parts.join(" ")}`);
    }
    const cands = [...this.candidates].sort((a, b) => a.timestamp - b.timestamp).slice(-maxPerFrame);
    for (const c of cands) {
      const sig = c.reaction && c.reaction.crowdEnergy > 0 ? ` (rxn:e=${c.reaction.crowdEnergy.toFixed(2)})` : "";
      lines.push(`[t=${c.timestamp.toFixed(1)}s] candidate:${c.eventType}${sig}`);
    }
    // Confirmed highlights that fall inside the current window.
    if (this.highlights.length) {
      const newestTs = frames.length ? frames[frames.length - 1].timestamp : NaN;
      const lo = newestTs - DECIDE_WINDOW_SECONDS;
      for (const h of this.highlights) {
        if (h.start >= lo || (Number.isNaN(lo) && h.start >= 0)) {
          lines.push(`[t=${h.start.toFixed(1)}s] highlight:${h.eventType}`);
        }
      }
    }
    let text = lines.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars) + "…";
    return text;
  }
  /** Buffer one audio tap chunk (base64 mono 16 kHz int16 PCM, ~100 ms) into
   * the rolling clip, keeping the retention window anchored on the video rail's
   * analysis position (ADAAAA-7671 — see `analysisPosTs`). */
  addAudioChunk(ts: number, samples: string): void {
    this.audio.push({ ts, samples });
    this.pruneAudioBuffer();
  }
  /** ADAAAA-7671: advance the video rail's content position and re-prune the
   * retained audio + audio series against it. Called from `addFrame`, so a run
   * that never receives frames (pure audio tap) keeps the legacy
   * "relative to the newest chunk" behaviour. */
  private noteAnalysisPosition(ts: number): void {
    if (!Number.isFinite(ts)) return;
    if (this.analysisPosTs === null || ts > this.analysisPosTs) this.analysisPosTs = ts;
    this.pruneAudioBuffer();
    this.pruneAudioSeries();
  }
  /** ADAAAA-7671: the retention anchor — the analysis position when known,
   * otherwise the newest buffered chunk (legacy behaviour). */
  private retentionAnchor(newestTs: number): number {
    const pos = this.analysisPosTs;
    return pos === null ? newestTs : Math.min(pos, newestTs);
  }
  /** ADAAAA-7671: drop buffered audio older than the retention window measured
   * back from the ANALYSIS position (not from the newest tap chunk), so the
   * audio for the window currently being decided is still buffered. A hard
   * memory cap bounds the buffer when the tap races far ahead of the pipeline
   * (live: ~10 s gemma per 3 s of content). */
  private pruneAudioBuffer(): void {
    if (!this.audio.length) return;
    const newest = this.audio[this.audio.length - 1].ts;
    const cutoff = this.retentionAnchor(newest) - this.audioRetainS;
    while (this.audio.length > 1 && this.audio[0].ts < cutoff) this.audio.shift();
    // The hard cap must never undercut the CONFIGURED retention: the VOD pass
    // deliberately retains the whole file timeline (VOD_AUDIO_RETAIN_S).
    const capCutoff = newest - Math.max(AUDIO_BUFFER_MAX_S, this.audioRetainS);
    while (this.audio.length > 1 && this.audio[0].ts < capCutoff) this.audio.shift();
  }
  /** The buffered audio as a mono 16 kHz 16-bit PCM WAV (base64), covering the
   * last `AUDIO_CLIP_KEEP_S` seconds — the surrounding audio clip for decide().
   * ADAAAA-7671: the slice length is independent of the retention window (which
   * may be longer than the clip on live), so the clip can never balloon into a
   * multi-minute WAV. "" when the tap has buffered nothing yet. */
  audioClipB64(): string {
    if (!this.audio.length) return "";
    const newest = this.audio[this.audio.length - 1].ts;
    const from = newest - AUDIO_CLIP_KEEP_S;
    const parts = this.audio.filter((a) => a.ts > from).map((a) => a.samples);
    if (!parts.length) return "";
    return pcmInt16ToWavB64(joinPcmB64Parts(parts));
  }
  /** ADAAAA-7399: the buffered audio as a mono 16 kHz WAV (base64) SLICED to
   * the chunks whose ts falls in `[centerTs - preS, centerTs + postS]` — the
   * WINDOW-ALIGNED surrounding audio for a decide window. The VOD tap decodes
   * the whole file faster than the GPU video pass, so the plain rolling
   * `audioClipB64()` returns FILE-END audio, not the current video-window
   * center; this slices the retained timeline around the window center (the
   * live/file-sim tap arrives in real time, so here it behaves identically to
   * the rolling clip). "" when no buffered chunk falls in range (silent /
   * no-tap window -> stays text-only, no regression). */
  audioWindowB64(centerTs: number, preS: number, postS: number): string {
    const lo = centerTs - preS;
    const hi = centerTs + postS;
    const inWin = this.audio.filter((a) => a.ts >= lo && a.ts <= hi);
    if (!inWin.length) return "";
    // ADAAAA-7665: join the chunk BYTES (not their padded base64 strings) — the
    // padded-string join truncated every window to its first 100 ms.
    return pcmInt16ToWavB64(joinPcmB64Parts(inWin.map((a) => a.samples)));
  }
  /** ADAAAA-7399 (instrumentation): number of audio tap chunks currently
   * buffered. Logged at the VOD decide so on-box runs reveal whether the tap
   * reached the shared window (0 => no audio context reached the LLM). */
  audioChunkCount(): number {
    return this.audio.length;
  }
  /** ADAAAA-7671 (instrumentation): the buffered tap audio's content-time span
   * plus the video rail's analysis position, so a live on-box run shows whether
   * the tap reached the window being decided (`[live-audio:<job>] decide ...`
   * log line). Null ends mean nothing buffered yet. */
  audioSpan(): { from: number | null; to: number | null; pos: number | null } {
    return {
      from: this.audio.length ? this.audio[0].ts : null,
      to: this.audio.length ? this.audio[this.audio.length - 1].ts : null,
      pos: this.analysisPosTs,
    };
  }
  /** ADAAAA-7255: merge the bounded per-chunk (t, energy, baseline) audio-gate
   * inspection series that perceive forwarded on the /audio event path.
   * ADAAAA-7671: perceive's snapshot only covers its own ~1.7 s lookback, and on
   * live the audio tap runs far AHEAD of the (lagging) analysis window, so
   * keeping only the LATEST snapshot left every window after the first with an
   * empty series (the AUDIO energy graph never rendered). Accumulate the points
   * keyed by content time and prune them against the analysis position, exactly
   * like the audio buffer. Bounded, so a long stream never grows it. */
  setAudioSeries(points: { t: number; energy: number; baseline: number }[]): void {
    if (!Array.isArray(points)) return;
    // An EMPTY snapshot is the "no tap data at all" signal (fresh session); it
    // still resets, exactly as the previous replace-only contract did.
    if (!points.length) {
      this.audioSeries = [];
      return;
    }
    const byTs = new Map<number, { t: number; energy: number; baseline: number }>();
    for (const p of this.audioSeries) byTs.set(p.t, p);
    for (const p of points) {
      if (p && Number.isFinite(p.t)) byTs.set(p.t, { t: p.t, energy: p.energy, baseline: p.baseline });
    }
    this.audioSeries = [...byTs.values()].sort((a, b) => a.t - b.t);
    this.pruneAudioSeries();
  }
  /** ADAAAA-7671: drop inspection-series points older than the retention window
   * measured from the analysis position (mirrors `pruneAudioBuffer`), and keep a
   * hard point cap as a memory bound. */
  private pruneAudioSeries(): void {
    if (!this.audioSeries.length) return;
    const newest = this.audioSeries[this.audioSeries.length - 1].t;
    const cutoff = this.retentionAnchor(newest) - this.audioRetainS;
    this.audioSeries = this.audioSeries.filter((p) => p.t >= cutoff);
    const maxPoints = Math.max(AUDIO_SERIES_MAX_POINTS, Math.round(this.audioRetainS * 10) + 200);
    if (this.audioSeries.length > maxPoints) {
      this.audioSeries = this.audioSeries.slice(-maxPoints);
    }
  }
  /** ADAAAA-7658: observed audio-trigger records not yet handed to the live
   * decide observer. Bounded — a trigger is drained (or expires) within a
   * couple of frames, so this can never accumulate on a long stream. */
  private audioTriggerQueue: AudioTriggerRecord[] = [];
  /**
   * ADAAAA-7658: record a fired audio-noise trigger (from a perceive `/audio`
   * candidate) so the live decide loop can schedule ONE analysis window
   * anchored to its onset instead of only blind cadence. The record is
   * provenance + schedule request, never a decide verdict.
   *
   * ADAAAA-7694: the same record also enters the Stage-A outcome ledger, which
   * BOTH rails measure through — the trigger's outcome is the verdict of the
   * decide window that judges its onset. On the VOD rail there is no anchoring
   * (no frame to anchor to ahead of the decode), so the ledger is the only
   * consumer there.
   */
  recordAudioTrigger(trigger: AudioTriggerRecord | null | undefined): boolean {
    if (!trigger) return false;
    // ADAAAA-7707: family-aware routing. A `stageB/*` (whistle) trigger is
    // recorded in its own ledger and NEVER in the Stage-A one, so the published
    // Stage-A fidelity numbers cannot move because the whistle path emits.
    if (isStageBTrigger(trigger.thresholdId)) {
      // Counted only when the ledger ACCEPTS it: a re-fire inside the coalesce
      // window is one audible event, so the volume counter is a per-event rate.
      if (this.stageBOutcomes.recordTrigger(trigger)) this.whistleTriggerTally++;
    } else {
      this.stageAOutcomes.recordTrigger(trigger);
    }
    this.audioTriggerQueue.push(trigger);
    if (this.audioTriggerQueue.length > 32) this.audioTriggerQueue.shift();
    return true;
  }
  /** ADAAAA-7707: whistle triggers recorded on this run (emission volume). */
  whistleTriggerCount(): number {
    return this.whistleTriggerTally;
  }
  /** Drain the pending audio triggers (the live loop feeds them to the
   * observer each frame). Empty array when none are pending. */
  takeAudioTriggers(): AudioTriggerRecord[] {
    if (!this.audioTriggerQueue.length) return [];
    const out = this.audioTriggerQueue;
    this.audioTriggerQueue = [];
    return out;
  }
  /** ADAAAA-7255: the audio-gate inspection series points whose ``t`` falls in
   * ``[centerTs - preS, centerTs + postS]`` (oldest -> newest), for the
   * per-window energy-vs-baseline graph. Empty when no audio tap data reached
   * the run. */
  seriesWindow(centerTs: number, preS: number, postS: number): { t: number; energy: number; baseline: number }[] {
    const lo = centerTs - preS;
    const hi = centerTs + postS;
    return this.audioSeries.filter((p) => p.t >= lo && p.t <= hi).sort((a, b) => a.t - b.t);
  }
  /**
   * I4 / ADAAAA-6361: the audio-energy level CURVE (not just one scalar peak).
   * Computes a normalized RMS energy per buffered tap (~100 ms), newest-first
   * trimmed to `maxPoints`, so the decide prompt can cite the shape of the
   * crowd/commentary energy around the trigger. [] when nothing buffered yet.
   */
  audioLevelSeries(maxPoints = 48): number[] {
    const out = this.audio.map((a) => rmsNormalized(Buffer.from(a.samples, "base64")));
    return out.slice(-Math.max(1, maxPoints));
  }
  /** ADAAAA-7399: timestamped RMS energy per buffered audio tap (oldest-first)
   * for deterministic highlight-instant localization (peak-audio post-trigger).
   * [] when nothing buffered. No new inference / no GPU call. */
  audioEnergyTaps(): { ts: number; rms: number }[] {
    return this.audio.map((a) => ({ ts: a.ts, rms: rmsNormalized(Buffer.from(a.samples, "base64")) }));
  }
  /** ADAAAA-7399: the window-aligned audio-energy level curve around a decide
   * center (chunks within [center-preS, center+postS]), newest-first trimmed to
   * `maxPoints`. [] when no buffered chunk falls in range. Lets the Stage-1
   * decide evidence carry audio intensity (not just the ASR text). */
  audioWindowLevels(centerTs: number, preS: number, postS: number, maxPoints = 48): number[] {
    const lo = centerTs - preS;
    const hi = centerTs + postS;
    const inWin = this.audio.filter((a) => a.ts >= lo && a.ts <= hi);
    const out = inWin.map((a) => rmsNormalized(Buffer.from(a.samples, "base64")));
    return out.slice(-Math.max(1, maxPoints));
  }
  /** I4 / ADAAAA-6361: per-detection boxes (tracks + open-set objects) for the
   * frame FINDINGS nearest `timestamp`, so the decide prompt gets real geometry
   * (bboxes) instead of asking Gemma to guess positions from vision alone. []
   * when no in-window frame has cached findings yet. */
  richDetections(timestamp: number): DetectionEvidence[] {
    let best: FrameFindings | undefined;
    let bestDiff = Infinity;
    for (const v of this.frames.values()) {
      if (!v.findings) continue;
      const d = Math.abs(v.timestamp - timestamp);
      if (d < bestDiff) {
        bestDiff = d;
        best = v.findings;
      }
    }
    if (!best) return [];
    const out: DetectionEvidence[] = [];
    for (const t of best.tracks) {
      out.push({ label: t.label || "player", bbox: t.bbox as number[], confidence: 0, trackId: t.trackId });
    }
    for (const o of best.objects) {
      out.push({ label: o.label, bbox: o.bbox as number[], confidence: o.confidence ?? 0, trackId: "" });
    }
    return out.slice(0, 16);
  }
  /** I4 / ADAAAA-6361: normalized [x, y] center of the soccer ball detection in
   * the findings nearest `timestamp`, or undefined when no ball is tracked yet.
   * Uses the label shallow-match used elsewhere in the soccer closed roster. */
  ballPosition(timestamp: number): [number, number] | undefined {
    const dets = this.richDetections(timestamp);
    const ball = dets.find((d) => /ball/i.test(d.label));
    if (!ball || ball.bbox.length < 4) return undefined;
    const [x1, y1, x2, y2] = ball.bbox;
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }
  /** Record one confirmation-pass dive into the Stage-1 vs Stage-2 metric
   * (ADAAAA-6797). `stage1Disagreed` is only counted when a real reconciled
   * verdict came back (a transport failure / passthrough records a run with no
   * disagreement). */
  recordConfirm(result: { stage1Disagreed?: boolean }): void {
    this.confirmMetrics.totalRuns++;
    if (result.stage1Disagreed === true) this.confirmMetrics.disagreed++;
  }
  /** ADAAAA-7365: whether this goal candidate (~stable goal-event identity) has
   * already had its Stage-2 confirm dive processed, and the cached outcome.
   * Returns undefined when not yet processed (first observation of the goal). */
  confirmedGoalOutcome(
    key: string
  ): { decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision } | undefined {
    return this.confirmedGoals.get(key)?.outcome;
  }
  /** ADAAAA-7663: reuse an already-confirmed goal whose EVENT instant is within
   * `windowS` of `goalEventTs`. The live observer re-reads one goal across
   * overlapping ROLLING windows whose center slides with the cadence, so its
   * center-derived identity changes window to window; this proximity reuse keeps
   * the dive at one per distinct goal. `windowS` is the accept path's burst
   * window, so a reuse can never merge two goals that could both have been
   * accepted. Nearest match wins; undefined when nothing is in range. */
  confirmedGoalNear(
    goalEventTs: number,
    windowS: number
  ): { decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision } | undefined {
    if (!Number.isFinite(goalEventTs) || !(windowS > 0)) return undefined;
    let best: { decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision } | undefined;
    let bestDiff = Infinity;
    for (const v of this.confirmedGoals.values()) {
      if (!Number.isFinite(v.ts)) continue;
      const diff = Math.abs(v.ts - goalEventTs);
      if (diff <= windowS && diff < bestDiff) {
        bestDiff = diff;
        best = v.outcome;
      }
    }
    return best;
  }
  /** ADAAAA-7365: remember the outcome of the (first) confirm dive for a goal
   * candidate so re-produced overlapping observe windows reuse it instead of
   * re-billing / re-confirming / re-cutting. ADAAAA-7663: `goalEventTs` records
   * the event instant the key was derived from, enabling `confirmedGoalNear`.
   * Bounded to avoid growth on long streams. */
  rememberConfirmedGoal(
    key: string,
    outcome: { decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision },
    goalEventTs?: number
  ): void {
    this.confirmedGoals.set(key, { ts: goalEventTs ?? NaN, outcome });
    if (this.confirmedGoals.size > 256) {
      const first = this.confirmedGoals.keys().next().value;
      if (first !== undefined) this.confirmedGoals.delete(first);
    }
  }
  /** Sampled frames inside [ts-windowS, ts+windowS] as raw {timestamp, imageB64}
   * pairs (oldest -> newest), for the Stage-2 denser window / keyframes. Uses
   * the already-cached frame window — no new GPU. [] when nothing cached. */
  framesNear(timestamp: number, windowS: number): { timestamp: number; imageB64: string }[] {
    return [...this.frames.values()]
      .filter((f) => f.imageB64 && f.timestamp >= timestamp - windowS && f.timestamp <= timestamp + windowS)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((f) => ({ timestamp: f.timestamp, imageB64: f.imageB64 }));
  }
  /** Build the Stage-2 object/ball trajectory tracks + motion/optical-flow
   * magnitude (ADAAAA-6797) from the ALREADY-COMPUTED cached findings — no new
   * GPU inference. For each tracked object it assembles a per-timestep
   * [t, cx, cy] center path across the in-window frames; `opticalFlowMagnitude`
   * is the max single-step center displacement (a motion proxy) and
   * `flowMagnitudes` is the per-frame max displacement series. Empty / 0 when
   * no track findings are cached in the window. */
  motionContext(timestamp: number): {
    trajectories: { label: string; trackId: string; path: number[][] }[];
    opticalFlowMagnitude: number;
    flowMagnitudes: number[];
  } {
    const frames = [...this.frames.values()]
      .filter((f) => f.findings && f.timestamp >= timestamp - CONFIRM_MOTION_WINDOW_S && f.timestamp <= timestamp + CONFIRM_MOTION_WINDOW_S)
      .sort((a, b) => a.timestamp - b.timestamp);
    const byTrack = new Map<string, { label: string; path: number[][] }>();
    const prevPos = new Map<string, [number, number]>();
    let opticalFlowMagnitude = 0;
    const flowMagnitudes: number[] = [];
    for (const f of frames) {
      let frameMax = 0;
      for (const t of f.findings!.tracks) {
        const bbox = t.bbox as number[];
        if (!bbox || bbox.length < 4) continue;
        const cx = (bbox[0] + bbox[2]) / 2;
        const cy = (bbox[1] + bbox[3]) / 2;
        const key = t.trackId || t.label || "obj";
        const entry = byTrack.get(key) ?? { label: t.label || "object", path: [] };
        entry.path.push([f.timestamp, cx, cy]);
        byTrack.set(key, entry);
        const prev = prevPos.get(key);
        if (prev) {
          const d = Math.hypot(cx - prev[0], cy - prev[1]);
          if (d > frameMax) frameMax = d;
          if (d > opticalFlowMagnitude) opticalFlowMagnitude = d;
        }
        prevPos.set(key, [cx, cy]);
      }
      flowMagnitudes.push(frameMax);
    }
    const trajectories = [...byTrack.values()]
      .map((e) => ({ label: e.label, trackId: e.label, path: e.path }))
      .slice(0, 8);
    return { trajectories, opticalFlowMagnitude, flowMagnitudes };
  }
}

/** Seconds of audio tap kept for the decide() surrounding-audio clip
 * (ADAAAA-4954 detail-first; bounded so a long VOD pass doesn't grow unbounded).
 * Roughly the clip-relevant window around a trigger. */
export const AUDIO_CLIP_KEEP_S = 10;
/** ADAAAA-7671: how many seconds of tapped audio a LIVE run retains for
 * window-aligned slicing. Retention is measured back from the pipeline's
 * analysis position, and a live window is the trailing LIVE_OBSERVE_WINDOW_S
 * (10 s) plus AUDIO_WINDOW_MARGIN_S on each side, so 10 s clipped the window's
 * own head. 20 s covers the whole window with headroom at ~640 KB of PCM. */
export const LIVE_AUDIO_RETAIN_S = 20;
/** ADAAAA-7671: hard memory cap on the retained tap audio. When the tap races
 * far ahead of a lagging live analysis position, the retention window itself can
 * span minutes; this bounds the buffer at ~7.7 MB of PCM. */
export const AUDIO_BUFFER_MAX_S = 240;
/** ADAAAA-7671: hard cap on retained audio-gate inspection-series points
 * (~10 Hz, so 240 s of series). */
export const AUDIO_SERIES_MAX_POINTS = 2400;
/** ADAAAA-7399: extra seconds of audio to slice on each side of a decide-window
 * center (beyond the frame span) so the clip brackets the whole window. */
export const AUDIO_WINDOW_MARGIN_S = 2;
/** ADAAAA-7399: fallback half-window (seconds) when a decide payload has no
 * frame timestamps to derive the window span from. */
export const AUDIO_DEFAULT_WINDOW_S = 5;
/** Stage-2 confirmation-pass motion-context window (s on each side of the
 * event instant) the server samples cached track findings from (ADAAAA-6797).
 * Roughly the dense-dive window; no new GPU (reuses cached findings). */
export const CONFIRM_MOTION_WINDOW_S = 5;
/** ADAAAA-7162: extra seconds (each side) the Stage-2 confirmation frame window
 * is expanded beyond the Stage-1 pre/post window, so the confirm pass sees the
 * ball actually cross the line / enter the net. 4 s is within the required
 * 3-5 s window. Tune via `DECIDE_CONFIRM_EXTRA_WINDOW_S`. */
export const DEFAULT_CONFIRM_WINDOW_EXTRA_S = 4;

/** ADAAAA-7543: the maximum number of frames handed to the Stage-2 deep dive.
 * The VOD detail-first burst re-sample is 8 fps over ±3 s (48 frames); feeding
 * that dense burst made the verification pass lose the ball-in-net instant and
 * REFUTE genuine goals (measured on /data/clips soc-goal-01: the same window
 * attests ball-in-net + line-crossed at ~11 evenly spaced frames but refutes at
 * 16+ frames / multi-fps bursts). A bounded, evenly spaced sequence keeps the
 * whole pre-instant -> aftermath span visible while staying readable. */
export const CONFIRM_MAX_FRAMES = 12;

/** ADAAAA-7543: evenly downsample a dense confirm frame sequence to at most
 * `max` frames, ALWAYS keeping the first and last frame so the window's full
 * temporal span survives. Pure + order-preserving, so it is unit-testable and a
 * no-op when the sequence already fits. */
export function downsampleConfirmFrames<T>(frames: T[], max = CONFIRM_MAX_FRAMES): T[] {
  const all = frames ?? [];
  const cap = Math.max(2, Math.floor(max));
  const n = all.length;
  if (n <= cap) return all;
  const out: T[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(all[Math.round((i * (n - 1)) / (cap - 1))]);
  }
  return out;
}

/** Wrap a run of base64 mono 16 kHz int16 PCM samples into a RIFF/WAVE file and
 * return it as base64. Pure + deterministic so it is unit-testable. The decide
 * runner accepts a mono WAV at any of the common PCM bit depths; 16-bit is the
 * natural format our ffmpeg tap already emits (pcm_s16le). */
export function pcmInt16ToWavB64(samplesB64: string, sampleRate = 16_000): string {
  const pcm = Buffer.from(samplesB64, "base64");
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}


/**
 * Increment D (ADAAAA-6467): the what-to-track plan orchestrator on the
 * worker. Owns the SINGLE stream-start warm-up plan call and the out-of-band
 * re-check cadence, and holds the active TrackingPlan that the per-frame
 * /analyze path delivers to perceive (so detect/seeding stays scoped to the
 * plan's roster). CRITICAL INVARIANT: it NEVER calls the planner from the
 * per-frame loop — planner calls happen exactly at warm-up and on the
 * re-check cadence, so per-frame planner/discovery invocations = 0 and the
 * 1-5 s live detection budget is preserved.
 *
 * Guardrails (applied here + by perceive's TrackingPlan contract):
 *  - maxTracks is clamped to the mode cap (3 live / 8 VOD) — both the decide
 *    runner and here; a plan can never exceed the company cap.
 *  - Narrow-only: a plan can only narrow the roster to what is detectable; it
 *    may not widen past the closed-vocab gate. perceive already degrades any
 *    untrackable/off-plan target, so a bad plan yields an empty roster ->
 *    canned/safe-default. The controller additionally drops a plan whose
 *    maxTracks exceeds the cap or whose targets are empty/untrackable.
 *  - Degrade-to-canned/safe-default: on an absent/invalid planner reply the
 *    controller keeps the previous plan (or no plan) and lets perceive run the
 *    canned gameHint roster — never a dead stream, never a per-frame planner
 *    retry.
 */
export class TrackingPlanController {
  private activePlan: TrackingPlanResult | null = null;
  private plannedAt = 0;
  private warmup = false;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly warmupSeconds: number;
  private readonly recheckIntervalSeconds: number;
  private readonly planMode: "live" | "vod";
  /** Sequential re-check marker so overlapping re-plan calls cannot race. */
  private replanning = false;
  onPlan?: (plan: TrackingPlanResult | null, source: "warmup" | "recheck" | "candidate") => void;

  constructor(cfg: { warmupSeconds?: number; recheckIntervalSeconds?: number; planMode?: "live" | "vod" }) {
    this.warmupSeconds = cfg.warmupSeconds ?? 3;
    this.recheckIntervalSeconds = cfg.recheckIntervalSeconds ?? 10;
    this.planMode = cfg.planMode ?? "live";
  }

  get active(): TrackingPlanResult | null {
    return this.activePlan;
  }
  get lastPlanAt(): number {
    return this.plannedAt;
  }
  /** The plan dict to deliver on the next /analyze (or null for the canned
   * /safe-default interim). `maxTracks` is already clamped. */
  delivery(): Record<string, unknown> | null {
    return this.activePlan ? { ...this.activePlan } : null;
  }

  private buildRequest(imageB64: string | undefined): PlanRequest {
    return {
      intent: "",
      category: (this.activePlan?.category as string) || "",
      gameHint: undefined,
      mode: this.planMode,
      imageB64,
      context: this.activePlan ? { previousPlan: this.activePlan } : undefined,
    };
  }

  private apply(plan: TrackingPlanResult | null): void {
    if (plan && plan.maxTracks > (this.planMode === "vod" ? 8 : 3)) {
      // Hard clamp — a plan can NEVER exceed the mode cap (company invariant).
      plan = { ...plan, maxTracks: this.planMode === "vod" ? 8 : 3 };
    }
    this.activePlan = plan;
    this.plannedAt = plan?.plannedAt ?? Date.now() / 1000;
  }

  /** Fire exactly ONE warm-up plan call (blocking the first frame's plan
   * delivery, NOT the per-frame loop). Returns the plan or null. */
  async warmUp(client: PipelineClient, imageB64?: string): Promise<TrackingPlanResult | null> {
    if (this.warmup) return this.activePlan;
    this.warmup = true;
    const plan = await this.replan(client, imageB64, "warmup");
    this.onPlan?.(plan, "warmup");
    return plan;
  }

  /** Start the out-of-band re-check cadence. `sample` returns a representative
   * in-window frame (imageB64) for the planner, or undefined when the window
   * has none yet. Runs OFF the per-frame path; the timer never blocks a frame. */
  startRecheck(client: PipelineClient, sample: () => string | undefined): void {
    if (this.recheckTimer || this.stopped) return;
    this.recheckTimer = setInterval(async () => {
      if (this.stopped || this.replanning) return;
      try {
        const plan = await this.replan(client, sample(), "recheck");
        if (plan) this.onPlan?.(plan, "recheck");
      } catch {
        /* re-check is best-effort — the last good plan stays active */
      }
    }, Math.max(1, this.recheckIntervalSeconds) * 1000);
    // Let the timer not keep the process alive after the job ends.
    if (typeof this.recheckTimer.unref === "function") this.recheckTimer.unref();
  }

  /** Immediate re-plan on a candidate event (out of band from the per-frame
   * detection; invoked by the worker's candidate handler). */
  async onCandidate(client: PipelineClient, imageB64?: string): Promise<void> {
    if (this.stopped || this.replanning) return;
    const plan = await this.replan(client, imageB64, "candidate");
    if (plan) this.onPlan?.(plan, "candidate");
  }

  /** One planner call (warm-up / re-check / candidate). Never throws; on any
   * failure keeps the current plan (perceive degrades to canned/safe-default
   * if there is none). Bound so it never becomes a per-frame call. */
  private async replan(
    client: PipelineClient,
    imageB64: string | undefined,
    _why: string
  ): Promise<TrackingPlanResult | null> {
    if (this.replanning) return this.activePlan;
    this.replanning = true;
    try {
      let res: TrackingPlanResult | null = null;
      try {
        res = await client.plan(this.buildRequest(imageB64));
      } catch {
        // planner call failed (unreachable / 4xx): keep the current plan, so
        // perceive degrades to canned/safe-default if there is none. Never an
        // unhandled rejection from the warm-up / re-check paths.
        return this.activePlan;
      }
      if (!res || typeof res !== "object") return this.activePlan;
      // Narrow-only guard: a plan with no trackable targets or an empty roster
      // is dropped (perceive will run the canned/safe-default roster), unless
      // it is an explicit safe-default fallback (source planner-fallback with
      // empty targets is still valid — it means "degrade to canned").
      const targets = Array.isArray(res.targets) ? res.targets : [];
      const trackable = targets.some((t) => t && typeof t.label === "string" && t.label.trim() !== "");
      if (!trackable && !targets.length) {
        // empty roster — valid only as an explicit degrade signal; keep active
        // plan unchanged so prior scoping is preserved, else hand the fallback.
        if (res.source === "planner-fallback" && !this.activePlan && targets.length === 0) {
          this.apply(res);
          return this.activePlan;
        }
        return this.activePlan;
      }
      this.apply(res);
      return this.activePlan;
    } finally {
      this.replanning = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) {
      clearInterval(this.recheckTimer);
      this.recheckTimer = null;
    }
  }
}

/** Compact `path: message` rendering of a zod failure (ADAAAA-7848), for a log
 * line that names the exact field so a future contract drift is actionable. */
function describeZodIssues(err: unknown): string {
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return String((err as { message?: unknown })?.message ?? err);
  const rendered = issues.slice(0, 6).map((i: any) => {
    const path = Array.isArray(i?.path) && i.path.length ? i.path.join(".") : "<root>";
    return `${path}: ${i?.message ?? i?.code ?? "invalid"}`;
  });
  if (issues.length > rendered.length) rendered.push(`(+${issues.length - rendered.length} more)`);
  return rendered.join("; ");
}

/** Last-resort projection of a confirm record so its payload still reaches the
 * board (ADAAAA-7848): a `dataItems` value that is not a scalar (string /
 * number / boolean) or a bounded scalar series is rendered as compact text
 * instead of failing the whole block. Nothing else is touched — a genuinely
 * malformed record still fails the retry and is logged. */
function salvageConfirmRecord(confirm: ConfirmRecord): ConfirmRecord {
  const request: any = (confirm as any)?.request;
  if (!request || !Array.isArray(request.dataItems)) return confirm;
  const dataItems = request.dataItems.map((item: any) => {
    const value = item?.value;
    if (value === null || value === undefined) return item;
    const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    const series = Array.isArray(value) && value.every(
      (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    );
    if (scalar || series) return item;
    let text: string;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return { ...item, value: text };
  });
  return { ...confirm, request: { ...request, dataItems } } as ConfirmRecord;
}

/** Build + emit a persisted decide note for one evaluation (ADAAAA-6851 Inc 2).
 * `status` captures why the trigger did/didn't become a highlight record
 * (accepted / suppressed / rejected). Called at the SAME decision point that
 * builds the HighlightRecord, so every decide() result is recorded, not just
 * accepted ones. Best-effort: a throwing onDecision is caught + logged and
 * never fails the frame loop. */
export function buildCandidateNote(
  cfg: AnalyzerConfig,
  candidate: CandidateSignal,
  decision: DecisionResult,
  status: "accepted" | "suppressed" | "rejected",
  candidateId: string,
  trigger: HighlightTrigger,
  // ADAAAA-7156 Increment B: the per-window analysis + Stage-2 confirm record
  // captured at the decide boundary, persisted onto the JobCandidate so the
  // job-detail API can expose them. Observability only; absent on legacy rows.
  analysis?: WindowAnalysis,
  confirm?: ConfirmRecord
): void {
  if (!cfg.onDecision) return;
  // ADAAAA-7156 Increment B: only attach analysis/confirm blocks that conform to
  // the contract, so a malformed decide response (or a future schema drift) can
  // never make the WHOLE candidate note fail recordJobCandidate's parse and get
  // dropped from persistence. Observability is best-effort: a bad block is
  // skipped (window still shows as decided, without analysis) rather than
  // silently losing the note.
  //
  // ADAAAA-7848: a rejected block used to be swallowed (`catch {}`), which made
  // the loss invisible — job dee44c2f persisted 103/103 window analyses and 0/103
  // confirm records with no trace anywhere. Every rejection is now logged with
  // the job id + the zod issues, and the confirm record gets ONE salvage retry
  // with non-conforming `dataItems` values coerced to text, so a single drifting
  // context field degrades the record instead of deleting the model's evidence.
  let okAnalysis = analysis;
  let okConfirm = confirm;
  if (analysis !== undefined) {
    try { okAnalysis = WindowAnalysisSchema.parse(analysis); }
    catch (e) {
      console.error(`[decide-note:${cfg.jobId}] window analysis rejected: ${describeZodIssues(e)}`);
      okAnalysis = undefined;
    }
  }
  if (confirm !== undefined) {
    try { okConfirm = ConfirmRecordSchema.parse(confirm); }
    catch (e) {
      console.error(`[decide-note:${cfg.jobId}] confirm record rejected: ${describeZodIssues(e)}`);
      try {
        okConfirm = ConfirmRecordSchema.parse(salvageConfirmRecord(confirm));
      } catch (e2) {
        console.error(`[decide-note:${cfg.jobId}] confirm record unsalvageable: ${describeZodIssues(e2)}`);
        okConfirm = undefined;
      }
    }
  }
  try {
    cfg.onDecision({
      id: candidateId,
      jobId: cfg.jobId,
      seq: candidate.seq ?? 0,
      timestamp: candidate.timestamp,
      eventType: highlightEventType(decision, candidate.eventType),
      score: decision.score,
      isHighlight: decision.isHighlight,
      outcome: decision.outcome,
      nearMiss: decision.nearMiss,
      reason: decision.reason,
      status,
      trigger,
      analysis: okAnalysis,
      confirm: okConfirm,
      createdAt: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error(`[decide-note:${cfg.jobId}] persist failed:`, String(e?.message || e));
  }
}
/** Accept (or suppress) a decided candidate with exactly the serial semantics:
 * goal-burst suppression applied in timestamp order, then cut + record + SSE
 * `highlight` event (which drives decision-time persist/bill/quota exactly
 * once). Shared by the serial (live / w=1) inline path and the ordered VOD
 * pipeline so both are byte-for-byte identical. */
/** ADAAAA-6874 (Phase 2): deterministic per-highlight idempotency key anchored
 * on the job + candidate frame seq + event type. A re-claimed/resumed job that
 * re-decides the same candidate produces the SAME key, so the server's
 * addHighlight dedup prevents double-persist and double-billing. */
export function highlightIdempotencyKey(jobId: string, seq: number, eventType?: string): string {
  return `hl:${jobId}:${seq}:${eventType ?? "highlight"}`;
}

/** ADAAAA-7118: the dedup key the VOD onEvent guard (and any caller mirroring
 * store.addHighlight) must use. It is the SAME key store.addHighlight dedups on
 * (a persisted record's `idempotencyKey`), so a candidate that emits two
 * `highlight` events with an identical key (e.g. the GOAL anchor at the same seq)
 * increments `highlightsFound` exactly once and the live counter matches the
 * persisted count during processing. Legacy persisted rows without an
 * idempotencyKey fall back to the legacy `start|eventType` form so resume
 * protection still holds for them. */
export function highlightDedupKey(h: { idempotencyKey?: string; start: number; eventType?: string }): string {
  return h.idempotencyKey ?? `${Math.round(h.start)}|${h.eventType ?? "highlight"}`;
}

/** ADAAAA-7255: attach the bounded (t, energy, baseline) audio-gate inspection
 * series (sliced to the decide window around the trigger) to a per-window
 * analysis payload, so the inspection view renders the energy-vs-baseline
 * graph. Best-effort: absent analysis / no series returns the payload
 * unchanged. */
function withAudioSeries(
  analysis: WindowAnalysis | undefined,
  run: LiveRunShared,
  triggerTs: number,
  cfg: AnalyzerConfig
): WindowAnalysis | undefined {
  if (!analysis) return analysis;
  const pre = cfg.preWindowS ?? DEFAULT_PRE_WINDOW_S;
  const post = cfg.postWindowS ?? DEFAULT_POST_WINDOW_S;
  const series = run.seriesWindow(triggerTs, pre, post);
  if (!series.length) return analysis;
  return { ...analysis, audioSeries: series };
}

/** ADAAAA-7965 (contract v5 §3.1/§3.2/§3.4/§3.5) + ADAAAA-8006: the ONE
 * write-seam derivation of a highlight's stored, customer-readable surface.
 *
 * The model's `reason` crosses the caption gate HERE — goal claims are gated on
 * the verdict actually stored, names the window's prompt cannot corroborate are
 * replaced, internal tokens are stripped, and a lead that cannot resolve a place
 * drops to the quiet shape instead of shipping in that form. The page's caption
 * and card options are derived from the same gated line, so the render is
 * byte-identical to what the gate approved.
 *
 * Factored out of `acceptVideoDecision` (ADAAAA-8006) so the deferred-attestation
 * re-emit can restore the surface computed for a row's SCORING-LANE verdict
 * instead of re-deriving copy at read time; the accept seam's own output is
 * unchanged (same gate, same order, same fields). */
export function storedSurfaceFor(
  decision: DecisionResult,
  grounding: CaptionGroundingContext | undefined
): { reason?: string; colour?: ColourSignal; caption?: string; cardTitles?: string[]; reason_raw?: string } {
  const gatedReasonRaw = grounding ? groundCaption(decision.reason ?? "", grounding) : decision.reason;
  let gatedReason = gatedReasonRaw;
  if ((!gatedReason || !gatedReason.trim()) && grounding) {
    const quiet = quietShape(decision.reason ?? "");
    const zone = (grounding.place ?? "").trim();
    gatedReason = quiet && zone && !placePhraseOf(quiet) ? `${quiet} ${zone}` : quiet || "";
  }
  const eventLabel = humanEventLabel(highlightEventType(decision) || "");
  // ADAAAA-8027 (§2, card clause): the card is derived through the store-time
  // post-condition — the gated line as candidate, the stored raw sentence as its
  // source, and card options from the ACCEPTED caption string. Refused -> the
  // whole re-gated first sentence of `decision.reason`; still refused -> the row
  // stores NO card, so a violating string cannot reach the customer.
  // ADAAAA-8040 (Defect 2): the pipeline's own evidence tags (`; scoreboard
  // score change confirmed`, `| live scoring lane: …`) are AUDIT text, not part
  // of the stored sentence. Leaving them in the §2 source made a corroborated
  // goal line look like a prefix cut of its own raw (`The scoreboard updates
  // from 1-1 to 2-1 as the ball enters the net.` followed by the tag), which
  // refused the card AND the reason on a real goal.
  const rawSurface = stripInternalTokens(decision.reason ?? "");
  const card =
    grounding && (gatedReason ?? "").trim()
      ? storedCardSurface({
          gated: gatedReason as string,
          raw: rawSurface,
          label: eventLabel,
          // The card's budget is the verdict's own rule, the same one the quiet
          // gate applied to the line it stores.
          quiet: isQuietVerdict(grounding?.verdict),
          // ADAAAA-8043 (contract v7 §3.4): corroboration reaches the card-title
          // surface, so an uncorroborated goal never renders `goal:` or `goal`.
          corroborated: grounding?.corroborated ?? null,
          verdict: grounding?.verdict ?? null,
          regate: (sentence: string) => regateServedSentence(sentence, grounding),
        })
      : { caption: "", cardTitles: [] as string[] };
  // ADAAAA-8040 (Defect 2): the stored `reason` is user-readable copy on the
  // detail route (the card is literally derived from it), so it crosses the SAME
  // store-time post-condition the card crosses — it IS the accepted caption. The
  // pre-fix verbless lead (`Shot on the left` while the caption read `The
  // goalkeeper falls to the ground.`) can no longer be stored, because a refused
  // shape yields no accepted caption. When nothing could be accepted, `reason` is
  // omitted instead of falling back to a violating string: "no reason" on the
  // route is the honest state, exactly as a missing card is.
  // When the card was refused but the gated line is itself shape-clean against
  // the stripped stored sentence, the line is still honest copy — serve it
  // closed rather than leaving a goal row with no text at all.
  const shapedReason = restoreTerminalPunctuation((gatedReason ?? "").trim());
  const reasonClean =
    !!shapedReason &&
    servedShapeViolations(shapedReason, [wholeStoredSentence(rawSurface)].filter(Boolean)).length === 0;
  const storedReason = grounding ? card.caption || (reasonClean ? shapedReason : "") : gatedReason;
  return {
    ...(storedReason ? { reason: storedReason } : {}),
    ...(grounding?.colourSignal && captionColour(storedReason) ? { colour: grounding.colourSignal } : {}),
    ...(card.caption ? { caption: card.caption, cardTitles: card.cardTitles } : {}),
    ...(grounding && storedReason !== decision.reason && (decision.reason ?? "").trim() ? { reason_raw: decision.reason } : {}),
  };
}

export async function acceptVideoDecision(
  client: PipelineClient,
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  emit: { seq: number; timestamp: number },
  candidate: CandidateSignal,
  stage1: DecisionResult,
  // ADAAAA-7253 (ACC-3): the window's per-frame localization inputs (ts +
  // perceive-derived goal/ball signal + detection confidence) so the delivered
  // clip is centered on the per-frame signal peak, not the coarse trigger.
  // Optional — when absent the frame-based path is skipped and the existing
  // audio-tap / trigger fallback runs unchanged.
  frameSignals?: LocalizeFrameInput[],
  /** ADAAAA-7365: the goal EVENT's stable content timestamp for the confirm
   * exactly-once key. Observe-path callers pass the goal's own content time so a
   * goal re-produced across overlapping windows maps to one confirm dive. */
  goalEventTs?: number,
  /** ADAAAA-7957: receives the decision this call actually STORED. A repeat
   * GOAL accept is downgraded to `big_play` here (ADAAAA-7865), so a caller that
   * persists copy for the window must gate it with the downgraded verdict — not
   * the pre-accept one. */
  sink?: {
    final?: DecisionResult;
    /** ADAAAA-7962: the ONE grounding context for this window's user-readable
     * fields, computed where the accepted highlight's corroboration is known. */
    grounding?: CaptionGroundingContext;
  },
  /** ADAAAA-7996: the JUDGED content window `[lo, hi]` this accept was decided
   * over (live rail only). When present, localization may anchor the delivered
   * instant anywhere INSIDE that window (the trailing live window starts ~10 s
   * before its centre, which is where the accepted evidence actually sits),
   * instead of only forward from the window centre. Absent = VOD behaviour,
   * byte-identical. */
  liveWindow?: { lo: number; hi: number }
): Promise<void> {
  // ADAAAA-7255: attach the bounded (t, energy, baseline) audio-gate inspection
  // series (sliced to the decide window around the trigger) to the per-window
  // analysis so the request-inspection view renders the energy-vs-baseline
  // graph. Best-effort: absent analysis / no series leaves it unchanged.
  const stageAnalysis = withAudioSeries(stage1.analysis, run, candidate.timestamp, cfg);
  // ADAAAA-6797: Stage-2 confirmation dive — for an un-attested goal-type
  // candidate whose Stage-1 read is a scoring_play accept, run the decide
  // /confirm deep frame dive and adopt the reconciled verdict in its place.
  // Strict no-op when the trigger doesn't fire or the flag (confirmEnabled) is
  // off; the Stage-1 verdict is kept on passthrough / transport failure.
  const { decision: confirmReconciled, confirmRan, confirm } = await confirmReconcile(client, run, cfg, stage1, candidate, goalEventTs);
  // ADAAAA-7185: accepted == corroborated. When the Stage-2 gate is live and it
  // RAN for this un-attested goal but could not corroborate it (passthrough or
  // transport failure left goalConfirmed null), the Stage-1 visual read is NOT
  // sufficient — downgrade to a near-miss so no un-corroborated GOAL is accepted
  // as final. (A structured confirmed_goal without corroboration is already
  // downgraded to near_miss by the decide-side gate.)
  let decision = confirmReconciled;
  if (cfg.confirmEnabled && confirmRan && !(confirm && confirm.goalConfirmed)) {
    decision = downgradeUncorroborated(stage1);
  }
  // ADAAAA-6798 Inc 2: derive the trigger provenance ONCE from the candidate
  // (pure function, no inference) and share one candidateId across the
  // persisted JobCandidate and the HighlightRecord so the trigger kind +
  // timestamp match the candidate with zero drift.
  const trigger = deriveHighlightTrigger(candidate);
  const candidateId = randomUUID();
  // ADAAAA-6851 Inc 2: persist EVERY decide evaluation — accepted highlight,
  // burst-suppressed, near-miss, not-highlight. This runs on both the serial
  // (live / w=1) path and the ordered pipeline accept path (ADAAAA-6854), so
  // the decision-time note trail stays identical either way.
  if (!isAcceptedHighlight(decision, cfg.preferLabels)) {
    buildCandidateNote(cfg, candidate, decision, "rejected", candidateId, trigger, stageAnalysis, confirm?.analysis);
    if (sink) sink.final = decision;
    return;
  }
  // ADAAAA-6610 temporal burst suppression: a GOAL
  // accepted within `goalBurstWindowS` of a previous one is a start-of-clip
  // burst duplicate and is dropped, not recorded.
  // ADAAAA-7420 (shootout-aware): key on the AGGREGATE `confirm.corroborated`
  // flag. A converted penalty in the deployed ADAAAA-7402 flow is corroborated
  // by the model's ball-in-net / confirmed_goal attestation (NOT a scoreboard
  // change — the aggregate score is fixed in a shootout), so corroborationSource
  // is typically null. Keying on the aggregate flag stops burst-suppressing a
  // distinct conversion while still deduping a same-kick re-read (AC4). Saves /
  // misses never reach here (the confirm gate downgrades them to near_miss first),
  // so AC3 is unaffected.
  const corroborated = confirm?.corroborated === true;
  if (run.suppressIfGoalBurst(candidate.timestamp, decision.eventType ?? candidate.eventType, { corroborated })) {
    buildCandidateNote(cfg, candidate, decision, "suppressed", candidateId, trigger, stageAnalysis, confirm?.analysis);
    onEvent?.({
      seq: emit.seq,
      timestamp: emit.timestamp,
      type: "candidateBlocked",
      candidate: { eventType: highlightEventType(decision, candidate.eventType), timestamp: candidate.timestamp },
      reason: "goal highlight suppressed (burst: within goal burst window of an accepted goal)",
    });
    if (sink) sink.final = decision;
    return;
  }
  // ADAAAA-7232: center the delivered clip on the localized highlight instant,
  // so the moment lands in the middle third and the window always meets >=15 s.
  // ADAAAA-7253 (ACC-3): prefer the frame-based localization (per-frame signal
  // peak) when the pass carries post-trigger per-frame signals, falling back to
  // the deterministic peak-audio post-trigger tap, then the trigger.
  // ADAAAA-7845: peak audio only anchors the clip when it agrees with the
  // accepting evidence instant (or reads as a crowd/react burst, capped to the
  // tolerance edge) — a far narration peak no longer drags the clip off the
  // evidence.
  // ADAAAA-7996: on the live rail the judged window is TRAILING (`[now-10, now]`)
  // and its centre is the newest frame, so a forward-only scan could never reach
  // the transition the window accepted on. Localize over the whole window: the
  // measured scoreboard transition instant first, then the earliest attested
  // frame, then the pre-existing path.
  const loc = liveWindow
    ? localizeLiveWindowInstant(
        candidate.timestamp,
        frameSignals,
        run.audioEnergyTaps(),
        cfg.clipAfterS,
        liveWindow,
        candidate.scoreBoardDelta
      )
    : localizeHighlightInstantVod(candidate.timestamp, frameSignals, run.audioEnergyTaps(), cfg.clipAfterS);
  const win = clipWindow(loc.ts, cfg.clipBeforeS, cfg.clipAfterS, cfg.clipWindowMinSec ?? 15);
  // ADAAAA-7865: one score transition, one SCORING highlight. A GOAL accept that
  // re-reads an already-delivered goal's event (its anchor sits inside that
  // goal's clip, or it is within the duplicate reach of it) and carries no
  // independent transition evidence is delivered as a CELEBRATION: the clip is
  // still cut (celebration windows stay accepted), but its outcome leaves the
  // scoring lane so the board never shows a second GOAL for the same transition.
  let isGoalAccept = /^(GOAL|GOL)$/i.test(highlightEventType(decision, candidate.eventType) || "");
  /** ADAAAA-8006: the pre-downgrade (scoring lane) verdict, set only when the
   * ADAAAA-7996 gate below demotes this accept. */
  let scoringLaneDecision: DecisionResult | undefined;
  // ADAAAA-7996: the LIVE scoring lane requires a MEASURED attestation. The
  // Stage-2 confirm dive is the only corroboration gate and the live rail runs it
  // OFF (LIVE_DECIDE_CONFIRM=0 in the measured posture), so a window whose whole
  // evidence is the model's read shipped `scoring_play` — job 44aaeaf6 stored a
  // postable false GOAL at 289.5 s in score-steady lull footage ("The 'GOL'
  // graphic appears"; no score change, no goal-line signal). Downgrade here (the
  // same seam and shape as the 7865 repeat-goal downgrade): the clip is still cut
  // and delivered as a celebration, but it can never be postable as a GOAL.
  if (
    isGoalAccept &&
    cfg.liveObserveLoop &&
    cfg.decideWindowN === undefined &&
    !liveGoalHasMeasuredEvidence({
      scoreBoardChanged: candidate.scoreBoardChanged,
      goalCrossed: candidate.goalCrossed,
      ballOutcome: candidate.ballOutcome,
      corroborated: confirm?.corroborated === true,
      goalConfirmed: confirm?.goalConfirmed ?? null,
    })
  ) {
    console.error(
      `[live-goal-gate:${cfg.jobId}] downgraded unattested GOAL accept @${candidate.timestamp}s ` +
        `(trigger ${trigger.kind}) to a celebration: no measured attestation in the window`
    );
    // ADAAAA-8006: keep the SCORING-LANE verdict before the downgrade. The row is
    // delivered as a celebration now, but a later scoreboard read can re-attest it
    // (see `run.noteDeferredGoalAttestation` below) — and that upgrade must restore
    // the copy the gate produced for THIS verdict, not re-derive copy at read time.
    scoringLaneDecision = decision;
    decision = downgradeUnattestedLiveGoal(decision);
    isGoalAccept = false;
  }
  const repeatGoal = isGoalAccept
    ? run.repeatGoalEvent({
        anchorTs: loc.ts,
        start: win.start,
        end: win.end,
        isGoal: true,
        corroborationSource: confirm?.corroborationSource ?? null,
        scoreboardDeltaLegible: scoreboardDeltaLegible(candidate.scoreBoardDelta),
        confirmEvidenceScoreboardChanged:
          (confirm?.evidence as Record<string, boolean | null> | undefined)?.scoreboardChanged ?? null,
      })
    : undefined;
  if (repeatGoal) decision = downgradeRepeatGoalCelebration(decision, repeatGoal);
  if (sink) sink.final = decision;
  // ADAAAA-6851 note: persisted AFTER the ADAAAA-7865 downgrade so the
  // decision-time note carries the outcome the board actually receives.
  buildCandidateNote(cfg, candidate, decision, "accepted", candidateId, trigger, stageAnalysis, confirm?.analysis);
  // ADAAAA-7962 (contract v4 §3.1): the write seam's ONE grounding context.
  // Computed here because THIS is where the accepted highlight's corroboration is
  // final (sink.final already carries the downgraded verdict), and the same
  // context then gates the story-log line in `observeAcceptOnly` — one gate, one
  // evidence set, so the stored set and the page can never disagree.
  const selfCorroborated =
    confirm?.corroborated === true || (confirm?.goalConfirmed ?? "").trim().toLowerCase() === "confirmed_goal";
  const writeGrounding: CaptionGroundingContext | undefined = cfg.captionGrounding
    ? captionGroundingForWindow(
        decision,
        run,
        candidate.timestamp,
        cfg,
        selfCorroborated,
        frameSignals,
        { ballOutcome: candidate.ballOutcome ?? null, goalCrossed: candidate.goalCrossed ?? null }
      )
    : undefined;
  if (sink && writeGrounding) sink.grounding = writeGrounding;
  // ADAAAA-7965 (contract v5 §3.2/§3.4): a lead that cannot resolve a place does
  // not ship in that form, and an unverified negative does not ship at all — the
  // gate returns "" for those. The row keeps the outcome shape the quiet gate
  // can certify (actor + verb) instead of an empty reason on a customer card.
  // ADAAAA-8006: `storedSurfaceFor` is that ONE derivation, factored out so the
  // deferred re-emit can restore the surface the gate produced for the
  // pre-downgrade verdict instead of re-deriving copy at read time.
  const surface = storedSurfaceFor(decision, writeGrounding);
  const gatedReason = surface.reason;
  const { clipId, clipUri } = await cut(loc.ts);
  const rec: HighlightRecord = {
    id: randomUUID(),
    jobId: cfg.jobId,
    // ADAAAA-7232: record the localized instant + signal so the delivered clip
    // center is queryable (Acc-3). Additive optional — legacy rows carry none.
    localizedTs: loc.ts,
    localizeSignal: loc.signal,
    // ADAAAA-7845 (AC2): persist WHY the clip sits there and how far the anchor
    // is from the accepting evidence instant, so placement is auditable from the
    // record alone (no tap buffer needed).
    localizeAnchorReason: loc.anchorReason,
    localizeEvidenceTs: loc.evidenceTs,
    localizeAnchorDeltaSec: loc.deltaSec,
    // ADAAAA-7865: set on a repeat GOAL accept that was delivered as a
    // celebration instead of a second scoring event. Names the goal event it
    // duplicates so the board can audit the downgrade from the record alone.
    dedupeReason: repeatGoal
      ? `goal_celebration_duplicate:${repeatGoal.highlightId}`
      : undefined,
    // ADAAAA-7247 (ACC-7): record the per-company clip-window setting that
    // produced this clip plus the delivered window length so the delivered clip
    // window is auditable (Acc-3). Values come from the resolved (webui > env)
    // per-company setting already applied to `cfg`; `win` may pad the after side
    // to the >=15 s floor, so clipWindowSec reflects the ACTUAL delivered length.
    clipWindowBeforeS: cfg.clipBeforeS,
    clipWindowAfterS: cfg.clipAfterS,
    clipWindowSec: win.end - win.start,
    // ADAAAA-6874 (Phase 2): deterministic idempotency key so a resumed job that
    // re-decides the same candidate cannot double-persist/double-bill.
    idempotencyKey: highlightIdempotencyKey(cfg.jobId, emit.seq, decision.eventType ?? candidate.eventType),
    clipUri,
    start: win.start,
    end: win.end,
    eventType: highlightEventType(decision),
    score: decision.score,
    // ADAAAA-7962 (contract v4 §3.1): a user-readable field is gated BEFORE it
    // is stored, not when the card renders. The model's reason carries goal
    // claims and invented names in the same shapes the caption gate removes.
    reason: gatedReason,
    // ADAAAA-7965 (contract v5 §3.1/§3.5, R22): the derived beat's signal
    // reference rides the record whenever the beat reached the stored reason, and
    // the page's caption + card options are stored HERE so the render is
    // byte-identical to what the gate approved (no read-time cut, no dropped
    // colour clause, no dropped period).
    ...(surface.colour ? { colour: surface.colour } : {}),
    ...(surface.caption ? { caption: surface.caption, cardTitles: surface.cardTitles } : {}),
    ...(surface.reason_raw ? { reason_raw: surface.reason_raw } : {}),
    // Increment F / ADAAAA-6465: near-miss surface at a lower score, labeled
    // distinctly via the outcome/nearMiss flag.
    outcome: decision.outcome,
    nearMiss: decision.nearMiss,
    // Stage-2 confirmation verdict (ADAAAA-6797), set when the trigger fired.
    goalConfirmed: confirm?.goalConfirmed ?? undefined,
    stage1Disagreed: confirm?.stage1Disagreed ?? undefined,
    // ADAAAA-7185: independent corroboration evidence (scoreboard change or
    // goal-calling audio/commentary text), persisted so accepted == corroborated
    // is queryable on the accepted highlight record.
    corroborated: confirm?.corroborated ?? undefined,
    corroborationSource: confirm?.corroborationSource ?? undefined,
    // ADAAAA-7251 (ACC-3): persist the ASR transcript the decide /confirm pass
    // computed for this highlight's audio context, so it surfaces on the
    // highlight card for human corroboration. Absent where ASR was not computed
    // (no audio context), so no-audio clips show the "No audio captured" badge.
    asrTranscript: confirm?.transcript || undefined,
    status: "pending",
    // ADAAAA-6798 Inc 2: link the highlight to the candidate that started it
    // and carry that candidate's trigger provenance (no read-time join).
    candidateId,
    trigger,
    createdAt: new Date().toISOString(),
  };
  run.highlights.push(rec);
  // ADAAAA-8006: a demoted LIVE goal stays eligible for re-attestation. Hold the
  // delivered row plus the write-seam surface the gate produced for its
  // scoring-lane verdict, so a later scoreboard read can re-emit it as a GOAL
  // without re-deriving (or degrading) the customer copy.
  if (scoringLaneDecision && liveWindow) {
    const scoringGrounding = cfg.captionGrounding
      ? captionGroundingForWindow(scoringLaneDecision, run, candidate.timestamp, cfg, selfCorroborated, frameSignals, {
          ballOutcome: candidate.ballOutcome ?? null,
          goalCrossed: candidate.goalCrossed ?? null,
        })
      : undefined;
    const scoringSurface = storedSurfaceFor(scoringLaneDecision, scoringGrounding);
    run.noteDeferredGoalAttestation({
      highlightId: rec.id,
      jobId: cfg.jobId,
      lo: liveWindow.lo,
      hi: liveWindow.hi,
      anchorTs: loc.ts,
      triggerKind: trigger.kind,
      reason: scoringSurface.reason,
      caption: scoringSurface.caption,
      cardTitles: scoringSurface.cardTitles,
      colour: scoringSurface.colour,
      reasonRaw: scoringSurface.reason_raw,
    });
  }
  // ADAAAA-7865: record the delivered SCORING goal's event coverage. Only a
  // scoring accept becomes an event — a downgraded celebration must never make a
  // following celebration look like a first re-read of a real goal.
  if (rec.outcome === "scoring_play") {
    run.noteAcceptedGoalEvent({ highlightId: rec.id, anchorTs: loc.ts, start: win.start, end: win.end });
  }
  onEvent?.({ seq: emit.seq, timestamp: emit.timestamp, type: "highlight", highlight: rec });
}

// ---------------------------------------------------------------------------
// ADAAAA-7007: decide-observer request builders + helpers. The vision LLM is
// the primary observer; perceive-derived per-frame context (seeds) + per-window
// bias hints (provenance) ride the payload, and candidate triggers never gate.
// ---------------------------------------------------------------------------

/** A generic observe-window event label used when the window carries no bias
 * hint (a moment with no perceived trigger). The outcome enum still governs
 * whether it can be a GOAL — never published as GOAL unless scoring_play. */
export function observeDefaultEventType(_payload: ObserveDecidePayload): string {
  return "SPORTING_EVENT";
}

/** Derive a monotonic, schema-valid frame sequence for an observe-window decide
 * emit (ADAAAA-7007). The observe payload frames carry only `ts`/`imageB64`
 * (no per-frame seq), so we derive the anchor's frame index from `centerTs` at
 * the content fps used to assemble the window. Clamped to 0 so a zero-anchored
 * timeline never yields a negative seq — the candidate / JobDecision trail
 * schema requires `seq >= 0` (packages/events). Replaces the previous hardcoded
 * `seq: -1`, which made every observe-loop highlight hit a ZodError
 * (`candidates[N].seq` must be >= 0) and fail the VOD job before it completed. */
export function observeEmitSeq(centerTs: number, fps: number): number {
  const f = Number.isFinite(fps) && fps > 0 ? fps : OBSERVE_CONTENT_FPS;
  return Math.max(0, Math.round(centerTs * f));
}

/** True when an unknown error is the recoverable-but-unpayable TicketParams
 * expiry (ADAAAA-7003). Mirrors the OrderedDecidePipeline guard. */
export function isTicketParamsExpired(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { ticketParamsExpired?: boolean }).ticketParamsExpired === true;
}

// ADAAAA-7022: clamp observer-built evidence to the decide service's schema
// caps before sending. A real multi-object broadcast window exceeds both
// bounds, and because decide is now the SOLE driver of the live loop a 422
// aborts the whole live job (`decide failed: HTTP 422`). These mirror the
// decide contract (services/decide/app/__init__.py: Evidence.trackCount le=8,
// Evidence.detections max_length=16, Detection.bbox max_length=4,
// Detection.confidence ge=0 le=1) so the observer never produces a payload the
// decide schema rejects.
export const DECIDE_MAX_TRACK_COUNT = 8;
export const DECIDE_MAX_DETECTIONS = 16;
export const DECIDE_MAX_DETECTION_BBOX = 4;

/** Fold the goal-attestation signals (goalCrossed / ballOutcome /
 * scoreBoardChanged) carried by a set of in-window bias hints into a single
 * window-level attestation. Any hint carrying a true attestation attests the
 * window; the strongest signal wins (a goal attestation stands over a
 * near-miss / absent). Returns `{}` when nothing attests — the correct
 * "no attestation, provenance-only" case. Pure + deterministic (ADAAAA-7021). */
export function foldWindowAttestation(
  hints: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean; scoreBoardDelta?: ScoreboardDeltaEvidence }[] | ReadonlyArray<ObserveBiasHint>
): { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean; scoreBoardDelta?: ScoreboardDeltaEvidence } {
  const out: { goalCrossed?: boolean; ballOutcome?: string; scoreBoardChanged?: boolean; scoreBoardDelta?: ScoreboardDeltaEvidence } = {};
  for (const h of hints) {
    if (h.goalCrossed === true) out.goalCrossed = true;
    if (typeof h.ballOutcome === "string" && /^goal$/i.test(h.ballOutcome.trim())) out.ballOutcome = h.ballOutcome;
    if (h.scoreBoardChanged === true) out.scoreBoardChanged = true;
    // ADAAAA-7844: keep the FIRST legible measured delta in the window (the
    // hints are already time-filtered to the window, so it is time-tied by
    // construction). A bare boolean with no legible delta still attests (the
    // Boolean stays true) but carries no delta, so the decide pass refuses to
    // label it "scoreboard".
    if (!out.scoreBoardDelta && scoreboardDeltaLegible((h as any).scoreBoardDelta)) {
      out.scoreBoardDelta = (h as any).scoreBoardDelta;
    }
  }
  return out;
}

/** Build the decide() evidence + opts for an observe window. The temporal
 * window frames + the perceive-seeded per-frame context are the primary
 * evidence; candidate triggers inside the window are folded as bias hints
 * (provenance), and the frozen candidate/event vocabulary is preserved.
 * Deterministic per payload so the decision is reproducible. */
export function buildObserveDecideRequest(
  cfg: AnalyzerConfig,
  run: LiveRunShared,
  payload: ObserveDecidePayload
): { evidence: Parameters<PipelineClient["decide"]>[0]; opts: Parameters<PipelineClient["decide"]>[1] } {
  const bias = payload.biasHints[0] as ObserveBiasHint | undefined;
  const eventType = bias?.eventType ?? observeDefaultEventType(payload);
  const center = payload.centerTs;
  // Fold the window's perceive-derived context into the scalar evidence the
  // decide contract expects (track count / OCR / reaction) from the seeds.
  const seeds = payload.seeds;
  let maxTrackCount = 0;
  let ocrHits = 0;
  for (const s of seeds) {
    maxTrackCount = Math.max(maxTrackCount, s.tracks?.length ?? 0);
    ocrHits += s.ocr?.length ?? 0;
  }
  // ADAAAA-7022: clamp to the decide Evidence schema caps so a multi-object
  // window never builds a payload decide rejects (trackCount le=8).
  const trackCount = Math.min(maxTrackCount, DECIDE_MAX_TRACK_COUNT);
  const detections: DetectionEvidence[] = [];
  for (const s of seeds) {
    for (const o of s.objects ?? []) {
      detections.push({
        label: o.label,
        confidence: o.confidence ?? 0,
        // ADAAAA-7022: Detection.bbox is max_length=4 and confidence ge=0 le=1.
        bbox: (o.bbox ?? []).slice(0, DECIDE_MAX_DETECTION_BBOX),
        trackId: "",
      });
    }
  }
  // ADAAAA-7021 fix: fold the perceive candidate's goal-attestation signals that
  // rode the in-window bias hints (goalCrossed / ballOutcome / scoreBoardChanged).
  // Any hint in the window carrying a true attestation attests the whole window;
  // the strongest signal (goal attests over near-miss) wins. Absent everywhere =
  // no attestation (provenance only). This keeps the goal-attestation gate able
  // to independently confirm a scoring_play instead of rejecting every goal.
  const windowAttestation = foldWindowAttestation(payload.biasHints);
  // ADAAAA-7399: window-ALIGNED audio around the window center. The VOD tap
  // decodes the whole file faster than the GPU video pass, so the plain rolling
  // `audioClipB64()` is FILE-END audio, not the current video-window center —
  // that is why VOD windows persisted `audio.path:"none"` / no transcript while
  // the live/file-sim tap (audio captured in real time) worked. Slice the
  // retained timeline around `center` (a head/tail margin brackets the whole
  // window; silent / no-tap windows yield "" and stay text-only, no regression).
  // ADAAAA-7856: the job's persisted match context, normalised once for this
  // window. `toDecideMatchContext` is pure and reads the value the injector
  // already loaded, so it never triggers a resolver/GPU pass per window.
  const matchCtx = toDecideMatchContext(cfg.getMatchContext?.());
  const frameTs = payload.frames.map((f) => f.ts).filter((t) => Number.isFinite(t));
  const preS = frameTs.length ? Math.max(center - Math.min(...frameTs), 0) + AUDIO_WINDOW_MARGIN_S : AUDIO_DEFAULT_WINDOW_S;
  const postS = frameTs.length ? Math.max(Math.max(...frameTs) - center, 0) + AUDIO_WINDOW_MARGIN_S : AUDIO_DEFAULT_WINDOW_S;
  const windowAudioB64 = cfg.audioContext && cfg.decideAudioClip !== false ? run.audioWindowB64(center, preS, postS) : "";
  const windowAudioLevels = cfg.audioContext ? run.audioWindowLevels(center, preS, postS) : [];
  const audioPeak = windowAudioLevels.length ? Math.max(...windowAudioLevels) : 0;
  const evidence: Parameters<PipelineClient["decide"]>[0] = {
    eventType,
    trackCount,
    maxVelocity: run.evidence.maxVelocity,
    ocrHits,
    // ADAAAA-7399: the Stage-1 reaction now carries the window's audio intensity
    // (crowdEnergy from the aligned audio level curve) so the LLM gets audio
    // cues on the PRIMARY pass, not just the Stage-2 confirm path. Absent audio
    // stays a text-only empty reaction (no regression).
    reaction: buildReactionEvidence(
      {
        audio: {
          kind: windowAudioLevels.length ? "swell" : "",
          ts: center,
          firedAt: center,
          onsetLatencyS: 0,
          peakEnergy: audioPeak,
          baselineEnergy: 0,
        },
      },
      trackCount
    ),
    // ADAAAA-7399: forward the window-aligned audio-energy level CURVE to the
    // Stage-1 decide evidence (the confirm path already forwards it via
    // `audioLevels`; the primary evidence did not).
    audioLevels: windowAudioLevels,
    // Perceive-derived per-detection geometry + audio level curve (I4).
    // ADAAAA-7022: keep the FIRST DECIDE_MAX_DETECTIONS (oldest frames) so the
    // payload never breaches Evidence.detections max_length=16.
    detections: detections.slice(0, DECIDE_MAX_DETECTIONS),
    // ADAAAA-7021 fix: forward the perceive candidate's goal-attestation signals
    // (folded into the in-window bias hints) FIRST-CLASS so the decide
    // goal-attestation gate can independently attest a `scoring_play`. Previously
    // scoreBoardChanged was hardcoded false and goalCrossed/ballOutcome were never
    // forwarded, so the decide runner rejected every goal ("model reason alone is
    // not sufficient") — collapsing goal recall to 0% (ADAAAA-7021). Absent/undefined
    // = no attestation (provenance only), never a fabricated false attestation.
    goalCrossed: windowAttestation.goalCrossed || undefined,
    ballOutcome: windowAttestation.ballOutcome || undefined,
    scoreBoardChanged: windowAttestation.scoreBoardChanged || undefined,
  };
  // (ADAAAA-7399): the window-aligned audio clip + level curve were computed
  // above (before the evidence) via `run.audioWindowB64` / `audioWindowLevels`
  // and are forwarded as `opts.audioB64` + `evidence.audioLevels` below.
  // ADAAAA-7399 (instrumentation): log the VOD decide's audio reach so an
  // on-box job reveals whether the tap fed the shared window (tapChunks>0 and
  // audioB64Len>0 => aligned audio reached the LLM; 0 => it did not).
  if (cfg.decideWindowN !== undefined && cfg.jobId) {
    console.error(
      `[vod-audio:${cfg.jobId}] decide @${center}s tapChunks=${run.audioChunkCount()} audioB64Len=${windowAudioB64.length} levels=${windowAudioLevels.length}`
    );
  }
  // ADAAAA-7671 (instrumentation): the SAME reach for the LIVE observe pass.
  // The live audio tap runs on real time while the decide loop lags it, so the
  // tap span vs the pipeline position is the number that says whether this
  // window's audio survived retention (`audioB64Len: 0` with a tap span far
  // ahead of `pos` = retention, not a silent stream).
  if (cfg.liveObserveLoop && cfg.jobId) {
    const span = run.audioSpan();
    console.error(
      `[live-audio:${cfg.jobId}] decide @${center.toFixed(2)}s tapChunks=${run.audioChunkCount()} ` +
        `tap=[${span.from === null ? "-" : span.from.toFixed(2)}..${span.to === null ? "-" : span.to.toFixed(2)}] ` +
        `pos=${span.pos === null ? "-" : span.pos.toFixed(2)} prePost=${preS.toFixed(1)}/${postS.toFixed(1)} ` +
        `audioB64Len=${windowAudioB64.length} levels=${windowAudioLevels.length} ` +
        `series=${run.seriesWindow(center, preS, postS).length}`
    );
  }
  // ADAAAA-7938 (Spec A) / ADAAAA-7988: the compact prior-game-state block.
  // Forwarded on BOTH rails now: the 13:14Z live share judged every celebration
  // window in isolation (the live rail never received story-so-far), so a
  // reaction could only read as "reacting to a previous event". Bounded tails
  // (150 + 90 chars) keep the per-window cost delta inside the ADAAAA-7799
  // ceiling, and an empty state renders nothing, so the first window's request
  // stays byte-identical (AC-A2).
  const priorGameState = run.priorGameStateFor(center);
  const opts: Parameters<PipelineClient["decide"]>[1] = {
    gameHint: cfg.gameHint,
    reasoningEffort: "none",
    frames: payload.frames.map((f) => ({
      role: "full",
      base64: f.imageB64,
      ...(Number.isFinite(f.seq) ? { seq: Math.floor(f.seq as number) } : {}),
    })),
    ...(windowAudioB64 ? { audioB64: windowAudioB64 } : {}),
    // ADAAAA-7028 Inc 2: audit identity — forward the job + frame-group
    // partition key so the decide service's `_audit` descriptor keys the
    // durable decide_audit index by (sessionId, groupKey). One row per frame
    // group regardless of how many decide invocations the group spans.
    jobId: cfg.jobId,
    groupKey: decideGroupKey(center),
    // ADAAAA-7111 (Increment D): carry the job's running video summary
    // (story-so-far) so the decide brain EXTENDS it (monotonic growth).
    storySoFar: cfg.getRunningSummary?.() ?? "",
    // ADAAAA-7938 (Spec A): the compact prior-game-state block for the VOD
    // detail pass. VOD-ONLY (the live rail never receives it).
    ...(priorGameState ? { priorGameState } : {}),
    // ADAAAA-7856 (Stage 6): the job's inferred teams + kit colours, read from
    // persistence (one resolver pass per job — zero extra GPU per window). An
    // absent/unusable context omits the key entirely, so the request and the
    // rendered prompt stay byte-identical to today (AC6).
    ...(matchCtx ? { matchContext: matchCtx } : {}),
    // ADAAAA-7781: compact verdict contract on the live rail (decode-bound
    // throughput). `false` — the default — sends the byte-identical request.
    compact: cfg.liveDecideCompact === true,
  };
  return { evidence, opts };
}

/**
 * ADAAAA-7722: stamp the anchoring trigger's FAMILY onto a decide-audit
 * descriptor before it is persisted. The decide service builds its own
 * descriptor and cannot know how the server scheduled the window, so a
 * whistle-anchored decide used to be indistinguishable from a cadence decide in
 * `decide_audit` (its `params` carried no threshold id). Pure and
 * non-destructive: returns the descriptor unchanged when it carries no trigger
 * (a cadence window has no family) or is not an object. Additive keys only —
 * existing params are preserved.
 */
export function attachTriggerFamilyToAudit<T>(audit: T, trigger?: { thresholdId?: string } | null): T {
  if (!audit || typeof audit !== "object" || !trigger || typeof trigger.thresholdId !== "string") return audit;
  const desc = audit as any;
  const params = desc.params && typeof desc.params === "object" ? desc.params : {};
  return {
    ...desc,
    params: {
      ...params,
      triggerFamily: triggerFamily(trigger.thresholdId),
      triggerThresholdId: trigger.thresholdId,
    },
  } as T;
}

/**
 * Run the on-demand perceive recall for an observe payload (ADAAAA-7008 /
 * ADAAAA-7012). When a decide verdict requests more evidence for a moment, the
 * server calls perceive on demand (`recall` callback -> adapter -> perceive
 * `/app/evidence`) and folds the freshly derived per-frame context into the
 * payload via {@link applyOnDemandRecall} BEFORE finalizing.
 *
 * `recall` is the injectable transport (the adapter's `recallPerceive`); it
 * returns the recall's seeds (empty `[]` / undefined on a no-op). A no-op
 * recall returns the SAME payload object unmodified, so a recall can never
 * regress a decision — the caller checks `!== payload` to decide whether to
 * re-decide with the richer payload.
 */
export async function applyObserveRecall(
  payload: ObserveDecidePayload,
  recall: (centerTs: number, windowS?: number) => Promise<{ centerTs?: number; seeds: PerFrameSeed[] } | undefined>
): Promise<ObserveDecidePayload> {
  if (!payload) return payload;
  const result = await recall(payload.centerTs, undefined);
  // A no-op recall (nothing new) returns the SAME payload object, so a recall
  // can never regress a decision.
  if (!result || result.seeds.length === 0) return payload;
  return applyOnDemandRecall(payload, { centerTs: result.centerTs ?? payload.centerTs, seeds: result.seeds });
}

/**
 * ADAAAA-7111 (Increment D): derive the updated running video summary to
 * persist after a cadence decide. Returns the bounded summary string when it
 * actually changed vs the prior one (carried in), else null (no write needed —
 * avoids redundant DB writes on a stable/compact summary). Pure + testable.
 */
export function nextRunningSummary(prior: string | undefined, decision: DecisionResult): string | null {
  const rs = (decision as any).runningSummary;
  if (typeof rs !== "string" || !rs.trim()) return null;
  return rs === (prior ?? "") ? null : rs;
}

/**
 * ADAAAA-7734: give a decided window's analysis a RESOLVABLE frame evidence list.
 *
 * The decide service builds `analysis.frames[]` from the frame dicts it received
 * and, because its `ImageRef` only carries `role`/`base64`, every ref came back
 * as `{seq: <window index>, uri: ""}` — a placeholder that resolves to no image.
 * The media rail persists the very JPEG it decided on, so the server rewrites the
 * refs to the frames this window ACTUALLY carried, each pointing at the canonical
 * `/jobs/<jobId>/frames/<seq>` delivery (the same route the job-detail filmstrip
 * and decide-note thumbnails use).
 *
 * Pure and conservative: a payload whose frames carry no global seq (legacy
 * rows, test fakes) leaves the analysis untouched — never a guessed seq.
 */
export function withWindowFrameRefs(
  analysis: WindowAnalysis | undefined,
  frames: { seq?: number }[] | undefined,
  jobId?: string
): WindowAnalysis | undefined {
  if (!analysis) return analysis;
  const list = frames ?? [];
  if (list.length === 0) return analysis;
  const refs: { seq: number; uri: string }[] = [];
  for (const f of list) {
    const raw = Number(f?.seq);
    // One frame without a known global seq means the refs cannot be made
    // truthful for this window: keep what the decide service returned.
    if (!Number.isFinite(raw) || raw < 0) return analysis;
    const seq = Math.floor(raw);
    refs.push({ seq, uri: jobId ? `/jobs/${jobId}/frames/${seq}` : "" });
  }
  return { ...analysis, frames: refs };
}

/**
 * ADAAAA-7011 / ADAAAA-7771: the DECIDE half of the shared decide+accept
 * callback. Builds the decide request from an observe window payload, runs the
 * gemma decide (with on-demand perceive recall when the verdict asks for more
 * evidence), finalizes the decision's frame refs and records the decide audit.
 *
 * ADAAAA-7771: split out from {@link observeAcceptOnly} so the live observer can
 * keep several windows' decide work in flight. This half touches no acceptance
 * state (no highlight list, no burst suppression, no SSE), so running it
 * concurrently is safe; the accept half is always applied in content order.
 *
 * Returns the decision, or `null` when the decide was skipped because its
 * TicketParams expired (a recoverable non-event: nothing accepted, nothing
 * billed beyond the skipped call).
 */
export async function observeDecideOnly(
  client: PipelineClient,
  run: LiveRunShared,
  cfg: AnalyzerConfig,
  sessionId: string,
  payload: ObserveDecidePayload
): Promise<DecisionResult | null> {
  let { evidence, opts } = buildObserveDecideRequest(cfg, run, payload);
  let decision: DecisionResult;
  try {
    decision = await client.decide(evidence, opts);
  } catch (e) {
    if (isTicketParamsExpired(e)) {
      console.error(`[observe] decide @${payload.centerTs} skipped (TicketParams expired)`);
      return null;
    }
    throw e;
  }
  // ADAAAA-7008 / ADAAAA-7012: on-demand perceive recall. When the verdict asks
  // for MORE evidence for this moment, call perceive on demand (per-frame
  // derived context already computed — no detector re-run), fold it into the
  // payload via applyOnDemandRecall, and re-decide before finalizing. A no-op
  // recall returns the SAME payload (refreshed === payload), so we keep the
  // original decision — a recall can never regress it.
  if (decision.recall && client.recallPerceive) {
    const refreshed = await applyObserveRecall(payload, (centerTs, windowS) =>
      client.recallPerceive!(sessionId, { centerTs, windowS })
    );
    if (refreshed !== payload) {
      const rebuilt = buildObserveDecideRequest(cfg, run, refreshed);
      evidence = rebuilt.evidence;
      opts = rebuilt.opts;
      decision = await client.decide(evidence, opts);
    }
  }
  // ADAAAA-7734: replace the decide service's placeholder frame refs with the
  // frames this window actually carried, each resolvable at
  // /jobs/<jobId>/frames/<seq> (the media rail persists those JPEGs).
  // ADAAAA-7736: the VOD rail stamps its extracted frame seq the same way, so
  // its decide notes now name the exact frames the window analysed too. A
  // payload with no seqs at all (legacy rows) is left byte-identical.
  decision.analysis = withWindowFrameRefs(decision.analysis, payload.frames, cfg.jobId);
  // ADAAAA-7028 Inc 2: ingest the decide audit descriptor into the durable
  // decide_audit index (best-effort; never a pipeline failure). Gated by
  // `cfg.onDecideAudit` (wired to recordDecideAudit in the server). Captured
  // ONCE here, after any on-demand recall re-decide settles, using the final
  // `decision` — so exactly one row is persisted per frame group (the
  // (sessionId, groupKey) upsert in recordDecideAudit also makes it idempotent
  // across repeated decide invocations for the same group).
  if (cfg.onDecideAudit) {
    try {
      // ADAAAA-7722: name the trigger FAMILY on the durable audit row, so a
      // whistle-anchored decide is countable after the run (`params
      // .triggerFamily` / `.triggerThresholdId` in `decide_audit`).
      cfg.onDecideAudit(attachTriggerFamilyToAudit((decision as any)?.audit, payload.trigger));
    } catch (e: any) {
      console.error(`[decide-audit:${cfg.jobId}] onDecideAudit failed:`, String(e?.message || e));
    }
  }
  // ADAAAA-7938 (Spec A) / ADAAAA-7988: advance the prior-game state for the
  // NEXT window from THIS window's resolved decision — story-so-far, its ASR
  // (where a goal call sits) and the measured scoreboard transition it carried.
  // Noted here (not on accept) because the accept chain runs a paid confirm +
  // clip cut and therefore lags the decide chain by whole windows. Live rail
  // included since ADAAAA-7988: a live celebration window judged in isolation
  // could only read as "reacting to a previous event".
  // ADAAAA-7988: also record this window's own description class in the live
  // goal-recall ledger, which the accept path reads to cite the attack/shot
  // window a celebration follows. Live only; VOD's ledger stays empty.
  try {
    run.noteWindowGameState(payload.centerTs, decision, {
      scoreBoardDelta: (payload.biasHints[0] as { scoreBoardDelta?: ScoreboardDeltaEvidence } | undefined)
        ?.scoreBoardDelta,
    });
  } catch (e: any) {
    console.error(`[prior-game-state:${cfg.jobId}] note failed:`, String(e?.message || e));
  }
  if (cfg.liveObserveLoop && cfg.decideWindowN === undefined) {
    try {
      run.liveGoalRecall.record(payload.centerTs, liveWindowDescription(decision));
    } catch (e: any) {
      console.error(`[live-goal-recall:${cfg.jobId}] ledger note failed:`, String(e?.message || e));
    }
  }
  return decision;
}

/**
 * ADAAAA-7771: the ACCEPT half of the shared decide+accept callback. Persists
 * the running summary, builds the candidate from the window, and routes the
 * verdict through the same `acceptVideoDecision` path used by the
 * candidate-gated live/VOD paths (clip cut + highlight record + SSE highlight +
 * decision-time billing). Returns whether the moment was accepted.
 *
 * Ordering: `acceptVideoDecision` has serial semantics (burst suppression keys
 * off previously accepted goals; highlights are appended in order; the running
 * summary is a read-modify-write), so the live observer calls this strictly in
 * CONTENT order even when decides complete out of order.
 */
/**
 * ADAAAA-7957 (Inc 5): the grounding context the fast-rail summary seam carries.
 *
 * The §3.2 name gate is PROVENANCE, so an absent decide analysis means NO
 * evidence, not "skip the gate": this seam used to pass `null` here, which the
 * gate reads as "already certified upstream", so the gate never ran and two
 * invented names ("Manuel Ordoñez", "David Saez") reached a caption on level
 * 9fecca77 (g37/g56). A missing prompt is therefore `""` — every unsourced
 * proper name fails closed to a role. `null` stays reserved for text the webapp
 * knows is already certified.
 */
export function captionGroundingForDecision(
  decision: Pick<DecisionResult, "outcome" | "eventType" | "analysis">,
  extras: Pick<CaptionGroundingContext, "corroborated" | "colourSignal" | "absenceEvidence" | "place"> = {}
): CaptionGroundingContext {
  return {
    verdict: decision.outcome ?? null,
    promptText: decision.analysis?.prompt ?? "",
    eventType: decision.eventType ?? null,
    ...extras,
  };
}

/**
 * ADAAAA-7965 (contract v5 §3.1, R18): the per-window audio-noise delta that
 * ADAAAA-7964 measured as the only stored signal that grounds a colour beat at
 * the 20-40% band with 0 contradicted beats — computed at the write seam from
 * the taps the pipeline already holds, and attached to the stored frame nearest
 * the burst.
 *
 * Returns `null` (the drop path) when the window has too few taps, no peak above
 * the energy floor, or NO stored frame to confirm the instant. A dropped beat
 * means the row keeps its quiet shape — the contract prefers a drop to a
 * contradiction. 0 GPU: no model call, no new perception pass, no new frames.
 */
export function windowColourSignal(
  run: Pick<LiveRunShared, "seriesWindow">,
  centerTs: number,
  cfg: Pick<AnalyzerConfig, "preWindowS" | "postWindowS" | "sampleFps" | "analysisFps">,
  frames?: readonly { ts: number; seq?: number }[]
): ColourSignal | null {
  if (!Number.isFinite(centerTs)) return null;
  const pre = cfg.preWindowS ?? DEFAULT_PRE_WINDOW_S;
  const post = cfg.postWindowS ?? DEFAULT_POST_WINDOW_S;
  const series = run.seriesWindow(centerTs, pre, post);
  const energies = series.map((p) => p.energy).filter((e) => Number.isFinite(e));
  if (energies.length < 4) return null;
  const peak = Math.max(...energies);
  // Audit §5: no real energy -> no beat.
  if (peak < 0.15) return null;
  const sorted = [...energies].sort((a, b) => a - b);
  const base = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const ratio = peak / Math.max(base, 0.005);
  const sustained = energies.filter((e) => e >= 0.5 * peak).length / energies.length;
  const peakPoint = series.find((p) => p.energy === peak);
  const peakT = peakPoint?.t ?? centerTs;
  // §3.1: every delivered beat stores the frame that confirms it. No frame in
  // the window -> the beat cannot be confirmed -> dropped.
  let frame: { ts: number; seq?: number } | undefined;
  let bestDiff = Infinity;
  for (const f of frames ?? []) {
    if (!Number.isFinite(f?.ts)) continue;
    const d = Math.abs(f.ts - peakT);
    if (d < bestDiff) {
      bestDiff = d;
      frame = f;
    }
  }
  if (!frame) return null;
  const fps = cfg.sampleFps ?? cfg.analysisFps ?? 3;
  const frameSeq =
    typeof frame.seq === "number" && Number.isFinite(frame.seq) ? Math.floor(frame.seq) : Math.round(frame.ts * fps);
  return { signal: "audio_noise", ratio, sustained, peak, peakT, frameTs: frame.ts, frameSeq };
}

/**
 * ADAAAA-7965 (contract v5 §3.2, R19): the place a lead ships with, resolved
 * from the window's OWN state — the tracked ball position in this window's
 * frames first (a measurement), then the last stored possession line of the
 * running summary. Never from a prompt change and never invented here.
 *
 * The mapping is deliberately coarse and frame-verifiable: a wide camera's
 * horizontal thirds are the left / middle / right of the pitch, and a ball in
 * the bottom fifth of the frame is at the near touchline. Saying "in the box"
 * would need a homography, which is `not available` on every window ADAAAA-7964
 * inspected — so the gate never claims one.
 */
export function windowPlace(
  run: Pick<LiveRunShared, "ballPosition">,
  centerTs: number,
  cfg: Pick<AnalyzerConfig, "getRunningSummary">
): string {
  const pos = Number.isFinite(centerTs) ? run.ballPosition(centerTs) : undefined;
  if (pos && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
    const [x, y] = pos;
    if (y > 0.82) return "near the touchline";
    if (x < 0.3) return "on the left";
    if (x > 0.7) return "on the right";
    return "in midfield";
  }
  const lines = ((cfg.getRunningSummary?.() ?? "") as string)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : "";
  const phrase = placePhraseOf(last).replace(/[.!?;:]+$/, "").trim();
  if (!phrase) return "";
  // `into the penalty area` -> `in the penalty area`: the caption form.
  return phrase.replace(/^into\b/i, "in");
}

/**
 * ADAAAA-7965 (contract v5 §3.4, R21): the window's stored evidence for an
 * absence claim. Fail-closed: a goal window never evidences an absence, and a
 * non-goal window needs an explicit frame pair (ball NOT in the net AND not
 * across the line) or an out-of-play attestation. Anything less => the negative
 * does not ship.
 */
export function windowAbsenceEvidence(
  attest: {
    ballOutcome?: string | null;
    goalCrossed?: boolean | null;
    seeds?: readonly { signal?: PerFrameSignal }[];
  },
  outcome?: string | null
): boolean {
  if ((outcome ?? "").trim().toLowerCase() === "scoring_play") return false;
  const outAttested = /^(?:out|off_target|wide|saved|blocked|cleared|cross)$/i.test(
    String(attest.ballOutcome ?? "")
  );
  if (outAttested) return true;
  if (attest.goalCrossed === true) return false;
  return (attest.seeds ?? []).some(
    (s) => s.signal?.ballInNet === false && s.signal?.goalCrossed === false
  );
}

/**
 * ADAAAA-7962 (contract v4 §3.1): the ONE grounding context the write seam uses
 * for every user-readable field of this window — the story-log line AND the
 * highlight's delivered `reason`. It carries the three facts the gates need and
 * that v3's seam could not see:
 *
 *   - `corroborated`: the same rule the page's banner uses (`windowCorroborated`
 *     over the accepted highlights), so a goal the banner calls uncorroborated
 *     is never STORED as an asserted goal (R13: 27 stored rows, 10 claims, page 0);
 *   - `colourEvidence`: the window's own audio energy series (§3.5);
 *   - `place`: the zone the model line named, so a rewrite keeps actor + action
 *     + place even when the claim clause is dropped (§3.4).
 */
export function captionGroundingForWindow(
  decision: Pick<DecisionResult, "outcome" | "eventType" | "analysis" | "reason">,
  run: Pick<LiveRunShared, "seriesWindow" | "ballPosition" | "highlights">,
  centerTs: number,
  cfg: Pick<
    AnalyzerConfig,
    "preWindowS" | "postWindowS" | "sampleFps" | "analysisFps" | "getRunningSummary"
  >,
  /** This accept's OWN corroboration (confirm pass / scoreboard / audio), known
   * before the record is pushed — the window is corroborated when this accept
   * corroborated it OR an already-accepted highlight covering it did. */
  selfCorroborated = false,
  /** The window's own frames (seeds). Required for the §3.1 frame reference and
   * the §3.2 place measurement. Absent => no colour beat (fail closed) and the
   * place falls back to stored possession state. */
  frames?: readonly { ts: number; seq?: number }[],
  /** This decide's folded goal attestation (the candidate's own signals), for
   * the §3.4 absence evidence. */
  attest?: { ballOutcome?: string | null; goalCrossed?: boolean | null; seeds?: readonly PerFrameSeed[] }
): CaptionGroundingContext {
  return captionGroundingForDecision(decision, {
    corroborated: selfCorroborated || windowCorroborated(run.highlights as any, centerTs),
    colourSignal: windowColourSignal(run, centerTs, cfg, frames),
    absenceEvidence: windowAbsenceEvidence(attest ?? {}, decision.outcome),
    // §3.2: ALWAYS resolved on the fast rail. `""` means "resolved to nothing",
    // which makes a place-less play lead drop instead of shipping.
    place: windowPlace(run, centerTs, cfg),
  });
}

/** ADAAAA-8006: apply the deferred-attestation re-emits a later window's
 * scoreboard read resolves, logging one audit line per re-emit (the
 * `[live-goal-gate:<job>]` downgrade line's mirror). Returns the re-emit count.
 *
 * Purely a bookkeeping seam: the delta is a MEASUREMENT the live pass already
 * paid for, so this adds no decide, no perceive call and no GPU-second — which is
 * what keeps the $/h/stream cap untouched (AC3 on the issue).
 */
export function applyDeferredGoalAttestations(
  run: Pick<LiveRunShared, "resolveDeferredGoalAttestation">,
  cfg: Pick<AnalyzerConfig, "jobId" | "onDeferredGoalAttested">,
  input: { readAt: number; delta?: ScoreboardDeltaEvidence | null }
): number {
  const upgrades = run.resolveDeferredGoalAttestation({ readAt: input.readAt, delta: input.delta ?? null });
  for (const up of upgrades) {
    // ADAAAA-8017: `deltaTs` may sit on/inside the judged window's close (a
    // boundary transition is first legible just before `hi` while the read lands
    // with a later window), so the audit phrase reports the sign honestly instead
    // of printing a negative "after the window closed".
    const lateBy = up.deltaTs - up.hi;
    const timing =
      lateBy >= -1e-9
        ? `${lateBy.toFixed(1)} s after the window closed`
        : `${(-lateBy).toFixed(1)} s inside the window's closing edge`;
    console.error(
      `[live-goal-gate-upgrade:${cfg.jobId}] re-attested GOAL @${up.anchorTs}s (judged window [${up.lo}, ${up.hi}], ` +
        `trigger ${up.triggerKind}) from the scoreboard delta first legibly read at ${up.deltaTs}s — ` +
        `${timing} (carried by the later window read at ${up.readAt}s, lookahead ${up.lookaheadS} s): ` +
        `${up.delta.pre.join("-")} -> ${up.delta.post.join("-")}`
    );
    try {
      cfg.onDeferredGoalAttested?.(up);
    } catch (e: any) {
      console.error(`[live-goal-gate-upgrade:${cfg.jobId}] persist hook failed:`, String(e?.message || e));
    }
  }
  return upgrades.length;
}

export async function observeAcceptOnly(
  client: PipelineClient,
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  payload: ObserveDecidePayload,
  decision: DecisionResult
): Promise<boolean> {
  // ADAAAA-7988: LIVE goal recall. The media node samples at 1 fps, so a judged
  // window usually misses the net-crossing instant and the decide brain rejects
  // a celebration it described correctly ("reacting to a previous event"). When
  // this window's own description is a celebration/reaction AND the nearest
  // window behind it (within LIVE_GOAL_RECALL_LEAD_S) was an attack/shot, the
  // window is a goal CANDIDATE: promote the reject to the goal-shaped,
  // un-attested `near_miss` the Stage-2 dive already knows how to adjudicate
  // (ADAAAA-7357 delayed-corroboration shape), citing the prior window's
  // evidence. Corroboration still owns the final GOAL, and an already-delivered
  // goal is never re-opened. Live rail only - VOD keeps its precision gate.
  const recall =
    cfg.liveObserveLoop && cfg.decideWindowN === undefined && isLiveGoalRecallCandidate(decision)
      ? run.liveGoalRecall.recallFor(payload.centerTs, { acceptedGoalTs: run.acceptedGoalAnchors() })
      : null;
  const stage1: DecisionResult = recall ? applyLiveGoalRecall(decision, recall) : decision;
  if (recall) {
    console.error(
      `[live-goal-recall:${cfg.jobId}] promoted window @${recall.centerTs}s ` +
        `(celebration) citing attack window @${recall.attackTs}s (${recall.leadS}s earlier)`
    );
  }
  // ADAAAA-7111 (Increment D): the running video summary (story-so-far) this
  // window's decide produced, persisted so the job-detail endpoint + web UI can
  // surface it growing across cadence ticks. The VALUE is computed here (nothing
  // about it depends on the accept path) but it is WRITTEN after the accept, so
  // the §3 gate sees the verdict that is actually stored — see below.
  const pendingSummary = cfg.onRunningSummary ? nextRunningSummary(cfg.getRunningSummary?.(), stage1) : null;
  // ADAAAA-7021 fix: the window's goal-attestation signals (folded from the
  // in-window bias hints) ride the candidate too, so acceptVideoDecision's
  // Stage-2 confirm reconcile + deriveHighlightTrigger see the attestation
  // (hasIndependentAttestation excludes an attested goal from the un-attested
  // confirm dive) rather than treating the goal as un-attested.
  const windowAttestation = { ...foldWindowAttestation(payload.biasHints) };
  const candidate: CandidateSignal = {
    eventType: payload.biasHints[0]?.eventType ?? observeDefaultEventType(payload),
    timestamp: payload.centerTs,
    goalCrossed: windowAttestation.goalCrossed,
    ballOutcome: windowAttestation.ballOutcome,
    scoreBoardChanged: windowAttestation.scoreBoardChanged,
    // ADAAAA-7844: carry the measured delta (if any) so the confirm request can
    // be credited/labelled on a legible, time-tied measurement.
    scoreBoardDelta: windowAttestation.scoreBoardDelta,
  };
  // ADAAAA-7253 (ACC-3): carry the window's per-frame localization inputs
  // (ts + perceive-derived goal/ball signal + max detection confidence) into
  // the accept path so frame-based localization can center the clip on the
  // per-frame signal peak. These are ALREADY-COMPUTED cached findings from the
  // observe seeds — no new inference / decide / GPU call (Acc-6).
  const frameSignals: LocalizeFrameInput[] = payload.seeds.map((s) => ({
    ts: s.ts,
    signal: s.signal,
    detectionConfidence: (s.objects ?? []).reduce((m, o) => Math.max(m, clamp01(o.confidence)), 0),
  }));
  // ADAAAA-7365: the goal EVENT's stable content timestamp (goal trigger /
  // localized instant) so the confirm dive fires EXACTLY ONCE per distinct goal
  // candidate across the overlapping windows that re-produce it — NOT the window
  // center (which slides by the cadence).
  // ADAAAA-7988: a promoted celebration window anchors its dive on the CITED
  // attack window instead — the goal instant sits just past that shot, not at
  // the celebration's own (lagging) center — so the Stage-2 keyframes can
  // actually contain the crossing the 1 fps grid skipped.
  const goalEventTs = recall
    ? recall.attackTs + Math.min(3, Math.max(0, recall.leadS))
    : observeGoalEventTs(payload, candidate, cfg.clipAfterS);
  // ADAAAA-7957 (Inc 5): the accept path can CHANGE this window's verdict — a
  // repeat GOAL accept is downgraded to a celebration (`big_play`, ADAAAA-7865).
  // Gating the caption with the pre-accept verdict let a "scores" line sit on a
  // stored `big_play` row (level 2c025e97, seq 17/19), so the summary is written
  // with the verdict the board will actually read.
  const sink: { final?: DecisionResult; grounding?: CaptionGroundingContext } = {};
  // ADAAAA-7996: the judged content window this accept was decided over. On the
  // live rail it is the TRAILING `[centerTs - windowS, centerTs]` span; the
  // delivery instant is localized inside it instead of at its centre.
  const liveWindow =
    cfg.liveObserveLoop && cfg.decideWindowN === undefined
      ? { lo: payload.centerTs - (cfg.observeWindowS ?? OBSERVE_WINDOW_S), hi: payload.centerTs }
      : undefined;
  let acceptError: unknown = null;
  try {
    await acceptVideoDecision(client, run, cut, cfg, onEvent, { seq: observeEmitSeq(payload.centerTs, cfg.sampleFps ?? cfg.analysisFps ?? OBSERVE_CONTENT_FPS), timestamp: payload.centerTs }, candidate, stage1, frameSignals, goalEventTs, sink, liveWindow);
  } catch (e) {
    acceptError = e;
  }
  const stored = sink.final ?? stage1;
  // ADAAAA-8006: a scoreboard read in THIS window can still re-attest a
  // goal-shaped accept a previous window had to demote (the measured failure:
  // the score changed 17 s after the judged window closed, so recall was 1/2).
  // The delta is a measurement the pass already paid for — no decide is added.
  // Live rail only: the VOD pass never sets `liveObserveLoop`, and its precision
  // gate owns its own attestation path.
  if (cfg.liveObserveLoop && cfg.decideWindowN === undefined) {
    applyDeferredGoalAttestations(run, cfg, { readAt: payload.centerTs, delta: windowAttestation.scoreBoardDelta });
  }
  if (pendingSummary !== null && cfg.onRunningSummary) {
    try {
      // ADAAAA-7948 (Inc 3): on the FAST rail, carry this window's own stored
      // verdict + the exact prompt text it decided from, so the summary-log
      // seam can gate goal claims, ground names and strip internal tokens.
      // VOD never sets `captionGrounding`, so its entries stay byte-identical.
      // ADAAAA-7962: reuse the context the accept path already computed (the
      // stored verdict + that window's corroboration + its audio evidence), so
      // the story line is gated with exactly what the highlight row was.
      const grounding: CaptionGroundingContext | undefined = cfg.captionGrounding
        ? sink.grounding ??
          // ADAAAA-7965 (§3.1/§3.2): a REJECTED window never reaches the accept
          // seam's grounding computation (it returns at "rejected"), yet its story
          // row is delivered copy too — so the fallback carries the same measured
          // signal, stored place and absence evidence the accepted path would.
          captionGroundingForWindow(
            stored,
            run,
            payload.centerTs,
            cfg,
            false,
            payload.seeds,
            { ballOutcome: candidate.ballOutcome ?? null, goalCrossed: candidate.goalCrossed ?? null, seeds: payload.seeds }
          )
        : undefined;
      cfg.onRunningSummary(pendingSummary, {
        windowTs: payload.centerTs,
        ...(grounding ? { grounding } : {}),
      });
    } catch (e: any) {
      console.error(`[running-summary:${cfg.jobId}] persist failed:`, String(e?.message || e));
    }
  }
  if (acceptError) throw acceptError;
  return isAcceptedHighlight(stored, cfg.preferLabels);
}

/**
 * ADAAAA-7011: shared decide+accept callback for BOTH decide-observer paths
 * (the VOD ObserveDecider and the live LiveObserver). Composes
 * {@link observeDecideOnly} + {@link observeAcceptOnly}, so the observer verdict
 * contract never diverges from the candidate-gated one.
 */
export async function observeOnDecide(
  client: PipelineClient,
  run: LiveRunShared,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent: ((ev: AnalyzeEvent) => void) | undefined,
  sessionId: string,
  payload: ObserveDecidePayload
): Promise<boolean> {
  const decision = await observeDecideOnly(client, run, cfg, sessionId, payload);
  if (!decision) return false;
  return observeAcceptOnly(client, run, cut, cfg, onEvent, payload, decision);
}

// ---------------------------------------------------------------------------
// Stage-2 confirmation-pass driver (ADAAAA-6797): trigger detection + confirm
// context assembly + reconcile adoption. Pure/helpers are unit-testable.
// ---------------------------------------------------------------------------

/** Goal-type event categories eligible for the confirmation pass. A near-miss
 * as a GOAL is the user-facing false positive the pass guards against. */
const GOAL_TYPE_EVENTS = new Set(["GOAL", "GOL", "TOUCHDOWN", "BASKET", "KILL"]);

/** Is `eventType` a goal-type event (goal / touchdown / basket / kill)? */
export function isGoalTypeEvent(eventType: string | undefined): boolean {
  return GOAL_TYPE_EVENTS.has((eventType || "").toUpperCase().trim());
}

/** ADAAAA-7185: whether a Stage-1 decide verdict is GOAL-shaped — the
 * goal-type classification that gates the confirmation pass. The decide
 * OUTCOME taxonomy is authoritative: only `scoring_play` is ever published as
 * a GOAL (highlightEventType maps scoring_play→GOAL, near_miss→NEAR_MISS,
 * big_play→BIG_PLAY), so a requested near-miss / big-play highlight is never a
 * goal even if its eventType says GOAL. Legacy verdicts with no `outcome` fall
 * back to the historic eventType check. The candidate's raw event label is NOT
 * used here because in the observe architecture it carries the perceive
 * bias-hint label (commonly SPORTING_EVENT) while the actual GOAL class lives
 * on the verdict. */
export function isGoalDecision(d: DecisionResult): boolean {
  if (d.outcome === undefined) return isGoalTypeEvent(d.eventType);
  return d.outcome === "scoring_play";
}

/** Whether a candidate carries INDEPENDENT attestation of the goal: perceive
 * `ballOutcome=goal`, `goalCrossed`, or a scoreboard score change. When any is
 * present the candidate is already independently confirmed and the Stage-2
 * dive is NOT needed — this is exactly the exclusion that keeps the confirm
 * pass scoped to the un-attested population. */
export function hasIndependentAttestation(c: {
  ballOutcome?: string;
  goalCrossed?: boolean;
  scoreBoardChanged?: boolean;
}): boolean {
  if (typeof c.ballOutcome === "string" && /^goal$/i.test(c.ballOutcome.trim())) return true;
  if (c.goalCrossed === true) return true;
  if (c.scoreBoardChanged === true) return true;
  return false;
}

/** ADAAAA-7357: whether a Stage-1 verdict is GOAL-shaped for the confirmation
 * pass — the decide outcome is a scoring play OR the candidate's event label is
 * a goal-type event. The outcome alone is NOT sufficient: the kids_soccer 114s
 * goal came through outcome=not_highlight / eventType=GOAL (the coarse 1fps read
 * said "ball moving away… no ball enters the net" and the notable-only bar
 * appended the rejection), so a narrow `isGoalDecision()` gate
 * (outcome===scoring_play) missed exactly the target goal and the confirm dive
 * never ran. */
export function isGoalShaped(d: DecisionResult): boolean {
  return isGoalDecision(d) || isGoalTypeEvent(d.eventType);
}

/** ADAAAA-7357: whether a Stage-1 verdict is a GOAL-shaped, UN-ATTESTED
 * NON-accept — a read the deterministic notable-only bar stripped to a non-accept
 * because it carried no in-window corroboration (a "bare trigger"). This is the
 * delayed-corroboration population: the vision read was a goal, but the
 * scoreboard / goal-call audio landed in a LATER window (kids_soccer.mp4 goal
 * 114-117s, scoreboard 117-120s), so apply_gate rejected the candidate.
 *
 * We do NOT match the literal "rejected by notable-only bar: no corroborating
 * evidence (bare trigger)" reason string — it varies by model read (the 114s
 * goal carried "ball moving away from goal… no ball enters the net"), so a
 * signature match missed exactly the target goal. Instead we detect a bare
 * goal-shaped non-accept structurally: not an accepted highlight, goal-shaped
 * (scoring_play outcome OR goal-type event label), and carrying no independent
 * attestation. The population stays bounded to goal-shaped reads; the confirm
 * pass's own deterministic corroboration gate (ADAAAA-7162) still downgrades an
 * un-corroborated confirmed_goal to near_miss, so a genuine near-miss / saved /
 * dribble never becomes a board GOAL (AC3) and cost stays at one confirm dive
 * per goal-shaped candidate (AC6). */
export function isGateRejectedBareGoal(d: DecisionResult): boolean {
  if (d.isHighlight) return false;
  return isGoalShaped(d);
}

/** ADAAAA-7988: the description text a decided window is classified on. The
 * decide note's `reason` is where the model states what it saw ("The player is
 * standing with arms raised; ... celebrating a previous event"); the running
 * summary is the fallback for a verdict with no reason. Bounded downstream by
 * {@link liveWindowQuote}. */
export function liveWindowDescription(d: DecisionResult | null | undefined): string {
  if (!d) return "";
  const reason = typeof d.reason === "string" ? d.reason.trim() : "";
  if (reason) return reason;
  return typeof d.runningSummary === "string" ? d.runningSummary.trim() : "";
}

/** The Stage-2 trigger: an un-attested goal-type candidate whose Stage-1 read
 * is a scoring_play accept (goal-shaped), OR a goal-shaped read left as a bare
 * non-accept for lack of in-window corroboration (the delayed-corroboration
 * rescue, ADAAAA-7357), enters the confirmation dive. Everything else (non-goal
 * type, attested, a requested near-miss / big-play highlight — isHighlight=true
 * with a non-scoring outcome — or a true non-goal read) keeps the existing
 * path (recommended near-miss / big-play, attested goal, true non-goal). The
 * config gate is `cfg.confirmEnabled` — off is a strict no-op. */
export function shouldRunConfirm(
  cfg: AnalyzerConfig,
  candidate: { eventType: string; ballOutcome?: string; goalCrossed?: boolean; scoreBoardChanged?: boolean },
  stage1Decision: DecisionResult
): boolean {
  if (!cfg.confirmEnabled) return false;
  // ADAAAA-7185/7357: gate goal-ness on the DECISION + eventLabel, not the
  // candidate's raw eventType alone. In the observe architecture the candidate
  // carries the perceive bias-hint label (commonly SPORTING_EVENT) while the
  // actual GOAL class lives on the verdict. Gating on outcome===scoring_play
  // alone made the gate inert for the delayed-corroboration goal whose Stage-1
  // read was outcome=not_highlight / eventType=GOAL (ADAAAA-7357).
  if (!isGoalShaped(stage1Decision)) return false;
  if (hasIndependentAttestation(candidate)) return false;
  // Accepted highlights: fire ONLY for a genuine goal read (scoring_play /
  // legacy goal-type). A requested near-miss / big-play highlight
  // (isHighlight=true, outcome != scoring_play) is never a goal, so no confirm.
  if (stage1Decision.isHighlight) return isGoalDecision(stage1Decision);
  // Non-accept: fire for a goal-shaped bare non-accept (the notable-only /
  // delayed-corroboration rescue). Bounded to goal-shaped reads; the confirm
  // corroboration gate keeps a true non-goal from ever becoming a board GOAL.
  return isGateRejectedBareGoal(stage1Decision);
}

/** Select the precise pre-event / event-instant / post-event keyframes from a
 * dense frame list (nearest frame to each target timestamp). Returns [] when no
 * frame matches. Deterministic + pure so it is unit-testable. */
export function selectConfirmKeyframes(
  frames: { timestamp: number; imageB64: string }[],
  eventTs: number,
  preS: number,
  postS: number
): { role: string; base64: string }[] {
  const targets = [eventTs - preS, eventTs, eventTs + postS];
  const out: { role: string; base64: string }[] = [];
  for (const t of targets) {
    let best: { timestamp: number; imageB64: string } | undefined;
    let bestDiff = Infinity;
    for (const f of frames) {
      const d = Math.abs(f.timestamp - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = f;
      }
    }
    if (best && best.imageB64) out.push({ role: "full", base64: best.imageB64 });
  }
  return out;
}

/** Assemble the higher-fidelity Stage-2 confirm context (ADAAAA-6797): a denser
 * temporal frame window + precise pre/event/post keyframes + object/ball
 * trajectory tracks + motion/optical-flow magnitude + audio-energy envelope.
 * Wherever a tool is unavailable, send the empty default — the decide /confirm
 * endpoint handles absent context (no crash, no regression). */
export async function buildConfirmContext(
  shared: LiveRunShared,
  cfg: AnalyzerConfig,
  candidate: { timestamp: number },
  stage1: DecisionResult,
  /** ADAAAA-7543: the goal's OWN content instant the deep dive should look at.
   * The observe-window CENTER can sit several seconds past the crossing, so
   * centering the frame window on it fed the dive a post-goal restart and the
   * pass refuted a genuine goal. Defaults to the candidate timestamp for every
   * non-observe path (where the candidate timestamp IS the goal trigger). */
  centerTs?: number
): Promise<Omit<ConfirmRequest, "eventType" | "timestamp" | "gameHint" | "stage1">> {
  // Denser frame window: prefer the detail-first higher-FPS burst re-sample
  // (I7 / ADAAAA-6361) around the trigger; else the cached window; else [].
  // ADAAAA-7162: expand the confirm window by `confirmWindowExtraS` on each side
  // so the model sees the ball actually cross the line / enter the net, not a
  // single boundary frame.
  const extra = Math.max(0, cfg.confirmWindowExtraS ?? DEFAULT_CONFIRM_WINDOW_EXTRA_S);
  const center = centerTs ?? candidate.timestamp;
  let dense: { timestamp: number; imageB64: string }[] = [];
  if (cfg.resampleFrames) {
    try {
      dense = (await cfg.resampleFrames(center)) ?? [];
    } catch {
      dense = [];
    }
  }
  if (!dense.length) dense = shared.framesNear(center, CONFIRM_MOTION_WINDOW_S + extra);
  // ADAAAA-7543: hand the deep dive a bounded, evenly spaced sequence (never the
  // raw 8 fps burst) — a dense burst makes the pass lose the crossing instant and
  // refute a genuine goal.
  const sampled = downsampleConfirmFrames(dense);
  const frames = sampled.map((f) => ({ role: "full", base64: f.imageB64 }));
  const keyframes = selectConfirmKeyframes(
    sampled,
    center,
    (cfg.preWindowS ?? DEFAULT_PRE_WINDOW_S) + extra,
    (cfg.postWindowS ?? DEFAULT_POST_WINDOW_S) + extra
  );
  const motion = shared.motionContext(candidate.timestamp);
  const audioLevels = shared.audioLevelSeries();
  // ADAAAA-7665: slice the confirm audio to the CONFIRM WINDOW, never the whole
  // rolling clip. `audioClipB64()` is documented as "the last AUDIO_CLIP_KEEP_S"
  // but VOD sets `vodAudioRetainS` to 1800 s, so the rolling clip IS the entire
  // file: once the padded-base64 truncation is fixed, sending it to ASR costs
  // ~77 MB of base64 and tens of seconds on a 13-minute VOD. The window slice
  // carries the audio the model actually reasons about; no in-window chunk
  // means no audio context at all (same honest text-only degrade the observe
  // path uses), never a wrong-region clip.
  const confirmSpan =
    (cfg.preWindowS ?? DEFAULT_PRE_WINDOW_S) +
    (cfg.postWindowS ?? DEFAULT_POST_WINDOW_S) +
    extra +
    AUDIO_WINDOW_MARGIN_S;
  const confirmHalfWindow = Math.min(confirmSpan, AUDIO_CLIP_KEEP_S);
  const audioB64 = shared.audioWindowB64(center, confirmHalfWindow, confirmHalfWindow);
  return {
    frames,
    keyframes,
    trajectories: motion.trajectories,
    opticalFlowMagnitude: motion.opticalFlowMagnitude,
    flowMagnitudes: motion.flowMagnitudes,
    audioLevels,
    audioB64,
  };
}

/** ADAAAA-7365: whether a bias hint independently attests a goal (the same
 * signals the confirm gate treats as already-confirmed evidence). */
function hintAttestsGoal(h: ObserveBiasHint): boolean {
  if (h.goalCrossed === true) return true;
  if (h.scoreBoardChanged === true) return true;
  return typeof h.ballOutcome === "string" && /^goal$/i.test(h.ballOutcome.trim());
}

/** ADAAAA-7365: stable key for a goal candidate's Stage-2 confirm dive. Keyed on
 * the goal EVENT's content timestamp (the goal trigger / localized instant), NOT
 * the observe-window center, so the SAME goal re-produced across overlapping
 * windows maps to ONE key (one confirm dive) while a genuinely distinct goal at a
 * different content time is a different key. Rounded to 0.01 s so the same
 * content time always yields one key regardless of float representation. */
export function confirmCandidateIdentity(cfg: AnalyzerConfig, goalEventTs: number): string {
  const bucket = Math.round(goalEventTs * 100) / 100;
  return `${cfg.jobId ?? "job"}:${bucket}`;
}

/** ADAAAA-7365: the goal EVENT's content timestamp for an observe window. The
 * stable identity of a goal is its CONTENT time, so the same goal carries the
 * same identity across every overlapping window that contains it (unlike the
 * window center, which slides by the cadence and is explicitly NOT used).
 * Prefers the in-window goal-typed / goal-attested perceive trigger (the goal's
 * own trigger ts); else the frame-localized goal instant; else the candidate
 * timestamp (the last-resort fallback for a hint-less bare goal). */
export function observeGoalEventTs(
  payload: ObserveDecidePayload,
  candidate: CandidateSignal,
  maxLookaheadS: number
): number {
  const hints = payload.biasHints ?? [];
  const goalHint = hints.find((h) => hintAttestsGoal(h) || (typeof h.eventType === "string" && isGoalTypeEvent(h.eventType)));
  if (goalHint && Number.isFinite(goalHint.ts)) return goalHint.ts;
  const loc = localizeHighlightInstantFrame(
    candidateFrameSignalsFromPayload(payload),
    candidate.timestamp,
    maxLookaheadS
  );
  if (loc.signal === "peak_frame") return loc.ts;
  return candidate.timestamp;
}

/** ADAAAA-7365: the per-frame localization inputs for an observe window (the
 * same mapping acceptVideoDecision derives from the payload seeds). */
function candidateFrameSignalsFromPayload(payload: ObserveDecidePayload): LocalizeFrameInput[] {
  return (payload.seeds ?? []).map((s) => ({
    ts: s.ts,
    signal: s.signal,
    detectionConfidence: (s.objects ?? []).reduce((m, o) => Math.max(m, clamp01(o.confidence)), 0),
  }));
}

/** Run the Stage-2 confirmation dive (if the trigger fires) and return the
 * effective decision to use downstream. On the no-trigger / flag-off path the
 * Stage-1 verdict is returned unchanged (strict no-op). On a real dive it
 * adopts the reconciled `decision` when the pass produced one (goalConfirmed
 * non-null); on passthrough (disabled/unparseable) or any transport failure it
 * keeps the Stage-1 verdict (no behavior change). Also records the disagreement
 * metric on `shared`. */
export async function confirmReconcile(
  client: PipelineClient,
  shared: LiveRunShared,
  cfg: AnalyzerConfig,
  stage1: DecisionResult,
  candidate: {
    eventType: string;
    timestamp: number;
    ballOutcome?: string;
    goalCrossed?: boolean;
    scoreBoardChanged?: boolean;
    scoreBoardDelta?: ScoreboardDeltaEvidence;
  },
  /** ADAAAA-7365: the goal EVENT's stable content timestamp (goal trigger /
   * localized instant). For the VOD observe path this is the goal's own content
   * time — invariant across the overlapping windows that re-produce the same
   * goal — NOT the window center. When absent (non-observe paths), falls back to
   * the candidate timestamp (which is already the goal trigger there). */
  goalEventTs?: number
): Promise<{ decision: DecisionResult; confirmRan: boolean; confirm?: ConfirmDecision }> {
  if (!shouldRunConfirm(cfg, candidate, stage1)) {
    return { decision: stage1, confirmRan: false };
  }
  // ADAAAA-7365: exactly-once. A genuine goal is re-produced by every overlapping
  // observe window that contains it (10 s window, 3 s cadence => ~5x re-fire on
  // the untouched base). Once a goal candidate has had its confirm dive, reuse the
  // FIRST outcome so a re-produced window neither re-bills the confirm dive nor
  // re-cuts the highlight. Keyed on goal-event identity, not the window center.
  // ADAAAA-7663: `eventTs` is that goal-event instant (the stable content time on
  // VOD; the candidate trigger / window center on live).
  const eventTs = goalEventTs ?? candidate.timestamp;
  const key = confirmCandidateIdentity(cfg, eventTs);
  const cached = shared.confirmedGoalOutcome(key);
  if (cached) return cached;
  // ADAAAA-7663: the LIVE pass has no stable content-time identity — its rolling
  // window center slides by the cadence, so the same goal maps to a different
  // key per window. Reuse a goal confirmed within `confirmReuseWindowS` of this
  // one (the observe window + one cadence tick of slack, deliberately SMALLER
  // than the 30 s burst window) so the dive stays at one per distinct goal
  // instead of one per overlapping window. Unset => no-op, which keeps the VOD
  // exact-key behaviour byte-identical.
  //
  // Exception (recall guard): a nearby dive that REFUTED the goal (goalConfirmed
  // not `confirmed_goal`, e.g. a post-goal celebration window that never saw the
  // ball in the net) must not veto a fresh scoring_play ACCEPT a few seconds
  // later — the later window is better evidence for the same event and a genuine
  // goal must never be dropped by an earlier celebration read. That costs at
  // most one extra dive for the accept.
  const reuseWindowS = cfg.confirmReuseWindowS;
  if (reuseWindowS && reuseWindowS > 0) {
    const near = shared.confirmedGoalNear(eventTs, reuseWindowS);
    const refutedByNearby = near ? near.confirm?.goalConfirmed !== "confirmed_goal" : false;
    if (near && !(isGoalDecision(stage1) && refutedByNearby)) return near;
  }
  // ADAAAA-7543: center the deep dive's frame window on the goal EVENT instant —
  // the observe-window center can sit several seconds past the crossing, and a
  // post-goal restart window made the pass refute genuine goals.
  const goalTs = eventTs;
  const ctx = await buildConfirmContext(shared, cfg, candidate, stage1, goalTs);
  try {
    // ADAAAA-7626: measure the /confirm wall time HERE, server-side, around the
    // call — the /confirm service emits no timings of its own. The carrier opts
    // also carry the jobId so the confirm payload's audit session is job-scoped.
    const confirmStartedAt = Date.now();
    const confirm = await client.confirm({
      eventType: candidate.eventType,
      timestamp: goalTs,
      gameHint: cfg.gameHint,
      stage1,
      ...ctx,
      ballOutcome: candidate.ballOutcome,
      goalCrossed: candidate.goalCrossed,
      scoreBoardChanged: candidate.scoreBoardChanged,
      scoreBoardDelta: candidate.scoreBoardDelta,
    } as ConfirmRequest, { jobId: cfg.jobId });
    const confirmElapsedMs = Date.now() - confirmStartedAt;
    shared.recordConfirm({ stage1Disagreed: confirm.stage1Disagreed === true });
    // ADAAAA-7185: emit a decide-audit descriptor from the /confirm pass
    // (run_confirmation_pass) so the corroboration result for an accepted GOAL
    // is queryable after the fact. Keyed by (jobId, group:confirm) so it never
    // collides with the primary /highlight decide-audit row.
    // ADAAAA-7626: the row now describes itself — candidate in-video timestamp,
    // frame count, sha256 of the frames actually sent (CPU only, no GPU call),
    // and the server-measured confirm elapsed time.
    if (cfg.onDecideAudit) {
      try {
        cfg.onDecideAudit(
          confirmAuditDescriptor(cfg, {
            timestamp: goalTs,
            frames: ctx.frames ?? [],
            elapsedMs: confirmElapsedMs,
            confirm,
          })
        );
      } catch (e: any) {
        console.error(`[confirm-audit:${cfg.jobId}] ingest failed:`, String(e?.message || e));
      }
    }
    // Adopt the reconciled verdict only when the pass actually produced one; on
    // passthrough (goalConfirmed null) keep the Stage-1 verdict unchanged.
    if (confirm.goalConfirmed && confirm.decision && typeof confirm.decision === "object") {
      const outcome = { decision: confirm.decision, confirmRan: true, confirm };
      shared.rememberConfirmedGoal(key, outcome, eventTs);
      return outcome;
    }
    const outcome = { decision: stage1, confirmRan: true, confirm };
    shared.rememberConfirmedGoal(key, outcome, eventTs);
    return outcome;
  } catch {
    // Transport failure — keep the Stage-1 verdict (no behavior change).
    shared.recordConfirm({ stage1Disagreed: false });
    const outcome = { decision: stage1, confirmRan: true };
    shared.rememberConfirmedGoal(key, outcome, eventTs);
    return outcome;
  }
}

/** ADAAAA-7185 / ADAAAA-7626: build a decide-audit descriptor for a Stage-2
 * /confirm pass (run_confirmation_pass). Identity is job-scoped (jobId /
 * sessionId / groupKey), and — unlike the original thin row — the descriptor
 * describes itself: the candidate's in-video `timestamp`, `frameCount` = the
 * number of frames actually sent, `candidateCount` = 1, sha256 `mediaHashes` for
 * those frames (CPU only, no extra GPU call), the /confirm verdict, and the
 * server-measured `timings.elapsedMs` around the `client.confirm` call (the
 * /confirm service emits no timings of its own). */
export function confirmAuditDescriptor(
  cfg: { jobId?: string },
  input: {
    /** The candidate's in-video time the dive looked at. */
    timestamp: number;
    /** The frames actually sent in the confirm request. */
    frames?: { role?: string; base64?: string }[];
    /** Server-measured wall time of the client.confirm call. */
    elapsedMs?: number;
    confirm: ConfirmDecision;
  }
): Record<string, unknown> {
  const { timestamp, frames, elapsedMs, confirm } = input;
  const jobId = cfg.jobId ?? null;
  // ADAAAA-7626 (AC1): the /confirm service builds its own prompt and returns it
  // in the pass analysis record (`analysis.request.prompt`). Persisting that exact
  // prompt makes the confirm row self-describing and replayable — prompt +
  // per-frame sha256 is everything needed to re-submit the dive. Reading it off
  // the SAME response is CPU-only: no added confirm call, no added GPU work.
  // Absent on a passthrough that never built a prompt (then promptText stays null
  // and replayable stays false rather than claiming a replay we cannot serve).
  const promptText = (confirm as any)?.analysis?.request?.prompt;
  const prompt = typeof promptText === "string" && promptText.trim() ? promptText : null;
  const mediaHashes = frameMediaHashes(frames);
  return {
    jobId,
    sessionId: jobId,
    groupKey: `${decideGroupKey(timestamp)}:confirm`,
    timestamp,
    frameCount: frames?.length ?? 0,
    candidateCount: 1,
    promptText: prompt,
    mediaHashes,
    replayable: !!(prompt && mediaHashes.length > 0),
    verdicts: {
      runConfirmationPass: true,
      goalConfirmed: confirm?.goalConfirmed ?? null,
      corroborated: confirm?.corroborated ?? false,
      corroborationSource: confirm?.corroborationSource ?? null,
      // ADAAAA-7844: persist the measured delta behind a "scoreboard" label so
      // the corroboration is queryable/replayable after the fact.
      scoreboardDelta: confirm?.scoreboardDelta ?? null,
      stage1Disagreed: confirm?.stage1Disagreed ?? false,
    },
    params: { stage1Disagreed: confirm?.stage1Disagreed ?? false },
    rawReply: confirm?.reason ?? "",
    timings: {
      elapsedMs: typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? Math.round(elapsedMs) : null,
    },
    createdAt: new Date().toISOString(),
  };
}

/** ADAAAA-7626: content-address the frames actually sent to the decide service
 * (sha256 of the decoded bytes, CPU only). A frame that cannot be hashed is
 * skipped — building an audit descriptor must never fail a confirm pass. */
function frameMediaHashes(frames?: { role?: string; base64?: string }[]): {
  type: string;
  sha256: string;
  mime: string;
  role?: string;
}[] {
  const out: { type: string; sha256: string; mime: string; role?: string }[] = [];
  for (const f of frames ?? []) {
    if (!f || typeof f.base64 !== "string" || !f.base64) continue;
    try {
      const sha256 = createHash("sha256").update(Buffer.from(f.base64, "base64")).digest("hex");
      out.push({ type: "image", sha256, mime: "image/jpeg", ...(f.role ? { role: f.role } : {}) });
    } catch {
      // ignore an unhashable frame — never fail the pass for audit detail
    }
  }
  return out;
}

/** ADAAAA-7185: when the Stage-2 gate RAN for this un-attested goal but could
 * not corroborate it (passthrough / transport failure left the Stage-1 visual
 * accept standing), the server must NOT accept a GOAL on the Stage-1 read alone
 * (accepted == corroborated). Downgrade to a near-miss so it never surfaces as
 * a board-accepted goal. */
function downgradeUncorroborated(stage1: DecisionResult): DecisionResult {
  const d: DecisionResult = {
    ...stage1,
    outcome: "near_miss",
    nearMiss: true,
    isHighlight: false,
    eventType: "NEAR_MISS",
    // ADAAAA-7185: surface the reason so a reviewer can see the confirm pass
    // could not corroborate the goal (the accept was not trusted).
    reason: `${stage1.reason ?? ""}; confirm pass couldn't corroborate the goal (no independent signal) — accepted as near_miss`.trim(),
  } as DecisionResult;
  const sc = Number((stage1 as any).score ?? 0) || 0;
  if (sc >= 60) d.score = 55;
  return d;
}


/** Live-console event: pushed to SSE subscribers for a job as analysis runs. */
export interface AnalyzeEvent {
  seq: number;
  timestamp: number;
  type:
    | "observation"
    | "candidate"
    | "highlight"
    | "candidateBlocked"
    | "lifecycle"
    | "highlightAttested"
    // ADAAAA-8032: a browser (screen-share) highlight's clip landed. Emitted
    // the moment the live cut patches `clipUri` (and by the stop path), so an
    // open grid / job-detail view repaints the card without a page reload.
    | "clip";
  observation?: { tracks: TrackObservation[] };
  candidate?: { eventType: string; timestamp: number };
  highlight?: HighlightRecord;
  reason?: string;
  /** ADAAAA-8032 `clip` events: which highlight's clip landed and where it is
   *  playable. `clipError` is set instead when the cut itself failed. */
  highlightId?: string;
  clipUri?: string;
  clipError?: string;
  /** ADAAAA-7700 `lifecycle` events: a terminal/attributable job transition
   *  pushed to the live console (e.g. the media node restarted under a share). */
  status?: "done" | "failed" | "cancelled";
  failureReason?: string;
  message?: string;
}

/**
 * ADAAAA-7152 (Gap 2): forward this job's per-camera pitch calibration
 * (homography 3x3 + goalLine spec) to a perceive session via the `configure`
 * control. This is what makes perceive emit a REAL `goalCrossed`/`ballOutcome`
 * attestation on the server path. Called once when a session is reserved (and
 * again after each re-reserve so a fresh session inherits the calibration).
 *
 * Best-effort: a calibration-forward failure (e.g. a transient 404 on a just-
 * re-reserved session, or an adapter without controlForward support) is dropped
 * and logged, never fatal to the frame loop. When `cal` is absent (no
 * calibration configured for the camera) this is a strict no-op — the session
 * stays uncalibrated (no goal channel), the recall-safe gate unchanged. The
 * server never fabricates a calibration: only explicit per-camera config is
 * carried here.
 */
export async function configurePerceiveCalibration(
  client: PipelineClient,
  sessionId: string,
  cal: PerceiveCalibration | undefined
): Promise<void> {
  if (!cal) return;
  const control: { type: string; [k: string]: unknown } = { type: "configure" };
  if (cal.homography) control.homography = cal.homography;
  if (cal.goalLine) control.goalLine = cal.goalLine;
  await client.controlForward(sessionId, control).catch((err: any) => {
    console.warn(`[calibration:${sessionId}] configure forward failed (best-effort):`, String(err?.message || err));
  });
}

export async function analyzeJob(
  client: PipelineClient,
  iterFrames: AsyncIterable<{ seq: number; timestamp: number; imageB64: string }>,
  cut: (ts: number) => Promise<{ clipId: string; clipUri: string }>,
  cfg: AnalyzerConfig,
  onEvent?: (ev: AnalyzeEvent) => void,
  /** Optional pre-reserved session (shared with a concurrent audio tap so both
   * the video /analyze and audio /audio legs feed the SAME perceive session).
   * When absent, analyzedJob reserves one itself. */
  initialSession?: ReserveResult,
  /** Optional shared live-run context (INC-2 / ADAAAA-4325 slice 4). When a
   * Stage-A audio tap is concurrently feeding the same percieve session, pass a
   * LiveRunShared so both legs share the frame-anchor window, video evidence,
   * and collected highlights. When absent (VOD), a private namespace is used
   * and behavior is unchanged. */
  shared_?: LiveRunShared,
  /** Live-slot hooks (ADAAAA-6561). `onReserve` fires on every reservation
   * (the initial session and each re-reserve) so the caller can track the job's
   * CURRENT perceive session and release it synchronously from the stop path —
   * independent of the in-flight GPU /analyze that analyzeJob's `finally`
   * would otherwise wait for. `isStopped` tells the loop to stop re-reserving
   * a fresh session once the job has been stopped (otherwise the stop-path
   * slot release would make the in-flight analyze 404 and re-bind a new slot
   * on a job that is already stopping). */
  slotRef?: { onReserve?: (res: ReserveResult) => void; isStopped?: () => boolean },
  /** Progress hook (ADAAAA-6873): fires with the running frames-processed count
   * after each frame is fed to the pipeline, so the durable worker can persist
   * a throttled, monotonic progress snapshot without waiting for job
   * completion. Optional and trailing so existing positional callers are
   * unaffected. */
  onProgress?: (framesAnalyzed: number) => void
): Promise<AnalyzeOutcome> {
  const maxReReserves = cfg.maxReReserves ?? 3;
  // ADAAAA-6577: bounded exponential backoff between a perceive session-lost
  // re-reserve and the retry of the same frame. A flapping perceive runner
  // 404s every /analyze; backing off keeps the re-reserve cadence near
  // ~1/sec at the base and lets the pass ride through a brief runner recovery
  // instead of hammering the orchestrator (see backoffDelayMs).
  const sessionRetryBackoffMs = cfg.sessionRetryBackoffMs ?? 500;
  const sessionRetryBackoffMaxMs = cfg.sessionRetryBackoffMaxMs ?? 8000;
  // ADAAAA-7203: how many times to re-attempt the reserve within ONE re-reserve
  // when the runner is momentarily unavailable (deploy-recreate). Bounded.
  const reReserveAttempts = cfg.reReserveAttempts ?? 5;
  const first = initialSession ?? (await client.reservePerceive());
  let sessionId = first.sessionId;
  slotRef?.onReserve?.(first);
  // ADAAAA-7152 (Gap 2): ship this job's per-camera pitch calibration (homography
  // + goalLine) to the freshly-reserved session so perceive emits a REAL
  // goalCrossed / ballOutcome attestation (a `scoring_play` accept) instead of
  // an uncalibrated no-goal channel. Best-effort; a no-op when no calibration is
  // configured for the camera (recall-safe baseline unchanged).
  await configurePerceiveCalibration(client, sessionId, cfg.perceiveCalibration);
  // Every session we reserved (initial + any re-reserves) must be stopped /
  // un-paid in `finally`, even the ones go-livepeer already released (the
  // server-side released ones still hold a payment refiller in the adapter).
  const reserved = new Set<string>([first.sessionId]);
  // Live path shares frame window / evidence / highlights with the audio tap so
  // decide sees the anchored moment; VOD path gets a private namespace.
  const run = shared_ ?? new LiveRunShared({ decideWindowN: cfg.decideWindowN, goalBurstWindowS: cfg.goalBurstWindowS });
  const evidence = run.evidence;
  const highlights = run.highlights;
  // Increment D (ADAAAA-6467): the what-to-track plan orchestrator. Fires the
  // SINGLE warm-up planner call near stream start and the out-of-band re-check
  // cadence — never the planner from the per-frame loop. The resulting plan is
  // delivered to perceive alongside gameHint/preferLabels on every /analyze
  // (mirrors ADAAAA-4109 delivery so a re-reserved session inherits it too).
  const planController = new TrackingPlanController({
    warmupSeconds: cfg.warmupSeconds,
    recheckIntervalSeconds: cfg.recheckIntervalSeconds,
    planMode: cfg.planMode ?? "live",
  });
  // ADAAAA-7007: decide-observer architecture for the VOD detail-first pass.
  // The vision LLM is the PRIMARY observer: decide is invoked on a ~3 s cadence
  // with a ~10 s overlapping window (<=30 frames) and perceive is a data seeder
  // + on-demand provider, NOT the candidate on/off gate. Candidate trigger
  // signals inside the window are folded in as per-window bias hints
  // (provenance metadata). The decision path is shared via
  // observeOnDecide -> acceptVideoDecision.
  // ADAAAA-7878: prove the frame-consume loop keeps running while a decide is in
  // flight. Active on BOTH rails and on BOTH sides of `observeDecideOffLoop`, so
  // the flag-off (serial) run prints the same `[ingest-gap]` line — and its
  // pre-fix signature (0 frames consumed during the decide, one gap = the decide
  // E2E) is the "before" number of the measured pair.
  const observeDecideOffLoop = cfg.observeDecideOffLoop !== false;
  const ingestGaps = new IngestGapTracker({
    jobId: cfg.jobId ?? "job",
    framePeriodMs: 1000 / Math.max(0.001, cfg.sampleFps ?? cfg.analysisFps ?? 2),
  });
  /** ADAAAA-7878: measure one decide call's span for the `[ingest-gap]` line. */
  const measuredDecide = async <T>(centerTs: number, fn: () => Promise<T>): Promise<T> => {
    const startedMs = Date.now();
    try {
      return await fn();
    } finally {
      ingestGaps.recordWindow({ centerTs, startedMs, endedMs: Date.now() });
    }
  };
  const observeDecider =
    cfg.observeLoop && cfg.decideWindowN !== undefined
      ? new ObserveDecider({
          cadenceS: cfg.observeCadenceS,
          windowS: cfg.observeWindowS,
          maxFrames: cfg.observeMaxFrames ?? OBSERVE_MAX_FRAMES,
          fps: cfg.sampleFps ?? cfg.analysisFps ?? 2,
          signalGate: cfg.observeSignalGate,
          signalGateOpts: cfg.observeSignalGateOpts,
          stageA: run.stageAOutcomes,
          // ADAAAA-7722: the VOD rail judges a whistle-anchored window in the
          // Stage-B ledger, never the Stage-A one.
          stageB: run.stageBOutcomes,
          // ADAAAA-7906 (VOD resume): start the cadence clock at the persisted
          // cursor and report every applied window so the caller persists it.
          ...(cfg.resumeFromTs !== undefined ? { startTs: cfg.resumeFromTs } : {}),
          ...(cfg.onDecidedWindow ? { onApplied: cfg.onDecidedWindow } : {}),
          // ADAAAA-7878: ISSUE the decide off the frame-consume loop (default), so
          // ingest keeps feeding perceive while gemma judges a window; the verdict
          // is applied in content order by the accept chain. Decide count and
          // decide concurrency are unchanged (depth 1 by default). Flag off keeps
          // the pre-7878 serial `onDecide` pass byte-identical.
          ...(observeDecideOffLoop
            ? {
                maxInFlight: Math.max(1, Math.floor(cfg.observeDecideInFlight ?? 1)),
                maxPending: Math.max(1, Math.floor(cfg.observeDecideQueueMax ?? 512)),
                onDecideStaged: (payload: ObserveDecidePayload) => {
                  let verdict: Awaited<ReturnType<typeof observeDecideOnly>> = null;
                  return {
                    decide: async () => {
                      await measuredDecide(payload.centerTs, async () => {
                        verdict = await observeDecideOnly(client, run, cfg, sessionId, payload);
                      });
                    },
                    accept: async () => {
                      if (!verdict) return false;
                      return observeAcceptOnly(client, run, cut, cfg, onEvent, payload, verdict);
                    },
                  };
                },
              }
            : {
                onDecide: (payload: ObserveDecidePayload) =>
                  measuredDecide(payload.centerTs, () => observeOnDecide(client, run, cut, cfg, onEvent, sessionId, payload)),
              }),
        })
      : null;
  // ADAAAA-7011: LIVE decide-observer. When enabled on the live/default pass
  // (decideWindowN UNSET), decide is driven on the ~3 s cadence REGARDLESS of
  // whether perceive emitted a candidate, using the rolling-PAST LiveObserver.
  // Perceive becomes a data seeder (per-frame tracks/objects/ocr ride every
  // payload) and candidate triggers are folded into biasHints (provenance) —
  // they never gate decide, so trigger-FP gating no longer limits recall. The
  // accept path is shared via observeOnDecide -> acceptVideoDecision.
  const liveInvoke = cfg.liveObserveInFlight;
  const liveInFlight = Math.max(1, Math.floor(liveInvoke ?? 1));
  // ADAAAA-7771: the in-flight depth is a SHARED budget. The orchestrated decide
  // client admits only `DECIDE_CONCURRENCY` decide app-calls at once, so depth
  // above that admission does not add throughput — it only queues, and a queued
  // window lands later (measured at depth 4 with a 2-wide gate: 1 stream
  // 11.6 s/decide and 31.3 s lag; 2 streams 24.8-26.6 s and 50.8-52.0 s lag,
  // worse than the serial 32.6-34.5 s). ADAAAA-7773: docker-compose now ships
  // `DECIDE_CONCURRENCY=8` (the box's real 4+4 decide slots), so two streams get
  // 4 each instead of falling back to the serial pass; the fallback below stays
  // at the client's own default (2) so an unset env behaves like the client.
  // Each live stream therefore gets `admission / activeStreams`, never more than
  // `liveObserveInFlight`.
  const liveDecideAdmissionBudget = Math.max(1, Math.floor(cfg.liveDecideAdmission ?? 2));
  if (liveInFlight > 1) liveDecideAdmission.registerLiveJob(cfg.jobId);
  const liveObserver =
    cfg.liveObserveLoop && cfg.decideWindowN === undefined
      ? new LiveObserver({
          cadenceS: cfg.liveObserveCadenceS ?? cfg.observeCadenceS,
          windowS: cfg.observeWindowS,
          maxFrames: cfg.observeMaxFrames ?? LIVE_OBSERVE_MAX_FRAMES,
          fps: cfg.sampleFps ?? cfg.analysisFps ?? 2,
          signalGate: cfg.observeSignalGate,
          signalGateOpts: cfg.observeSignalGateOpts,
          stageA: run.stageAOutcomes,
          // ADAAAA-7707: the whistle family gets its own verdict ledger, so a
          // judged whistle window never lands in the Stage-A FP-rate.
          stageB: run.stageBOutcomes,
          // ADAAAA-8005 (gate 3): the per-row trigger -> delivered metric. The
          // server's persist path completes each row off the SAME run object, so
          // the live RTMP/file rail reports it too (not only the media rail).
          delivery: run.delivery,
          // ADAAAA-7758: one live decide slot per box. When another live job
          // holds it this tick is skipped (counted as an admission skip) instead
          // of interleaving a second decide that would stretch BOTH streams past
          // the 30 s budget. Default off until the CEO approves queue wording.
          canDecide: () => liveDecideAdmission.admit(cfg.jobId),
          // ADAAAA-7799 (lever C): hold the funded spend ceiling by capping the
          // decide rate (fraction of decide opportunities kept). Undefined
          // leaves the pass unbounded.
          decideKeepRatio: cfg.liveDecideKeepRatio,
          // ADAAAA-7771: pipelined depth. With K > 1 the expensive decide half
          // runs K-wide while acceptance stays serial in CONTENT order — the
          // serial loop could never hold the 3 s cadence when one decide costs
          // several cadence periods (measured: 33 % coverage at one stream).
          //
          // ADAAAA-7878: the depth-1 fallback (crowded box) now ALSO issues and
          // does not await, so ingest never stalls on gemma; one decide is in
          // flight at a time (the backpressure gate refuses the tick). Flag off
          // keeps the pre-7878 shape exactly: staged at depth > 1, inline serial
          // `onDecide` at depth 1.
          ...(observeDecideOffLoop || liveInFlight > 1
            ? {
                maxInFlight: liveInFlight,
                ...(liveInFlight > 1
                  ? { depthBudget: () => liveDecideAdmission.depthFor(cfg.jobId, liveInFlight, liveDecideAdmissionBudget) }
                  : {}),
                onDecideStaged: (payload: ObserveDecidePayload) => {
                  let verdict: Awaited<ReturnType<typeof observeDecideOnly>> = null;
                  return {
                    decide: async () => {
                      await measuredDecide(payload.centerTs, async () => {
                        verdict = await observeDecideOnly(client, run, cfg, sessionId, payload);
                      });
                    },
                    accept: async () => {
                      if (!verdict) return false;
                      return observeAcceptOnly(client, run, cut, cfg, onEvent, payload, verdict);
                    },
                  };
                },
              }
            : {
                onDecide: (payload: ObserveDecidePayload) =>
                  measuredDecide(payload.centerTs, () => observeOnDecide(client, run, cut, cfg, onEvent, sessionId, payload)),
              }),
        })
      : null;
  let framesAnalyzed = 0;
  let planApplied = false;
  // ADAAAA-7676: bound the LIVE observe lag against the WALL clock. A frame's
  // `timestamp` is the pipeline's CONTENT clock (seq / sampleFps) while the
  // capture runs in real time, so a slow decide (~8–13 s wall per ~3 s content)
  // pulls the two apart and the captured-frame backlog grows without bound
  // (measured: window `T+42s` decided at wall `+242s`, ~5.7x). Anchor the content
  // clock to the wall time the first frame arrived, measure every later frame's
  // lag, and DROP frames/windows past the budget instead of deciding them late.
  // `<= 0` keeps the legacy unbounded behaviour (opt-out).
  const lagBudgetS = cfg.liveObserveLagBudgetS ?? LIVE_OBSERVE_LAG_BUDGET_S;
  // The lag is measured whenever the live observer owns the loop (cheap, and it
  // is the AC1 evidence); only the DROP depends on an active budget (`<= 0`
  // keeps the legacy unbounded behaviour — opt-out control).
  const lagMeasured = !!liveObserver;
  const lagBounded = lagMeasured && lagBudgetS > 0;
  /**
   * ADAAAA-7676: reserve part of the budget for the decide that has not landed
   * yet. What a viewer experiences is `lag_at_fire + decide_e2e`, so the drop
   * threshold is `budget - reserve` and the reserve must cover the WORST decide
   * seen so far (not the mean): measured on job `4f8d47bd`, a mean-based reserve
   * let an 11.7 s decide land at completed 33–40 s on a 30 s budget. 1 s of
   * margin absorbs the fenceposts of the measurement itself.
   */
  const lagReserveS = (): number =>
    liveLagReserveS(liveObserver!.maxE2eMs(), liveObserver!.meanE2eMs(), lagBudgetS);
  let streamWallStartMs: number | null = null;
  let lastFrameLagMs = 0;
  let staleFrameDrops = 0;
  // ADAAAA-7152 Gap 1: adaptive perceive cadence for the VOD detail-first pass.
  // The per-frame `client.analyze` (perceive `process_frame` -> Florence detect)
  // is the dominant VOD E2E cost. When active, cool (no-signal) regions run at a
  // reduced `quietStride` cadence and the escalated goal window is forced to FULL
  // perceive. Auto-enable (unless explicitly forced by `cfg.perceiveCadence`)
  // exactly when the gated VOD detail-first pass is present — the configuration
  // the gap targets (ObserveDecider + Tier-2 signal gate + decideWindowN).
  // see perceive-cadence.ts for the recall-safety argument.
  // ADAAAA-7774: the LIVE observe pass owns the same cadence on the frames it
  // CONSUMES. The live ingest is strided to the analysis fps first (`liveStrideS`
  // below), then the cadence's cool stride runs inside that set — so the pass
  // perceives ~`OBSERVE_CONTENT_FPS` frames per content second in a cool region,
  // the decide window still gets ~2 fps of frames, and `perceiveCalls <
  // framesAnalyzed` proves the stride. Auto-enable for the live observer unless
  // explicitly forced off (`PERCEIVE_CADENCE=0`).
  const livePerceiveCadence = !!liveObserver && cfg.perceiveCadence !== false;
  const perceiveCadenceEnabled =
    cfg.perceiveCadence === true ||
    (cfg.perceiveCadence === undefined &&
      ((cfg.observeLoop === true &&
        cfg.observeSignalGate === true &&
        cfg.decideWindowN !== undefined) ||
        livePerceiveCadence));
  const perceiveCadence: PerceiveCadence | null = perceiveCadenceEnabled
    ? new PerceiveCadence({
        quietStride: cfg.perceiveQuietStride,
        hotAfterS: cfg.perceiveHotAfterS ?? cfg.observeWindowS ?? OBSERVE_WINDOW_S,
      })
    : null;
  // ADAAAA-7774: ingest -> analysis stride for the LIVE pass. The rail delivers
  // ~5 fps of content while the decide window only carries `OBSERVE_CONTENT_FPS`
  // (2) frames per content second, so the surplus frames were perceived (0.36 s
  // of blocking `client.analyze` each) and then discarded by the window
  // assembler — and the resulting ~1.8x-slower-than-realtime loop is what made
  // the lag budget drop frames and swallow 56-86 of ~100 cadence windows per
  // 300 s. Consuming frames at the analysis fps instead keeps the loop inside
  // the budget (droppedFrames/skippedStaleWindows -> 0) with no payload change.
  // `<= 0` disables the stride (perceive every ingested frame = pre-7774).
  const liveContentFps = Number(cfg.liveObserveContentFps ?? OBSERVE_CONTENT_FPS);
  const liveStrideS = !!liveObserver && Number.isFinite(liveContentFps) && liveContentFps > 0 ? 1 / liveContentFps : 0;
  // ADAAAA-7774: the stride is also COST-AWARE. A fixed 0.5 s step assumes the
  // box can perceive ~2 frames/content-second; measured on the box at decide
  // depth 4 the shared GPU made one `client.analyze` take ~1.6 s, so a fixed
  // step let the loop fall behind the wall clock again and the lag budget
  // dropped 2 of every 3 frames (614 of 857, 56 skipped windows) exactly like
  // the pre-7774 pass. Stepping by the MEASURED perceive cost keeps every
  // consumed frame at the live edge (lag ~= one perceive), so the budget never
  // drops content and no cadence window is swallowed; when perceive is fast the
  // step falls back to `1 / analysisFps` (2 per content second).
  let perceiveCostS = 0;
  let perceiveCostSumS = 0;
  let perceiveCostCount = 0;
  // ADAAAA-7774: perceive is GPU-bound on a contended box (measured at 2 streams
  // + decide depth 4: ~4.1 s per `client.analyze`). Awaiting every consumed
  // frame's perceive is what made the cadence windows run late, so perceive
  // demand is BUDGETED: the pass may spend at most `livePerceiveUtilization` of
  // the wall clock in perceive, i.e. one perceive call per
  // `cost / utilization` content seconds. A consumed frame the budget refuses is
  // still recorded and decide-seeded with an EMPTY seed (recall-safe, the VOD
  // cadence contract), so the frame loop keeps consuming at the analysis fps and
  // the 3 s decide cadence fires on time even when the GPU cannot perceive that
  // fast.
  const livePerceiveUtilization = Math.max(0.05, Math.min(1, Number(cfg.livePerceiveUtilization ?? LIVE_PERCEIVE_UTILIZATION)));
  let perceiveTokens = 1;
  let perceiveBudgetTs: number | null = null;
  /** Spend one perceive from the GPU budget; refilled by content time at
   *  `utilization / cost` per second (unbounded until the first cost measurement). */
  const takePerceiveBudget = (ts: number): boolean => {
    const fps = perceiveCostS > 0 && liveStrideS > 0 ? Math.min(1 / liveStrideS, livePerceiveUtilization / perceiveCostS) : Infinity;
    if (!Number.isFinite(fps)) return true;
    if (perceiveBudgetTs === null) {
      perceiveBudgetTs = ts;
      return perceiveTokens >= 1;
    }
    const dt = ts - perceiveBudgetTs;
    if (dt > 0) perceiveTokens = Math.min(1, perceiveTokens + dt * fps);
    if (ts > perceiveBudgetTs) perceiveBudgetTs = ts;
    if (perceiveTokens >= 1 - 1e-9) {
      perceiveTokens -= 1;
      return true;
    }
    return false;
  };
  // ADAAAA-7795: stride credit state (frames). `strideCreditTs` is the content
  // time the credit was last accrued to.
  let strideCredit = 1;
  let strideCreditTs: number | null = null;
  let framesSeen = 0;
  let framesStrided = 0;
  let perceiveSkipped = 0;
  let perceiveBudgetSkipped = 0;
  let perceiveHotCalls = 0;
  let perceiveCalls = 0;
  try {
    for await (const frame of iterFrames) {
      framesSeen++;
      // ADAAAA-7676: drop stale content instead of deciding it late. Measured
      // against the wall clock since the stream's first frame, minus one decide
      // E2E already observed: the number that matters is the lag when the RESULT
      // lands, not the lag when the window is picked. A dropped frame is NOT
      // recorded (its image would only widen the gap); the observer advances its
      // cadence clock through the dropped content time and counts the swallowed
      // windows as `skippedStaleWindows`.
      if (lagMeasured) {
        if (streamWallStartMs === null) streamWallStartMs = Date.now() - frame.timestamp * 1000;
        const lagS = Math.max(0, (Date.now() - streamWallStartMs) / 1000 - frame.timestamp);
        if (lagBounded && lagS > lagBudgetS - lagReserveS()) {
          staleFrameDrops++;
          liveObserver!.noteStaleFrame(frame.timestamp, lagS);
          continue;
        }
        lastFrameLagMs = Math.round(lagS * 1000);
      }
      // ADAAAA-7774 / ADAAAA-7795: ingest -> analysis stride. The consume rate is
      // pinned to the analysis fps by a CREDIT ACCUMULATOR (Bresenham), not by a
      // hard floor on the frame spacing. Credit accrues at `liveContentFps` per
      // content second, one consumed frame debits 1.0, and a frame is consumed
      // when the credit reaches 1 — so the CONSUMED COUNT converges on the
      // analysis fps at ANY ingest rate faster than it. The floor this replaces
      // could not: on the deployed 3 fps ingest (a frame every ~0.333 s) a 0.5 s
      // floor alternates consume/skip/consume, i.e. 0.667 s spacing = 1.5
      // content fps, which is exactly the `framesAnalyzed` ~450 / 300 s measured
      // on the shipped build instead of ~600. A frame the credit refuses is
      // skipped entirely: not perceived (~0.36 s of blocking work saved), not
      // recorded, and not decide-seeded. The decide window only ever carries
      // ~`OBSERVE_CONTENT_FPS` frames per content second anyway
      // (assembleLiveWindow thins to it), so the payload contract is unchanged
      // while the loop stops falling behind the wall clock — which is what let
      // the lag budget drop content and swallow 56-86 of ~100 cadence windows
      // per 300 s.
      if (liveStrideS > 0) {
        if (strideCreditTs === null) {
          // First frame of the stream is always consumed (no credit to bank yet).
          strideCreditTs = frame.timestamp;
          strideCredit = 1;
        } else {
          const dt = frame.timestamp - strideCreditTs;
          if (dt > 0) {
            strideCredit = Math.min(LIVE_STRIDE_CREDIT_CAP, strideCredit + dt * liveContentFps);
            strideCreditTs = frame.timestamp;
          }
        }
        if (strideCredit < 1 - 1e-9) {
          framesStrided++;
          continue;
        }
        strideCredit -= 1;
      }
      framesAnalyzed++;
      onProgress?.(framesAnalyzed);
      run.addFrame(frame.seq, frame.timestamp, frame.imageB64);
      let res!: ObservationResult;
      let reReserved = 0;
      // Warm-up: fire exactly ONE planner call at stream start (on the first
      // sampled frame, so the plan is grounded in the feed). The per-frame
      // loop does NOT await the planner — it proceeds on the canned/safe-
      // default interim (no trackingPlan yet) and the plan applies the moment
      // it lands. Within the warm-up window the plan is applied before steady-
      // state tracking (plan §7 D).
      const planImage = run.anchor(frame.timestamp) ?? frame.imageB64;
      if (!planApplied) {
        void planController.warmUp(client, planImage).then(() => {
          planApplied = true;
        });
        // Start the out-of-band re-check cadence (sampling the rolling window,
        // off the per-frame path).
        planController.startRecheck(client, () => run.anchor(run.lastTimestamp()));
      }
      // Deliver the job's closed vocabulary (gameHint/preferLabels) on EVERY
      // /analyze (ADAAAA-4109): a fresh session — including one re-reserved
      // after a 404 session-lost — inherits the config the moment its first
      // frame runs, before resolve_vocabulary() gates the <OD> prompt.
      // The active TrackingPlan rides the same per-frame delivery so the
      // detect/seeding stays scoped to the plan's roster.
      const vocab = {
        gameHint: cfg.gameHint,
        preferLabels: cfg.preferLabels,
        loraRef: cfg.loraRef,
        trackingPlan: planController.delivery() ?? undefined,
        // ADAAAA-6489 / ADAAAA-7159 Gap 2: deliver this session's per-camera/
        // per-clip goal-line calibration (homography + goal-line spec) on every
        // /analyze so a fresh or re-reserved session inherits it and the
        // goal-line signal (goalCrossed/ballOutcome) flows into decide. Absent
        // -> perceive emits no signal (not_captured, never fabricated).
        ...(cfg.calibration?.homography ? { homography: cfg.calibration.homography } : {}),
        ...(cfg.calibration?.goalLine ? { goalLine: cfg.calibration.goalLine } : {}),
      };
      // ADAAAA-7152 Gap 1: decide whether this frame gets the expensive perceive
      // pass. In a cool (no-signal) region only every `quietStride`-th frame is
      // sent to perceive; once the Tier-2 gate escalates, the armed hot window
      // forces FULL perceive on every frame (the escalated goal window is never
      // starved). When the cadence is active and this frame is skipped, we still
      // feed it to the decide observer below with NO fabricated signal — the gate
      // treats an absent signal as recall-safe — so the decide window keeps full
      // frame coverage and the decide cadence keeps ticking.
      const perceiveTier = perceiveCadence?.tier(frame.timestamp) ?? "cool";
      const cadenceAllows = perceiveCadence ? perceiveCadence.shouldPerceive(frame.timestamp) : true;
      // ADAAAA-7774: the GPU budget can refuse a perceive the cadence allowed
      // (shared GPU: measured 1.9 s at 1 stream, 4.1 s at 2). The frame is still
      // consumed below with an EMPTY seed, so the decide window keeps its ~2 fps
      // of frames and the cadence fires on time.
      const budgetAllows = cadenceAllows ? takePerceiveBudget(frame.timestamp) : false;
      const shouldPerceive = cadenceAllows && budgetAllows;
      if (!shouldPerceive) {
        if (!cadenceAllows) perceiveSkipped++;
        else perceiveBudgetSkipped++;
      }
      let stoppedRun = false;
      if (shouldPerceive) {
        perceiveCalls++;
        if (perceiveTier === "hot") perceiveHotCalls++;
        for (;;) {
          try {
            const tPerceive = Date.now();
            // ADAAAA-7878: stamp the ingest pulse — the `[ingest-gap]` line counts
            // the analyze calls that START while a decide is in flight.
            ingestGaps.noteAnalyze(tPerceive);
            res = await client.analyze(sessionId, frame, vocab);
            // ADAAAA-7774: the stride that keeps the loop at the live edge is
            // driven by this measurement (shared-GPU perceive is the real rate
            // limit, not the ingest rate).
            perceiveCostS = (Date.now() - tPerceive) / 1000;
            perceiveCostSumS += perceiveCostS;
            perceiveCostCount++;
            break;
          } catch (err) {
            // ADAAAA-6561: the stop path released the perceive slot synchronously,
            // so the in-flight /analyze may now fail. On a stopped job do NOT
            // re-reserve a fresh session (that would re-bind a capacity-1 slot to
            // a job that is already stopping) — just exit the frame loop.
            if (slotRef?.isStopped?.()) {
              stoppedRun = true;
              break;
            }
            if (!(err instanceof SessionLostError)) throw err;
            if (reReserved >= maxReReserves) throw err;
            // ADAAAA-6577: bounded exponential backoff before re-reserving so a
            // flapping perceive runner (every /analyze 404s) doesn't get a
            // request storm — ride through a brief recovery, then still abort
            // cleanly once maxReReserves is exhausted.
            await sleep(backoffDelayMs(reReserved, sessionRetryBackoffMs, sessionRetryBackoffMaxMs));
            reReserved++;
            // ADAAAA-7203: retry the reserve within ONE re-reserve with the
            // bounded backoff, so a runner that was recreated by a staged deploy
            // (momentarily 404ing "runner not found" while it re-registers) can
            // be re-acquired and the pass resumes from the last observation. On
            // exhaustion a typed `analyze interrupted (perceive-session-lost)` verdict
            // is thrown so the job is retriable, not a bare 502.
            const fresh = await reservePerceiveWithRetry(client, {
              attempts: reReserveAttempts,
              baseMs: sessionRetryBackoffMs,
              maxMs: sessionRetryBackoffMaxMs,
            });
            sessionId = fresh.sessionId;
            reserved.add(fresh.sessionId);
            slotRef?.onReserve?.(fresh);
            // ADAAAA-7152 (Gap 2): a re-reserved session is a fresh perceive
            // session, so re-ship the job's calibration (best-effort) — otherwise
            // it would fall back to the uncalibrated no-goal channel.
            await configurePerceiveCalibration(client, sessionId, cfg.perceiveCalibration);
          }
        }
        if (stoppedRun) break;
        evidence.step(res.observation);
        onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "observation", observation: res.observation });
        // A1: cache this frame's already-computed findings (tracks/OCR/objects)
        // into the 60 s window. Reused by windowFactsText — never re-analyzed.
        run.setFindings(frame.seq, res.observation);
        // ADAAAA-7190: perceive no longer emits a `candidate` (ADAAAA-7108 set
        // cand_dict=None), so the attestation fold below (gated on res.candidate)
        // never runs and the deterministic scoreboard / goal attestation carried
        // on the per-frame OBSERVATION is dropped before the confirm gate — every
        // real goal the model saw in the frames was downgraded to near_miss for
        // lack of an independent corroboration record. Fold the observation-level
        // attestation into the window bias hints too, so scoreBoardChanged (and
        // ballOutcome / goalCrossed) reach the confirm request's corroboration
        // check. Absent attestation stays provenance-only, never a false signal.
        {
          const _o = res.observation as any;
          const _ev: PerFrameSignal | undefined = _o.evidence;
          const _att = {
            goalCrossed: _o.goalCrossed ?? _ev?.goalCrossed,
            ballOutcome: _o.ballOutcome ?? _ev?.ballOutcome,
            scoreBoardChanged: _o.scoreBoardChanged ?? _ev?.scoreBoardChanged,
            // ADAAAA-7844: the measured delta the flag is backed by (absent when
            // perceive did not measure a legible one). Wire name on the
            // observation is `scoreboardDelta`; the hint/attestation field is
            // `scoreBoardDelta`.
            scoreBoardDelta: _o.scoreboardDelta ?? (_ev as any)?.scoreboardDelta,
          };
          const _attested =
            _att.scoreBoardChanged === true ||
            _att.goalCrossed === true ||
            (typeof _att.ballOutcome === "string" && GOAL_OUTCOMES.has(_att.ballOutcome));
          if (_attested) {
            const _evType: string = _o.eventType || res.candidate?.eventType || "SPORTING_EVENT";
            observeDecider?.addHint(_evType, frame.timestamp, _att);
            liveObserver?.addHint(_evType, frame.timestamp, _att);
          }
        }
        if (res.candidate) {
          // Immediate re-plan on a candidate event (out of band from the per-frame
          // detection; never blocks the observer cadence).
          void planController.onCandidate(client, run.anchor(res.candidate.timestamp) ?? frame.imageB64);
          // Fold the candidate into the window's factual context (plan §A).
          run.addCandidate({ timestamp: res.candidate.timestamp, eventType: res.candidate.eventType });
          onEvent?.({ seq: frame.seq, timestamp: frame.timestamp, type: "candidate", candidate: res.candidate });
          // ADAAAA-7007/7008: a perceive candidate is ONLY a bias hint (per-window
          // provenance) — it NEVER gates decide. The decide-observer (ObserveDecider
          // for VOD, LiveObserver for live) drives every decide on the ~3 s cadence
          // below regardless of whether perceive emitted a candidate, so trigger-FP
          // gating no longer limits recall. Perceive is a data seeder here.
          // ADAAAA-7021 fix: the candidate's goal-attestation signals (goalCrossed /
          // ballOutcome / scoreBoardChanged) are folded into the hint so the decide
          // goal-attestation gate can attest a `scoring_play` rather than reject it.
          observeDecider?.addHint(res.candidate.eventType, res.candidate.timestamp, {
            goalCrossed: res.candidate.goalCrossed,
            ballOutcome: res.candidate.ballOutcome,
            scoreBoardChanged: res.candidate.scoreBoardChanged,
          });
          liveObserver?.addHint(res.candidate.eventType, res.candidate.timestamp, {
            goalCrossed: res.candidate.goalCrossed,
            ballOutcome: res.candidate.ballOutcome,
            scoreBoardChanged: res.candidate.scoreBoardChanged,
          });
        }
      }
      // ADAAAA-7007/7008: drive the decide-observer on cadence, feeding EVERY
      // frame's perceive-derived context (tracks / objects / ocr) as the payload
      // seed. The vision LLM is the PRIMARY observer; decide runs on the ~3 s
      // cadence REGARDLESS of candidates. maybeFire no-ops until the cadence
      // elapses (so the analyze hot path is not blocked between ticks) and the
      // live observer never decodes ahead (rolling PAST window).
      if (observeDecider || liveObserver) {
        // A skipped (cool-region) frame carries NO perceive-derived context and NO
        // signal. Empty tracks/objects/ocr + `signal: undefined` is recall-safe at
        // the gate (absent signal escalates, never starves) and never fabricates a
        // goal/ball signal the frame did not report.
        const seed: PerFrameSeed = shouldPerceive
          ? {
              ts: frame.timestamp,
              tracks: res.observation.tracks.map((t) => ({ trackId: t.trackId, label: t.label ?? t.kind, bbox: t.bbox as number[] })),
              objects: res.observation.objects,
              ocr: res.observation.ocr,
              // ADAAAA-7145: fold perceive's per-frame goal/ball signal evidence into
              // the seed so the Tier-2 signal gate can judge the window. Mark a
              // goal-line judgment (goalCrossed / ballOutcome / ballInNet present) as
              // goalInfra so an explicit non-goal frame can be suppressed; an absent
              // evidence is recall-safe (the gate escalates, never starving a goal).
              signal: seedSignalFromEvidence(res.observation.evidence),
            }
          : { ts: frame.timestamp, tracks: [], objects: [], ocr: [], signal: undefined };
        observeDecider?.record(frame.timestamp, frame.imageB64, seed, frame.seq);
        // ADAAAA-7734: the live rail's frames are on disk at the same position as
        // `frame.seq` (ffmpeg `frame_%06d.jpg`, position == seq), so stamp it and
        // the decided window's analysis refs resolve to the exact JPEG.
        liveObserver?.record(frame.timestamp, frame.imageB64, seed, frame.seq);
        // ADAAAA-7658: hand every fired audio-noise trigger to the live
        // observer so its window is anchored to the onset (one analysis per
        // trigger, coalesced inside the scheduler) instead of only blind
        // cadence. `run` carries the triggers the audio tap leg recorded.
        if (liveObserver) {
          for (const trig of run.takeAudioTriggers()) {
            liveObserver.recordTrigger(trig);
            liveObserver.addHint(`AUDIO_${trig.kind.toUpperCase()}`, trig.onsetTs);
            // ADAAAA-7774: a fired trigger arms the FULL-perceive window from
            // its onset, so the audible event's moment is judged on every
            // consumed frame (never under-sampled by the cool stride) — the same
            // escalation the Tier-2 signal path arms.
            perceiveCadence?.armHot(trig.onsetTs);
          }
        }
        if (observeDecider) await observeDecider.maybeFire(frame.timestamp);
        if (liveObserver) {
          await liveObserver.maybeFire(frame.timestamp, false, lagMeasured ? lastFrameLagMs : undefined);
          // ADAAAA-7676: one evidence line per DECIDED window — the content
          // moment, its wall lag, the decide E2E and the resulting lag, so a
          // deployed run can be measured from `docker logs highlights-server`
          // (the job's `summaryLog` gives the same windowTs-vs-wall pair).
          const fired = liveObserver.lastFiredWindow();
          if (lagMeasured && fired && fired.centerTs === frame.timestamp) {
            // ADAAAA-7771: the window is ISSUED here and settles later (content
            // order), so the E2E/completed fields show the settled sample when
            // one exists and "pending" otherwise. `inFlight` is the pipelining
            // proof: 1 = serial, up to K = the decide work is actually
            // overlapping.
            const settled = (() => {
              const s = liveObserver.lastSample();
              return s && s.centerTs === fired.centerTs ? s : null;
            })();
            console.log(
              `[live-lag:${cfg.jobId}] decide @${fired.centerTs.toFixed(2)}s lag=${(fired.lagMs / 1000).toFixed(1)}s ` +
                `e2e=${settled ? `${Math.round(settled.e2eMs)}ms` : "pending"} ` +
                `completed=${settled ? `${((settled.completedLagMs ?? settled.e2eMs) / 1000).toFixed(1)}s` : "pending"} ` +
                `inFlight=${liveObserver.inFlightDepth()} staleSkips=${liveObserver.skippedStaleWindowCount()} budget=${lagBudgetS}s`
            );
          }
        }
        // ADAAAA-7152 Gap 1: arm the full-perceive hot window when this frame
        // escalates the Tier-2 gate (the SAME predicate the decide observer uses),
        // so the goal window around it keeps FULL perceive treatment going forward.
        if (perceiveCadence) {
          // ADAAAA-7774: on the LIVE rail an ABSENT / uncalibrated signal must not
          // arm the hot window. The decide gate escalates on absence by design
          // (recall-safe), and inheriting that here armed full perceive for the
          // WHOLE run (measured: `perceiveHot=182` of 183 perceive calls at 1
          // stream), i.e. the cadence never cut anything. The cadence arms on a
          // REAL Tier-2 signal (goal crossed / ball in net / goal outcome /
          // scoreboard change / motion+audio burst / meaningful ball speed) or on
          // a trigger (`armHot` above); a seed-less frame simply carries no
          // signal into the decide window, which keeps the gate recall-safe.
          const cadenceOpts = liveObserver
            ? { ...(cfg.observeSignalGateOpts ?? {}), suppressQuietUncalibrated: true }
            : cfg.observeSignalGateOpts ?? {};
          perceiveCadence.noteFrameSignal(frame.timestamp, seed.signal, cadenceOpts);
        }
      }
    }
    // Force one final observer tick at end-of-stream so the tail of the feed is
    // still observed (no-op if nothing was recorded). ADAAAA-7676: the tail is
    // measured on the same wall clock as every other window.
    await observeDecider?.flush();
    // ADAAAA-7676: the end-of-stream tail obeys the same budget. A FORCE flush
    // ignores the cadence, so without this check the very last decided window of
    // a loaded run lands `e2e` after a tail that was already stale (measured on
    // job `4f8d47bd`: the tail, content `T+104s`, landed at wall `+146s`). Drop
    // it and count it instead — a stale tail is not worth a late decision.
    const tailTs = liveObserver?.lastRecordedTs() ?? null;
    const tailLagS =
      lagMeasured && streamWallStartMs !== null && tailTs !== null
        ? Math.max(0, (Date.now() - streamWallStartMs) / 1000 - tailTs)
        : 0;
    if (liveObserver && lagBounded && tailTs !== null && tailLagS > lagBudgetS - lagReserveS()) {
      staleFrameDrops++;
      liveObserver.noteStaleFrame(tailTs, tailLagS);
    } else {
      await liveObserver?.flush(lagMeasured ? Math.round(tailLagS * 1000) : undefined);
    }
    if (lagMeasured) {
      // ADAAAA-7808 (PO ruling on ADAAAA-7802): `skippedWindows` on the shipped
      // rail means SUPPLY skips — stale drops + admission/backpressure. The
      // throttle is a FUNDED rate decision, so it is printed as its own labelled
      // field and never folded into the supply total: the ruling must be readable
      // from the log, not derived from gaps between decided windows.
      const supplyStaleSkips = liveObserver!.skippedStaleWindowCount();
      const supplyBackpressureSkips = liveObserver!.backpressureSkipCount();
      const supplyAdmissionSkips = liveObserver!.admissionSkipCount();
      const supplySkippedWindows = supplyStaleSkips + supplyBackpressureSkips + supplyAdmissionSkips;
      console.log(
        `[live-lag:${cfg.jobId}] summary droppedFrames=${staleFrameDrops} skippedStaleWindows=${liveObserver!.skippedStaleWindowCount()} ` +
          `decides=${liveObserver!.decideCalls()} throttleSkippedWindows=${liveObserver!.throttleSkipCount()} ` +
          `supplySkippedWindows=${supplySkippedWindows} ` +
          `supplyBreakdown=stale:${supplyStaleSkips},backpressure:${supplyBackpressureSkips},admission:${supplyAdmissionSkips} ` +
          `maxLag=${(liveObserver!.maxObservedLagMs() / 1000).toFixed(1)}s budget=${lagBudgetS}s frames=${framesAnalyzed} ` +
          // ADAAAA-7774: the perceive stride. `frames` is what the pass consumed
          // (~wall x analysisFps); `framesSeen` is what the ingest delivered;
          // `perceiveCalls < frames` proves the cool-region cadence skipped
          // frames, and each skipped frame was recorded with an EMPTY seed.
          `framesSeen=${framesSeen} framesStrided=${framesStrided} perceiveCalls=${perceiveCalls} ` +
          `perceiveSkipped=${perceiveSkipped} perceiveHot=${perceiveHotCalls} analysisFps=${liveStrideS > 0 ? (1 / liveStrideS).toFixed(1) : "off"} ` +
          // ADAAAA-7774: the GPU budget. `perceiveBudget` counts consumed frames
          // the budget refused (empty seed); `perceiveUtil` is the share of the
          // wall clock the pass is allowed to spend in perceive.
          `perceiveBudget=${perceiveBudgetSkipped} perceiveUtil=${livePerceiveUtilization} ` +
          // ADAAAA-7774: the measured cost that sets the cost-aware stride — the
          // number that proves the loop is bounded by the shared GPU, not by the
          // ingest, when it exceeds `1 / analysisFps`.
          `perceiveCostMs=${perceiveCostCount ? Math.round((perceiveCostSumS / perceiveCostCount) * 1000) : 0}`
      );
    }
  } finally {
    // ADAAAA-7758: give the live decide slot back so the next live job can take
    // it (idempotent; a no-op for a VOD pass, which never held it).
    liveDecideAdmission.release(cfg.jobId);
    // ADAAAA-7771: this stream no longer shares the in-flight decide budget, so
    // the remaining live streams get their full share back (idempotent).
    liveDecideAdmission.releaseLiveJob(cfg.jobId);
    // Stop / un-pay every session we reserved this pass. Sessions the server
    // already released are a no-op on the orchestrator but still drop their
    // adapter payment refiller, so stopping them is required to avoid leaks.
    // Stop the planner's re-check timer so it cannot outlive the job.
    planController.stop();
    for (const s of reserved) {
      await client.stopPerceive(s).catch(() => {});
    }
  }
  // ADAAAA-7007/7008: the observer already awaited every cadence decide above
  // (observeOnDecide runs each decide + accept inline on the cadence), so
  // nothing further to drain before returning.
  return {
    sessionId,
    highlights,
    framesAnalyzed,
    ...(perceiveCadenceEnabled ? { perceiveCalls } : {}),
    ...(liveObserver
      ? {
          observeMetrics: buildLiveObserveMetrics(liveObserver, {
            framesSeen,
            framesAnalyzed,
            framesStrided,
            perceiveCalls,
            perceiveSkipped,
            perceiveBudgetSkipped,
            perceiveHotCalls,
            analysisFps: liveStrideS > 0 ? 1 / liveStrideS : 0,
            perceiveMeanCostMs: perceiveCostCount ? Math.round((perceiveCostSumS / perceiveCostCount) * 1000) : 0,
          }),
        }
      : {}),
    ...(observeDecider ? { vodObserveMetrics: buildVodObserveMetrics(observeDecider) } : {}),
  };
}
