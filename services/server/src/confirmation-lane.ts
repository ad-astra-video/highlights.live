/**
 * ADAAAA-8287: WHICH acceptance lane confirmed a decide window.
 *
 * A VOD highlight is accepted by one of two lanes, and only one of them leaves
 * a visible artefact:
 *
 *   lane 1 — measured attestation inside the judged window (goal-line crossing,
 *            ball-in-net, scoreboard transition, ball-outcome=goal). This is the
 *            primary lane. `shouldRunConfirm()` in `analyzer.ts` short-circuits
 *            on `hasIndependentAttestation()`, so an attested goal never runs the
 *            Stage-2 dive and therefore stores NO confirm record.
 *   lane 2 — the Stage-2 deep dive (`/confirm`), the fallback for a goal-shaped
 *            read with no measurement to lean on. Only this lane writes a
 *            `confirm` block, and only that block renders a confirm panel.
 *
 * Read side only: the lane is DERIVED from what the candidate already stores —
 * `status`, `trigger` (the accept-gate signal), `analysis.response` (the Stage-1
 * verdict + its measured criteria) and `confirm.decision` (the dive verdict).
 * No decide call, no inference, no GPU, no Livepeer spend, and nothing is
 * persisted or mutated, so a row written before the captures existed derives
 * `unconfirmed` ("lane not recorded") instead of inventing a lane.
 */
import type { ConfirmRecord, HighlightTrigger, WindowAnalysis } from "@highlights/events";

/** Which lane confirmed the window. `unconfirmed` = accepted with no stored
 *  measurement AND no dive (never a claim that the clip is wrong). */
export type ConfirmationLane = "measured" | "dive" | "dive_disagreed" | "unconfirmed";

/** The measurement a lane-1 label names (strongest channel first, the same
 *  order `frameLocalizationScore()` ranks them). */
export type ConfirmationMeasurement = "goal_line" | "ball_in_net" | "score" | "ball_outcome" | "dive" | "none";

/** The four goal criteria the decide layer asks the model to verify. `null`
 *  means the wire carried `null` — unverifiable for that window — and
 *  `undefined` means the field was not reported at all. */
export interface AttestationFlags {
  scoreboardChanged: boolean | null;
  ballCrossedLineBetweenPosts: boolean | null;
  ballInNet: boolean | null;
  crowdErupted: boolean | null;
}

/** Where the flags on a derived confirmation came from. */
export type AttestationSource = "stage1_verdict" | "dive_evidence" | "trigger";

/** The Stage-2 dive verdict, compacted for the inspector. */
export interface DiveVerdict {
  goalConfirmed: "confirmed_goal" | "near_miss" | "not_goal" | null;
  confidence: number | null;
  stage1Disagreed: boolean | null;
  outcome: string | null;
  corroborated: boolean;
}

/** The row-level confirmation projection attached to a decide note. */
export interface WindowConfirmation {
  lane: ConfirmationLane;
  /** The row-body sentence: exactly one lane, stated in words. */
  label: string;
  measurement: ConfirmationMeasurement;
  /** The measured detail the label cites when the store carries one
   *  (e.g. "0-0 → 0-1 at 04:47"). Never synthesized. */
  detail?: string;
  // The inspector half (`?inspect=1` / `/sections/:index/inspect`): the raw
  // stored attestation + the dive verdict. Stripped from the row-level payload by
  // `stripWindowInspection()` exactly like `analysis` / `confirm`.
  flags?: AttestationFlags;
  flagsSource?: AttestationSource;
  dive?: DiveVerdict;
}

/** The candidate fields the derivation reads (a stored JobCandidate satisfies
 *  this shape; tests can pass a literal). */
export interface ConfirmationInput {
  status: "accepted" | "suppressed" | "rejected";
  eventType?: string;
  outcome?: string;
  trigger?: HighlightTrigger;
  analysis?: WindowAnalysis;
  confirm?: ConfirmRecord;
}

const LANE_LABELS = {
  dive: "Confirmed by deep dive (Stage-2)",
  diveDisagreed: "dive did not corroborate",
  noMeasurementNoDive: "Accepted without corroboration — no measurement and no dive",
  legacy: "Accepted — confirmation lane not recorded (legacy row)",
} as const;

/** Read the Stage-1 verdict's measured criteria (`verdict.criteria`) out of a
 *  captured analysis. Absent/legacy captures yield `undefined`. */
function criteriaFlags(analysis?: WindowAnalysis): AttestationFlags | undefined {
  const raw = analysis?.response?.verdict;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const criteria = (raw as { criteria?: unknown }).criteria;
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria)) return undefined;
  const c = criteria as Record<string, unknown>;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    scoreboardChanged: bool(c.scoreboardChanged),
    ballCrossedLineBetweenPosts: bool(c.ballCrossedLineBetweenPosts),
    ballInNet: bool(c.ballInNet),
    crowdErupted: bool(c.crowdErupted),
  };
}

/** Map the dive verdict's own evidence block onto the same four flags
 *  (`ballTrajectoryCrossedLine` / `audioErupted` are the dive's names for
 *  two of them). Absent when the dive stored no evidence object. */
function diveEvidenceFlags(confirm?: ConfirmRecord): AttestationFlags | undefined {
  const ev = confirm?.decision?.evidence;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return undefined;
  const e = ev as Record<string, unknown>;
  const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  return {
    scoreboardChanged: flag(e.scoreboardChanged),
    ballCrossedLineBetweenPosts: flag(e.ballTrajectoryCrossedLine),
    ballInNet: flag(e.ballInNet),
    crowdErupted: flag(e.audioErupted),
  };
}

/** The single strongest measurement the accept gate read (`trigger` signals, in
 *  the same precedence the localization score uses), or undefined when the
 *  candidate carries no attestation signal. */
function triggerMeasurement(trigger?: HighlightTrigger): ConfirmationMeasurement | undefined {
  if (!trigger) return undefined;
  if (trigger.goalCrossed === true) return "goal_line";
  if (typeof trigger.ballOutcome === "string" && /^goal$/i.test(trigger.ballOutcome.trim())) return "ball_outcome";
  if (trigger.scoreBoardChanged === true) return "score";
  return undefined;
}

/** The same predicate the accept path uses to SKIP the Stage-2 dive
 *  (`hasIndependentAttestation`), plus the Stage-1 measured criteria so a row
 *  whose `trigger` was never persisted still reads as attested. */
function measuredMeasurement(input: ConfirmationInput, flags?: AttestationFlags): ConfirmationMeasurement | undefined {
  const fromTrigger = triggerMeasurement(input.trigger);
  if (fromTrigger) return fromTrigger;
  if (flags?.ballCrossedLineBetweenPosts === true) return "goal_line";
  if (flags?.ballInNet === true) return "ball_in_net";
  if (flags?.scoreboardChanged === true) return "score";
  return undefined;
}

/** Parse the measured score transition the model cited from the stored strings
 *  ("Scoreboard change 0-0 to 0-1 at 04:47"). Returns the detail only — the
 *  caller owns the sentence. Never synthesizes a transition. */
export function scoreTransitionDetail(analysis?: WindowAnalysis): string | undefined {
  const r = analysis?.response;
  if (!r) return undefined;
  const candidates: string[] = [];
  for (const attested of r.evidenceAttested ?? []) if (typeof attested === "string") candidates.push(attested);
  if (typeof r.reason === "string") candidates.push(r.reason);
  if (typeof r.reasoning === "string") candidates.push(r.reasoning);
  const verdict = r.verdict as { independentlyObserved?: unknown } | undefined;
  if (verdict && typeof verdict.independentlyObserved === "string") candidates.push(verdict.independentlyObserved);
  for (const text of candidates) {
    // "Scoreboard change 0-0 to 0-1 at 04:47" / "scoreboard changes from 0-0 to
    // 0-1" / "0-0 → 0-1" — the three shapes the decide prose actually uses.
    const m = /scoreboard\s+(?:score\s+)?(?:changes?|change)\s+(?:from\s+)?([0-9]+\s*-\s*[0-9]+)\s*(?:->|to|→)\s*([0-9]+\s*-\s*[0-9]+)(?:\s+at\s+([0-9][0-9:.]*))?/i.exec(
      text
    );
    if (!m) continue;
    const [, from, to, at] = m;
    const norm = (s: string) => s.replace(/\s*-\s*/g, "-");
    return `${norm(from)} → ${norm(to)}${at ? ` at ${at}` : ""}`;
  }
  return undefined;
}

/** The dive verdict compacted for the inspector, and whether it corroborated. */
export function diveVerdict(confirm?: ConfirmRecord): DiveVerdict | undefined {
  if (!confirm) return undefined;
  const d = confirm.decision ?? {};
  const goalConfirmed = d.goalConfirmed ?? null;
  const outcome = d.outcome ?? null;
  const corroborated =
    goalConfirmed === "confirmed_goal"
      ? true
      : goalConfirmed === "near_miss" || goalConfirmed === "not_goal"
        ? false
        : outcome === "scoring_play";
  return {
    goalConfirmed,
    confidence: d.confidence ?? null,
    stage1Disagreed: d.stage1Disagreed ?? null,
    outcome,
    corroborated,
  };
}

/**
 * Derive the confirmation lane for one stored candidate.
 *
 * Precedence (and why):
 *   1. a stored dive that did NOT corroborate → `dive_disagreed` ("dive did not
 *      corroborate"). It must win over any measurement so a demoted row can never
 *      read as lane 1 (AC2) — a disagreeing dive demotes the row to near_miss.
 *   2. a stored dive that corroborated → `dive` (lane 2).
 *   3. no dive + a measured attestation → `measured` (lane 1), naming the
 *      strongest measurement that fired.
 *   4. accepted with neither → `unconfirmed`; the label says which of the two
 *      honest cases it is (no measurement at all vs a legacy row with no
 *      captures) and never claims corroboration.
 *   5. a non-accepted row with no dive → no block at all (the row is already
 *      rendered as rejected/suppressed; a lane label would be noise).
 */
export function deriveConfirmation(input: ConfirmationInput): WindowConfirmation | undefined {
  const stage1 = criteriaFlags(input.analysis);
  const diveFlags = diveEvidenceFlags(input.confirm);
  const dive = diveVerdict(input.confirm);

  if (dive && !dive.corroborated) {
    return {
      lane: "dive_disagreed",
      label: LANE_LABELS.diveDisagreed,
      measurement: "none",
      flags: diveFlags ?? stage1,
      flagsSource: diveFlags ? "dive_evidence" : stage1 ? "stage1_verdict" : undefined,
      dive,
    };
  }

  if (dive) {
    return {
      lane: "dive",
      label: LANE_LABELS.dive,
      measurement: "dive",
      flags: diveFlags ?? stage1,
      flagsSource: diveFlags ? "dive_evidence" : stage1 ? "stage1_verdict" : undefined,
      dive,
    };
  }

  const measured = measuredMeasurement(input, stage1);
  if (measured) {
    const detail = measured === "score" ? scoreTransitionDetail(input.analysis) : undefined;
    const label =
      measured === "goal_line"
        ? "Confirmed by goal line: ball crossed the line between posts"
        : measured === "ball_in_net"
          ? "Confirmed by ball in net"
          : measured === "ball_outcome"
            ? "Confirmed by measured ball outcome: goal"
            : detail
              ? `Confirmed by measured score: ${detail}`
              : "Confirmed by measured score change";
    return {
      lane: "measured",
      label,
      measurement: measured,
      ...(detail ? { detail } : {}),
      flags: stage1,
      flagsSource: stage1 ? "stage1_verdict" : input.trigger ? "trigger" : undefined,
    };
  }

  if (input.status !== "accepted") return undefined;

  const hasCapture = Boolean(input.analysis || input.trigger);
  return {
    lane: "unconfirmed",
    label: hasCapture ? LANE_LABELS.noMeasurementNoDive : LANE_LABELS.legacy,
    measurement: "none",
    flags: stage1,
    flagsSource: stage1 ? "stage1_verdict" : undefined,
  };
}
