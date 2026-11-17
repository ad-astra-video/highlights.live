// ADAAAA-8668 (spec ADAAAA-8665 §3): the SERVER side of the `summary` copy lane.
//
// The card's headline (`postTitle`, ADAAAA-8318) and announcer line (`caption`,
// ADAAAA-7933) both stay exactly as ratified. This lane adds BODY copy beside
// them: one text-only inference per PROMOTED highlight, run AFTER promotion and
// off the decide loop, so the live detect path gains zero latency (AC4) and the
// card is servable on `postTitle` before the copy lands.
//
// Bounds are enforced HERE, not by convention:
//  - the call is issued only after the row is readable (never at decide time, and
//    never awaited by the promotion path);
//  - ONE inference per promoted row, at most ONE retry (AC5), then drop-and-serve;
//  - the lane is serialized to one in-flight call per job and holds a small
//    pending ring: a row that finds the lane busy waits, and a row that finds the
//    ring full is dropped `pool_busy` — the lane never queues a storm behind
//    decide (the decide pool is the priority lane, this one is lowest);
//  - the reply is gated by `gateSummaryDetail` from `@highlights/events`, the ONE
//    summary contract (depth bands, clamp, grounding reuse, caption overlap);
//    a DETERMINISTIC refusal ends the row on one call and only the AC8 repeat
//    path may spend a second one (AC5 / spec §13.2);
//  - a drop writes ONLY the meter (`summaryDropped`, `summaryDroppedByReason`)
//    and never a `summary` value, so a failed generation can never blank the card
//    or emit a placeholder (AC6);
//  - every row carries its own meter (`summaryCalls`, `summaryDropped`,
//    `summaryDroppedByReason`, `summaryP95Ms`), which is what QA reads.
import {
  SUMMARY_CALL_TIMEOUT_MS,
  SUMMARY_DETERMINISTIC_REFUSALS,
  SUMMARY_FEE_RATIO,
  SUMMARY_MAX_CALLS_PER_ROW,
  SUMMARY_MIN_FACT_KINDS,
  attestedFactKinds,
  attestedMatchClockToken,
  bodyNamesAttestedActor,
  clockTokensOf,
  summaryRefusalDetail,
  summaryRefusalIsRepairable,
  SUMMARY_RAW_MAX_CHARS,
  buildSummaryPrompt,
  gateSummaryDetail,
  resolveSummaryFee,
  repeatedSentences,
  pruneRepeatedSentences,
  summaryBand,
  sentenceSimilarity,
  summaryOpeningRun,
  summarySentencesOf,
  summaryFactMenu,
  type SummaryDropReason,
  type SummaryEvidence,
  type SummaryRail,
  type SummaryRetryDirective,
  attestedActorNames,
  summarySpentActPairs,
  summarySpentOpenings,
} from "@highlights/events";

/** ADAAAA-9031 (AC5 / spec §13.2): why a row took a SECOND summary call, or — since
 *  ADAAAA-9120 — which repair a ONE-call repeat row ran. The contract permits a
 *  second call only on the AC14 filler-clause regeneration; the AC8 repeat refusal
 *  is deterministic and now ends on its first call (the clause drop is free).
 *  Recording it on the row is what makes the meter auditable: the rev-10 VOD leg
 *  billed 11 second calls and 3 served rows carried no reason. */
export type SummaryRetryReason =
  | "repeat-opening"
  | "repeat-sentence"
  | "filler-repair";

/** The subset of the store this lane needs (narrow on purpose: the lane must not
 *  be able to touch a verdict, a clip or a price field). */
export interface SummaryLaneStore {
  patchHighlightSummary(
    id: string,
    patch: {
      summary?: string;
      summaryGate?: string;
      summaryRaw?: string;
      summaryCaptionOverlap?: number;
      summaryCalls?: number;
      summaryDropped?: number;
      summaryDroppedByReason?: Record<string, number>;
      summaryP95Ms?: number;
      /** ADAAAA-8903 (§15.4): the refusal detail (violations + the judged word
       *  count beside the band) a `dropped:*` row persists. */
      summaryViolations?: string[];
      summaryWordCount?: number;
      summaryFloorWords?: number;
      summaryTargetMinWords?: number;
      summaryDroppedSentences?: number;
      /** ADAAAA-8914 (AC14.5): what the filler clause repair deleted. */
      summaryDroppedClauses?: number;
      summaryClauseClaims?: string[];
      summaryRepairedWords?: number;
      /** ADAAAA-9031: the reason a second call was billed (AC5 §13.2). */
      summaryRetryReason?: string;
      /** ADAAAA-9177 (AC1/lever 3): the prompt's avoid block as rendered, persisted
       *  on the row so "did `avoidOpenings`/`avoidActs` reach the writer" is a row
       *  read. */
      summaryPromptAvoid?: { openings: string[]; acts: string[] };
    }
  ): Promise<unknown>;
}

/** One promoted highlight waiting for (or holding) its summary call. */
export interface SummaryRowDescriptor {
  jobId: string;
  highlightId: string;
  /** The row's own evidence — see `SummaryEvidence` in `@highlights/events`. */
  evidence: SummaryEvidence;
}

/**
 * AC8 (rev 3): the state the opening guard needs, scoped to ONE JOB.
 *
 * The set holds every normalized opening run already SERVED in this job — the
 * scope is the job, not the row, because the defect is two cards on the same
 * video opening the same way. Two different jobs may legitimately reuse an
 * opening; the lane owns one instance per job (`SummaryLane`), so that scope is
 * structural, not a convention a caller can forget.
 */
export interface SummaryJobState {
  servedOpenings: Set<string>;
  /** ADAAAA-8914 (AC14.3): every SENTENCE already served in this job. AC8 only
   *  compares the first four words, so the rev-7 live bodies repeated a whole
   *  sentence template in sentence 2 (0.965-0.982 pairwise similarity) and all
   *  three served. The job is the scope for the same reason it is the scope for
   *  openings: the defect is two CARDS on one video. Kept for the PROMPT-first
   *  avoidance (`avoidSentences`) only — ADAAAA-8969 moved the DROP decision onto
   *  `servedBodies` because job-wide sentence equality also refuses honest cards. */
  servedSentences: string[];
  /** ADAAAA-9121 (writer round 3): the actor-and-act PAIRS this job has already
   *  served (`summarySpentActPairs`), handed to the prompt as `avoidActs`. On a
   *  `clock` + `action` row an act pair IS a sentence's whole substance, so without
   *  this state every card picks the same pair: job `1e0d7187` served 2 of 7 rows
   *  and all 5 `repeat-*` rows re-used one substance sentence that the AC14 prune
   *  then deleted. Prompt state only — the gate and the repeat key are unchanged. */
  servedActs: string[];
  /** ADAAAA-8969 (increment 2, defect 3): the bodies this job actually SERVED,
   *  with the instants that tell one promotion from another. The repeat key reads
   *  these, so "another promotion from the same prompt template" (a shared opening
   *  run, one shared sentence) is no longer a repeat: the measured live leg
   *  dropped 16/19 promotions that way and could not fill a 10-card deck. */
  servedBodies: SummaryServedBody[];
}

/** One body a job served, as the repeat key reads it. */
export interface SummaryServedBody {
  highlightId: string;
  windowTs: number | null;
  windowDurationS: number | null;
  /** The row's attested match clock, else the first clock token its body prints. */
  clockToken: string | null;
  body: string;
  opening: string | null;
}

/** ADAAAA-8941 (integration repair): the repeat key's two CONTRACT bars — the
 *  bars spec rev 16 grades, neither of which takes an instant exception:
 *
 *  - **AC8**: no two served bodies in one job share a normalized 4-word opening
 *    run. A candidate that repeats a served opening is repaired on its FIRST call
 *    (the repeated clause is dropped, ADAAAA-9120); a body with no admissible
 *    clause repair drops with `summaryDroppedByReason: {repeat: 1}`.
 *  - **AC14**: no two served bodies in one job share a normalized sentence at
 *    >= 0.80 similarity (the template detector, `repeatedSentences`).
 *
 *  A shared opening or sentence is graded on the COPY, not on whether the two
 *  rows happen to sit on different windows: the defect AC8 exists to stop is
 *  "every card opens the same way", and two instants with the same opening are
 *  still two cards that read the same. */
export type SummaryRepeatKey = "opening" | "sentence";

export interface SummaryRepeatVerdict {
  /** null => this body is a DISTINCT promotion and must serve. */
  key: SummaryRepeatKey | null;
  against: string | null;
  bodySimilarity: number;
  windowOverlapS: number | null;
  sameClock: boolean;
  openingRepeat: boolean;
  sentence: { a: string; b: string; similarity: number } | null;
  /** ADAAAA-9031 (AC14.3): EVERY candidate sentence at or above the bar against
   *  a served body. AC14's repair order is "regenerate once, then drop the
   *  offending clause" — the lane needs the full list to drop them, not only the
   *  closest pair. */
  repeatedSentences: string[];
}

/**
 * ADAAAA-8941 (integration repair): the repeat key, on the CONTRACT's scope.
 *
 * ADAAAA-8969 increment 2 scoped this key to "the same promotion" so a shared
 * opening or sentence on a different window would serve. That answers the deck
 * shortfall by dropping the AC8/AC14 bars — the spec grades both on the served
 * COPY within one job, with no instant exception (§4, rev 16). It also did not
 * buy the coverage it claimed: the integrated lens (increment 1's attested-fact
 * gate first) refuses every one of those template bodies anyway, so the stored
 * rows serve 0 with either key. The deck shortfall is upstream body diversity
 * (decide-prompt parity, ADAAAA-8928), not a missing exception in this guard.
 *
 * So the key keeps both contract bars and reports the instant evidence as
 * EVIDENCE ONLY (for the census and the log), never as a suppression.
 */
export function summaryRepeatKey(
  body: string,
  evidence: SummaryEvidence,
  served: readonly SummaryServedBody[]
): SummaryRepeatVerdict {
  const opening = summaryOpeningRun(body);
  const windowTs = evidence.windowTs ?? null;
  const ownToken = attestedMatchClockToken(evidence) ?? clockTokensOf(body)[0] ?? null;
  let best: SummaryServedBody | null = null;
  let bodySimilarity = 0;
  let overlapS: number | null = null;
  let sameClock = false;
  const sentenceRepeats: NonNullable<SummaryRepeatVerdict["sentence"]>[] = [];
  for (const other of served) {
    const similarity = sentenceSimilarity(body, other.body);
    if (best === null || similarity > bodySimilarity) {
      best = other;
      bodySimilarity = similarity;
      overlapS =
        windowTs !== null && other.windowTs !== null ? Math.abs(windowTs - other.windowTs) : null;
      sameClock =
        ownToken !== null && other.clockToken !== null && ownToken === other.clockToken;
    }
    for (const repeat of repeatedSentences(body, summarySentencesOf(other.body))) {
      sentenceRepeats.push(repeat);
    }
  }
  const openingRepeat = opening !== null && served.some((s) => s.opening === opening);
  const closestSentence =
    sentenceRepeats.length > 0
      ? sentenceRepeats.reduce((a, b) => (b.similarity > a.similarity ? b : a))
      : null;
  // AC8 first: a repeated opening is the cheaper, more visible defect to name.
  const key: SummaryRepeatKey | null = openingRepeat
    ? "opening"
    : closestSentence !== null
      ? "sentence"
      : null;
  const repeatedList = [...new Set(sentenceRepeats.map((r) => r.a))];
  return {
    key,
    against: best?.highlightId ?? null,
    bodySimilarity,
    windowOverlapS: overlapS,
    sameClock,
    openingRepeat,
    sentence: closestSentence,
    repeatedSentences: repeatedList,
  };
}

export function newSummaryJobState(): SummaryJobState {
  return { servedOpenings: new Set<string>(), servedSentences: [], servedActs: [], servedBodies: [] };
}

export interface SummaryLaneConfig {
  /** Decide-service base URL. Absent => the lane is inert and drops `pool_busy`
   *  (never a fabricated summary). */
  decideUrl?: string;
  /** Operator override for the per-call fee; clamped to the AC5 ceiling. */
  summaryFee?: number | null;
  /** List price per decide call, for the fee ceiling. */
  decideFee: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** How many promoted rows may WAIT for the single in-flight slot. Deliberately
 *  small: the lane is lowest priority, and a row that cannot get the slot is
 *  dropped and served on the headline rather than queued behind decide. */
export const SUMMARY_LANE_PENDING_RING = 8;

/** The meter a run (or a job) reports. Mirrors the stored-row counters. */
export interface SummaryMeterSnapshot {
  summaryCalls: number;
  summaryDropped: number;
  summaryDroppedByReason: Record<string, number>;
  /** Measured p95 generation latency in ms (0 when nothing was measured). */
  summaryP95Ms: number;
}

function emptyMeter(): SummaryMeterSnapshot {
  return { summaryCalls: 0, summaryDropped: 0, summaryDroppedByReason: {}, summaryP95Ms: 0 };
}

/** p95 of a sample set (nearest-rank), 0 for an empty set. */
export function summaryP95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/** The per-call fee this lane bills (AC5: <= 1.5x DECIDE_FEE). */
export function summaryFeeFor(cfg: Pick<SummaryLaneConfig, "decideFee" | "summaryFee">): number {
  return resolveSummaryFee(cfg.decideFee, cfg.summaryFee ?? null);
}

/** Body of the text-only `/app/summary` call. The PROMPT is composed here, in
 *  the shared contract module, so the prompt is snapshot-tested in TS and the
 *  decide service stays a thin text runner. */
export interface SummaryCallBody {
  prompt: string;
  rail: SummaryRail;
  /** Ceiling for the reply: the band's hard max plus headroom for the clamp. */
  maxWords: number;
}

/** One text-only call. Returns the raw reply text, or the drop cause. Never
 *  throws. */
export async function requestSummaryCall(
  cfg: SummaryLaneConfig,
  body: SummaryCallBody
): Promise<{ text: string } | { reason: SummaryDropReason }> {
  const base = cfg.decideUrl?.replace(/\/+$/, "");
  if (!base) return { reason: "pool_busy" };
  const fetchImpl = cfg.fetchImpl ?? fetch;
  try {
    const r = await fetchImpl(`${base}/app/summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: body.prompt, rail: body.rail, maxWords: body.maxWords }),
      signal: AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS),
    });
    if (!r.ok) return { reason: "transport_failure" };
    const data: any = await r.json();
    const text = typeof data?.summary === "string" ? data.summary.trim() : "";
    // An empty reply is a PARSE failure, not a gate refusal: nothing was written.
    if (!text) return { reason: "parse" };
    return { text };
  } catch (e: any) {
    const name = e?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(String(e?.message ?? ""))) {
      return { reason: "timeout" };
    }
    return { reason: "transport_failure" };
  }
}

export interface SummaryLaneRunResult {
  /** `stored` = copy written; `dropped` = meter written, no copy. */
  outcome: "stored" | "dropped";
  reason?: SummaryDropReason;
  gate?: string;
  calls: number;
  latencyMs: number;
}

/**
 * ADAAAA-8984 — NAME a refusal. `filler` vs `gate` is a DIAGNOSTIC, so it lives in
 * ONE place: the lane calls this and the `$0` replay (`tools/replay-8934.ts`) calls
 * it too, which is what keeps the served path and the gate that grades it from
 * drifting apart.
 *
 * The ORDER is the contract, and `services/server/test/summary-lane-8984.test.ts`
 * pins it: a CLAIM violation that no repair can clear is tested FIRST, the word
 * shortfall second. A row whose only action-bearing clause is unattested cannot be
 * repaired at any length (measured: padding the rev-8 row `3cdf3fdd` to 58 words
 * only trades `too-few-words` for `unattested-side`), so naming it `filler` — a
 * depth name — sends the next census round after depth instead of attribution
 * (ADAAAA-8938 requirement (b)).
 *
 * `filler` stays reserved for the class the definition names: a filler deletion
 * that leaves the body short with NO unrepairable claim in it.
 */
export function summaryDropReasonName(
  decision: ReturnType<typeof gateSummaryDetail>,
  evidence: SummaryEvidence
): Extract<SummaryDropReason, "filler" | "gate"> {
  const unrepairableClaim = decision.violations.some((v) => !summaryRefusalIsRepairable(v, evidence));
  if (unrepairableClaim) return "gate";
  // ADAAAA-9083 (AC15): a frame-narration lead the strip deleted is the same
  // diagnostic class as a filler clause — copy that carried no fact was removed and
  // the remainder fell under the floor — so it takes the `filler` name (the AC4
  // "named reason"), never a new drop class.
  const fillerDrop =
    (decision.droppedClauses.length > 0 || decision.frameOpeners.length > 0) &&
    decision.repairedWords < summaryBand(evidence.rail).floorWords;
  return fillerDrop ? "filler" : "gate";
}

/**
 * Generate, gate, store. ONE inference plus at most one retry; a failure writes
 * the meter only. The row's status, verdict, caption, title and clip fields are
 * never touched — only the six `summary*` fields.
 *
 * AC8 (rev 3): `state` carries the JOB's already-served opening runs. A body
 * whose opening repeats one of them, or whose sentence repeats one at >= 0.80, is
 * a DETERMINISTIC refusal (the served corpus cannot change between two samples),
 * so ADAAAA-9120 ends it on ONE call: the repeated clause is dropped and the
 * remainder re-gated, and only a remainder that still fails drops with its own
 * named reason. The paid regeneration is reserved for the AC14 filler-clause class
 * (AC5 envelope: `summaryCalls / rows <= 1.5`, one call per row by construction).
 */
export async function runSummaryForRow(
  store: SummaryLaneStore,
  cfg: SummaryLaneConfig,
  descriptor: SummaryRowDescriptor,
  state?: SummaryJobState
): Promise<SummaryLaneRunResult> {
  const now = cfg.now ?? (() => Date.now());
  const log = cfg.log ?? ((line: string) => console.log(line));
  const evidence = descriptor.evidence;
  const servedOpenings = state?.servedOpenings;
  let calls = 0;
  let lastReason: SummaryDropReason | null = null;
  /** The last refusal, so the drop path can keep its reply as `summaryRaw`. */
  let lastGate: ReturnType<typeof gateSummaryDetail> | null = null;
  /** ADAAAA-8803: the measured shape of the draft the gate refused, handed to
   *  the retry call. Absent on the first pass, so the first prompt is unchanged. */
  let retry: SummaryRetryDirective | undefined;
  /** ADAAAA-9031 (AC5 / spec §13.2): WHY a second call was billed. The rev-10 VOD
   *  leg billed 11 second calls and 3 served rows recorded no reason at all, so a
   *  census could not tell an AC8 repeat from a depth retry. Every row that bills
   *  two calls now carries the reason it did. */
  let retryReason: SummaryRetryReason | null = null;
  /** ADAAAA-9085: the AC14 prune ran and its OWN re-gate is what refused the row.
   *  The drop path used to persist `lastGate = decision` (the PRE-prune body), so a
   *  row that died inside the repair read as a clean body dropped for repeating:
   *  `summaryViolations: []` and a word count from a body that measured nothing. */
  let repairRefused: {
    token: string;
    /** The drop NAME the repair's own refusal earns (`filler` for a remainder the
     *  clause drop took under the band floor, `gate` for a content bar the repair
     *  cannot fix, `repeat` for a remainder that still repeats after the drop —
     *  ADAAAA-9177). The row is named by the repair, not by the repeat that started
     *  it: AC14.3's own order is "regenerate once, then drop the clause", and the
     *  clause drop is what the copy died of. */
    name: Extract<SummaryDropReason, "filler" | "gate" | "repeat">;
    decision: ReturnType<typeof gateSummaryDetail>;
    /** The WRITER's own reply (pre-prune). A repair that dropped every repeated
     *  sentence leaves an empty post-prune body, so this is the text `summaryRaw`
     *  must keep. */
    raw: string;
    dropped: number;
    substituted: number;
    survivors: number;
  } | null = null;
  /** ADAAAA-9085: the AC14.5 filler repair substitutes from a deterministic pool,
   *  so it must not re-serve a sentence this JOB already carries — that insert is
   *  what tripped the repeat key on 3 of the rev-13 VOD job's 20 rows. */
  const gateOptions =
    state && state.servedSentences.length > 0 ? { avoidSentences: [...state.servedSentences] } : undefined;
  /** ADAAAA-9177 (AC1 / lever 3): the avoid block the prompt renders, built ONCE
   *  per row from the same two lists the prompt call gets — same order, same
   *  truncation (`slice(0, 8)` openings, `slice(0, 10)` pairs) — so the block
   *  persisted on the row is byte-for-byte what the model was shown. The state
   *  cannot change mid-row (only a SERVED row spends anything), so one build per
   *  row is exact rather than approximate.
   *
   *  The openings come from `servedOpenings`, the AC8 structure the lane has kept
   *  since rev 3; `summarySpentOpenings` re-derives them from the served bodies
   *  for a caller that hydrates bodies without replaying the set (a replay tool),
   *  and both derivations read the same `summaryOpeningRun`. */
  const avoidOpenings =
    servedOpenings && servedOpenings.size > 0
      ? [...servedOpenings]
      : state
        ? summarySpentOpenings(state.servedBodies.map((served) => served.body))
        : [];
  const avoidActs = state ? [...state.servedActs] : [];
  const promptAvoid =
    avoidOpenings.length > 0 || avoidActs.length > 0
      ? { openings: avoidOpenings.slice(0, 8), acts: avoidActs.slice(0, 10) }
      : null;
  const started = now();
  for (let attempt = 1; attempt <= SUMMARY_MAX_CALLS_PER_ROW; attempt++) {
    // AC8 prompt-first: the regeneration (and any retry) is asked to avoid the
    // openings already served in this job, so the gate is a backstop, not the
    // only defence. ADAAAA-8914 (AC14.3) extends the same prompt-first rule to the
    // whole SENTENCE: the job's served sentences are shown and the copy is asked to
    // differ from them, because only the lane can see the other cards.
    const prompt = buildSummaryPrompt({
      ...evidence,
      // ADAAAA-9177 (rev-20): the OPENINGS come first in the avoid block, and the
      // prompt states plainly that sentence 1's opening is what is compared —
      // `avoidActs` alone let three cards open on one spent pair on job `798f21c2`.
      ...(avoidOpenings.length > 0 ? { avoidOpenings } : {}),
      ...(state && state.servedSentences.length > 0 ? { avoidSentences: [...state.servedSentences] } : {}),
      // ADAAAA-9121 (writer round 3): rotate the SUBSTANCE, not only the shape.
      // ADAAAA-9089 banned the frame shapes and the writer still re-emitted one
      // act-plus-purpose sentence on every card, because a `clock` + `action` row
      // has one pair to spend per sentence and the model picks the same one. The
      // job's spent pairs go to the FIRST pass too (not the retry alone), so the
      // repetition never happens instead of being repaired by a paid second call.
      ...(avoidActs.length > 0 ? { avoidActs } : {}),
      // ADAAAA-8803/8806: the retry directive carries the refused draft's
      // measured shape AND its violations, so the repair line can name both the
      // shortfall and the missing fact.
      ...(retry ? { retry } : {}),
    });
    const body: SummaryCallBody = {
      prompt,
      rail: evidence.rail,
      maxWords: evidence.rail === "vod" ? 120 : 70,
    };
    calls++;
    const reply = await requestSummaryCall(cfg, body);
    if ("reason" in reply) {
      lastReason = reply.reason;
      // A parse failure is deterministic: one retry only for transport-shaped
      // failures, so a broken reply cannot spend a second call.
      if (reply.reason === "parse" || reply.reason === "pool_busy") break;
      continue;
    }
    const decision = gateSummaryDetail(reply.text, evidence, gateOptions);
    if (!decision.summary) {
      lastGate = decision;
      // ADAAAA-8914 (AC14.5): when the clause repair is what took the body under
      // the band floor, the drop is a FILLER drop, not a compliance drop — name it
      // so a census can tell "the writer had nothing to say" from "the writer
      // invented something". A refusal that is ALSO deterministic (the row's fact
      // menu cannot nourish two kinds, an invented name, an internal token) keeps
      // the `gate` name: that row was never repairable by a second sample, so the
      // clause repair is not what sank it.
      // ADAAAA-8984: the name is computed by `summaryDropReasonName`, which tests
      // the CLAIM violation BEFORE the word shortfall. An evidence-limited claim
      // refusal on a short row is a `gate` drop, never `filler`: the row cannot
      // serve at ANY length, so a depth name would send the next census round
      // after the wrong defect (ADAAAA-8938 requirement (b)). The `$0` replay
      // calls the SAME function, so the gate cannot disagree with the lane.
      lastReason = summaryDropReasonName(decision, evidence);
      // ADAAAA-8773 / spec §13.2 (rev 7): a DETERMINISTIC refusal ends the row on
      // ONE call. The row's fact menu is fixed and the same prompt cannot repair a
      // clock anchor, an invented name or an enum-shaped token; the served VOD job
      // `70400b1d` spent 2 calls on both promoted rows to reach the identical
      // `too-few-facts` refusal, which billed 2 x the 1.5x ceiling = 2.0x
      // DECIDE_FEE per row. The second call is now the AC8 repeat path's alone.
      // ADAAAA-8806: a `too-few-facts` refusal is deterministic ONLY when the
      // row's own evidence cannot nourish two fact types; a thin reply on a row
      // that does attest two earns the repair retry instead of a drop.
      if (decision.violations.some((v) => !summaryRefusalIsRepairable(v, evidence))) {
        log(
          `[summary:${descriptor.jobId}] deterministic-refusal highlight=${descriptor.highlightId} violations=${decision.violations.join(",")} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        break;
      }
      // ADAAAA-9031 (AC5 / spec §13.2): "the second call is permitted ONLY on
      // the AC8 repeat path" — plus the explicit AC14 regeneration after the
      // clause repair ("a failing candidate is regenerated once, then the
      // offending clause is dropped"). A depth or claim refusal is neither, so it
      // ends the row on ONE call. The rev-10 VOD leg billed 11 second calls and
      // only 4 were the repeat path; 3 served rows recorded no reason at all.
      //
      // `too-few-facts` is deterministic HERE even on a row whose menu offers two
      // kinds: §13.2 names it as never-retried, and the rev-10 VOD leg re-sampled
      // exactly those rows (`26a58961`, `8f093fad`, `4c65a303`) to the identical
      // refusal. The fix for a fact-poor FIRST sample is upstream (the prompt and
      // the row's own attestation), not a second paid call.
      const factPoor = decision.violations.includes("too-few-facts");
      // ADAAAA-9083 (AC15/AC4): a frame-narration lead the strip deleted is the
      // same repairable shape as a filler clause — the body lost copy that carried
      // no fact and fell under the floor — so the ONE regeneration the contract
      // allows is the AC5 slot it already had (no new retry class). The retry is
      // told which lead was deleted, so the second sample opens on the action.
      const fillerRepair =
        !factPoor && (decision.droppedClauses.length > 0 || decision.frameOpeners.length > 0);
      if (!fillerRepair) {
        log(
          `[summary:${descriptor.jobId}] one-call drop highlight=${descriptor.highlightId} violations=${decision.violations.join(",")} words=${decision.words} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        break;
      }
      if (attempt < SUMMARY_MAX_CALLS_PER_ROW) {
        // ADAAAA-8803: the retry is TOLD what the refused draft measured. A
        // second sample of the same prompt is where the served VOD row
        // `2f5a5796` went 28 -> 34 words against the 40-word floor; the retry now
        // carries the shortfall and asks for the floor plus a margin
        // (`summaryRetryMinWords`), so it cannot re-land on the boundary.
        // ADAAAA-8934: the retry is handed the DELETED clause list and the fact
        // menu beside the shortfall. The rev-8 grade measured 9 rows retried and
        // 9 still dropped: the second call re-read the same prompt, re-wrote the
        // same possession/pressure clauses, and the clause repair deleted them
        // again. Naming what was deleted (and what may replace it) is the only
        // thing that makes the second sample different from the first.
        retry = {
          words: decision.words,
          sentences: decision.sentences,
          violations: decision.violations,
          ...(decision.droppedClauses.length > 0 ? { droppedClauses: decision.droppedClauses } : {}),
          factMenu: summaryFactMenu(evidence),
        };
        retryReason = "filler-repair";
        log(
          `[summary:${descriptor.jobId}] gate-retry highlight=${descriptor.highlightId} violations=${decision.violations.join(",")} words=${decision.words} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        continue;
      }
      break;
    }
    // AC8 + AC14 (ADAAAA-8941 integration repair): ONE repeat key on the
    // contract's job scope. A shared normalized 4-word opening (AC8) or a shared
    // sentence at >= 0.80 similarity (AC14) is a repeat: drop the repeated clause
    // and re-gate the remainder. ADAAAA-8969 increment 2 briefly exempted rows on
    // different windows; that traded both bars for a coverage number the
    // attested-fact gate refuses anyway, so it is reverted here. The prompt still
    // asks the writer to avoid the job's openings and sentences (prompt-first), so
    // the gate is the backstop. ADAAAA-9120 removed the paid REGENERATION on this
    // path: the served corpus is fixed, so a second sample is not a repair (see
    // the block below).
    /** The decision this row serves (the gate's own, or the AC14 clause-dropped
     *  repair of it). */
    let accepted = decision;
    let prunedSentences: string[] = [];
    /** ADAAAA-9052: fact sentences the repeat repair substituted to reach the band. */
    let prunedSubstituted = 0;
    const repeat = state ? summaryRepeatKey(decision.summary, evidence, state.servedBodies) : null;
    if (repeat && repeat.key !== null) {
      const inputs =
        `key=${repeat.key} against=${JSON.stringify(repeat.against)} ` +
        `bodySimilarity=${repeat.bodySimilarity.toFixed(3)} windowOverlapS=${repeat.windowOverlapS ?? "n/a"} ` +
        `sameClock=${JSON.stringify(repeat.sameClock)} openingRepeat=${JSON.stringify(repeat.openingRepeat)} ` +
        `closestSentence=${repeat.sentence ? `${repeat.sentence.similarity.toFixed(3)} ${JSON.stringify(repeat.sentence.a.slice(0, 120))}` : "none"}`;
      // ADAAAA-9120 (AC5 envelope): the AC8/AC14 repeat refusal is DETERMINISTIC —
      // the served bodies it is measured against are fixed, so a second sample of
      // the same prompt is not a repair, it is another bill. The rev-17 served job
      // `1e0d7187` measured it: 6 of 7 rows billed a second call and every one of
      // the 5 dropped rows re-landed the repeat (`summaryRepairRefused:
      // prune:gate`), for row meter 1.857 and job meter 2.143 against AC5's 1.5.
      // The paid regeneration is therefore gone for this class. The deterministic
      // clause drop (AC14.3) IS the repair and it runs on THIS call, so a repeat
      // row bills exactly one summary call whether the pruned remainder serves or
      // is refused. The reason is still recorded: a census reads `summaryCalls`
      // beside it, so a one-call repair cannot be mistaken for a 2-call retry.
      retryReason = retryReason ?? (repeat.key === "opening" ? "repeat-opening" : "repeat-sentence");
      log(`[summary:${descriptor.jobId}] repeat-body highlight=${descriptor.highlightId} ${inputs} — repairing on one call`);
      // ADAAAA-9031 (AC14.3): "a failing candidate is regenerated once, then the
      // offending CLAUSE is dropped; a body that then falls under its floor is
      // dropped with the named reason." On the repeat class ADAAAA-9120 dropped the
      // paid first step (see above): the clause drop is deterministic, so it runs
      // immediately. The lane used to drop the whole body, which cost the rev-10 VOD
      // leg 4 of 22 promoted rows even where the surviving sentences carried facts.
      // Drop the repeated sentences and re-gate the remainder; only a body that
      // still fails (or falls under the band floor) drops as `repeat`.
      // ADAAAA-9052: and a remainder the drop took UNDER the floor is now
      // repaired back to the band with a different attested fact instead of the
      // row being discarded — dropping the row was the defect (rev-11 VOD
      // coverage: `54388ada`, `285ae8d0`, `0b6ee1d8`, `87e616cc`, `2646edbb` all
      // dropped as `repeat` with fact-bearing survivors). The substitution may
      // not repeat a sentence the job already served, so the repair cannot
      // re-break AC14.3.
      // ADAAAA-9085: the clause drop is reachable on EVERY repeat key, not only
      // `sentence`. An `opening` repeat names the body's FIRST sentence in
      // `repeatedSentences` — the shared 4-word run IS that sentence — so the same
      // repair applies and removing it fixes AC8 by construction. Gating the repair
      // on `key === "sentence"` made ADAAAA-9052's repair unreachable for the class
      // and the row dropped with the pre-prune decision on it (rev-13 VOD row
      // `369ff147`, `repeat-opening`).
      //
      // ADAAAA-9177 (rev-20): that assumption only held when the two cards also
      // shared a whole SENTENCE. On job `798f21c2` the openings collided and the
      // bodies did not (`closestSentence=none` on `f7f62ed8` and `d9dc73b6`), so
      // `repeatedSentences` was EMPTY, no clause drop ran, and both rows dropped
      // with the pre-prune decision — `summaryViolations: []`, which reads as a bar
      // nothing pointed at. The opening run IS sentence 1, so an `opening` repeat
      // puts sentence 1 in the drop list whether or not a whole sentence repeated.
      // That is the "force a different opening" half of the AC2 lever done at `$0`:
      // the drop and the re-gate ride the SAME call, so no second sample is billed
      // (AC4) and the served body cannot share the spent opening by construction.
      // A row whose opening did NOT repeat keeps the pre-9177 list exactly.
      const repairClauses =
        repeat.openingRepeat && decision.summary
          ? [...new Set([...repeat.repeatedSentences, summarySentencesOf(decision.summary)[0] ?? ""])].filter(
              (sentence) => sentence.trim().length > 0
            )
          : repeat.repeatedSentences;
      if (repairClauses.length > 0) {
        const prune = pruneRepeatedSentences(
          decision.summary,
          repairClauses,
          evidence,
          state?.servedSentences ?? []
        );
        const prunedDecision = gateSummaryDetail(prune.text, evidence, gateOptions);
        // ADAAAA-9177: the re-gate does not read AC8 (and never read AC14), so a
        // pruned body must also clear the repeat key before it can serve. This is
        // the measured rev-19 shape on row `03cdc053`: its collision was sentence
        // 2, the prune dropped sentence 2, and the SERVED body still opened on
        // `portugal dispossesses the ball` — a served AC8 violation that the
        // sentence-similarity grade could not see. A remainder that still repeats
        // drops as `repeat` with the mechanism named on the row (`prune:repeat`).
        const prunedRepeat = prunedDecision.summary
          ? summaryRepeatKey(prune.text, evidence, state?.servedBodies ?? [])
          : null;
        if (prunedDecision.summary && (prunedRepeat === null || prunedRepeat.key === null)) {
          accepted = prunedDecision;
          prunedSentences = repairClauses;
          prunedSubstituted = prune.substituted.length;
          retryReason = retryReason ?? (repeat.key === "opening" ? "repeat-opening" : "repeat-sentence");
          log(
            `[summary:${descriptor.jobId}] repeat-clause-drop highlight=${descriptor.highlightId} dropped=${repairClauses.length} substituted=${prune.substituted.length} words=${prunedDecision.words} opening=${JSON.stringify(summaryOpeningRun(prune.text))} ${inputs}`
          );
        } else {
          // ADAAAA-9085: keep the REPAIR's own refusal, not the pre-prune decision.
          // `summaryRepairRefused` names the mechanism so a served-row census can
          // separate "the row's evidence offered no admissible fact" from "the
          // writer's body violated a bar"; the drop path below then persists this
          // decision's violations / words / droppedClauses.
          //
          // ADAAAA-9177: a remainder that still repeats is a REPEAT refusal, not a
          // depth or content one — named `prune:repeat` so the row says why.
          const stillRepeats = prunedDecision.summary !== null && prunedRepeat?.key != null;
          const survivors = (decision.sentences ?? 0) - repairClauses.length;
          const depthOnly = prunedDecision.violations.every(
            (violation) => violation === "too-few-words" || violation === "too-few-sentences"
          );
          const repairName: Extract<SummaryDropReason, "filler" | "gate" | "repeat"> = stillRepeats
            ? "repeat"
            : prunedDecision.violations.length > 0 && depthOnly
              ? "filler"
              : summaryDropReasonName(prunedDecision, evidence);
          repairRefused = {
            token: `prune:${repairName}`,
            name: repairName,
            decision: prunedDecision,
            raw: decision.raw,
            dropped: repairClauses.length,
            substituted: prune.substituted.length,
            survivors: survivors > 0 ? survivors : 0,
          };
          log(
            `[summary:${descriptor.jobId}] repeat-prune-refused highlight=${descriptor.highlightId} reason=prune:${repairName} dropped=${repairClauses.length} substituted=${prune.substituted.length} survivors=${survivors > 0 ? survivors : 0} words=${prunedDecision.words} violations=${prunedDecision.violations.join(",")}${stillRepeats ? ` stillRepeats=${prunedRepeat?.key}` : ""} ${inputs}`
          );
        }
      }
      if (accepted === decision) {
        // ADAAAA-9085: a row that died inside the repair carries the repair's own
        // post-prune refusal; a row with no admissible clause repair keeps the
        // pre-prune decision (there is no repair result to speak of).
        lastGate = repairRefused ? repairRefused.decision : decision;
        // ADAAAA-9085: a row whose clause drop left a body under the band floor is
        // a FLOOR drop, not a repeat drop — AC14.3's own order ends there, and the
        // row keeps the repeat evidence (`summaryRetryReason`, `summaryRepairRefused`,
        // the dropped-sentence count). A repair refused on a CONTENT bar keeps
        // `gate`; a row that never reached a repair keeps `repeat`.
        lastReason = repairRefused ? repairRefused.name : "repeat";
        log(
          `[summary:${descriptor.jobId}] repeat-body highlight=${descriptor.highlightId} ${inputs} — drop (repeat)${repairRefused ? ` repairRefused=${repairRefused.token}` : ""} raw=${JSON.stringify(decision.raw.slice(0, 200))}`
        );
        break;
      }
    }
    const servedBody = accepted.summary ?? decision.summary;
    if (!servedBody) {
      lastGate = decision;
      lastReason = "repeat";
      break;
    }
    const opening = summaryOpeningRun(servedBody);
    servedOpenings?.add(opening);
    for (const sentence of summarySentencesOf(servedBody)) state?.servedSentences.push(sentence);
    // ADAAAA-9121: remember which actor-and-act pairs this job has now spent, so
    // the next card's prompt can rotate away from them.
    if (state) state.servedActs.push(...summarySpentActPairs([servedBody], attestedActorNames(evidence)));
    state?.servedBodies.push({
      highlightId: descriptor.highlightId,
      windowTs: evidence.windowTs ?? null,
      windowDurationS: evidence.windowDurationS ?? null,
      clockToken: attestedMatchClockToken(evidence) ?? clockTokensOf(servedBody)[0] ?? null,
      body: servedBody,
      opening,
    });
    const latencyMs = Math.max(0, Math.round(now() - started));
    await store.patchHighlightSummary(descriptor.highlightId, {
      summary: servedBody,
      summaryGate: accepted.gate,
      summaryCaptionOverlap: accepted.captionOverlap,
      summaryCalls: calls,
      summaryDropped: 0,
      summaryP95Ms: latencyMs,
      ...(retryReason ? { summaryRetryReason: retryReason } : {}),
      // ADAAAA-9177 (AC1): the avoid block this row's prompt carried, so the next
      // grade reads "did the writer see the served openings" off the row instead of
      // writing `not_captured`.
      ...(promptAvoid ? { summaryPromptAvoid: promptAvoid } : {}),
      ...(prunedSentences.length > 0
        ? {
            summaryDroppedSentences: (accepted.droppedSentences ?? 0) + prunedSentences.length,
            summaryRepairedWords: accepted.words,
          }
        : {}),
    });
    log(
      `[summary:${descriptor.jobId}] stored highlight=${descriptor.highlightId} words=${accepted.words} sentences=${accepted.sentences} gate=${accepted.gate} calls=${calls} ms=${latencyMs} opening=${JSON.stringify(opening)} clockToken=${JSON.stringify(clockTokensOf(servedBody))} matchClockToken=${JSON.stringify(attestedMatchClockToken(evidence))} retryReason=${JSON.stringify(retryReason)}${
        promptAvoid ? ` avoid=${JSON.stringify(promptAvoid)}` : ""
      }${
        accepted.droppedClauses.length > 0
          ? ` droppedClauses=${accepted.droppedClauses.length} substitutedClauses=${accepted.substitutedClauses.length} repairedWords=${accepted.repairedWords}`
          : ""
      }${prunedSentences.length > 0 ? ` droppedRepeatedSentences=${prunedSentences.length} repairedSentences=${prunedSubstituted}` : ""}${
        accepted.frameOpeners.length > 0 ? ` frameOpeners=${JSON.stringify(accepted.frameOpeners)}` : ""
      }`
    );
    return { outcome: "stored", gate: accepted.gate, calls, latencyMs };
  }
  const reason: SummaryDropReason = lastReason ?? "transport_failure";
  const latencyMs = Math.max(0, Math.round(now() - started));
  // ADAAAA-8687: a refusal keeps the model's own reply as `summaryRaw` (and an
  // excerpt in the log), so the next QA can quote WHAT was refused instead of
  // only the violation token. Still never a `summary`: the card renders on its
  // headline exactly as before (AC6).
  // ADAAAA-9085: when the repair is what refused the row, the reply worth keeping is
  // the WRITER's (pre-prune) one — a repair that dropped every repeated sentence
  // leaves an empty post-prune body, and `summaryRaw: ""` would lose the evidence the
  // next census quotes.
  const rawSource = repairRefused && !repairRefused.decision.raw ? repairRefused.raw : (lastGate?.raw ?? "");
  const raw = rawSource ? rawSource.slice(0, SUMMARY_RAW_MAX_CHARS) : undefined;
  // ADAAAA-8903 (§15.4): the refusal DETAIL rides the row, not just the ordered
  // `gate` counter — the next census must be able to tell a depth-threshold
  // refusal from a compliance one by reading the row.
  const detail = lastGate ? summaryRefusalDetail(lastGate, evidence.rail) : null;
  await store.patchHighlightSummary(descriptor.highlightId, {
    summaryGate: `dropped:${reason}`,
    ...(raw ? { summaryRaw: raw } : {}),
    ...(lastGate ? { summaryCaptionOverlap: lastGate.captionOverlap } : {}),
    ...(detail
      ? {
          summaryViolations: detail.violations,
          summaryWordCount: detail.words,
          summaryFloorWords: detail.floorWords,
          summaryTargetMinWords: detail.targetMinWords,
          summaryDroppedSentences: detail.droppedSentences,
          summaryDroppedClauses: detail.droppedClauses,
          summaryRepairedWords: detail.repairedWords,
          ...(detail.clauseClaims.length > 0 ? { summaryClauseClaims: detail.clauseClaims } : {}),
        }
      : {}),
    summaryCalls: calls,
    summaryDropped: 1,
    summaryDroppedByReason: { [reason]: 1 },
    summaryP95Ms: latencyMs,
    ...(retryReason ? { summaryRetryReason: retryReason } : {}),
    // ADAAAA-9177 (AC1): a DROPPED row carries the same block, so a census can read
    // "the writer was told" beside "the writer still repeated" without a leg.
    ...(promptAvoid ? { summaryPromptAvoid: promptAvoid } : {}),
    // ADAAAA-9085: the repair's own outcome rides the row. Without it a census
    // reads a repaired-then-refused row as a clean body dropped for repeating.
    ...(repairRefused
      ? {
          summaryRepairRefused: repairRefused.token,
          summaryRepairDroppedSentences: repairRefused.dropped,
          summaryRepairSubstitutedSentences: repairRefused.substituted,
        }
      : {}),
  });
  // ADAAAA-8903 (AC1-live): a `too-few-facts` refusal on a row whose OWN evidence
  // offers two fact kinds AND whose judged body names an attested actor is the
  // lane contradicting itself — the prompt asked for a fact type the gate could
  // not credit (the measured class: sustained-play prose on a `ballOutcome: null`
  // row). Name it in the log so a census can count the class without replaying
  // replies; a body that names nobody is a sampling miss, not a contradiction.
  if (lastGate && lastGate.violations.includes("too-few-facts")) {
    const offered = attestedFactKinds(evidence);
    if (offered.length >= SUMMARY_MIN_FACT_KINDS && bodyNamesAttestedActor(lastGate.raw, evidence)) {
      log(
        `[summary:${descriptor.jobId}] fact-menu-contradiction highlight=${descriptor.highlightId} offered=${offered.join(",")} words=${lastGate.words} raw=${JSON.stringify((raw ?? "").slice(0, 200))}`
      );
    }
  }
  log(
    `[summary:${descriptor.jobId}] dropped (${reason}) highlight=${descriptor.highlightId} calls=${calls}${lastGate ? ` violations=${lastGate.violations.join(",")} raw=${JSON.stringify((raw ?? "").slice(0, 200))}` : ""}${promptAvoid ? ` avoid=${JSON.stringify(promptAvoid)}` : ""}`
  );
  return { outcome: "dropped", reason, gate: lastGate?.gate, calls, latencyMs };
}

/**
 * The lane. `enqueue` is SYNCHRONOUS and never awaits a call, so the promotion
 * path returns to the frame loop immediately (AC4: zero added detect latency).
 * The drain loop runs one call at a time per job.
 */
export class SummaryLane {
  private readonly pending: SummaryRowDescriptor[] = [];
  private inFlight = false;
  private draining = false;
  private readonly samples: number[] = [];
  private meter: SummaryMeterSnapshot = emptyMeter();
  /** AC8 (rev 3): the openings already served in THIS job. The lane is one per
   *  job, so the guard's scope is the job by construction. */
  private readonly jobState: SummaryJobState = newSummaryJobState();
  /** Rows that could not even be queued (ring full / lane inert). */
  private droppedAtEnqueue = 0;

  constructor(
    readonly jobId: string,
    private readonly store: SummaryLaneStore,
    private readonly cfg: SummaryLaneConfig
  ) {}

  /** Queue a promoted row. Returns true when it will be attempted. Never throws,
   *  never awaits: the caller is the promotion seam. */
  enqueue(descriptor: SummaryRowDescriptor): boolean {
    if (!this.cfg.decideUrl) {
      // The lane is INERT with no decide service: no call is issued and no row
      // write is spent — the meter still records why nothing shipped. This is the
      // operator kill-switch path, and a card with no copy renders exactly as it
      // did before the lane existed.
      this.recordDrop("pool_busy");
      return false;
    }
    if (this.pending.length >= SUMMARY_LANE_PENDING_RING) {
      this.recordDrop("pool_busy");
      void this.writeDropMeter(descriptor.highlightId, "pool_busy");
      return false;
    }
    this.pending.push(descriptor);
    void this.drain();
    return true;
  }

  private async writeDropMeter(highlightId: string, reason: SummaryDropReason): Promise<void> {
    try {
      await this.store.patchHighlightSummary(highlightId, {
        summaryGate: `dropped:${reason}`,
        summaryCalls: 0,
        summaryDropped: 1,
        summaryDroppedByReason: { [reason]: 1 },
      });
    } catch (e: any) {
      (this.cfg.log ?? console.log)(`[summary:${this.jobId}] drop-meter write failed: ${e?.message ?? e}`);
    }
  }

  private recordDrop(reason: SummaryDropReason): void {
    this.meter.summaryDropped++;
    this.meter.summaryDroppedByReason[reason] = (this.meter.summaryDroppedByReason[reason] ?? 0) + 1;
    this.droppedAtEnqueue++;
  }

  /** Await the queue empty (used by tests and by a job's settle path). */
  async idle(): Promise<void> {
    while (this.draining || this.inFlight || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        this.inFlight = true;
        try {
          const result = await runSummaryForRow(this.store, this.cfg, next, this.jobState);
          this.meter.summaryCalls += result.calls;
          this.samples.push(result.latencyMs);
          if (result.outcome === "dropped") {
            this.meter.summaryDropped++;
            const reason = result.reason ?? "transport_failure";
            this.meter.summaryDroppedByReason[reason] = (this.meter.summaryDroppedByReason[reason] ?? 0) + 1;
          }
        } catch (e: any) {
          (this.cfg.log ?? console.log)(`[summary:${this.jobId}] lane error: ${e?.message ?? e}`);
          this.recordDrop("transport_failure");
        } finally {
          this.inFlight = false;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** The meter a settle path folds into `observeMetrics` / `costUsd`. */
  snapshot(): SummaryMeterSnapshot {
    return {
      summaryCalls: this.meter.summaryCalls,
      summaryDropped: this.meter.summaryDropped,
      summaryDroppedByReason: { ...this.meter.summaryDroppedByReason },
      summaryP95Ms: summaryP95(this.samples),
    };
  }

  /** Pending rows never attempted (drained on a job end so they are not lost
   *  silently). */
  get pendingCount(): number {
    return this.pending.length;
  }

  get enqueueDrops(): number {
    return this.droppedAtEnqueue;
  }
}

/**
 * A `{pre, post}` score pair as the transition's `from`/`to` score strings.
 *
 * ADAAAA-8787: reads the tuple shape the pipeline actually PERSISTS
 * (`deferredAttestation.pre/post` on the live rail, `attestationUsed
 * .transitionScore` on both rails) — the `scoreboardDelta {from,to}` shape is
 * kept first for the contract's own documented path, but no persisted row ever
 * wrote it, which is what starved the score fact. Only a legible 2x2 non-negative
 * integer pair qualifies: anything else is absent evidence, never a guess.
 */
function transitionPairFromTuples(
  pre: readonly number[] | null | undefined,
  post: readonly number[] | null | undefined
): { from: string; to: string } | null {
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== 2 || post.length !== 2) return null;
  if (![...pre, ...post].every((n) => Number.isInteger(n) && n >= 0)) return null;
  return { from: `${pre[0]}-${pre[1]}`, to: `${post[0]}-${post[1]}` };
}

/** The `pre -> post` pair a transition key names (`1-1>2-1`), or null. */
function transitionPairFromKey(key: string | null | undefined): { from: string; to: string } | null {
  if (typeof key !== "string") return null;
  const m = key.trim().match(/^(\d+)\s*-\s*(\d+)\s*(?:->|>|\u2192|\bto\b)\s*(\d+)\s*-\s*(\d+)$/i);
  if (!m) return null;
  return { from: `${+m[1]}-${+m[2]}`, to: `${+m[3]}-${+m[4]}` };
}

/**
 * The score transition a row CREDITS, or null.
 *
 * ADAAAA-8787: the lane used to read `deferredAttestation.scoreboardDelta`
 * alone, a shape no row persists, so `scoreTransition` was always null and every
 * body that relayed the score line was judged against a menu of
 * `[clock, action]` — a VOD promoted row whose verbs register no `action` fact
 * was then refused `too-few-facts` (job `a200d2bd`, row `48fe4280`). Priority is
 * the most explicit evidence first, and it only ever NAMES the measured pair:
 *   1. `deferredAttestation.scoreboardDelta` (the live rail's documented path);
 *   2. `deferredAttestation.pre/post` (what a live deferred promotion persists);
 *   3. `attestationUsed.transitionScore` (the measured transition a VOD row
 *      discloses, ADAAAA-8663);
 *   4. `attestationUsed.transitionKey` (legacy rows: the key names the pair).
 * An absent or illegible pair returns null, so no fact is invented.
 */
function scoreTransitionForRow(row: {
  deferredAttestation?: {
    scoreboardDelta?: { from?: string | null; to?: string | null } | null;
    pre?: readonly number[] | null;
    post?: readonly number[] | null;
  } | null;
  attestationUsed?: {
    transitionScore?: { pre?: readonly number[] | null; post?: readonly number[] | null } | null;
    transitionKey?: string | null;
  } | null;
}): { from: string | null; to: string | null } | null {
  const delta = row.deferredAttestation?.scoreboardDelta;
  if (delta && (delta.from || delta.to)) return { from: delta.from ?? null, to: delta.to ?? null };
  const deferred = transitionPairFromTuples(row.deferredAttestation?.pre, row.deferredAttestation?.post);
  if (deferred) return deferred;
  const attested = transitionPairFromTuples(
    row.attestationUsed?.transitionScore?.pre,
    row.attestationUsed?.transitionScore?.post
  );
  if (attested) return attested;
  return transitionPairFromKey(row.attestationUsed?.transitionKey);
}

/**
 * The evidence a stored row carries, mapped to the summary contract. Pure, so a
 * caller can assert the inputs the model sees without a pipeline.
 */
export function summaryEvidenceForRow(row: {
  verdict?: string | null;
  eventType?: string | null;
  outcome?: string | null;
  reason?: string | null;
  caption?: string | null;
  postTitle?: string | null;
  trigger?: { timestamp?: number; durationS?: number } | null;
  start?: number;
  end?: number;
  /** ADAAAA-8914 (AC14.4): the row's own persisted scorebug reading, so a clock
   *  clause that frames a stamp as match time can be checked against it. */
  matchClock?: {
    token?: string | null;
    seconds?: number | null;
    period?: string | null;
    legible?: boolean | null;
  } | null;
  deferredAttestation?: {
    scoreboardDelta?: { from?: string | null; to?: string | null } | null;
    pre?: readonly number[] | null;
    post?: readonly number[] | null;
    /** The persisted audit fields beside the pair (never read by this lane). */
    deltaTs?: number;
    readAt?: number;
    windowLo?: number;
    windowHi?: number;
    channel?: string;
  } | null;
  attestationUsed?: {
    transitionScore?: { pre?: readonly number[] | null; post?: readonly number[] | null } | null;
    transitionKey?: string | null;
    /** ADAAAA-8806: the folded attestation's own flags. Read only for "did this
     *  window record a ball outcome at all", so the body (and the prompt) never
     *  assert what the ball did on a row that measured nothing. */
    ballOutcome?: string | null;
    goalCrossed?: boolean | null;
    scoreBoardChanged?: boolean | null;
  } | null;
  /** ADAAAA-9031: the Stage-2 confirmation dive's verdict on the ROW, and the
   *  dive record it came from. A `confirmed_goal` is the row's strongest measured
   *  attestation, and the folded `attestationUsed` flags can still read
   *  `ballOutcome: null, goalCrossed: false` on the same row. */
  goalConfirmed?: string | null;
  confirmAttestation?: { goalConfirmed?: string | null } | null;
  asrTranscript?: string | null;
  matchContext?: unknown;
}, rail: SummaryRail, adjacentScoreCue?: string | null): SummaryEvidence {
  const ts = row.trigger?.timestamp;
  const windowTs = typeof ts === "number" && Number.isFinite(ts) ? ts : typeof row.start === "number" ? row.start : null;
  const duration =
    row.trigger?.durationS ?? (typeof row.start === "number" && typeof row.end === "number" ? row.end - row.start : null);
  return {
    rail,
    // The row's stored verdict wins; the event type only labels the window.
    verdict: row.verdict ?? row.outcome ?? null,
    eventType: row.eventType ?? null,
    reason: row.reason ?? null,
    caption: row.caption ?? null,
    postTitle: row.postTitle ?? null,
    windowTs,
    windowDurationS: duration ?? null,
    scoreTransition: scoreTransitionForRow(row),
    matchContext: row.matchContext ?? null,
    // ADAAAA-8914 (AC14.4): the row's attested match clock, when one was read.
    matchClock: row.matchClock
      ? {
          token: row.matchClock.token ?? null,
          seconds: row.matchClock.seconds ?? null,
          period: row.matchClock.period ?? null,
          legible: row.matchClock.legible ?? null,
        }
      : null,
    transcript: row.asrTranscript ?? null,
    adjacentScoreCue: adjacentScoreCue ?? null,
    attestation: row.attestationUsed
      ? {
          ballOutcome: row.attestationUsed.ballOutcome ?? null,
          goalCrossed: row.attestationUsed.goalCrossed ?? null,
          scoreBoardChanged: row.attestationUsed.scoreBoardChanged ?? null,
          // ADAAAA-9031 (AC1-VOD coverage): the Stage-2 dive's verdict rides the
          // same attestation object the gate reads. On the rev-10 VOD rows the
          // folded flags say `ballOutcome: null, goalCrossed: false` while the
          // dive says `confirmed_goal` (authority `frame`, corroborated, 12
          // frame refs) — the gate read only the flags and refused every honest
          // goal clause on two promoted rows.
          goalConfirmed: row.goalConfirmed ?? row.confirmAttestation?.goalConfirmed ?? null,
        }
      : null,
  };
}

export { SUMMARY_FEE_RATIO };
