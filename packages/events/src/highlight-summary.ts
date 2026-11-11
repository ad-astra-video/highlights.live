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
  type CaptionGroundingContext,
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

/** VOD: 3-5 sentences / 40-90 words, hard reject > 120 words / 700 chars. The
 *  floor is the same 0.72x ratio the live band uses (40 * 0.72 ≈ 29 -> 30), so a
 *  VOD row that answers in two long sentences is still refused as thin. */
export const SUMMARY_VOD_BAND: SummaryDepthBand = {
  rail: "vod",
  minSentences: 3,
  maxSentences: 5,
  targetMinWords: 40,
  targetMaxWords: 90,
  floorWords: 30,
  hardMaxWords: 120,
  hardMaxChars: 700,
};

export function summaryBand(rail: SummaryRail): SummaryDepthBand {
  return rail === "vod" ? SUMMARY_VOD_BAND : SUMMARY_LIVE_BAND;
}

/** The spec's de-duplication bar: normalized token overlap with `caption`. */
export const SUMMARY_MAX_CAPTION_OVERLAP = 0.5;

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

/** Never more than one retry, so a row bills at most two calls (AC5). */
export const SUMMARY_MAX_CALLS_PER_ROW = 2;

/** p95 generation budget after promotion (AC4: `summary` p95 <= 6 s). It is a
 *  post-promotion budget, never a live-path budget: nothing on the decide path
 *  waits on this. */
export const SUMMARY_GENERATION_P95_BUDGET_MS = 6_000;

/** Per-call timeout handed to the text-only decide call, under the p95 budget so
 *  one retry still fits inside it. */
export const SUMMARY_CALL_TIMEOUT_MS = 2_500;

/** Why a promoted row carries no `summary`. Named (never a free-form sentence)
 *  so a stored-row read can attribute a drop without a log join (AC6). */
export type SummaryDropReason = "pool_busy" | "timeout" | "transport_failure" | "parse" | "gate";

export const SUMMARY_DROP_REASONS: readonly SummaryDropReason[] = [
  "pool_busy",
  "timeout",
  "transport_failure",
  "parse",
  "gate",
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

/** How much of `caption` the summary RE-STATES: the share of the caption's own
 *  normalized tokens that appear in the summary. Measured against the caption
 *  (the short lane), not the summary, because a longer summary would dilute a
 *  Jaccard score into always passing. >= 0.5 is the spec's refusal bar. */
export function captionTokenOverlap(summary: string, caption?: string | null): number {
  const cap = new Set(normalizeSummaryTokens(caption ?? ""));
  if (cap.size === 0) return 0;
  const sum = new Set(normalizeSummaryTokens(summary ?? ""));
  let hit = 0;
  for (const t of cap) if (sum.has(t)) hit++;
  return hit / cap.size;
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

/** The name-like strings an evidence blob attests: capitalized multi-token runs
 *  (teams, players) from matchContext + the window transcript, NOT from the
 *  model's own sentence. Used only to decide whether an entity is attested; the
 *  name GATE stays `groundNames`. */
export function attestedEntityNames(evidence?: string | null): string[] {
  const body = evidence ?? "";
  const runs = body.match(/\b[A-ZÀ-Ý][a-zà-ÿ'’.-]+(?:\s+(?:de|van|der|dos|da|di|del)\s+)?(?:\s+[A-ZÀ-Ý][a-zà-ÿ'’.-]+)*\b/g) ?? [];
  return [...new Set(runs.map((r) => r.trim()).filter((r) => r.split(/\s+/).length >= 1 && r.length > 2))];
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
  | "no-attested-entity";

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
  // A taxonomy/enum token mid-sentence (`… after a scoring_play …`) survives the
  // strip above, so the served value is checked with the existing taxonomy table
  // plus the snake_case enum SHAPE (no second token list).
  if (!out.includes("internal-token")) {
    if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(body)) out.push("internal-token");
    else
      for (const token of body.match(/[A-Za-z][A-Za-z_]{1,24}|[a-z]+(?:[- ][a-z]+){1,2}/g) ?? []) {
        if (isTaxonomyToken(token)) {
          out.push("internal-token");
          break;
        }
      }
  }
  if (CLOCK_PREFIX_RE.test(body)) out.push("clock-prefix");
  if (EM_DASH_CHAIN_RE.test(body)) out.push("em-dash-chain");
  if (hasPlaceChain(body)) out.push("place-chain");
  if (SPECULATIVE_RE.test(body)) out.push("speculative-verb");
  const ctx = summaryGroundingContext(evidence);
  if (hasGoalClaim(body) && gateGoalClaims(body, ctx) !== body) out.push("goal-claim");
  if (gateAbsenceClaims(body, ctx) !== body) out.push("absence-claim");
  if (groundNames(body, ctx.promptText) !== body) out.push("ungrounded-name");
  if (captionTokenOverlap(body, evidence.caption) >= SUMMARY_MAX_CAPTION_OVERLAP) out.push("restates-caption");
  // Depth bars — a name is NOT required (ADAAAA-8456 lesson).
  if (newSummaryFacts(body, evidence.postTitle).length === 0) out.push("no-new-fact");
  if (!hasAttestedEntity(body, summaryEvidenceText(evidence))) out.push("no-attested-entity");
  return out;
}

/** What the write seam stores, plus why. Mirrors `PostTitleGateDecision`. */
export interface SummaryGateDecision {
  /** The value to store; null => the lane drops and the card keeps today's shape. */
  summary: string | null;
  /** Audit token: `accepted` / `trimmed` (the extractive clamp) / `refused:<violations>` / `absent`. */
  gate: string;
  violations: SummaryViolation[];
  words: number;
  sentences: number;
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
  if (!stripped) return { summary: null, gate: "absent", violations: ["empty"], words: 0, sentences: 0 };
  const clamped = clampSummaryDepth(stripped, evidence.rail);
  const candidates: { text: string; trimmed: boolean }[] =
    clamped && clamped !== stripped ? [{ text: stripped, trimmed: false }, { text: clamped, trimmed: true }] : [{ text: stripped, trimmed: false }];
  const refused: SummaryViolation[] = [];
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const violations = summaryViolations(candidate.text, evidence);
    if (violations.length === 0) {
      return {
        summary: candidate.text,
        gate: candidate.trimmed ? "trimmed" : "accepted",
        violations: [],
        words: summaryWordCount(candidate.text),
        sentences: summarySentenceCount(candidate.text),
      };
    }
    for (const v of violations) if (!refused.includes(v)) refused.push(v);
  }
  void band;
  return { summary: null, gate: `refused:${refused.join(",")}`, violations: refused, words: summaryWordCount(stripped), sentences: summarySentenceCount(stripped) };
}

// --- prompt contract -------------------------------------------------------

/** Everything the summary prompt may show the model. Built from the row's own
 *  evidence: no invented team, no invented name, no decide-contract change. */
export interface SummaryPromptInput extends SummaryEvidence {
  /** The card's served headline, when one exists (so the prompt can ask for a
   *  DIFFERENT fact rather than a restatement). */
  postTitle?: string | null;
}

/** Deterministic prompt. Snapshot-tested (`summary-prompt.test.ts`) so a prompt
 *  edit is a reviewed contract change, exactly like the decide prompt. */
export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const band = summaryBand(input.rail);
  const context = renderSummaryContext(input.matchContext) || "(none)";
  const verdict = input.verdict || input.eventType || "unknown";
  const windowLine =
    typeof input.windowTs === "number" && Number.isFinite(input.windowTs)
      ? `Window: ${clockLabel(input.windowTs)}${input.windowDurationS ? ` (+${Math.round(input.windowDurationS)} s)` : ""}`
      : "Window: (unknown)";
  const transition = input.scoreTransition
    ? `Score transition: ${input.scoreTransition.from ?? "?"} -> ${input.scoreTransition.to ?? "?"}`
    : "Score transition: (none measured)";
  const lines = [
    "You write the BODY copy under a highlight clip's short headline.",
    "The headline is already on the card; your copy sits underneath it and must add detail.",
    `Rail: ${input.rail}. Write ${band.minSentences}-${band.maxSentences} sentences, ${band.targetMinWords}-${band.targetMaxWords} words.`,
    "Rules:",
    "- State only what the evidence below supports.",
    "- Include at least one fact the headline does not carry: the score line, the clock or spell, the competition or venue, or a named player's attested action.",
    "- A name is optional. If the evidence names nobody, carry the depth with score, clock and action facts.",
    "- Never claim a goal unless the verdict is a scoring play.",
    "- Never invent a name, a team, a venue or a statistic.",
    "- Do not restate the headline or the announcer line.",
    "- No em-dash continuations, no 'T+' prefixes, no internal tokens, no speculation ('appeared to', 'looked like').",
    "Evidence:",
    `Verdict: ${verdict}`,
    `Reason: ${input.reason || "(none)"}`,
    `Headline: ${input.postTitle || "(none)"}`,
    `Announcer line: ${input.caption || "(none)"}`,
    windowLine,
    transition,
    `Match context:\n${context}`,
    `ASR transcript: ${input.transcript || "(none)"}`,
    `Adjacent scoring cue: ${input.adjacentScoreCue || "(none)"}`,
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
