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
import type {
  ConfirmRecord,
  ConfirmationSkipReason,
  HighlightConfirmation,
  HighlightRecord,
  HighlightTrigger,
  WindowAnalysis,
} from "@highlights/events";

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
  /** ADAAAA-8721 (D3): present exactly when NO dive ran — names why the Stage-2
   *  dive was skipped, derived from already-persisted state only. This IS a card
   *  surface (unlike `flags` / `dive` below) and survives `servedConfirmation()`. */
  skipReason?: ConfirmationSkipReason;
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
  /** ADAAAA-8678: a HIGHLIGHT row's publish state (`pending` = not yet approved,
   *  auto-publish off) is not an evidence verdict, so it derives a lane exactly
   *  like an accepted row; it only changes the sentence a lane-less row states. */
  status: "accepted" | "pending" | "suppressed" | "rejected";
  eventType?: string;
  outcome?: string;
  trigger?: HighlightTrigger;
  analysis?: WindowAnalysis;
  confirm?: ConfirmRecord;
  /** ADAAAA-8721 (D3): the deployment gate the ACCEPT path actually read
   *  (`cfg.confirmEnabled`, i.e. `decideConfirmEnabled` on VOD and
   *  `decideConfirmEnabled && liveDecideConfirm` on the live rail). Only used to
   *  name a skip reason when no dive ran; never to change the derived lane.
   *  `undefined` = the reader had no config at hand, so a skip reason is omitted
   *  rather than guessed. */
  confirmEnabled?: boolean;
  /** ADAAAA-8721 (D3): the row's OWN stored drop cause
   *  (`confirmAttestation.dropReason`), the only persisted record that a dive was
   *  requested and dropped fail-closed. */
  droppedReason?: string;
  /** ADAAAA-8894 (D4): the row carries a MEASURED attestation AND a D4 dive ran on
   *  it (`confirmAttestation.laneKeptByMeasurement`). The dive may not move the
   *  lane, so the measurement wins over the dive verdict. Absent on every row
   *  written before D4 — those keep the D3 precedence byte-identically. */
  measuredLaneKept?: boolean;
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
  // ADAAAA-8678: an unapproved (`pending`) row states the approve queue, never
  // "accepted" — that word is a claim only a settled row supports. Deliberately
  // ONE sentence: the only way to reach this lane is "no dive is recorded", and
  // the row may still store accept-lane evidence (`attestationUsed`) this
  // derivation does not read, so the sentence must not claim "no measurement".
  pending: "Awaiting approval — no confirming dive recorded for this window",
  // ADAAAA-8965 (D4-live): the three no-verdict card states. Each sentence names
  // the ROW's own state, never an evidence claim, so a card that carries no dive
  // verdict reads as "there is no card/verdict here" instead of as UNCONFIRMED
  // silence. See `noVerdictConfirmation()`.
  notPromoted: "Not promoted — this window carried no highlight, so no dive verdict exists for it",
  mergedDuplicate: "Merged into another moment — deduped into that card's footage",
  alternativeNotHighlight: "Served as an alternative of its moment, not as a highlight card",
} as const;

/** ADAAAA-8965 (D4-live): the reason a SERVED row carries no verdict.
 *
 *  D4 makes every promoted row dive, so the only rows left without a verdict are
 *  rows that never became a card, were deduped into another moment, or are served
 *  as that moment's alternative. Each is a real state the served payload can
 *  contain; publishing `unconfirmed` + this reason on it keeps the AC4.1 bar
 *  ("no served card with neither a verdict nor a skip reason") measurable without
 *  ever inventing a lane or a dive for a row that has none. */
export type NoVerdictReason = "not_promoted" | "merged_duplicate" | "alternative_not_highlight";

export function noVerdictConfirmation(reason: NoVerdictReason): HighlightConfirmation {
  const label =
    reason === "merged_duplicate"
      ? LANE_LABELS.mergedDuplicate
      : reason === "alternative_not_highlight"
        ? LANE_LABELS.alternativeNotHighlight
        : LANE_LABELS.notPromoted;
  return { lane: "unconfirmed", label, skipReason: reason };
}

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
 * ADAAAA-8721 (D3): WHY no Stage-2 dive ran, from persisted state only.
 *
 * Precedence (and why):
 *   1. a stored drop cause wins — a dive WAS requested and dropped fail-closed,
 *      and that is the most specific true statement about the window;
 *   2. the lane disabled in config (`cfg.confirmEnabled === false`) — no dive
 *      could have run for ANY window on this deployment;
 *   3. the window's own measured attestation — `shouldRunConfirm()` short-circuits
 *      on it, so the dive was deliberately skipped;
 *   4. otherwise the read was not goal-shaped (a requested near-miss / big-play
 *      highlight, or a true non-goal read never enters the dive);
 *   5. `confirmEnabled` unknown → omit. A reader with no config at hand cannot
 *      distinguish `dive_disabled` from `not_goal_shaped`, and naming the wrong
 *      one would be an invented reason.
 */
function skipReasonFor(
  input: ConfirmationInput,
  measurement: ConfirmationMeasurement | undefined
): ConfirmationSkipReason | undefined {
  const dropped = typeof input.droppedReason === "string" ? input.droppedReason.trim() : "";
  if (dropped) {
    const cause = dropped.split(":")[0];
    // ADAAAA-8894 (D4, Ruling B): `density_cap` is a BARE enum entry, not a
    // `dropped:` cause. It is an admission bound the contract owns (the live
    // 48-dives/stream-hour guard), not a fail-closed dive drop, so it is served
    // under its own name — a card answering "the cap withheld this dive" must not
    // read as a transport/busy failure.
    return cause === "density_cap" ? "density_cap" : `dropped:${cause}`;
  }
  if (input.confirmEnabled === false) return "dive_disabled";
  if (measurement && measurement !== "none") return "measured_attestation";
  if (input.confirmEnabled === undefined) return undefined;
  return "not_goal_shaped";
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
 *   4b. ADAAAA-8678: a `pending` (unapproved) row with no dive → `unconfirmed`
 *      too, worded as the approve queue ("Awaiting approval — …"), so an
 *      auto-publish-off card states its lane instead of serving no block at all.
 *   5. a rejected/suppressed row with no dive → no block at all (the row is
 *      already rendered as rejected/suppressed; a lane label would be noise).
 */
export function deriveConfirmation(input: ConfirmationInput): WindowConfirmation | undefined {
  const stage1 = criteriaFlags(input.analysis);
  const diveFlags = diveEvidenceFlags(input.confirm);
  const dive = diveVerdict(input.confirm);
  const measured = measuredMeasurement(input, stage1);

  /** The lane-1 arm. `withSkipReason=false` is the ADAAAA-8894 (D4) shape: a dive
   *  DID run on this measured row, so the card must not claim a skip — the row's
   *  own `confirmAttestation` is the answer, and the measurement is the lane. */
  const measuredArm = (withSkipReason: boolean): WindowConfirmation => {
    const value = measured as ConfirmationMeasurement;
    const detail = value === "score" ? scoreTransitionDetail(input.analysis) : undefined;
    const label =
      value === "goal_line"
        ? "Confirmed by goal line: ball crossed the line between posts"
        : value === "ball_in_net"
          ? "Confirmed by ball in net"
          : value === "ball_outcome"
            ? "Confirmed by measured ball outcome: goal"
            : detail
              ? `Confirmed by measured score: ${detail}`
              : "Confirmed by measured score change";
    const skipReason = withSkipReason ? skipReasonFor(input, value) : undefined;
    return {
      lane: "measured",
      label,
      measurement: value,
      ...(detail ? { detail } : {}),
      ...(skipReason ? { skipReason } : {}),
      flags: stage1,
      flagsSource: stage1 ? "stage1_verdict" : input.trigger ? "trigger" : undefined,
    };
  };

  // ADAAAA-8894 (D4): THE PRECISION GUARD, read side. D4 dives a row that already
  // measured its own goal; the dive may add the moment but may NOT move the lane,
  // so the measurement wins over the dive verdict on a flagged row (`AC4.2`: 0
  // measured rows change lane). The flag is written only by the two adoption
  // writers, so every pre-D4 row keeps the D3 precedence below byte-identically —
  // including the AC2 rule that a dive which DEMOTED a row still reads
  // `dive_disagreed` (a demoted row carries no flag, because the guard is what
  // stops D4 demoting one).
  if (measured && input.measuredLaneKept === true) return measuredArm(Boolean(input.droppedReason));

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

  if (measured) return measuredArm(true);

  // ADAAAA-8678: a `pending` row is NOT a non-accepted row in the reject sense —
  // it is a served card waiting for the operator's Approve, so it states its lane
  // instead of hiding it. It never uses the "Accepted …" sentences above: that
  // word is a claim only a settled row supports.
  if (input.status === "rejected" || input.status === "suppressed") return undefined;

  const hasCapture = Boolean(input.analysis || input.trigger);
  const skipReason = skipReasonFor(input, undefined);
  if (input.status === "pending") {
    return {
      lane: "unconfirmed",
      label: LANE_LABELS.pending,
      measurement: "none",
      ...(skipReason ? { skipReason } : {}),
      flags: stage1,
      flagsSource: stage1 ? "stage1_verdict" : undefined,
    };
  }
  return {
    lane: "unconfirmed",
    label: hasCapture ? LANE_LABELS.noMeasurementNoDive : LANE_LABELS.legacy,
    measurement: "none",
    ...(skipReason ? { skipReason } : {}),
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
  return derived
    ? { lane: derived.lane, label: derived.label, ...(derived.skipReason ? { skipReason: derived.skipReason } : {}) }
    : undefined;
}

/**
 * ADAAAA-8645: the card BADGE rule, server-side — the one predicate the webapp's
 * `confirmationBadge` implements (`measured` / `dive` are CONFIRMED; `dive_held`
 * is HELD; `dive_disagreed` / `unconfirmed` are UNCONFIRMED).
 *
 * The MATCH SUMMARY counts corroboration on the same page, so it must not carry
 * its own opinion: a row counts as corroborated exactly when its card's badge
 * says CONFIRMED. `dive_held` deliberately does NOT count — the dive confirmed
 * the goal but the window measured nothing, and the badge says HELD, not
 * CONFIRMED.
 */
export function laneConfirmsGoal(lane?: ConfirmationLane | null): boolean {
  return lane === "measured" || lane === "dive";
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
    confirmAttestation?: {
      goalConfirmed?: string | null;
      corroborated?: boolean | null;
      /** ADAAAA-8721 (D3): the stored fail-closed drop cause — proof a dive was
       *  requested and did not run. Includes the D4 `density_cap` admission bound. */
      dropReason?: string | null;
      /** ADAAAA-8894 (D4): a dive ran on a row that already MEASURED its goal, so
       *  the measurement keeps the lane. */
      laneKeptByMeasurement?: boolean | null;
      /** ADAAAA-8820 (D2): the content instant the dive named — carried on stored
       *  rows (both writers stamp it) and read by the clip re-anchor, never by the
       *  lane derivation. Declared so a row is typeable as what it stores. */
      momentTs?: number | null;
    } | null;
  },
  candidate?: ConfirmationInput,
  /** ADAAAA-8721 (D3): the deployment gate the accept path read, so a lane-less
   *  card can name `dive_disabled` instead of guessing. Omitted = unknown.
   *
   *  ADAAAA-8965 (D4-live): `cardKind` names the rail a row is served on when
   *  that rail is not a highlight/notable card (a merged duplicate, or a moment's
   *  alternative). A row served there carries no verdict by construction, so the
   *  card states its reason instead of shipping no `confirmation` block at all. */
  options?: { confirmEnabled?: boolean; cardKind?: NoVerdictReason }
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
  //
  // ADAAAA-8894 (D4): EXCEPT on a row D4 dived while it already carried a MEASURED
  // attestation (`laneKeptByMeasurement`). There the measurement IS the lane and
  // the dive's verdict is a second opinion the row records — the precision guard
  // forbids `measured -> dive` and `measured -> dive_disagreed`, which is exactly
  // what AC4.2 measures. A row that did NOT measure (or a pre-D4 row, where the
  // flag is absent) keeps the precedence below unchanged.
  const measuredLaneKept = row.confirmAttestation?.laneKeptByMeasurement === true;
  if (measuredLaneKept) {
    const status: ConfirmationInput["status"] =
      row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : row.status === "pending" ? "pending" : "suppressed";
    const input = withSkipInput(candidate ?? { status, trigger: row.trigger }, row, options);
    const derived = deriveConfirmation({ ...input, measuredLaneKept: true });
    const served = servedConfirmation(derived);
    if (served?.lane === "measured") return served;
  }
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
  if (candidate) {
    const derived = servedConfirmation(deriveConfirmation(withSkipInput(candidate, row, options)));
    // ADAAAA-8965 (D4-live): a rejected/suppressed card derives no lane. It still
    // answers "why is there no verdict?" with its rail's own reason (a highlight
    // card that was never promoted), never with silence.
    return derived ?? noVerdictConfirmation(options?.cardKind ?? "not_promoted");
  }
  // ADAAAA-8678: highlight row status is pending|accepted|rejected and `pending`
  // is a PUBLISH state (auto-publish off), not a rejection: it derives its lane
  // like an accepted row, so a served GOAL card never carries an evidence-free
  // claim with no lane at all. A row with no measurement and no dive states the
  // approve queue ("Awaiting approval — …") and badges UNCONFIRMED.
  const status: ConfirmationInput["status"] =
    row.status === "accepted" ? "accepted" : row.status === "rejected" ? "rejected" : row.status === "pending" ? "pending" : "suppressed";
  const derived = servedConfirmation(deriveConfirmation(withSkipInput({ status, trigger: row.trigger }, row, options)));
  // ADAAAA-8965 (D4-live): same rule for a row with no linked candidate.
  return derived ?? noVerdictConfirmation(options?.cardKind ?? "not_promoted");
}

/** ADAAAA-8721 (D3): fold the persisted skip evidence (the row's stored drop
 *  cause + the deployment gate) into the derivation input without overriding
 *  anything the caller already set explicitly. */
function withSkipInput(
  input: ConfirmationInput,
  row: { confirmAttestation?: { dropReason?: string | null } | null },
  options?: { confirmEnabled?: boolean }
): ConfirmationInput {
  const droppedReason = row.confirmAttestation?.dropReason ?? undefined;
  return {
    ...input,
    ...(droppedReason ? { droppedReason } : {}),
    ...(options?.confirmEnabled !== undefined && input.confirmEnabled === undefined
      ? { confirmEnabled: options.confirmEnabled }
      : {}),
  };
}
