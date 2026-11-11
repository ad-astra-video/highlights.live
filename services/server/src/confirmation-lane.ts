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
import type { ConfirmRecord, HighlightConfirmation, HighlightRecord, HighlightTrigger, WindowAnalysis } from "@highlights/events";

/** Which lane confirmed the window. `unconfirmed` = accepted with no stored
 *  measurement AND no dive (never a claim that the clip is wrong). */
export type ConfirmationLane = "measured" | "dive" | "dive_disagreed" | "dive_held" | "unconfirmed";

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
  // ADAAAA-8550: a held row can also be one the lane DID read with no
  // transition (`scoreReads=2, postSamples=0` on live row 4da1c317), so "read
  // nothing" contradicted the row's own stored measurement. The sentence names
  // the missing TRANSITION, which is true for both held cases.
  diveHeld: "Deep dive confirmed the goal — held: this window measured no score transition",
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
 * ADAAAA-8647: the dive verdict a SERVED row already carries on its own
 * `confirmAttestation`, as a `DiveVerdict`.
 *
 * The async Stage-2 lane writes its verdict onto the HIGHLIGHT row, and
 * `job_candidates` stores no confirm record at all (measured: `has_confirm=false`
 * on every candidate of the graded job `f02ec0bf`). A row read through
 * `confirmationForHighlightRow` therefore could not see the dive and fell through
 * to the candidate's measured attestation, so a dive-refuted row served the same
 * CONFIRMED badge as an attested one. Only a real verdict counts here: a dropped
 * dive (`goalConfirmed:"dropped"` + `dropReason`) or a passthrough produced no
 * verdict, and a stored `corroborated:true` never certifies a goal on its own
 * (it tracks frame evidence, so `near_miss` + `corroborated:true` is still a
 * dive that did not confirm).
 */
export function diveVerdictFromAttestation(
  attestation?: { goalConfirmed?: string | null; corroborated?: boolean | null } | null
): DiveVerdict | undefined {
  const goalConfirmed = attestation?.goalConfirmed;
  if (goalConfirmed !== "confirmed_goal" && goalConfirmed !== "near_miss" && goalConfirmed !== "not_goal") {
    return undefined;
  }
  return {
    goalConfirmed,
    confidence: null,
    stage1Disagreed: null,
    outcome: null,
    // ADAAAA-8647 follow-up (measured on `ec6008cd` row `f48cdbfa`): the stored
    // `corroborated` flag means "frame evidence supported SOMETHING", not "the
    // dive confirmed the goal". Two live rows carry `goalConfirmed:"near_miss"`
    // WITH `corroborated:true`, and trusting the flag alone served them lane
    // `dive` — "Confirmed by deep dive (Stage-2)" on a row whose own note says
    // "The deep dive did not confirm this goal". So a verdict certifies a goal
    // only when it IS `confirmed_goal` AND was not explicitly uncorroborated.
    corroborated: goalConfirmed === "confirmed_goal" ? attestation?.corroborated !== false : false,
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

/**
 * ADAAAA-8530: the confirmation projection a SERVED highlight / notable row
 * carries to the card. Lane + label only — the inspector half (`flags`, `dive`)
 * never leaves the decide note, exactly as `stripWindowInspection()` gates it.
 */
export function servedConfirmation(derived: WindowConfirmation | undefined): HighlightConfirmation | undefined {
  return derived ? { lane: derived.lane, label: derived.label } : undefined;
}

/**
 * ADAAAA-8530: derive the confirmation of a stored HIGHLIGHT row from its own
 * window.
 *
 * A highlight row stores `candidateId` (ADAAAA-6798), so the row's window IS a
 * decide window: when the candidate is still on the job, the derivation runs on
 * that stored candidate — literally the same input the decide note is derived
 * from (`job-detail.ts`, `confirmation: deriveConfirmation(c)`), so a card can
 * never disagree with the note above it for one window.
 *
 * A legacy row written before that link (no `candidateId`, or a job whose
 * candidate rows were trimmed) is derived from what the row itself stores —
 * `status` + `trigger`, both real recorded evidence. It never synthesizes an
 * analysis or a confirm record, so it can only reach `measured` (a stored
 * accept-gate signal) or `unconfirmed`; anything it cannot derive stays absent
 * and the card renders UNCONFIRMED rather than claiming a lane.
 */
export function confirmationForHighlightRow(
  row: Pick<HighlightRecord, "status" | "trigger"> & {
    /** ADAAAA-8542: a HELD confirmation marker on the row itself (the dive
     *  confirmed the goal, the window measured no transition). Read here so the
     *  badge distinguishes HELD from REFUTED without a second derivation. */
    provisionalGoal?: { held?: boolean; refuted?: boolean } | null;
    /** ADAAAA-8647: the row's OWN stored dive verdict (`confirmAttestation`) —
     *  the only place a live Stage-2 refutation is recorded, because the
     *  candidate rows store no confirm record. Read so a refuted row can never
     *  fall through to the candidate's `measured` lane. */
    confirmAttestation?: { goalConfirmed?: string | null; corroborated?: boolean | null } | null;
  },
  candidate?: ConfirmationInput
): HighlightConfirmation | undefined {
  // ADAAAA-8542: a held row is neither confirmed nor refuted. It wins over the
  // candidate-derived lane (which still reads `dive`, because the dive's verdict
  // really is `confirmed_goal`): the row is a notable celebration whose
  // promotion is waiting on evidence the rail never produced.
  if (row.provisionalGoal?.held === true) {
    const derived = candidate ? diveVerdict(candidate.confirm) : undefined;
    return servedConfirmation({
      lane: "dive_held",
      label: LANE_LABELS.diveHeld,
      measurement: "dive",
      ...(derived ? { dive: derived } : {}),
    });
  }
  // ADAAAA-8647: the row's OWN stored dive is the strongest evidence after HELD.
  // Same precedence `deriveConfirmation` documents for a candidate's `confirm`:
  // a verdict that did not corroborate wins over any measurement (so a refuted
  // row never reads CONFIRMED), and a corroborated verdict names lane 2.
  const rowDive = diveVerdictFromAttestation(row.confirmAttestation);
  if (rowDive && !rowDive.corroborated) {
    return servedConfirmation({
      lane: "dive_disagreed",
      label: LANE_LABELS.diveDisagreed,
      measurement: "none",
      dive: rowDive,
    });
  }
  if (rowDive) {
    return servedConfirmation({
      lane: "dive",
      label: LANE_LABELS.dive,
      measurement: "dive",
      dive: rowDive,
    });
  }
  if (candidate) return servedConfirmation(deriveConfirmation(candidate));
  // Highlight row status is pending|accepted|rejected; `pending` is not an
  // accepted row, so it maps onto the non-accepted lane and only a stored
  // measurement can give it a lane.
  const status: ConfirmationInput["status"] =
    row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : "suppressed";
  return servedConfirmation(deriveConfirmation({ status, trigger: row.trigger }));
}
