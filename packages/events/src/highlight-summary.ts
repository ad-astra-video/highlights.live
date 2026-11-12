// ADAAAA-8668 (spec ADAAAA-8665 §3): the `summary` copy lane — BODY copy under
// the card's `postTitle` headline.
//
// Why: the card's copy target is a one-clause headline (`postTitle`, ADAAAA-8318
// / ADAAAA-8302 Option 2) and the descriptive line (`caption`) is capped at 110
// chars and rendered collapsed. Measured announcer copy on QA v10 job `28214400`
// is p50 41 chars, and the model title lane serves 2 of 2157 stored rows, so most
// cards read `GOAL · 2:38`. The board's report is "dry and short to the point
// they dont provide much value". Neither ratified shape is reverted here: this
// module adds a THIRD, additive lane beside them.
//
// This module owns the whole COPY CONTRACT in one place, so the server write
// seam (services/server/src/summary-lane.ts), the decide service's prompt and
// QA's gate replay cannot drift:
//   * the depth bands (live / VOD) and every hard ceiling;
//   * the deterministic clamp (extractive only — deletes, never rewrites);
//   * the gate composition, reusing the EXISTING grounding helpers
//     (`stripInternalTokens`, `gateGoalClaims`, `gateAbsenceClaims`,
//     `groundNames`) rather than a second gate;
//   * the "depth must not depend on a name" rule (ADAAAA-8456 lesson): a summary
//     with no attested name still earns its place from score / clock / action
//     facts;
//   * the `caption` de-duplication bar (normalized token overlap < 0.5);
//   * the prompt itself, so a prompt-contract snapshot test is possible.
//
// Nothing here calls a model, touches the decide prompt or the decide contract,
// or reads the store: it is pure so the contract is unit-testable without a
// pipeline.
import {
  gateAbsenceClaims,
  gateGoalClaims,
  groundNames,
  hasGoalClaim,
  isTaxonomyToken,
  placePhraseOf,
  stripInternalTokens,
  taxonomyKey,
  attestedBallActionFrom,
  carriesAuditMarker,
  BALL_OUTCOME_ASSERTION,
  ROLE_NOUN_FORM_ALT,
  SUMMARY_ROLE_NOUN_GROUPS,
  type CaptionGroundingContext,
  type SummaryRoleNoun,
} from "./caption-grounding.js";
import { hasPlacePhrase } from "./caption-grounding.js";

/** Which rail produced the row: the depth band follows the rail, never the
 *  caller's mood. */
export type SummaryRail = "live" | "vod";

/** One depth band. Target band = what the prompt asks for; `floorWords` is the
 *  bar below which a reply is too thin to serve (the spec's `p10 >= 18` bar is a
 *  distribution bar, and the per-row floor is what makes it reachable); the hard
 *  maxima are the spec's reject bars. */
export interface SummaryDepthBand {
  rail: SummaryRail;
  /** Sentences the prompt asks for (min..max). */
  minSentences: number;
  maxSentences: number;
  /** Words the prompt asks for (min..max). */
  targetMinWords: number;
  targetMaxWords: number;
  /** Per-row floor: a reply below this is refused (`too-few-words`). */
  floorWords: number;
  /** Hard reject bars (never clamped silently — the clamp deletes down TO them,
   *  and a reply that cannot be clamped into shape is refused). */
  hardMaxWords: number;
  hardMaxChars: number;
}

/** Live: 2-3 sentences / 25-55 words, p10 >= 18, hard reject > 70 words / 420 chars. */
export const SUMMARY_LIVE_BAND: SummaryDepthBand = {
  rail: "live",
  minSentences: 2,
  maxSentences: 3,
  targetMinWords: 25,
  targetMaxWords: 55,
  floorWords: 18,
  hardMaxWords: 70,
  hardMaxChars: 420,
};

/** VOD: 3-5 sentences / aim 45-55 words / floor 40, hard reject > 120 words / 700
 *  chars.
 *
 *  ADAAAA-8791: the floor sits at the spec's 40-word bar, not at the old 0.72x
 *  fraction (30), which let a 36-word body serve as `accepted` on promoted row
 *  `0526c296` of job `a200d2bd`. A draft under `floorWords` is a `too-few-words`
 *  refusal.
 *
 *  ADAAAA-8803: the TARGET band is now ABOVE the floor (45-55, not 40-90). The
 *  served VOD leg of job `4e5ddf8d` landed its only accepted body on exactly 41
 *  words — one word over the floor — so "compliant" was a single-word boundary
 *  case that the next fresh sample could miss in either direction. Asking for a
 *  band well clear of the floor keeps a compliant draft off the boundary, and the
 *  retry (see `summaryRetryMinWords`) asks for the floor plus a margin. The floor
 *  itself is unchanged: it is the SERVE bar, and the gate is the same gate. */
export const SUMMARY_VOD_BAND: SummaryDepthBand = {
  rail: "vod",
  minSentences: 3,
  maxSentences: 5,
  targetMinWords: 45,
  targetMaxWords: 55,
  floorWords: 40,
  hardMaxWords: 120,
  hardMaxChars: 700,
};

export function summaryBand(rail: SummaryRail): SummaryDepthBand {
  return rail === "vod" ? SUMMARY_VOD_BAND : SUMMARY_LIVE_BAND;
}

/** ADAAAA-8803: the word margin a RETRY is asked to clear above the floor.
 *
 *  A retry that only restates the floor can re-land on it (the served VOD row
 *  `2f5a5796` retried to 34 words against a 40-word floor, six short). The retry
 *  instruction therefore asks for `floorWords + this margin`, i.e. 45 words when
 *  the floor is 40 — the same number the first-pass target band asks for. */
export const SUMMARY_RETRY_DEPTH_MARGIN_WORDS = 5;

/** The depth a retry is asked for: the band target, never less than the floor
 *  plus `SUMMARY_RETRY_DEPTH_MARGIN_WORDS`. Live resolves to its 25-word target;
 *  VOD resolves to 45 (floor 40 + 5). */
export function summaryRetryMinWords(band: SummaryDepthBand): number {
  return Math.max(band.targetMinWords, band.floorWords + SUMMARY_RETRY_DEPTH_MARGIN_WORDS);
}

/** R4 (rev 2, ADAAAA-8687): the caption-token coverage figure, kept ONLY as a
 *  per-row OBSERVATION. Rev 1 gated on it (`>= 0.5` => refused) and that refused
 *  100% of the promoted rows on the short-caption rail, so it is metered
 *  (`summaryCaptionOverlap`) and never drops a row. */
export function captionTokenOverlap(summary: string, caption?: string | null): number {
  const cap = new Set(normalizeSummaryTokens(caption ?? ""));
  if (cap.size === 0) return 0;
  const sum = new Set(normalizeSummaryTokens(summary ?? ""));
  let hit = 0;
  for (const t of cap) if (sum.has(t)) hit++;
  return hit / cap.size;
}

/**
 * Fee class. One summary call is metered as its own term and its ceiling is
 * 1.5x `DECIDE_FEE` per row (spec §4 AC5, §5 cost model). The ratio is the
 * CEILING, and the default fee sits at it: at the `.env.example` default
 * `DECIDE_FEE = 0.01` the summary term is $0.015/row, i.e. <= $10.38 per 30 days
 * at the measured 692-caption census — inside the spec's <= $10.35 projection
 * band (that projection rounds down). An operator can lower it with
 * `SUMMARY_FEE`; the resolved value is always clamped to the ceiling.
 */
export const SUMMARY_FEE_RATIO = 1.5;

/** Never more than one retry, so a row bills at most two calls (AC5).
 *  ADAAAA-8773: a DETERMINISTIC refusal (`too-few-facts`) ends the row on its
 *  first call — see `runSummaryForRow` in `services/server/src/summary-lane.ts`. */
export const SUMMARY_MAX_CALLS_PER_ROW = 2;

/** p95 generation budget after promotion (AC4: `summary` p95 <= 6 s). It is a
 *  post-promotion budget, never a live-path budget: nothing on the decide path
 *  waits on this. */
export const SUMMARY_GENERATION_P95_BUDGET_MS = 6_000;

/** Per-call timeout handed to the text-only decide call, under the p95 budget so
 *  one retry still fits inside it. */
export const SUMMARY_CALL_TIMEOUT_MS = 2_500;

/** ADAAAA-8687: how much of a REFUSED reply the write seam keeps as
 *  `summaryRaw`. Debug evidence only (never served, never rendered): the band's
 *  hard ceiling is 700 chars, so a reply inside its own contract is stored whole
 *  and only a runaway reply is clipped. */
export const SUMMARY_RAW_MAX_CHARS = 2_000;

/** Why a promoted row carries no `summary`. Named (never a free-form sentence)
 *  so a stored-row read can attribute a drop without a log join (AC6). */
export type SummaryDropReason =
  | "pool_busy"
  | "timeout"
  | "transport_failure"
  | "parse"
  | "gate"
  /** AC8 (rev 3): the body's opening run repeated another served body in the
   *  same job, and the ONE regeneration repeated too. The card still serves on
   *  its headline. */
  | "repeat";

export const SUMMARY_DROP_REASONS: readonly SummaryDropReason[] = [
  "pool_busy",
  "timeout",
  "transport_failure",
  "parse",
  "gate",
  "repeat",
];

/** Resolve the per-call fee: `override` when finite and positive, otherwise the
 *  ceiling `decideFee * SUMMARY_FEE_RATIO`; always clamped to the ceiling so a
 *  misconfigured `SUMMARY_FEE` can never breach AC5. */
export function resolveSummaryFee(decideFee: number, override?: number | null): number {
  const ceiling = Math.max(0, decideFee || 0) * SUMMARY_FEE_RATIO;
  const raw = typeof override === "number" && Number.isFinite(override) && override >= 0 ? override : ceiling;
  return Math.min(raw, ceiling);
}

// --- text metrics -----------------------------------------------------------

/** Words as a reader counts them: whitespace-separated runs carrying at least
 *  one letter or digit (a lone dash is not a word). */
export function summaryWordCount(text: string): number {
  return (text ?? "").split(/\s+/).filter((w) => /[A-Za-z0-9À-ÿ]/.test(w)).length;
}

/** Sentences: runs closed by `.`, `!`, `?` or `…`. A trailing unpunctuated run
 *  counts as one sentence (the clamp closes it), and a single-letter initial
 *  (`J. Smith`) never opens a new one. */
export function summarySentenceCount(text: string): number {
  const body = (text ?? "").trim();
  if (!body) return 0;
  const parts = body
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+(?=[A-ZÀ-Ý0-9"'“(])/u)
    .filter((s) => /[A-Za-z0-9À-ÿ]/.test(s));
  return parts.length;
}

/** Normalized tokens: lowercase, diacritics folded, punctuation dropped, digits
 *  and short function words removed. Numbers are dropped so a score line is
 *  compared as a FACT (below) rather than as token noise, and a clock never keeps
 *  a sentence alive on its own. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "as", "at", "by", "for", "from", "in", "into", "of", "on", "onto",
  "to", "with", "is", "was", "were", "be", "been", "are", "it", "its", "this", "that", "then", "than",
  "he", "she", "they", "his", "her", "their", "there", "here", "when", "while", "after", "before",
  "over", "under", "up", "down", "out", "off", "so", "just", "now", "again", "also", "very",
]);

export function normalizeSummaryTokens(text: string): string[] {
  const folded = (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!folded) return [];
  return folded.split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}


/** R1 (rev 2): the novel-detail FLOOR — distinct content tokens in the body
 *  that the caption does not carry. Below this the body adds only filler. */
export const SUMMARY_MIN_NOVEL_TOKENS = 8;

/** R2 (rev 2): the verbatim-echo CEILING — the longest contiguous WORD run (the
 *  normalized word sequence, stopwords kept: an echo detector, not a content
 *  measure) the body shares with the caption. */
export const SUMMARY_MAX_SHARED_RUN_TOKENS = 5;

/** Which rev-2 restatement clause a body failed (R1/R2/R3). */
export type SummaryRestatementClause = "novel-detail" | "verbatim-echo" | "subset-echo";

/** Everything R1-R3 measured, both for the gate and for the AC2 replay QA runs. */
export interface SummaryRestatement {
  /** R1: distinct body content tokens the caption does not carry. */
  novelTokens: number;
  /** R2: longest contiguous normalized-word run shared with the caption. */
  longestSharedRun: number;
  /** R3: every caption content token appears in the body. */
  captionSubset: boolean;
  /** R4 (observation only, never a gate): share of the caption's content tokens
   *  the body reuses. Metered per row so drift stays visible. */
  overlap: number;
  /** The clauses that failed, in R1 -> R2 -> R3 order. */
  failed: SummaryRestatementClause[];
  /** `failed.length > 0` — the body is a restatement and must not be served. */
  restates: boolean;
}

/** Lowercased, diacritic-folded word sequence (numbers and stopwords KEPT). R2's
 *  echo detector works on words, not on content tokens: "ball shoots in" is the
 *  same echo whether or not `in` is a stopword. */
export function summaryWords(text?: string | null): string[] {
  const folded = (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return folded ? folded.split(" ").filter(Boolean) : [];
}

// --- AC8: distinct openings ------------------------------------------------

/** AC8 (spec ADAAAA-8665 rev 3): the normalized opening run compared ACROSS a
 *  job's served bodies. Four words is the spec's bar, and the run is built with
 *  the same normalized WORD sequence the caption-echo bar uses (`summaryWords`),
 *  so "The midfielder drives forward" and "the MIDFIELDER drives, forward"
 *  collide instead of hiding behind punctuation. */
export const SUMMARY_OPENING_RUN_WORDS = 4;

/** AC8 rev 4 (ADAAAA-8735): a LEADING clock/timestamp is not part of an opening.
 *  On job `9891ff33` six of ten served bodies opened `At <m:ss>, …`, so the
 *  four-word run began with the clock and two bodies whose prose was otherwise
 *  identical ("the ball shoots on the right side of the field…") compared
 *  DISTINCT — the as-built scan reported 0 duplicate pairs where a
 *  clock-stripped scan reports 18. Strip the prefix (bare `m:ss`, `At m:ss,`,
 *  `At the m:ss mark`, `T+…`) BEFORE taking the run; a clock in the middle of a
 *  body is not an opening and is left alone. */
const OPENING_CLOCK_PREFIX_RE =
  /^\s*[\[(]?\s*(?:(?:at|around|by|near|on)\s+)?(?:the\s+)?(?:(?:t\s*\+\s*(?:\d{1,3}:\d{2}(?::\d{2})?|\d+(?:\.\d+)?\s*s?))|(?:\d{1,3}:\d{2}(?::\d{2})?))\s*(?:s(?:ec(?:onds?)?)?)?\s*(?:mark)?\s*[\])]?\s*[,.;:—–-]*\s*/i;

/** The opening run of a body ("the midfielder drives forward"), or "" when the
 *  body is empty. Shorter bodies compare on whatever they have. */
export function summaryOpeningRun(text: string, words = SUMMARY_OPENING_RUN_WORDS): string {
  const body = (text ?? "").replace(OPENING_CLOCK_PREFIX_RE, "");
  return summaryWords(body).slice(0, Math.max(1, words)).join(" ");
}

/** Longest contiguous run of words shared by `a` and `b` (classic DP, O(n*m)). */
export function longestSharedWordRun(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * ADAAAA-8687 / spec ADAAAA-8665 rev 2: is the body a RESTATEMENT of the
 * announcer caption?
 *
 * Rev 1 graded this as `captionTokenOverlap < 0.5`, a ratio over the CAPTION's
 * tokens. On the shipped short captions (2-5 content tokens) any faithful
 * elaboration reuses all of them, so it refused 3/3 live and 4/4 VOD promoted
 * rows. Rev 2 replaces it with three novelty clauses:
 *
 *  - R1 novel detail: >= SUMMARY_MIN_NOVEL_TOKENS distinct content tokens the
 *    caption does not carry (the "adds detail" half of the rule).
 *  - R2 no verbatim echo: no contiguous word run longer than
 *    SUMMARY_MAX_SHARED_RUN_TOKENS shared with the caption (the "must not
 *    restate" half).
 *  - R3 no subset echo: the caption's content tokens are not ALL present in the
 *    body. R3 is read together with R1, as its parenthetical states: a superset
 *    that adds ONLY FILLER is the restatement at any length. A body that carries
 *    every caption token and ALSO clears R1's novel-detail floor is not "only
 *    filler", so it passes — otherwise R3 and AC1 are mutually unsatisfiable on
 *    the short-caption rail (every 25-word elaboration of "Ball shoots in
 *    midfield" mentions ball, shoots and midfield; refusing all of them is the
 *    rev-1 failure in a new costume).
 *
 * `captionTokenOverlap` is still computed (R4) and is metered per row, but it is
 * never a drop reason.
 */
export function summaryRestatement(summary: string, caption?: string | null): SummaryRestatement {
  const cap = new Set(normalizeSummaryTokens(caption ?? ""));
  const bodyTokens = [...new Set(normalizeSummaryTokens(summary ?? ""))];
  const overlap = captionTokenOverlap(summary, caption);
  const novelTokens = bodyTokens.filter((t) => !cap.has(t)).length;
  const longestSharedRun = longestSharedWordRun(summaryWords(summary), summaryWords(caption));
  const captionSubset = cap.size > 0 && [...cap].every((t) => bodyTokens.includes(t));
  const failed: SummaryRestatementClause[] = [];
  // No caption to restate: the depth/fact bars own that row, and a missing
  // caption must never fail a row closed.
  if (cap.size > 0 && bodyTokens.length > 0) {
    if (novelTokens < SUMMARY_MIN_NOVEL_TOKENS) failed.push("novel-detail");
    if (longestSharedRun > SUMMARY_MAX_SHARED_RUN_TOKENS) failed.push("verbatim-echo");
    // R3 = subset echo: every caption token present AND the novel floor unmet,
    // i.e. the body adds only filler.
    if (captionSubset && novelTokens < SUMMARY_MIN_NOVEL_TOKENS) failed.push("subset-echo");
  }
  return { novelTokens, longestSharedRun, captionSubset, overlap, failed, restates: failed.length > 0 };
}

/** The boolean form the gate uses.
 *
 *  ADAAAA-8806 (defect 3 on job `3740585f`): the restatement bar must not refuse
 *  a body that carries an attested fact the caption does NOT carry. Measured
 *  defect: row `6ff00ac9`'s body read "… during the match involving **Barcelona**
 *  …" while its served caption named nothing, and `summaryViolations` refused the
 *  body `restates-caption` because the caption's own tokens ("shoots", "right")
 *  reappeared. That is the opposite of restatement: the body was the only surface
 *  with the entity. When `evidence` is supplied, a body that names an attested
 *  team/player (or carries an attested score line) the caption does not is
 *  exempt.
 */
export function captionRestatesSummary(
  summary: string,
  caption?: string | null,
  evidence?: SummaryEvidence | null
): boolean {
  const restatement = summaryRestatement(summary, caption);
  if (!restatement.restates) return false;
  if (evidence && summaryAddsAttestedFact(summary, caption, evidence)) return false;
  return true;
}

/** ADAAAA-8806: does `summary` carry an ATTESTED entity or score line that
 *  `caption` lacks? Both directions are read from the row's own evidence, so no
 *  new source is introduced. */
export function summaryAddsAttestedFact(
  summary: string,
  caption: string | null | undefined,
  evidence: SummaryEvidence
): boolean {
  const cap = caption ?? "";
  // An attested team/player named by the body and not by the caption.
  if (bodyNamesAttestedActor(summary, evidence) && !bodyNamesAttestedActor(cap, evidence)) return true;
  // An attested score line in the body that the caption does not carry.
  const capFacts = summaryFacts(cap).filter((f) => f.kind === "score");
  const bodyScores = summaryFacts(summary).filter((f) => f.kind === "score");
  for (const fact of bodyScores) {
    const grounded =
      scoreFactGrounded(fact.text, evidence) ||
      (!!evidence.adjacentScoreCue && sameScore(evidence.adjacentScoreCue, fact.text));
    if (!grounded) continue;
    const shared = capFacts.some((c) => sameScore(c.text, fact.text) || cap.includes(fact.text));
    if (!shared) return true;
  }
  return false;
}

// --- facts -----------------------------------------------------------------

/** The fact classes the spec accepts as "depth": `score` (a score line),
 *  `clock` (a clock stamp or a spell), `venue` (competition / venue), and
 *  `action` (an attested player action). */
export type SummaryFactKind = "score" | "clock" | "venue" | "action";

const SCORE_RE = /(?<![\w:.])\d{1,2}\s*[-–—]\s*\d{1,2}(?![\w:]|\.\d)/;
const CLOCK_RE = /\b\d{1,3}:\d{2}\b/;
const SPELL_RE = /\b(?:first|second|third|fourth|final|opening|closing)\s+(?:half|period|quarter|set|inning|leg|frame|round)\b|\bhalf[- ]time\b|\bfull[- ]time\b|\bextra[- ]time\b|\badded\s+time\b|\bstoppage\s+time\b|\b\d{1,2}(?:st|nd|rd|th)\s+(?:minute|min)\b|\bminute\s+\d{1,2}\b/i;
const VENUE_RE = /\b(?:stadium|arena|ground|park|cup|league|championship|tournament|series|derby|final|semi[- ]final|quarter[- ]final|group\s+[A-H]|matchday|round\s+of\s+\d+)\b/i;
/** An action verb the row can attest (never an inference verb). */
const ACTION_RE = /\b(?:scores?|scored|strikes?|struck|shoots?|shot|heads?|headed|finishes?|finished|converts?|converted|buries|buried|taps?|tapped|rolls?|rolled|slots?|slotted|drives?|drove|saves?|saved|blocks?|blocked|tackles?|tackled|passes?|passed|crosses?|crossed|clears?|cleared|wins|won|levels?|levelled|equalises?|equalised|restores?|restored|answers?|answered|completes?|completed|nets?|netted|rips?|ripped|fires?|fired|volleys?|volleyed|lobs?|lobbed|curls?|curled|assists?|assisted)\b/i;

/** Every fact the summary asserts, with the substring that carries it. */
export function summaryFacts(text: string): { kind: SummaryFactKind; text: string }[] {
  const body = text ?? "";
  const out: { kind: SummaryFactKind; text: string }[] = [];
  const score = body.match(SCORE_RE);
  if (score) out.push({ kind: "score", text: score[0] });
  const clock = body.match(CLOCK_RE);
  if (clock) out.push({ kind: "clock", text: clock[0] });
  const spell = body.match(SPELL_RE);
  if (spell) out.push({ kind: "clock", text: spell[0] });
  const venue = body.match(VENUE_RE);
  if (venue) out.push({ kind: "venue", text: venue[0] });
  const action = body.match(ACTION_RE);
  if (action) out.push({ kind: "action", text: action[0] });
  return out;
}

/** Facts the TITLE does not already carry. A fact counts as new when its own
 *  normalized form is absent from the title's normalized text (so a headline
 *  `GOAL · 2:38` leaves `2-1`, `second half`, `Champions League` and every
 *  attested action available as new facts). */
export function newSummaryFacts(summary: string, title?: string | null): { kind: SummaryFactKind; text: string }[] {
  const titleNorm = ` ${normalizeSummaryTokens(title ?? "").join(" ")} `;
  return summaryFacts(summary).filter((f) => {
    const norm = normalizeSummaryTokens(f.text).join(" ");
    // A bare clock/score token normalizes to nothing (numbers are dropped), so
    // compare it verbatim against the title too.
    if (titleNorm.trim() && norm && titleNorm.includes(` ${norm} `)) return false;
    if ((f.kind === "score" || f.kind === "clock") && (title ?? "").includes(f.text)) return false;
    return true;
  });
}

/** ADAAAA-8735: the evidence renderer's own KEY LABELS are not entities. The
 *  served defect read `Teams:` as a team name and glued the next line onto it
 *  (`"Barcelona\nBall"`). */
const SUMMARY_CONTEXT_LABEL_RE =
  /^\s*(?:teams?|sides?|players?|roster|kit\s*colou?rs?|kits|competition|tournament|league|venue|stadium|ground|arena|match\s*context)\s*:\s*/i;

/** ADAAAA-8735: words that are capitalized only because they OPEN A SENTENCE (or
 *  are a card label), never because they name a team or a player. The measured
 *  defect credited `action` off the sentence-initial capital of `Ball` in the
 *  decide reason `"Ball shoots on the left."`: `ball` is the sport's common noun,
 *  not an actor. A real single-token entity (`Barcelona`, `Northbridge`) is not
 *  in this set and still attests. */
const SUMMARY_NON_ENTITY_WORDS = new Set([
  "a", "an", "the", "this", "that", "it", "he", "she", "they", "his", "her", "their", "there", "here",
  "then", "when", "while", "after", "before", "and", "but", "so", "as", "at", "in", "on", "of", "to",
  "for", "from", "with", "by", "near", "far", "left", "right", "centre", "center",
  "ball", "balls", "shot", "shots", "goal", "goals", "play", "plays", "move", "moves", "match", "game",
  "crowd", "keeper", "goalkeeper", "goalie", "referee", "striker", "midfielder", "defender", "winger",
  "captain", "player", "players", "team", "teams", "side", "sides", "score", "scoreboard",
  "net", "post", "box", "wing", "midfield", "half", "minute", "minutes", "second", "first", "third",
  "fourth", "final", "opening", "closing", "added", "stoppage", "kick", "pass", "cross", "header",
  "save", "corner", "penalty", "foul", "attack", "counter", "soccer", "football", "basketball",
  "sport", "sports", "action", "highlight", "moment", "sequence", "field", "pitch", "court",
  "stadium", "arena", "venue", "competition", "league", "cup", "matchday",
]);

/** Capitalized runs on ONE line. A run never crosses a newline: the served defect
 *  rendered `Teams:` + `Barcelona` + `Ball` on three lines and the regex joined
 *  the last two into one "name". */
function capitalizedRuns(line: string): string[] {
  return (
    line.match(
      /\b[A-ZÀ-Ý][a-zà-ÿ'’.-]+(?:\s+(?:de|van|der|dos|da|di|del)\s+)?(?:\s+[A-ZÀ-Ý][a-zà-ÿ'’.-]+)*\b/g
    ) ?? []
  );
}

/** One capitalized run -> an entity name, or null when every word in it is a
 *  common noun / label word (i.e. the capital is only sentence position). The
 *  whole run is kept once any token survives, so a competition name keeps both
 *  of its words ("Champions League"). */
function entityNameOf(run: string): string | null {
  const words = run.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const kept = words.filter((w) => !SUMMARY_NON_ENTITY_WORDS.has(w.toLowerCase().replace(/[^a-zà-ÿ'’-]/g, "")));
  if (kept.length === 0 || run.trim().length <= 2) return null;
  return run.trim();
}

/** The name-like strings a text attests: capitalized runs from structured
 *  sources (teams, players, transcript), NOT from the model's own sentence.
 *  Renderer labels (`Teams:`) and sentence-initial common nouns (`Ball`) are
 *  filtered, so this cannot manufacture an attested actor. The name GATE stays
 *  `groundNames`; this only decides whether an entity is attested. */
export function attestedEntityNames(evidence?: string | null): string[] {
  const body = evidence ?? "";
  if (!body) return [];
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(SUMMARY_CONTEXT_LABEL_RE, "");
    for (const run of capitalizedRuns(line)) {
      const name = entityNameOf(run);
      if (name) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** The team/player names the job's matchContext STRUCTURALLY carries. Read from
 *  the fields rather than from the rendered text, so a label can never be read
 *  as a name. */
export function matchContextEntityNames(matchContext: unknown): string[] {
  if (!matchContext || typeof matchContext !== "object") return [];
  const mc = matchContext as Record<string, any>;
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
    else if (value && typeof value === "object") {
      const obj = value as Record<string, any>;
      for (const key of ["name", "team", "label"]) {
        if (typeof obj[key] === "string" && obj[key].trim()) {
          out.push(obj[key].trim());
          return;
        }
      }
    }
  };
  for (const key of ["teams", "sides"]) {
    const teams = mc[key];
    if (Array.isArray(teams)) teams.forEach(push);
    else push(teams);
  }
  for (const key of ["players", "roster"]) {
    const players = mc[key];
    if (Array.isArray(players)) players.forEach(push);
  }
  return [...new Set(out)];
}

/** ADAAAA-8735: the ACTORS a row can legitimately name — the match context's
 *  teams/players plus names the ASR transcript carries. The decide `reason` and
 *  the announcer `caption` are GENERATED copy, so they are deliberately not
 *  sources: that is exactly how `Ball` came to attest itself. */
export function attestedActorNames(evidence: SummaryEvidence): string[] {
  return [
    ...new Set([
      ...matchContextEntityNames(evidence.matchContext),
      ...attestedEntityNames(evidence.transcript ?? ""),
    ]),
  ];
}

/**
 * ADAAAA-8831: every entity the job's matchContext TRAIL names.
 *
 * The trail is the resolver's own measured attribution (scorebug OCR + the
 * commentary it folded in) and it can name a side the resolver never promoted
 * into `teams`: on live leg `27bd816f` every row's resolved teams were
 * `["Barcelona"]` while the same job's trail carried an explicit
 * `{"name":"Real Madrid","side":"home"}` entry from the `RMA2-2 BAR` scorebug
 * read. `renderSummaryContext` prints `teams` only, so `summaryEvidenceText` —
 * the evidence the NAME gate is held to — never contained Real Madrid, and a body
 * that names a team the box actually measured was refused `ungrounded-name`.
 *
 * This is evidence completeness, not a loosening: the trail is structured
 * measured data about THIS match, read the same way `roleAttestationText` already
 * reads the raw matchContext for role attestation. Nothing generated (reason,
 * caption, postTitle) is added.
 */
export function matchContextTrailNames(matchContext: unknown): string[] {
  if (!matchContext || typeof matchContext !== "object") return [];
  const trail = (matchContext as Record<string, any>).trail;
  if (!Array.isArray(trail)) return [];
  const out: string[] = [];
  for (const entry of trail) {
    if (!entry || typeof entry !== "object") continue;
    const names = (entry as Record<string, any>).names;
    if (!Array.isArray(names)) continue;
    for (const item of names) {
      if (typeof item === "string" && item.trim()) out.push(item.trim());
      else if (item && typeof item === "object") {
        for (const key of ["name", "team", "label"]) {
          const value = (item as Record<string, any>)[key];
          if (typeof value === "string" && value.trim()) {
            out.push(value.trim());
            break;
          }
        }
      }
    }
  }
  return [...new Set(out)];
}

/** True when `body` NAMES one of `names`. Whole-phrase match on the normalized
 *  word sequence; a multi-token roster name ("Virgil van Dijk") is also matched
 *  by any of its distinctive tokens ("van Dijk", "Dijk"). */
export function bodyNamesEntity(body: string, names: string[]): boolean {
  const words = summaryWords(body);
  if (words.length === 0) return false;
  const haystack = ` ${words.join(" ")} `;
  for (const name of names) {
    const parts = summaryWords(name);
    if (parts.length === 0) continue;
    if (haystack.includes(` ${parts.join(" ")} `)) return true;
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length >= 3 && haystack.includes(` ${part} `)) return true;
      }
    }
  }
  return false;
}

/** ADAAAA-8735: the body names an attested team/player. Action is a CREDITED
 *  fact only when this holds — a bare verb with no named actor is not one. */
export function bodyNamesAttestedActor(body: string, evidence: SummaryEvidence): boolean {
  return bodyNamesEntity(body, attestedActorNames(evidence));
}

/** True when the summary carries at least one attested entity: a name the
 *  evidence carries, a team/player the match context names, or a labeled
 *  score/clock fact. The LAST clause is the ADAAAA-8456 lesson — a name shortage
 *  must never starve depth. */
export function hasAttestedEntity(summary: string, evidence?: string | null): boolean {
  const body = summary ?? "";
  const names = attestedEntityNames(evidence);
  for (const name of names) if (body.includes(name)) return true;
  // Score/clock facts are entity-free and still earn the row's place.
  const kinds = summaryFacts(body).map((f) => f.kind);
  return kinds.includes("score") || kinds.includes("clock") || kinds.includes("venue");
}

// --- clamp -----------------------------------------------------------------

/** Close a sentence the model left open, without inventing content. */
function closeSentence(text: string): string {
  const body = (text ?? "").trim();
  if (!body) return "";
  return /[.!?…]$/.test(body) ? body : `${body}.`;
}

/**
 * EXTRACTIVE depth clamp (deletes only, never rewrites, never invents).
 *
 * Order matters: drop trailing sentences first (the depth band is a sentence
 * band), then trim trailing words, then re-close. A reply that is already inside
 * the band is returned byte-identical, so a stored value can be reproduced.
 */
export function clampSummaryDepth(text: string, rail: SummaryRail = "live"): string {
  const band = summaryBand(rail);
  let out = (text ?? "").replace(/\s+/g, " ").trim();
  if (!out) return "";
  out = closeSentence(out);
  const sentences = out.split(/(?<=[.!?…])\s+/).filter(Boolean);
  // 1. sentence ceiling
  while (sentences.length > band.maxSentences) sentences.pop();
  out = sentences.join(" ").trim();
  // 2. word ceiling
  if (summaryWordCount(out) > band.hardMaxWords) {
    const words = out.split(/\s+/);
    out = words.slice(0, band.hardMaxWords).join(" ");
    // prefer ending on a sentence boundary the truncation left behind
    const lastEnd = Math.max(out.lastIndexOf(". "), out.lastIndexOf("! "), out.lastIndexOf("? "));
    if (lastEnd > 0 && summaryWordCount(out.slice(0, lastEnd + 1)) >= band.floorWords) out = out.slice(0, lastEnd + 1);
    out = closeSentence(out);
  }
  // 3. char ceiling (a single long word run can survive the word cap)
  if (out.length > band.hardMaxChars) {
    const cut = out.slice(0, band.hardMaxChars);
    const lastEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    out = lastEnd > 0 ? cut.slice(0, lastEnd + 1) : closeSentence(cut.replace(/\s+\S*$/, ""));
  }
  return out.trim();
}

// --- gate ------------------------------------------------------------------

export type SummaryViolation =
  | "empty"
  | "too-few-words"
  | "too-many-words"
  | "too-long"
  | "too-few-sentences"
  | "too-many-sentences"
  | "internal-token"
  | "clock-prefix"
  | "em-dash-chain"
  | "place-chain"
  | "goal-claim"
  | "absence-claim"
  | "ungrounded-name"
  | "speculative-verb"
  | "restates-caption"
  | "no-new-fact"
  | "no-attested-entity"
  /** AC10 (rev 3): a role noun the row's evidence does not attest. */
  | "unattested-role"
  /** AC9 (rev 3): fewer than two DISTINCT attested fact types. */
  | "too-few-facts"
  /** ADAAAA-8806 (AC9): the body asserts what the BALL did while the row's own
   *  attestation recorded no ball outcome. */
  | "unattested-action";

/**
 * ADAAAA-8773 / spec §13.2 (rev 7): the refusals a SECOND sample cannot repair.
 *
 * The same prompt, re-sampled, cannot fix a deterministic defect: the row's fact
 * menu is fixed, its own evidence does not carry the name the body invented, and
 * the enum shape of an internal token does not change. QA measured the retry
 * buying `$0.0049986` to reach the identical `too-few-facts` refusal on both VOD
 * rows of job `70400b1d`. The lane keeps the retry slot for the AC8 repeat path
 * only, where a different opening is plausible by construction.
 */
export const SUMMARY_DETERMINISTIC_REFUSALS: readonly SummaryViolation[] = [
  "too-few-facts",
  "ungrounded-name",
  "internal-token",
];

/**
 * ADAAAA-8806: is THIS refusal repairable by one more sample of the same prompt?
 *
 * `too-few-facts` was treated as deterministic unconditionally, which is right
 * only when the row's own evidence cannot nourish two fact types. When the menu
 * DOES offer two (the measured rows of job `3740585f` offered clock + a named
 * Barcelona action), a clock-only reply is a SAMPLING miss — the reply, not the
 * row, is thin — so the retry slot (still `SUMMARY_MAX_CALLS_PER_ROW`, AC5) is
 * spent on a repair instruction instead of giving up on the row. Measured cost
 * of the wrong rule: row `2d8e9521` dropped after ONE call although `Barcelona`
 * was attested in its own `matchContext`.
 */
export function summaryRefusalIsRepairable(
  violation: SummaryViolation,
  evidence: SummaryEvidence
): boolean {
  if (!SUMMARY_DETERMINISTIC_REFUSALS.includes(violation)) return true;
  if (violation === "too-few-facts") {
    return attestedFactKinds(evidence).length >= SUMMARY_MIN_FACT_KINDS;
  }
  return false;
}

/** The evidence a summary is gated against. Everything is the ROW's own
 *  evidence; a missing field fails closed (never invents). */
export interface SummaryEvidence {
  rail: SummaryRail;
  /** The window's stored verdict (scoring_play / near_miss / big_play / not_highlight). */
  verdict?: string | null;
  eventType?: string | null;
  /** The decide reason for this window (already gated). */
  reason?: string | null;
  /** The card's served headline — the "facts the title does not carry" baseline. */
  postTitle?: string | null;
  /** The stored announcer line — the de-duplication baseline. */
  caption?: string | null;
  /** Window content time (stream seconds) and its duration. */
  windowTs?: number | null;
  windowDurationS?: number | null;
  /** Measured score transition for this window, when one exists. */
  scoreTransition?: { from?: string | null; to?: string | null } | null;
  /** The job's persisted match context (teams / players / kit colours). */
  matchContext?: unknown;
  /** The window's ASR transcript. */
  transcript?: string | null;
  /** An adjacent scoring cue (the neighbouring scoring window's line), when one exists. */
  adjacentScoreCue?: string | null;
  /**
   * ADAAAA-8806 (AC9 on the body): the row's folded goal attestation, as the
   * record carries it (`attestationUsed`). Absent => no attestation on this
   * surface, and every bar below keeps today's behaviour byte-identically.
   *
   * Read for ONE thing: whether the window recorded a ball OUTCOME. A body may
   * not assert what the ball did when the row's own measurement says nothing was
   * measured — the measured defect is row `6ff00ac9` of job `3740585f`
   * (`ballOutcome: none`, `goalCrossed: false`) served as "The ball shoots on
   * the right.".
   */
  attestation?: {
    ballOutcome?: string | null;
    goalCrossed?: boolean | null;
    scoreBoardChanged?: boolean | null;
  } | null;
}

/** ADAAAA-8806 (AC9): does the row's attestation record NO ball outcome? `null`
 *  when the surface carries no attestation at all (legacy / VOD rows), so every
 *  existing body keeps its behaviour. */
export function summaryBallActionAttested(evidence: SummaryEvidence): boolean | null {
  return attestedBallActionFrom(evidence.attestation ?? null);
}

/** ADAAAA-8806 (AC9): the body asserts what the ball did while the row's own
 *  measurement recorded nothing. */
export function bodyAssertsUnattestedAction(text: string, evidence: SummaryEvidence): boolean {
  if (summaryBallActionAttested(evidence) !== false) return false;
  return BALL_OUTCOME_ASSERTION.test(text ?? "");
}

const SPECULATIVE_RE = /\b(?:appeared\s+to|seemed\s+to|looked\s+like|looks\s+like|might\s+have|may\s+have|could\s+have|perhaps|possibly|probably)\b/i;
const CLOCK_PREFIX_RE = /^T\s*\+\s*(?:\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s)\b/i;
/** A multi-sentence body legitimately keeps periods; what it may not keep is the
 *  internal ` — ` continuation shape the announcer lane banned (a second beat
 *  glued on with a dash). */
const EM_DASH_CHAIN_RE = /\s[—–]\s/;

/**
 * A PLACE CHAIN, not a place mention: body copy may legitimately name a zone
 * ("at the near post"), so the ban is the announcer lane's shape — the SAME zone
 * tail closing two or more sentences ("… in the box. … in the box."). Composed
 * from the existing `placePhraseOf` helper (no second place gate).
 */
function hasPlaceChain(text: string): boolean {
  const sentences = (text ?? "").split(/(?<=[.!?…])\s+/).filter(Boolean);
  const tails = new Map<string, number>();
  for (const sentence of sentences) {
    const tail = placePhraseOf(sentence).trim().toLowerCase();
    if (!tail) continue;
    tails.set(tail, (tails.get(tail) ?? 0) + 1);
  }
  for (const count of tails.values()) if (count >= 2) return true;
  return false;
}

/** Plain-text view of the match context for prompting / evidence. */
export function renderSummaryContext(matchContext: unknown): string {
  if (!matchContext || typeof matchContext !== "object") return "";
  const mc = matchContext as Record<string, any>;
  const lines: string[] = [];
  const teams = mc.teams ?? mc.sides;
  if (Array.isArray(teams)) {
    const named = teams
      .map((t: any) => (typeof t === "string" ? t : t?.name ?? t?.team ?? t?.label))
      .filter(Boolean)
      .join(" vs ");
    if (named) lines.push(`Teams: ${named}`);
  } else if (typeof mc.teams === "string" && mc.teams.trim()) {
    lines.push(`Teams: ${mc.teams.trim()}`);
  }
  const players = mc.players ?? mc.roster;
  if (Array.isArray(players)) {
    const named = players
      .map((p: any) => (typeof p === "string" ? p : p?.name))
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    if (named) lines.push(`Players: ${named}`);
  }
  const kits = mc.kitColors ?? mc.kitColours ?? mc.kits;
  if (kits && typeof kits === "object" && !Array.isArray(kits)) {
    const rendered = Object.entries(kits as Record<string, unknown>)
      .map(([k, v]) => `${k} ${String(v)}`)
      .join(", ");
    if (rendered) lines.push(`Kit colours: ${rendered}`);
  }
  const competition = mc.competition ?? mc.tournament ?? mc.league;
  if (typeof competition === "string" && competition.trim()) lines.push(`Competition: ${competition.trim()}`);
  const venue = mc.venue ?? mc.stadium;
  if (typeof venue === "string" && venue.trim()) lines.push(`Venue: ${venue.trim()}`);
  return lines.join("\n");
}

/** The evidence text the name gate is held to: the row's OWN sources (match
 *  context + ASR + the gated reason + a measured score line), never the model's
 *  summary. */
export function summaryEvidenceText(evidence: SummaryEvidence): string {
  const parts = [
    renderSummaryContext(evidence.matchContext),
    // ADAAAA-8831: the match context's own measured ATTRIBUTION trail. A side
    // the resolver folded into the trail but not into `teams` (live leg
    // `27bd816f`: teams `["Barcelona"]`, trail `Real Madrid` home) is a name the
    // box measured, so a body may name it.
    matchContextTrailNames(evidence.matchContext).join("\n"),
    evidence.transcript ?? "",
    evidence.reason ?? "",
    evidence.adjacentScoreCue ?? "",
    evidence.scoreTransition?.to ? `score ${evidence.scoreTransition.to}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

/** The grounding context the summary gate composes with the existing helpers. */
export function summaryGroundingContext(evidence: SummaryEvidence): CaptionGroundingContext {
  return {
    verdict: evidence.verdict ?? null,
    // The window's own evidence: prompt-view of the sources the row actually has.
    promptText: summaryEvidenceText(evidence),
    eventType: evidence.eventType ?? null,
    // A summary is BODY copy: it never gets the absence-claim exemption (a quiet
    // read is not evidence that something did not happen), and the name gate is
    // held to the row's own copy as well (ADAAAA-8411 hygiene).
    absenceEvidence: false,
    ownCopy: evidence.caption ?? null,
  };
}

// --- AC10: role nouns are attestation claims -------------------------------

// ADAAAA-8831: the vocabulary itself now lives beside the name gate in
// `caption-grounding` (the post TITLE reads the same table), and is re-exported
// here so this module's public surface is unchanged.
export {
  SUMMARY_ROLE_NOUN_GROUPS,
  ROLE_NOUN_FORM_ALT,
  type SummaryRoleNoun,
};

const ROLE_DETERMINER = "(?:the|a|an|their|its|his|her)";
const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every role form, longest first so "central midfielder" wins over "midfielder". */
const ROLE_ALT = ROLE_NOUN_FORM_ALT;
const ROLE_PHRASE_SOURCE = `\\b${ROLE_DETERMINER}\\s+(${ROLE_ALT})\\b`;
/** Any determiner+role phrase in a body. */
const ROLE_PHRASE_RE = new RegExp(ROLE_PHRASE_SOURCE, "gi");
/** The same phrase ANCHORED at a sentence start: the only shape AC10 can
 *  neutralise into a different subject. */
const ROLE_SUBJECT_RE = new RegExp(`^\\s*${ROLE_PHRASE_SOURCE}`, "i");

function roleGroupOf(form: string): string {
  const key = form.toLowerCase();
  for (const group of SUMMARY_ROLE_NOUN_GROUPS) if (group.forms.includes(key)) return group.canonical;
  return key;
}

/** Every determiner+role-noun phrase in `text`, canonicalised. */
export function roleNounClaims(text: string): SummaryRoleNoun[] {
  const body = text ?? "";
  const out: SummaryRoleNoun[] = [];
  for (const match of body.matchAll(ROLE_PHRASE_RE)) {
    const form = match[1];
    if (!form) continue;
    out.push({ canonical: roleGroupOf(form), text: match[0] });
  }
  return out;
}

/** The raw match context as text: `renderSummaryContext` renders names only, and
 *  a roster entry's `position` is exactly the attestation AC10 needs. */
function matchContextRawText(matchContext: unknown): string {
  if (!matchContext || typeof matchContext !== "object") return "";
  try {
    return JSON.stringify(matchContext);
  } catch {
    return "";
  }
}

/** The evidence text that can ATTEST a role: the row's own sources. The served
 *  caption is excluded on purpose — it is generated copy, so a role noun in the
 *  announcer line is a claim, not evidence for another claim. */
export function roleAttestationText(evidence: SummaryEvidence): string {
  return [
    renderSummaryContext(evidence.matchContext),
    matchContextRawText(evidence.matchContext),
    evidence.transcript ?? "",
    evidence.reason ?? "",
    evidence.adjacentScoreCue ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The role groups (canonical names) the row's evidence attests. */
export function attestedRoleNouns(evidence: SummaryEvidence): Set<string> {
  const text = roleAttestationText(evidence);
  const attested = new Set<string>();
  if (!text) return attested;
  for (const group of SUMMARY_ROLE_NOUN_GROUPS) {
    const re = new RegExp(`\\b(?:${group.forms.map(escapeRe).join("|")})\\b`, "i");
    if (re.test(text)) attested.add(group.canonical);
  }
  return attested;
}

/** The role nouns in `text` the row does NOT attest. Empty => every role noun is
 *  grounded. */
export function unattestedRoleNouns(text: string, evidence: SummaryEvidence): SummaryRoleNoun[] {
  const attested = attestedRoleNouns(evidence);
  return roleNounClaims(text).filter((claim) => !attested.has(claim.canonical));
}

const SHOT_VERB_RE =
  /\b(?:shoots?|shot|fires?|fired|volleys?|volleyed|heads?|headed|strikes?|struck|curls?|curled|lobs?|lobbed|taps?|tapped|finishes?|finished|converts?|converted|scores?|scored|buries|buried|nests?|netted|finds?|finds)\b/i;
const MOVE_VERB_RE =
  /\b(?:drives?|drove|runs?|ran|breaks?|broke|carries|carried|advances?|advanced|surges?|surged|moves?|moved|attacks?|attacked|bursts?|burst|cuts?|cut|chases?|chased|presses?|pressed)\b/i;

/** The neutral subject a role-noun SENTENCE is rewritten to, chosen from the verb
 *  that follows it: a shot verb keeps "the shot", a movement verb "the move",
 *  anything else "the play". Deterministic, so a stored body can be reproduced. */
export function neutralRoleSubject(sentence: string): string {
  const after = sentence.replace(ROLE_SUBJECT_RE, " ");
  if (SHOT_VERB_RE.test(after)) return "The shot";
  if (MOVE_VERB_RE.test(after)) return "The move";
  return "The play";
}

/**
 * ADAAAA-8831: the neutral noun a role phrase is rewritten to when it is NOT the
 * sentence's subject (an object or a modifier, where a subject rewrite cannot
 * reach).
 *
 * Deleting the whole sentence was the shipped rule, and on live leg `27bd816f`
 * that starved a compliant body of the facts the sentence carried: row
 * `a4827973`'s 29-word reply lost *"after a defender found the back of the net."*
 * — the sentence holding the attested score line — leaving 13 words / 1 sentence,
 * refused `too-few-words,too-few-sentences,restates-caption,too-few-facts`.
 * `player` is not a role noun in the attestation table, so the rewrite removes
 * the unattested claim and adds none: the same trade `neutralRoleSubject`
 * already makes for a subject, and still deletion-plus-neutral-word only — no
 * fact, name, score or venue is introduced.
 */
function neutralRolePhrase(phrase: string): string {
  const determiner = /^(the|a|an|their|its|his|her)\b/i.exec(phrase)?.[1]?.toLowerCase() ?? "";
  const last = phrase.trim().split(/\s+/).pop() ?? "";
  const noun = /s$/i.test(last) && last.length > 1 ? "players" : "player";
  if (determiner === "the") return `the ${noun}`;
  return `a ${noun}`;
}

/** Replace every unattested role PHRASE in a sentence with its neutral noun,
 *  keeping the sentence's other facts intact. */
function replaceUnattestedRolePhrases(sentence: string, claims: readonly SummaryRoleNoun[]): string {
  let out = sentence;
  for (const claim of claims) {
    const re = new RegExp(claim.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const replacement = neutralRolePhrase(claim.text);
    out = out.replace(re, (match) =>
      /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement
    );
  }
  return out;
}

export interface SummaryRoleNeutralisation {
  text: string;
  /** Phrases rewritten to a neutral subject. */
  neutralised: SummaryRoleNoun[];
  /** Sentences deleted because a role noun sat somewhere a subject rewrite
   *  cannot reach (an object or a modifier). Deleting is the clamp's rule: this
   *  never rewrites a claim into a different one. */
  droppedSentences: number;
}

/**
 * AC10: remove unattested role nouns from a body WITHOUT inventing a claim.
 *
 * Two deterministic moves, in this order:
 *  1. a role noun opening its sentence is the SUBJECT: rewrite the subject to a
 *     neutral event noun ("the move", "the shot", "the play") and keep the verb,
 *     so the sentence still says what the evidence attests;
 *  2. a role noun anywhere else (object, modifier) is rewritten to a neutral
 *     noun ("a player" / "the players") rather than deleting the sentence
 *     (ADAAAA-8831: deleting it starved a compliant body of its attested facts).
 *     If the rewritten body still carries an unattested role noun, or the depth
 *     band is missed, the gate refuses it and the lane regenerates/drops —
 *     never a fabricated repair.
 */
export function neutraliseRoleNouns(text: string, evidence: SummaryEvidence): SummaryRoleNeutralisation {
  const body = (text ?? "").trim();
  const claims = unattestedRoleNouns(body, evidence);
  if (!body || claims.length === 0) return { text: body, neutralised: [], droppedSentences: 0 };
  const kept: string[] = [];
  const neutralised: SummaryRoleNoun[] = [];
  let droppedSentences = 0;
  for (const sentence of body.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
    const offending = unattestedRoleNouns(sentence, evidence);
    if (offending.length === 0) {
      kept.push(sentence);
      continue;
    }
    const leading = sentence.match(ROLE_SUBJECT_RE);
    // Only a role phrase that IS the sentence's subject can be neutralised.
    if (leading) {
      const subject = neutralRoleSubject(sentence);
      const rewritten = `${subject}${sentence.slice(leading[0].length)}`;
      if (unattestedRoleNouns(rewritten, evidence).length === 0) {
        kept.push(rewritten);
        neutralised.push({ canonical: roleGroupOf(leading[1] ?? ""), text: leading[0].trim() });
        continue;
      }
    }
    // ADAAAA-8831: an object/modifier role phrase — rewrite the phrase, keep the
    // sentence and every fact it carries.
    const repaired = replaceUnattestedRolePhrases(sentence, offending);
    if (repaired !== sentence && unattestedRoleNouns(repaired, evidence).length === 0) {
      kept.push(repaired);
      for (const claim of offending) neutralised.push(claim);
      continue;
    }
    droppedSentences++;
  }
  return { text: kept.join(" ").trim(), neutralised, droppedSentences };
}

// --- AC9: fact density -----------------------------------------------------

/** AC9 (spec ADAAAA-8665 rev 3): a served body relays at least TWO DISTINCT fact
 *  types from the row's own evidence channels. A clock-only body is filler. */
export const SUMMARY_MIN_FACT_KINDS = 2;

/** A body clock may differ from the window anchor by at most this much (a body
 *  that says "at the 2:40 mark" for a 2:38 window is anchoring the same moment;
 *  "at 9:12" is a fabricated timestamp). */
export const SUMMARY_CLOCK_ANCHOR_TOLERANCE_S = 90;

/** The competition / venue strings the match context actually carries. */
export function matchContextVenueText(matchContext: unknown): string {
  if (!matchContext || typeof matchContext !== "object") return "";
  const mc = matchContext as Record<string, any>;
  const parts: string[] = [];
  for (const key of ["competition", "tournament", "league", "venue", "stadium", "ground", "arena"]) {
    const value = mc[key];
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
    else if (value && typeof value === "object" && typeof value.name === "string" && value.name.trim()) parts.push(value.name.trim());
  }
  return parts.join(" · ");
}

function scoreDigits(text: string): string {
  return (text ?? "").replace(/[^\d]/g, "");
}

function sameScore(a: string, b: string): boolean {
  return scoreDigits(a) === scoreDigits(b) && scoreDigits(a) !== "";
}

/** AC9: which fact TYPES the ROW can attest. A type the evidence does not carry
 *  is never available, so a body can never earn it by asserting it. */
export function attestedFactKinds(evidence: SummaryEvidence): SummaryFactKind[] {
  const kinds: SummaryFactKind[] = [];
  if (typeof evidence.windowTs === "number" && Number.isFinite(evidence.windowTs)) kinds.push("clock");
  const from = (evidence.scoreTransition?.from ?? "").trim();
  const to = (evidence.scoreTransition?.to ?? "").trim();
  // A score line is a fact only when the row attests the CHANGE (from -> to).
  if (from && to && scoreDigits(from) && scoreDigits(to) && !sameScore(from, to)) kinds.push("score");
  // An action needs an attested ACTOR (ADAAAA-8456: a name shortage must not
  // starve depth, so a team name is an entity too). ADAAAA-8735: only the row's
  // STRUCTURED sources attest one — a sentence-initial capital of a common noun
  // in the decide reason (`Ball`) and the renderer's own `Teams:` label do not.
  if (attestedActorNames(evidence).length > 0) kinds.push("action");
  if (matchContextVenueText(evidence.matchContext).length > 0) kinds.push("venue");
  return kinds;
}

function clockSeconds(text: string): number | null {
  const m = (text ?? "").match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function scoreFactGrounded(factText: string, evidence: SummaryEvidence): boolean {
  const from = evidence.scoreTransition?.from ?? "";
  const to = evidence.scoreTransition?.to ?? "";
  return sameScore(factText, to) || sameScore(factText, from);
}

function venueFactGrounded(factText: string, evidence: SummaryEvidence): boolean {
  const venue = matchContextVenueText(evidence.matchContext);
  if (!venue) return false;
  const venueTokens = new Set(normalizeSummaryTokens(venue));
  const factTokens = normalizeSummaryTokens(factText);
  return factTokens.length > 0 && factTokens.every((t) => venueTokens.has(t));
}

function clockFactGrounded(factText: string, evidence: SummaryEvidence): boolean {
  const windowsTs = evidence.windowTs;
  if (typeof windowsTs !== "number" || !Number.isFinite(windowsTs)) return false;
  const seconds = clockSeconds(factText);
  // A spell ("second half") is a clock fact the row's window anchor carries; an
  // explicit m:ss must anchor THIS window, not a fabricated instant.
  if (seconds === null) return true;
  return Math.abs(seconds - windowsTs) <= SUMMARY_CLOCK_ANCHOR_TOLERANCE_S;
}

/** AC9 read: the DISTINCT fact types the body relays that the row attests. */
export function attestedSummaryFactKinds(text: string, evidence: SummaryEvidence): SummaryFactKind[] {
  const available = new Set(attestedFactKinds(evidence));
  const out = new Set<SummaryFactKind>();
  for (const fact of summaryFacts(text)) {
    if (!available.has(fact.kind)) continue;
    if (fact.kind === "score" && !scoreFactGrounded(fact.text, evidence)) continue;
    if (fact.kind === "venue" && !venueFactGrounded(fact.text, evidence)) continue;
    if (fact.kind === "clock" && !clockFactGrounded(fact.text, evidence)) continue;
    // ADAAAA-8735: an ACTION fact is credited only when the body NAMES the
    // attested team/player. A verb alone ("the ball shoots on the left") is a
    // bare action, not a fact the row attests — the measured rev-3 defect.
    if (fact.kind === "action" && !bodyNamesAttestedActor(text, evidence)) continue;
    out.add(fact.kind);
  }
  return [...out];
}

/** ADAAAA-8687: the taxonomy table's entries that are ordinary prose in body
 *  copy. The internal-token bar exists to keep the pipeline's OWN event labels
 *  off the served surface (`scoring_play`, `BIG_PLAY`, `big play`, `near miss`),
 *  not to ban the English nouns a highlight is described with. The served probe
 *  on 6d6090a caught a faithful GOAL body ("This goal occurs at the 2:40 mark of
 *  the match.") refused for the word `goal`, which alone would drop most GOAL
 *  rows' copy. Claim safety is a SEPARATE bar (`hasGoalClaim` /
 *  `gateGoalClaims`), so allowing the noun cannot smuggle a claim; the enum
 *  SHAPE (`snake_case`) and the bracketed-marker strip are untouched. */
const BODY_PROSE_TAXONOMY = new Set(["goal", "shot", "save", "corner", "penalty", "free kick", "highlight"]);

/** ADAAAA-8691: what makes a taxonomy phrase a LABEL rather than prose. Body
 *  copy delimits the pipeline's own label — `big play: …`, `verdict — near
 *  miss`, `(scoring_play)` — while a plain space is the shape of running
 *  English. */
const LABEL_CHUNK_SEP = /\s*[:—–=|()[\]{}\n]\s*/;
const LABEL_MARK = "\u0000";

/** ADAAAA-8691: the pipeline's OWN labels inside the body, scanned as 1-3 word
 *  phrases (the enum form of the taxonomy table) but ONLY in a label position:
 *  the body IS the label, or the phrase sits alone in a delimited chunk.
 *
 *  QA-E's bounded VOD job `572f1ec7` (served build `c76ab91`) refused a
 *  grounded, depth-compliant GOAL body — *"This scoring play follows a period of
 *  intense competition between the two sides."* — as `internal-token`, because a
 *  window scan over the whole body cannot tell that English phrase from the
 *  pipeline's `scoring_play`. `stripInternalTokens(raw) === raw` on that row, so
 *  it was this scan alone, and it starved VOD coverage (1 of 2 promotable rows).
 *
 *  Nothing that catches a REAL label is widened: the snake_case enum SHAPE is
 *  refused by `summaryViolations` wherever it appears, the bracketed / ALL-CAPS /
 *  `key=value` / clock markers are stripped by `stripInternalTokens` before this
 *  gate sees the text, a bare label body is refused here, and a delimited label
 *  chunk is refused here. The everyday prose nouns in `BODY_PROSE_TAXONOMY` stay
 *  exempt. */
export function internalLabelPhrases(text: string): string[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  const hits: string[] = [];
  const consider = (words: string[]): void => {
    const key = taxonomyKey(words.join(" "));
    if (!key || !isTaxonomyToken(key) || BODY_PROSE_TAXONOMY.has(key) || hits.includes(key)) return;
    hits.push(key);
  };
  // Tokenise with every separator kept as a boundary marker, then walk the runs
  // of ordinary words between markers. A run that IS a label, or a 1-3 word
  // phrase that TOUCHES a marker, is in a label position; a phrase inside a run
  // is English.
  const tokens = body.replace(LABEL_CHUNK_SEP, ` ${LABEL_MARK} `).split(/\s+/).filter(Boolean);
  const runs: { words: string[]; afterMarker: boolean; beforeMarker: boolean }[] = [];
  let afterMarker = false;
  for (const token of tokens) {
    if (token === LABEL_MARK) {
      if (runs.length) runs[runs.length - 1].beforeMarker = true;
      afterMarker = true;
      continue;
    }
    const last = runs[runs.length - 1];
    if (afterMarker || !last) {
      runs.push({ words: [token], afterMarker, beforeMarker: false });
      afterMarker = false;
    } else last.words.push(token);
  }
  for (const run of runs) {
    consider(run.words);
    for (let n = 1; n <= 3 && n <= run.words.length; n++) {
      if (run.afterMarker) consider(run.words.slice(0, n));
      if (run.beforeMarker) consider(run.words.slice(-n));
    }
  }
  return hits;
}

/** Every bar THIS candidate fails. Shape first, then the composed grounding
 *  gates, then the two lane-specific bars (depth facts + caption overlap). */
export function summaryViolations(summary: string, evidence: SummaryEvidence): SummaryViolation[] {
  const body = (summary ?? "").trim();
  const band = summaryBand(evidence.rail);
  if (!body) return ["empty"];
  const out: SummaryViolation[] = [];
  const words = summaryWordCount(body);
  const sentences = summarySentenceCount(body);
  if (words < band.floorWords) out.push("too-few-words");
  if (words > band.hardMaxWords) out.push("too-many-words");
  if (body.length > band.hardMaxChars) out.push("too-long");
  if (sentences < band.minSentences) out.push("too-few-sentences");
  if (sentences > band.maxSentences) out.push("too-many-sentences");
  if (stripInternalTokens(body) !== body) out.push("internal-token");
  // ADAAAA-8830: the window audit marker (`at t=0.0`, `at t=-1.0s`) is the
  // pipeline's own provenance and survives `stripInternalTokens`, so a body that
  // cites it is the same `internal-token` class of copy — AC13 grades `summary`
  // beside `caption`/`postTitle`, and a marker may reach neither.
  else if (carriesAuditMarker(body)) out.push("internal-token");
  // A taxonomy/enum token mid-sentence (`… after a scoring_play …`) survives the
  // strip above, so the served value is checked with the existing taxonomy table
  // plus the snake_case enum SHAPE (no second token list). The table's everyday
  // prose words are exempt (see BODY_PROSE_TAXONOMY) and a taxonomy phrase only
  // counts as a label in a label position (see `internalLabelPhrases`): the bar
  // is about the pipeline's OWN labels, not the English a highlight is described
  // with.
  if (!out.includes("internal-token")) {
    if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(body)) out.push("internal-token");
    else if (internalLabelPhrases(body).length > 0) out.push("internal-token");
  }
  if (CLOCK_PREFIX_RE.test(body)) out.push("clock-prefix");
  if (EM_DASH_CHAIN_RE.test(body)) out.push("em-dash-chain");
  if (hasPlaceChain(body)) out.push("place-chain");
  if (SPECULATIVE_RE.test(body)) out.push("speculative-verb");
  const ctx = summaryGroundingContext(evidence);
  if (hasGoalClaim(body) && gateGoalClaims(body, ctx) !== body) out.push("goal-claim");
  if (gateAbsenceClaims(body, ctx) !== body) out.push("absence-claim");
  if (groundNames(body, ctx.promptText) !== body) out.push("ungrounded-name");
  if (captionRestatesSummary(body, evidence.caption, evidence)) out.push("restates-caption");
  // Depth bars — a name is NOT required (ADAAAA-8456 lesson).
  if (newSummaryFacts(body, evidence.postTitle).length === 0) out.push("no-new-fact");
  if (!hasAttestedEntity(body, summaryEvidenceText(evidence))) out.push("no-attested-entity");
  // Rev 3 (AC8-AC10). The gate neutralises unattested role nouns BEFORE judging
  // (`gateSummaryDetail`), so `unattested-role` is the backstop for a shape the
  // deterministic neutraliser cannot reach. `too-few-facts` is the fact-density
  // bar: two DISTINCT attested channels, never a clock on its own.
  if (unattestedRoleNouns(body, evidence).length > 0) out.push("unattested-role");
  if (bodyAssertsUnattestedAction(body, evidence)) out.push("unattested-action");
  if (attestedSummaryFactKinds(body, evidence).length < SUMMARY_MIN_FACT_KINDS) out.push("too-few-facts");
  return out;
}

/** What the write seam stores, plus why. Mirrors `PostTitleGateDecision`. */
export interface SummaryGateDecision {
  /** The value to store; null => the lane drops and the card keeps today's shape. */
  summary: string | null;
  /** Audit token: `accepted` / `trimmed` (the extractive clamp) / `refused:<violations>` / `absent`. */
  gate: string;
  violations: SummaryViolation[];
  /** ADAAAA-8831: the words/sentences of the text the gate actually JUDGED — the
   *  post-neutralisation body on a refusal, not the model's raw reply. The two
   *  differ whenever the AC10 neutraliser rewrites or deletes a sentence, and
   *  reporting the raw count made a 13-word judged body look like a 29-word one:
   *  the retry was then told a shortfall it did not have (`words=29` against a
   *  25-word target) and the row stayed dry on its second call. */
  words: number;
  sentences: number;
  /** ADAAAA-8831: sentences the AC10 neutraliser had to DELETE because a role
   *  phrase could not be rewritten in place. A refusal carrying this > 0 is the
   *  neutraliser, not the writer, having taken the body under the band. */
  droppedSentences: number;
  /** ADAAAA-8687: the model's own reply, after the internal-token strip and the
   *  clock-prefix strip — i.e. exactly the text that was judged. The write seam
   *  persists it as `summaryRaw` on a refusal so the next QA can quote what the
   *  model wrote instead of only the violation token (QA-B: `not_captured`). */
  raw: string;
  /** R4 (spec rev 2): caption-token coverage of the judged body. An OBSERVATION,
   *  never a drop reason — the write seam meters it as `summaryCaptionOverlap`. */
  captionOverlap: number;
}

/**
 * THE gate. Clean -> clamp -> compose the existing grounding helpers -> accept or
 * refuse. A refusal stores NOTHING: the card must render byte-identically to
 * today and never show a placeholder (AC3/AC6).
 *
 * The clamp is only allowed to DELETE (a trailing sentence, trailing words), so
 * a refused claim/name survives the clamp and is still refused — repair never
 * launders evidence.
 */
export function gateSummaryDetail(raw: string | null | undefined, evidence: SummaryEvidence): SummaryGateDecision {
  const band = summaryBand(evidence.rail);
  const stripped = stripInternalTokens((raw ?? "").trim()).replace(/^\s*T\s*\+\s*[\d:.]+\s*s?\s*[—–-]\s*/i, "").trim();
  if (!stripped) return { summary: null, gate: "absent", violations: ["empty"], words: 0, sentences: 0, droppedSentences: 0, raw: "", captionOverlap: 0 };
  const clamped = clampSummaryDepth(stripped, evidence.rail);
  const candidates: { text: string; trimmed: boolean }[] =
    clamped && clamped !== stripped ? [{ text: stripped, trimmed: false }, { text: clamped, trimmed: true }] : [{ text: stripped, trimmed: false }];
  const refused: SummaryViolation[] = [];
  /** ADAAAA-8831: the text the LAST candidate was judged as, so a refusal reports
   *  what the gate actually measured (post-neutralisation) instead of the raw
   *  reply it never judged. */
  let lastJudged = "";
  let droppedSentences = 0;
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    // AC10 (rev 3): an unattested role noun is removed BEFORE judging, so a body
    // that names "the midfielder" without attestation still serves with a
    // neutralised subject ("the move") instead of dropping the card's copy.
    const neutralised = neutraliseRoleNouns(candidate.text, evidence);
    const judged = neutralised.text;
    if (!judged) continue;
    lastJudged = judged;
    droppedSentences = neutralised.droppedSentences;
    const violations = summaryViolations(judged, evidence);
    if (violations.length === 0) {
      return {
        summary: judged,
        gate: neutralised.neutralised.length > 0 ? "neutralised" : candidate.trimmed ? "trimmed" : "accepted",
        violations: [],
        words: summaryWordCount(judged),
        sentences: summarySentenceCount(judged),
        droppedSentences,
        raw: stripped,
        captionOverlap: captionTokenOverlap(judged, evidence.caption),
      };
    }
    for (const v of violations) if (!refused.includes(v)) refused.push(v);
  }
  void band;
  const measured = lastJudged || stripped;
  return {
    summary: null,
    gate: `refused:${refused.join(",")}`,
    violations: refused,
    words: summaryWordCount(measured),
    sentences: summarySentenceCount(measured),
    droppedSentences,
    raw: stripped,
    captionOverlap: captionTokenOverlap(stripped, evidence.caption),
  };
}

// --- prompt contract -------------------------------------------------------

/** ADAAAA-8803: what the RETRY is told about the draft that was refused.
 *
 *  A retry that re-sends the same prompt is a second sample of the same
 *  distribution: the served VOD row `2f5a5796` retried 28 words -> 34 words
 *  against a 40-word floor, so both calls were spent and the row still dropped.
 *  The lane hands the gate's own measurement to the second call, so the model is
 *  told the measured shortfall and the fact types that close it instead of
 *  re-reading the first instruction. Optional: the first pass carries none. */
export interface SummaryRetryDirective {
  /** Words the refused draft measured (the gate's count, not an estimate). */
  words: number;
  /** Sentences the refused draft measured, when the gate reports one. */
  sentences?: number;
  /** The violation tokens that refused it, e.g. `["too-few-words"]`. */
  violations?: string[];
}

/** Everything the summary prompt may show the model. Built from the row's own
 *  evidence: no invented team, no invented name, no decide-contract change. */
export interface SummaryPromptInput extends SummaryEvidence {
  /** The card's served headline, when one exists (so the prompt can ask for a
   *  DIFFERENT fact rather than a restatement). */
  postTitle?: string | null;
  /** AC8 (rev 3): the opening runs already SERVED in this job. The prompt asks
   *  for a different opening instead of relying on the gate to reject a repeat —
   *  prompt first, gate as the backstop. */
  avoidOpenings?: string[];
  /** ADAAAA-8803: present only on the RETRY call — the measured shape of the
   *  draft the gate refused. Absent on the first pass, so the first prompt stays
   *  the snapshot-pinned one.
   *
   *  ADAAAA-8806 reads the same directive's `violations`: when the refused draft
   *  was fact-poor (`too-few-facts` / `no-attested-entity`) the retry is told to
   *  name the row's attested actor, so the second sample repairs the fact menu
   *  instead of re-landing clock-only. */
  retry?: SummaryRetryDirective;
}

/** ADAAAA-8773: the placeholder a match-clock stamp is replaced with in the
 *  prompt's evidence lines. Reads as English in a sentence ("at the window
 *  moment"), never as a timestamp the model can copy. */
const PROMPT_CLOCK_PLACEHOLDER = "the window moment";

/**
 * ADAAAA-8773: remove clock stamps the row's body can never EARN before the
 * model sees them.
 *
 * The `Window:` line is stream/clip seconds; the decide reason, the ASR
 * transcript and an adjacent scoring cue can carry a scorebug MATCH clock
 * (ADAAAA-8733). The gate credits a `clock` fact only when the body's `m:ss`
 * reconciles with `windowTs` inside `SUMMARY_CLOCK_ANCHOR_TOLERANCE_S`, so a
 * match clock handed to the model is an ungrounded fact it will faithfully
 * repeat — the measured cause of the all-dry VOD rail on `70400b1d`. Only
 * stamps INSIDE the tolerance band survive, because they anchor the same
 * moment as the window.
 */
export function redactUngroundedPromptClocks(
  text: string | null | undefined,
  windowTs: number | null | undefined
): string {
  const body = text ?? "";
  if (!body) return body;
  const anchor = typeof windowTs === "number" && Number.isFinite(windowTs) ? windowTs : null;
  return body.replace(/(?:\bt=)?\b(\d{1,3}:\d{2})\b/g, (stamp, clock: string) => {
    if (anchor === null) return PROMPT_CLOCK_PLACEHOLDER;
    const seconds = clockSeconds(clock);
    if (seconds === null) return stamp;
    return Math.abs(seconds - anchor) <= SUMMARY_CLOCK_ANCHOR_TOLERANCE_S ? stamp : PROMPT_CLOCK_PLACEHOLDER;
  });
}

/** Deterministic prompt. Snapshot-tested (`summary-prompt.test.ts`) so a prompt
 *  edit is a reviewed contract change, exactly like the decide prompt.
 *
 *  ADAAAA-8773: the body clock must be the CLIP offset. The decide reason runs
 *  on the scorebug's MATCH clock (ADAAAA-8733 parses it and combines clips on
 *  game time), so the shipped VOD job `70400b1d` produced reasons that said
 *  `t=18:02` for a 24 s window; the prompt repeated the reason verbatim, the
 *  model wrote "at the 18:02 mark", and the gate — which reconciles a body clock
 *  against `windowTs` within `SUMMARY_CLOCK_ANCHOR_TOLERANCE_S` — refused both
 *  promoted rows `too-few-facts`. Grounding cannot be widened to accept a match
 *  clock the row does not attest, so the prompt stops handing one over. */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const band = summaryBand(input.rail);
  const context = renderSummaryContext(input.matchContext) || "(none)";
  const verdict = input.verdict || input.eventType || "unknown";
  const windowLine =
    typeof input.windowTs === "number" && Number.isFinite(input.windowTs)
      ? // ADAAAA-8773: the duration suffix is NOT rendered. The shipped probe
        // showed the model copying the parenthetical into prose ("at the 0:24
        // (+15 s) mark"), which reads as a broken timestamp on a served card.
        // The offset is the only thing the body needs from this line.
        `Window: ${clockLabel(input.windowTs)} — clip offset`
      : "Window: (unknown)";
  const transition = input.scoreTransition
    ? `Score transition: ${input.scoreTransition.from ?? "?"} -> ${input.scoreTransition.to ?? "?"}`
    : "Score transition: (none measured)";
  // ADAAAA-8687: the fact menu and the claim rule are VERDICT-aware. A card that
  // does not attest a scoring play must never be steered towards the score line —
  // the shared claim lexicon treats `score`/`goal`/`net` as a claim (fail-closed)
  // and refused a celebration body that said "the current score remains
  // unchanged". So a celebration row is offered the clock/venue/action facts only.
  const attestsScoring = String(input.verdict ?? "") === "scoring_play";
  const factMenu = attestsScoring
    ? "the score line, the clock or spell, the competition or venue, or an attested team's or player's action"
    : "the clock or spell, the competition or venue, or an attested team's or player's action";
  // ADAAAA-8803: the depth instruction is a BAND, and the RETRY is told what the
  // refused draft measured. Both fixes answer the same measured defect on the
  // served VOD leg of job `4e5ddf8d`: a compliant draft landed on 41 words
  // against a 40-word floor (one-word margin), and the retried row re-landed at
  // 34 words because the retry re-read the same "at least 40 words" line.
  const retryMin = summaryRetryMinWords(band);
  const retryLines = input.retry
    ? [
        `RETRY: the previous draft measured ${input.retry.words} words${
          typeof input.retry.sentences === "number" ? ` across ${input.retry.sentences} sentences` : ""
        } and was refused${input.retry.violations && input.retry.violations.length > 0 ? ` for: ${input.retry.violations.join(", ")}` : ""}.`,
        `- Close the measured shortfall: this copy must reach at least ${retryMin} words inside ${band.minSentences}-${band.maxSentences} sentences. ${retryMin} is ${retryMin - band.floorWords} words above the ${band.floorWords}-word floor on purpose: a draft that only just clears the floor is the defect this retry exists to repair.`,
        `- Expand with facts, not filler: add ${factMenu}. The half or spell and a named attested actor's action carry the most words without inventing anything.`,
        `- Do NOT spend a whole sentence on the clip clock: the \`Window:\` label (${typeof input.windowTs === "number" && Number.isFinite(input.windowTs) ? clockLabel(input.windowTs) : "the offset"}) must sit INSIDE a sentence that also carries another fact. A sentence that only says when the clip moment occurs adds no depth and does not count toward the two-fact rule.`,
        "- Do not pad with generic talk about momentum, intensity or the crowd rising: every added sentence must carry a fact from the evidence below.",
      ]
    : [];
  // ADAAAA-8806: the actors the row's own evidence attests, named EXPLICITLY so
  // the body can carry the entity (AC11) and a second fact type (AC9/AC12)
  // instead of a clock-only sentence — the measured cause of the 2/2 dry rows on
  // job `3740585f`, whose summary bodies named nobody although `matchContext`
  // carried Barcelona.
  const attestedActors = attestedActorNames(input);
  const ballActionAttested = attestedBallActionFrom(input.attestation ?? null);
  const lines = [
    "You write the BODY copy under a highlight clip's short headline.",
    "The headline is already on the card; your copy sits underneath it and must add detail.",
    `Rail: ${input.rail}. Write ${band.minSentences}-${band.maxSentences} sentences, ${band.targetMinWords}-${band.targetMaxWords} words.`,
    "Rules:",
    "- State only what the evidence below supports.",
    `- Hit the length band: aim for ${band.targetMinWords}-${band.targetMaxWords} words. If the copy runs short of ${band.targetMinWords}, add another fact — the clock, the competition or venue, or a named attested actor's action — rather than padding.`,
    ...retryLines,
    `- Carry at least TWO different facts from the evidence, not just the clock: ${factMenu}. A body whose only fact is the clock does not count.`,
    "- Use only fact types the evidence carries: state a score only when the evidence attests a score change, and name a competition or venue only when the match context does. Never guess a fact.",
    "- The clock fact is the `Window:` label only: it is an offset into THIS clip. A time quoted anywhere else in the evidence (a match clock in the reason or transcript, a scorebug stamp) is not this clip's offset — never restate one as the body's clock.",
    "- A name is optional. If the evidence names nobody, carry the depth with the clock plus the competition/venue when the match context carries one. An action fact counts ONLY when you NAME an attested team or player from the evidence: a bare verb with no named actor is not a fact.",
    ...(attestedActors.length > 0
      ? [
          `- The evidence attests these actors: ${attestedActors.slice(0, 8).join(", ")}. NAME at least one of them and say what they did — that is the second fact type your copy needs, and the headline is not allowed to carry a name so this is where it belongs.`,
        ]
      : []),
    ...(ballActionAttested === false
      ? [
          "- No ball outcome was measured in this window: do NOT say the ball was shot, headed, struck, fired, saved, blocked, cleared or went wide/in/near, and do not describe the ball entering the net. Describe the move, the reaction, the crowd or the team's play instead.",
        ]
      : []),
    attestsScoring
      ? "- Never claim a goal unless the evidence attests one; never invent a statistic."
      : "- This is NOT a scoring play: the words 'goal', 'scoring', 'score' and 'net' are off limits. Do not describe a goal or a scoring chance, do not name the net, and do not state a score or whether it changed.",
    "- Never invent a name, a team, a venue or a statistic. A role noun ('the midfielder', 'the keeper', 'the striker', 'the defender', 'the winger') is a claim: use it ONLY when the evidence below uses that word. Otherwise describe the play, the move or the shot, or name an attested team.",
    ...(attestsScoring
      ? []
      : ["- Name the clock in your copy (the window label, e.g. `0:12`), but the clock alone is not enough: pair it with the competition/venue or an attested action."]),
    "- Do not open with the same words as another card in this job: vary your first four words.",
    ...(input.avoidOpenings && input.avoidOpenings.length > 0
      ? [`- Do not open with any of these already-served runs: ${input.avoidOpenings.slice(0, 8).map((o) => `'${o}'`).join(", ")}.`]
      : []),
    ...(() => {
      // ADAAAA-8806: a retry whose draft was FACT-POOR gets an explicit repair
      // instruction naming the row's attested actor — the measured case is row
      // `2d8e9521` of job `3740585f`, whose retried copy only has to name
      // Barcelona to clear `too-few-facts`.
      const violations = input.retry?.violations ?? [];
      const factPoor =
        violations.includes("too-few-facts") || violations.includes("no-attested-entity");
      if (!factPoor) return [];
      const actor = attestedActors[0];
      if (!actor) return [];
      return [
        `- The previous draft was fact-poor (${violations.join(", ")}). NAME ${actor} and say what they did, so the copy carries two different facts.`,
      ];
    })(),
    ...(() => {
      // ADAAAA-8831: a retry whose draft named an entity the row's evidence does
      // not attest (row `8d521507` of live leg `27bd816f` wrote "Real Madrid"
      // where the attested actor was Barcelona) is handed the attested actor
      // list explicitly and told the claim is closed — the first-pass line says
      // "a name is optional", which is not a prohibition.
      const violations = input.retry?.violations ?? [];
      if (!violations.includes("ungrounded-name")) return [];
      if (attestedActors.length === 0) return [];
      return [
        `- The previous draft named an entity this evidence does not attest. Name ONLY these attested actors: ${attestedActors.slice(0, 8).join(", ")}. Do not name any other team, player, venue or competition.`,
      ];
    })(),
    "- Do not restate the headline or the announcer line.",
    "- No em-dash continuations, no 'T+' prefixes, no internal tokens, no speculation ('appeared to', 'looked like').",
    "Evidence:",
    `Verdict: ${verdict}`,
    `Reason: ${redactUngroundedPromptClocks(input.reason, input.windowTs) || "(none)"}`,
    `Headline: ${input.postTitle || "(none)"}`,
    `Announcer line: ${input.caption || "(none)"}`,
    windowLine,
    transition,
    `Match context:\n${context}`,
    `ASR transcript: ${redactUngroundedPromptClocks(input.transcript, input.windowTs) || "(none)"}`,
    `Adjacent scoring cue: ${redactUngroundedPromptClocks(input.adjacentScoreCue, input.windowTs) || "(none)"}`,
    "Body copy:",
  ];
  return lines.join("\n");
}

/** `m:ss` for a stream-seconds instant (the compact label the cards use). */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, "0")}`;
}
