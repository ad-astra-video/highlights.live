/**
 * ADAAAA-8139 (interim step, CEO ask 2026-11-06): surface a demoted goal window
 * as a PROVISIONAL goal instead of a silent celebration.
 *
 * The problem this closes: the ADAAAA-7996 live scoring gate requires a MEASURED
 * attestation (scoreboard change / goal-line / corroborated confirm inside the
 * judged window). When the score read is sparse the gate demotes a real goal to
 * `big_play`, and the board shows the same row it would show for any celebration
 * — the customer cannot tell "a goal probably happened here" from "a big play".
 * On the graded ADAAAA-8134 leg that demotion is what lost both real goals
 * (0/2 recall) even though the ASR said the goal had gone in.
 *
 * What this module does: on the demotion seam ONLY, when a corroborating cue is
 * present (a goal call in the window's ASR transcript, a celebration in the
 * window's description, or a measured crowd/motion reaction), stamp the row with
 * a provisional marker. The row stays `big_play` — this module NEVER changes
 * `outcome` / `eventType`, so `isPostableHighlight` (which requires
 * `scoring_play`) can never make a provisional row a postable GOAL. The confirm
 * half already exists: the ADAAAA-8006/8139 deferred re-attestation upgrades the
 * SAME row to `scoring_play` when a later scoreboard read measures the
 * transition, and `attestDeferredGoalHighlight` clears this marker then.
 *
 * Cost: ZERO added calls. The ASR transcript is already produced per live window
 * by the ADAAAA-8081 side lane (and rides `decision.analysis.asr`), the frame /
 * reaction cues are already in the observation the decide ran on, and no OCR,
 * decide or perceive call is added here. This is pure bookkeeping over evidence
 * the run already paid for.
 */

import { classifyLiveWindowText } from "./live-goal-recall";

/** The cues that make a demoted window a goal CANDIDATE. Each is evidence the
 * run already had; none of them can attest a score (ADAAAA-7996 keeps that
 * rule), which is exactly why the row is provisional and not a GOAL. */
export const PROVISIONAL_GOAL_CUES = ["asr_goal_call", "frame_celebration", "crowd_reaction"] as const;
export type ProvisionalGoalCue = (typeof PROVISIONAL_GOAL_CUES)[number];

/** The marker persisted on a demoted row. Additive optional on the record: rows
 * the gate did not demote carry none, and the marker is CLEARED the moment the
 * row enters the scoring lane. */
export interface ProvisionalGoal {
  status: "provisional";
  /** Every cue that fired, ordered as {@link PROVISIONAL_GOAL_CUES}. */
  cues: ProvisionalGoalCue[];
  /** Content instant (seconds from stream start) the window was judged at. */
  declaredTs: number;
  /** Bounded, user-readable explanation: what was seen and what is still
   * missing. Stored so the board can say WHY it is provisional without replaying
   * the decide. */
  note: string;
}

/** A goal CALL in commentary. Deliberately narrow: the phrases a commentator
 * uses when the ball has gone in, never the phrases that describe the goal
 * apparatus. ASR is fallible, so this is a CUE only — it never attests. */
const ASR_GOAL_CALL_PATTERNS: readonly RegExp[] = [
  /\bgo{2,}al\b/i,
  /\b(?:it'?s|that'?s|thats|what)\s+(?:a\s+)?goal\b/i,
  /\b(?:it'?s|that'?s|thats)\s+(?:gone\s+)?in\b/i,
  /\b(?:he|she|they)\s+score[sd]?\b/i,
  /\bscored?\b[^.]{0,24}\b(?:goal|opener|equaliser|equalizer|winner)\b/i,
  /\bgoal\s+(?:for|to)\s+\w+/i,
  /\bgol(?:azo|azo!)?\b/i,
  /\bwhat\s+a\s+(?:finish|strike|goal)\b/i,
];

/** Phrases that LOOK like a goal call but describe the apparatus, a disallowed
 * goal, or a shot that was saved. A cue that fires here would put a provisional
 * GOAL on a non-goal moment, so they are subtracted before the call patterns. */
const ASR_NOT_A_GOAL_PATTERNS: readonly RegExp[] = [
  /\bgoal\s*(?:kick|kick-?off|line|post|frame|area|difference|attempt|mouth)\b/i,
  /\bno\s+goal\b/i,
  /\bgoal\s+(?:is\s+)?(?:disallowed|ruled\s+out|chalked\s+off|not\s+given)\b/i,
  /\b(?:off|wide|over|past)\s+the\s+goal\b/i,
  /\b(?:shot|header|effort)\s+(?:is\s+)?(?:saved|blocked|cleared|wide|over)\b/i,
];

/** ADAAAA-8139: does this ASR transcript carry a goal call? Flattens first so a
 * multi-line whisper output is one sentence, and subtracts the non-goal phrases
 * before testing the calls. */
export function asrCarriesGoalCall(transcript: string | undefined | null): boolean {
  if (typeof transcript !== "string") return false;
  const flat = transcript.replace(/\s+/g, " ").trim();
  if (!flat) return false;
  if (ASR_NOT_A_GOAL_PATTERNS.some((re) => re.test(flat))) return false;
  return ASR_GOAL_CALL_PATTERNS.some((re) => re.test(flat));
}

/** ADAAAA-8139: measured crowd-reaction thresholds. The crowd peak is the
 * Stage-A audio gate's normalized RMS (0..1) that already rides the candidate
 * into decide, so this adds no inference. */
export const PROVISIONAL_CROWD_ENERGY_MIN = 0.5;
/** A crowd peak only reads as a reaction when the gate classified the energy
 * change as a burst or a swell — a flat curve that happens to cross the
 * threshold is narration, not a reaction. */
const REACTION_AUDIO_KINDS: readonly string[] = ["burst", "swell"];

/** ADAAAA-8139: a celebration read from the window's own description, reusing
 * the ADAAAA-7988 classifier so the two live paths agree on what a celebration
 * looks like in model prose. */
export function descriptionReadsAsCelebration(description: string | undefined | null): boolean {
  return classifyLiveWindowText(description) === "celebration";
}

/** ADAAAA-8139: the inputs the demotion seam already has. */
export interface ProvisionalGoalInput {
  /** Content instant of the judged window (seconds from stream start). */
  windowTs: number;
  /** The window's ASR transcript (already computed by the ADAAAA-8081 lane). */
  asrTranscript?: string | null;
  /** The decide note's own description of the window (model prose). */
  description?: string | null;
  /** Stage-A crowd peak energy forwarded to decide (0..1). */
  crowdEnergy?: number;
  /** The gate's classification of that energy change ("burst" | "swell" | ""). */
  audioKind?: string;
  /** The measured scoreboard delta, when the run had one. A LEGIBLE delta means
   * the window is not provisional — the gate would have attested it. */
  scoreBoardChanged?: boolean;
}

/**
 * ADAAAA-8139: derive the provisional marker for a DEMOTED window, or undefined.
 *
 * Fail-closed rules, in order:
 *   1. a measured scoreboard change means the row was not demoted for a missing
 *      attestation — never provisional;
 *   2. no cue at all means the window is a plain celebration — not provisional;
 *   3. the cues are ordered deterministically so the stored row is stable across
 *      a re-decide of the same window.
 */
export function deriveProvisionalGoal(input: ProvisionalGoalInput): ProvisionalGoal | undefined {
  if (input.scoreBoardChanged === true) return undefined;
  if (!Number.isFinite(input.windowTs)) return undefined;
  const cues: ProvisionalGoalCue[] = [];
  if (asrCarriesGoalCall(input.asrTranscript)) cues.push("asr_goal_call");
  if (descriptionReadsAsCelebration(input.description)) cues.push("frame_celebration");
  if (
    (input.crowdEnergy ?? 0) >= PROVISIONAL_CROWD_ENERGY_MIN &&
    REACTION_AUDIO_KINDS.includes((input.audioKind ?? "").toLowerCase())
  ) {
    cues.push("crowd_reaction");
  }
  if (!cues.length) return undefined;
  return {
    status: "provisional",
    cues,
    declaredTs: Math.max(0, input.windowTs),
    note:
      `provisional goal: ${cues.join(" + ")} in the judged window, no measured ` +
      "scoreboard change yet — the row is a celebration until a later score read " +
      "measures the transition (then it becomes the confirmed GOAL).",
  };
}

/** ADAAAA-8139: the one-line suffix appended to the demoted row's reason, so a
 * reader of the reason alone knows the row is waiting on a score read. */
export function provisionalGoalReasonSuffix(marker: ProvisionalGoal): string {
  return `| ${marker.note}`;
}
