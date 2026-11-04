// Caption grounding gate (ADAAAA-7948 / parent ADAAAA-7933 Inc 3).
//
// The fast summaries are model prose, and on the deployed v1 contract they LIE:
// 51% of live rows asserted a goal that the same window's stored verdict had
// rejected, one row named a player/team that appears nowhere in the window's
// prompt (no match context, empty ASR, a frame that only carried the scorebug),
// and a seeded caption shipped "Goal: [near_miss] Audio Burst" — an internal
// verdict label offered as postable copy.
//
// This module is the ONE deterministic, CPU-only gate every user-visible fast
// caption crosses (the server `summaryLog` seam and the seeded-caption seam).
// It is:
//   - pure: no network, no model call, no randomness, no clock;
//   - idempotent: grounding already-grounded copy is a byte-identical no-op;
//   - never lengthening: every rewrite is same-length or shorter, so the
//     terseness bar (p50 <= 95, p95 <= 140) cannot regress;
//   - never blanking: the pointed line is the product, so a goal claim is
//     rewritten to a non-goal beat (or its clause dropped), never the caption.
//
// Evidence sources for the two gates are the ones the window itself carries:
//   - verdict: the window's stored outcome (`scoring_play` / `near_miss` /
//     `big_play` / `not_highlight`);
//   - names / scores: that window's decide `prompt_text` (match context, ASR,
//     scorebug OCR). No prompt => no evidence => no invented-name rewrite, but
//     also no invented names survive when a prompt IS present and lacks them.
/** The window verdicts the pipeline stores (mirrors `DecisionResult.outcome`). */
export type CaptionVerdict = "scoring_play" | "near_miss" | "big_play" | "not_highlight";

/** Why the caption text is being grounded, so a caller can pass only what it has. */
export interface CaptionGroundingContext {
  /** This window's stored verdict / outcome. Absent => legacy row. */
  verdict?: string | null;
  /** This window's decide `prompt_text` (match context, ASR, scorebug OCR). */
  promptText?: string | null;
  /** The accepted highlight's event type, used only when no verdict exists. */
  eventType?: string | null;
  /**
   * ADAAAA-7958 (contract v3 §3.4, corroboration propagation): whether the
   * pipeline CORROBORATED this window's scoring read with an independent signal
   * (a measured scoreboard change, goal-calling audio, the two-signal frame
   * attestation). The corroboration computation is unchanged — this flag only
   * decides whether the surfaces may ASSERT a goal.
   *
   * - `false`  => the page counted this goal but never corroborated it, so no
   *               string may assert it as scored. Fails closed even when the
   *               stored verdict is `scoring_play`, so the banner ("N of M
   *               accepted goals are not corroborated by frames — counted, never
   *               asserted as scored") and every caption/title agree.
   * - `true`   => the verdict rule alone decides (a corroborated goal keeps its
   *               goal claim).
   * - absent / undefined => no corroboration evidence on this surface (VOD and
   *               legacy rows), so the verdict rule alone decides. This is what
   *               keeps the long-form VOD path byte-identical (AC8).
   */
  corroborated?: boolean | null;
  /**
   * ADAAAA-7965 (contract v5 §3.1, R18): the per-window MEASURED signal the
   * colour beat is DERIVED from — the audio-noise delta
   * (`analysis.audioSeries`) that ADAAAA-7964 selected, with the frame that
   * confirms it. The model's colour clause is never forwarded, and a beat that
   * carries no signal reference is not a beat.
   *
   * Absent / null => NO colour (fails closed), which is what keeps VOD and the
   * webapp's log-free paths byte-identical.
   */
  colourSignal?: ColourSignal | null;
  /**
   * ADAAAA-7965 (contract v5 §3.4, R21): the window's stored evidence that a
   * negative / absence claim (`the ball stays out`, `no goal`, `never crossed`)
   * is true — the stored verdict plus the frame attestation for this window.
   * Absent / false => no absence claim survives (the quiet shape ships).
   */
  absenceEvidence?: boolean | null;
  /**
   * ADAAAA-7962 (contract v4 §3.4, extended by v5 §3.2): the window's stored
   * zone/place, used when the model's line names none (§3.2 place injection) and
   * when a rewrite would otherwise drop the place. Resolved at the write seam
   * from the window's own state (tracked ball position / stored possession
   * line), never invented.
   */
  place?: string | null;
}

/**
 * ADAAAA-7965 (contract v5 §3.1, R18): the measured per-window signal a colour
 * beat is derived from, and the frame reference that confirms it.
 *
 * Parameters are exactly the block ADAAAA-7964 measured as the only stored
 * signal that reaches the 20-40% band with 0 contradicted beats:
 *
 *   peak      = max(energy)                     (audioSeries taps in-window)
 *   base      = median(energy)
 *   ratio     = peak / max(base, 0.005)
 *   sustained = count(energy >= 0.5*peak) / len(taps)
 *   peakT     = t of the peak tap (stream seconds)
 *   frameTs   = timestamp of the stored frame nearest peakT
 *   frameSeq  = that frame's index in the stored frame set (t * sampleFps)
 *
 * `signal` is fixed to `audio_noise` today; the field exists so a second signal
 * cannot be smuggled in without naming itself.
 */
export interface ColourSignal {
  signal: "audio_noise";
  ratio: number;
  sustained: number;
  peak: number;
  peakT: number;
  frameTs?: number;
  frameSeq?: number;
}

/** Human labels for pipeline enums (a caption is customer copy, never a code). */
const EVENT_LABELS: Record<string, string> = {
  GOAL: "goal",
  SPORTING_EVENT: "sporting moment",
  NEAR_MISS: "near miss",
  BIG_PLAY: "big play",
  HIGHLIGHT: "highlight",
  SCORING_PLAY: "goal",
  NOT_HIGHLIGHT: "highlight",
};

/** Human-readable label for a pipeline event type. Unknown types degrade to
 * title-cased words rather than leaking the enum. */
export function humanEventLabel(eventType?: string): string {
  const raw = (eventType ?? "").trim();
  if (!raw) return "highlight";
  const known = EVENT_LABELS[raw.toUpperCase()];
  if (known) return known;
  return raw
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A SCREAMING_SNAKE pipeline enum (`SPORTING_EVENT`, `NOT_HIGHLIGHT`, …). */
const SCREAMING_TOKEN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** A bracketed internal label: `[near_miss]`, `[goal]`, `[NEAR_MISS 0.31]`. */
const BRACKET_TOKEN = /\[[^\]\n]{1,40}\]/g;
/** A parenthesised internal verdict: `(near_miss)`, `(not_highlight)`. */
const PAREN_VERDICT =
  /\(\s*(?:near[_ ]miss|not[_ ]highlight|scoring[_ ]play|big[_ ]play)\b[^)]*\)/gi;
/** `outcome=near_miss`, `verdict: goal`, `event_type=GOAL`, `confidence=0.62`. */
const KEY_VALUE_TOKEN =
  /\b(?:outcome|verdict|event[_ ]?type|decision|reason|confidence|near[_ ]?miss|score)\s*[:=]\s*[A-Za-z0-9_.%+-]+/gi;
/** `T+69s`, `T+ 12.5s`. */
const CLOCK_TOKEN = /\bT\+\s*\d+(?:\.\d+)?\s*s\b/gi;

/** Keep the capitalisation of the text a rewrite replaced, so a sentence that
 * started with a name still starts with a capital ("Saka" -> "The striker"). */
function matchCase(replacement: string, matched: string): string {
  if (!replacement) return replacement;
  const first = matched.charAt(0);
  const head = replacement.charAt(0);
  if (first === first.toUpperCase() && head === head.toLowerCase()) {
    return head.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Collapse the whitespace/punctuation a strip leaves behind. Never applied to
 * text that no rule touched, so an already-clean line stays byte-identical. */
function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*(?=[,.;:!?])/g, "")
    .replace(/^[\s,;:—–-]+/, "")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
}

/**
 * Strip internal tokens from user-visible copy: bracket verdict labels, bare
 * key=value internals, `T+69s` clocks, SCREAMING_SNAKE enums and the `·`
 * separator. Untouched text is returned byte-identical (no normalisation).
 */
export function stripInternalTokens(text: string): string {
  const input = text ?? "";
  let out = input;
  out = out.replace(BRACKET_TOKEN, " ");
  out = out.replace(PAREN_VERDICT, " ");
  out = out.replace(INTERNAL_REASON_TAIL, "");
  out = out.replace(EVIDENCE_TAG, "");
  out = out.replace(KEY_VALUE_TOKEN, " ");
  out = out.replace(CLOCK_TOKEN, " ");
  out = out.replace(SCREAMING_TOKEN, (m) => humanEventLabel(m));
  out = out.replace(/[·•]/g, ", ");
  // A bare leading event enum ("GOAL — …") is an internal code, not copy.
  out = out.replace(/^\s*[A-Z][A-Z0-9]{1,}\b\s*[,;:—–-]*\s*/, "");
  if (out === input) return input;
  return tidy(out);
}

/** Verdicts that authorize a goal claim. */
function goalAllowed(ctx?: CaptionGroundingContext): boolean {
  // ADAAAA-7958 (contract v3 §3.4): corroboration propagation comes FIRST and
  // fails closed. A window the pipeline counted but never corroborated may not
  // assert a goal on any surface, even when its stored verdict says
  // `scoring_play` — otherwise the page shows "N of M accepted goals are not
  // corroborated by frames — counted, never asserted as scored" next to captions
  // that assert exactly those goals.
  if (ctx?.corroborated === false) return false;
  const verdict = (ctx?.verdict ?? "").trim().toLowerCase();
  if (verdict) return verdict === "scoring_play";
  // Legacy row with no stored verdict: fall back to the accepted event type.
  const eventType = (ctx?.eventType ?? "").trim().toUpperCase();
  return eventType === "GOAL" || eventType === "GOL";
}

/* ------------------------------------------------------------------------- *
 * Contract v3 §3.1 — the claim gate is SEMANTIC and FAILS CLOSED.
 *
 * The Inc 3 gate was an enumeration of bad phrasings ("scores a goal", "into
 * the net", …). A measured level (ADAAAA-7950, job 9fecca77) shipped three
 * `not_highlight` windows that still claimed a goal because the model used
 * phrasings the table had never seen ("No. 10 strikes the ball into the net",
 * "No. 6 shoots and scores in the box"). Adding those two strings to the table
 * would lose again on the next phrasing.
 *
 * So the decision is made the other way round: a score/net/goal word is a CLAIM
 * unless the text around it proves it is not one (a negated form, `goal kick`,
 * `shot on goal`, a scoreboard/graphic reference). The benign list is small and
 * explicit, so anything the mask cannot certify fails closed. The rewrite steps
 * below are only a best-effort SHORTENING of the claim the detector found; when
 * a rewrite cannot certify the line, `quietShape` rebuilds it as the quiet beat.
 * ------------------------------------------------------------------------- */

/**
 * Spans in which a goal/net/score word provably does NOT assert a goal. Matched
 * spans are blanked (same length, so offsets stay valid) before detection.
 */
const BENIGN_CLAIM_SPANS: RegExp[] = [
  // `goal kick`, `goal line`, `goal area`, `goal mouth`, `goal frame`, `goal post`
  /\bgoal\s*[- ]?(?:kick|kicks|line|lines|area|mouth|frame|post|posts)\b/gi,
  // a shot AT goal is not a goal: `shot on goal`, `effort towards goal`
  /\b(?:shot|shots|effort|strike|header|volley|free ?kick|penalty)\s+(?:on|at|towards?|toward)\s+(?:the\s+)?goal\b/gi,
  /\b(?:on|towards?|toward)\s+(?:the\s+)?goal\b/gi,
  /\bgoalward\b/gi,
  // display/audit talk about the score, never a scoring event
  /\bscore\s*[- ]?(?:board|bug|line|keeper|boards?|bugs?|screens?)\b/gi,
  /\bscore\s*[- ]?(?:transition|change|update|state|card|track)\b/gi,
  /\bscoreline\b/gi,
  // a quoted OCR label the model is describing ("the 'GOL' graphic appears")
  /\b(?:goal|gol|gooo+al)\b(?=['’"]?\s*(?:graphic|banner|overlay|title|card|logo)\b)/gi,
  // a negation states the opposite: `does not score`, `no goal`, `never finds the net`
  /\b(?:no|not|never|without|isn't|didn't|doesn't|wasn't)\b[^.;|]{0,40}?\b(?:goal|goals|gol|score[sd]?|scoring|net)\b/gi,
];

/**
 * Score / net / goal vocabulary. Fail closed: a word here IS a goal claim unless
 * a benign span above certifies it. Kept deliberately broad — a phrasing the
 * lexicon has never seen still contains one of these nouns, so it still gates.
 */
const CLAIM_MARKERS: RegExp[] = [
  /\b(?:scores?|scored|scoring|scorers?)\b/i,
  /\b(?:go+al|goals?|gol)\b/i,
  // the net, however the model names it ("the net", "into net", "the net bulges")
  /\bnet\b/i,
  /\b(?:equaliser|equalizer|match[- ]?winner)\b/i,
  /\b(?:levels?|levelled|levelling)\s+it\b/i,
  // putting the ball in, in the many ways a model says it
  /\b(?:taps?\s+(?:it\s+)?in|tap[- ]in|conver(?:ts|ted|t|sion)|slots?\s+(?:it\s+)?(?:in|home)|bur(?:ies|ied)|puts?\s+(?:it|the\s+ball)\s+(?:in|away)|put\s+away|cross(?:es|ed)?\s+the\s+(?:goal\s+)?line|(?:over|past)\s+the\s+(?:goal\s+)?line)\b/i,
  /\b(?:finds?|found)\s+the\s+(?:back\s+of\s+the\s+)?net\b/i,
  // …and the synonyms that never name the net at all
  /\b(?:smashes?|rifles?|blasts?|drills?|hammers?|bangs?|rolls?|squeezes?|flicks?)\s+it\s+(?:in|home)\b/i,
  /\b(?:into|in|inside|finds?|picks?\s+out)\s+the\s+(?:top|bottom|far|near)?\s*corner\b/i,
  /\b(?:in|home)\s+off\s+the\s+(?:post|bar)\b|\boff\s+the\s+(?:post|bar)\s+and\s+in\b/i,
];

/** Blank every benign span, so a claim marker inside one is not detected. */
function maskBenign(text: string): string {
  let out = text;
  for (const re of BENIGN_CLAIM_SPANS) out = out.replace(re, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Does this line assert a goal (score / net semantics)? Fail-closed probe: a
 * score/goal/net word is a claim unless a benign span proves otherwise.
 */
export function hasGoalClaim(text: string): boolean {
  if (!text) return false;
  const masked = maskBenign(text);
  return CLAIM_MARKERS.some((re) => re.test(masked));
}

/** Shot verbs already present in a line (so a rewrite never doubles a verb). */
const SHOT_VERB =
  /\b(?:shoots?|shot|strikes?|struck|fires?|fired|drills?|curls?|curled|hooks?|hooked|hammers?|smashes?|volleys?|heads?|headed|nods?|nodded|pokes?|prods?|bundles?|blasts?|flashes?|squeezes?)\b/i;

/**
 * The non-goal outcome verb a window's own line already carries (§3.1:
 * shot / saved / blocked / cleared / wide / deflected). Falls back to "shoots"
 * when the stored fields do not name an outcome — the generic shot beat is the
 * narrowest claim-free substitution.
 */
export function outcomeVerbFor(text: string): string {
  if (/\b(?:save[sd]?|parr(?:y|ies|ied)|tips?\s+(?:over|wide)|smothers?)\b/i.test(text)) return "is saved";
  if (/\b(?:block(?:s|ed)?|deflect(?:s|ed)?)\b/i.test(text)) return "is blocked";
  if (/\b(?:clear(?:s|ed)?|hoof(?:s|ed)?)\b/i.test(text)) return "is cleared";
  if (/\b(?:wide|off\s+target|over\s+the\s+bar|past\s+the\s+post)\b/i.test(text)) return "goes wide";
  return "shoots";
}

/**
 * Best-effort shortening of a detected claim (ordered, longest phrase first).
 * Every replacement keeps the actor and the place and is same-length or
 * shorter. A phrase this table cannot certify is left to `quietShape`.
 */
function rewriteScoreClaims(input: string, verb: string): string {
  // Protect benign spans first: `shot on goal` must never become `shot on shot`
  // when the bare-goal rule runs. Restored untouched at the end.
  const guarded: string[] = [];
  let out = input;
  for (const re of BENIGN_CLAIM_SPANS) {
    out = out.replace(re, (m) => {
      guarded.push(m);
      return `\u0002${guarded.length - 1}\u0002`;
    });
  }
  // A score phrase that names the goal word in one go.
  out = out.replace(/\b(?:scores?|scored)\s+(?:a|the)?\s*(?:goal|winner)\b/gi, (m) => matchCase(verb, m));
  // ADAAAA-7965 (contract v5 §3.4, R21): the ball crossing the line is a claim,
  // and the v4 rewrite replaced it with an ABSENCE claim ("the ball stays out")
  // that no stored evidence backed — all 5 accepted reasons on `fd9c0259`
  // asserted the ball stayed out while their own `reason_raw` said it entered
  // the net and the T+12 frame showed a `GOL` overlay. An absence assertion
  // needs evidence on the same terms as a positive one (§3.4), so the rewrite
  // REMOVES the clause instead of inventing the opposite claim.
  out = out.replace(
    /\b(?:and\s+)?(?:the\s+)?ball\s+(?:enters?|is\s+in|goes?\s+into|is\s+into|is\s+in)\s+the\s+net\b/gi,
    ""
  );
  out = out.replace(/\b(?:into|inside)\s+(?:the\s+)?net\b/gi, (m) => matchCase("wide", m));
  out = out.replace(/\binto\s+net\b/gi, (m) => matchCase("wide", m));
  out = out.replace(/\b(?:the\s+)?net\s+(?:ripples|bulges|swells|shakes|billows)\b/gi, (m) =>
    matchCase("goes wide", m)
  );
  out = out.replace(/\b(?:finds?|found|hits?|hit)\s+(?:the\s+)?(?:back\s+of\s+the\s+)?net\b/gi, (m) =>
    matchCase(`${verb} wide`, m)
  );
  out = out.replace(/\b(?:cross(?:es|ed)?|over|past)\s+the\s+(?:goal\s+)?line\b/gi, (m) =>
    matchCase(`${verb} wide`, m)
  );
  // Putting it in with a foot/head.
  out = out.replace(
    /\b(?:taps?|tapped|slots?|slotted|buries?|buried|puts?|put)\s+(?:it\s+|the\s+ball\s+)?(?:in|home|away)\b/gi,
    (m) => matchCase(verb, m)
  );
  out = out.replace(/\bconver(?:ts|ted)\b/gi, (m) => matchCase(verb, m));
  out = out.replace(/\b(?:levels?|levelled)\s+it\b/gi, (m) => matchCase("goes wide", m));
  // "<shot verb> and scores" -> keep the shot; otherwise "and <verb>".
  out = out.replace(
    /(\s*(?:,\s*)?(?:(?:and|then)\s+){1,2})(?:scores?|scored)\b/gi,
    (m, joiner: string, offset: number, whole: string) =>
      SHOT_VERB.test(whole.slice(0, offset)) ? "" : `${joiner}${verb}`
  );
  // Bare score / goal words left after the phrase rules.
  out = out.replace(/\b(?:scores?|scored)\b/gi, (m) => matchCase(verb, m));
  out = out.replace(/\b(?:go+al|goals?)\b/gi, (m) => matchCase("shot", m));
  out = out.replace(/\b(?:equaliser|equalizer|match[- ]?winner)\b/gi, (m) => matchCase(verb, m));
  out = out.replace(/\u0002(\d+)\u0002/g, (_m, i: string) => guarded[Number(i)] ?? "");
  return out;
}

/**
 * A place phrase at the end of a clause ("in the box", "from the edge of the
 * area"). ADAAAA-7965 widens this from "any words after a preposition" — which
 * matched a claim clause ("in the net before the whistle") and let it be
 * re-attached as if it were a zone — to an explicit PLACE vocabulary. A phrase
 * outside the vocabulary is not a place, so the §3.2 stored-zone injection
 * decides instead of a mis-parsed clause.
 */
/** The place nouns this gate recognises (measured place forms + the contract's). */
const PLACE_NOUN_SRC = String.raw`(?:penalty\s+area|box|goal\s+area|six[- ]yard\s+box|` +
  String.raw`cent(?:er|re)(?:\s+(?:circle|field|area))?|midfield|middle\s+third|final\s+third|` +
  String.raw`attacking\s+third|defensive\s+third|near\s+post|far\s+post|close\s+range|` +
  String.raw`touchline|wing|halves?|half|edge\s+of\s+the\s+(?:box|area)|` +
  String.raw`left|right)`;

const PLACE_TAIL = new RegExp(
  String.raw`\b(?:in|at|from|near|inside|outside|around|on|into)\s+(?:the\s+)?` + PLACE_NOUN_SRC + String.raw`\b\.?$`,
  "iu"
);

/** Any place phrase anywhere in a line (not just the tail). */
const PLACE_ANYWHERE = new RegExp(
  String.raw`\b(?:in|at|from|near|inside|outside|around|on|into)\s+(?:the\s+)?` + PLACE_NOUN_SRC + String.raw`\b`,
  "iu"
);

/** Does the line name a place at all? (§3.2: a lead must.) */
export function hasPlacePhrase(text: string): boolean {
  return PLACE_ANYWHERE.test(text ?? "");
}

/**
 * ADAAAA-7962 (contract v4 §3.4): the place phrase a line already carries, so a
 * rewrite or a quiet trim can KEEP it instead of cutting through it. "" when the
 * line names no place (then a caller-supplied `ctx.place` is the only zone).
 */
export function placePhraseOf(text: string): string {
  // Trailing sentence punctuation is not part of the place: the measured lines
  // end "… in the penalty area." and an unnormalised tail never matched.
  const lead = captionLead(text).replace(/[.!?;:,]+$/, "").trim();
  const m = lead.match(PLACE_TAIL);
  return (m?.[0] ?? "").trim();
}

/** Action verbs a quiet line can keep without inventing anything. */
const QUIET_ACTION =
  /^(?:reacts?|moves?|drives?|controls?|contests?|dribbles?|stands?|passes?|plays?|takes?|holds?|watches?|waits?|runs?|shoots?|strikes?|heads?|clears?|tackles?|blocks?|saves?|jumps?|turns?|attacks?|presses?|chases?|follows?|keeps?|sets?)$/i;

/**
 * ADAAAA-7962 (contract v4 §3.4): condense a quiet line to ACTOR + ACTION +
 * PLACE instead of cutting it at the 8-word boundary. The v3 trim truncated
 * "No. 9 reacts to a play in the penalty area" to "No. 9 reacts to a play in" —
 * the claim was already gone, but so was the zone, and the place is the half of
 * the beat that makes the line play-by-play (measured page place density 11/20,
 * level dcaa93c5).
 *
 * Deterministic and extractive: it keeps the line's own actor words and its own
 * action verb, then re-attaches the line's own place phrase (or the caller's
 * stored zone). It invents nothing and returns "" when the line has no place at
 * all, so the caller can fall back to the old truncation.
 */
function condenseKeepingPlace(text: string, placeOverride?: string | null): string {
  const lead = captionLead(text);
  const tail = placePhraseOf(lead);
  const place = tail || (placeOverride ?? "").trim();
  if (!place) return "";
  const cut = lead.toLowerCase().lastIndexOf(place.toLowerCase());
  const body = (cut > 0 ? lead.slice(0, cut) : lead).replace(/[\s,;:—–-]+$/, "").trim();
  if (!body) return "";
  const words = body.split(/\s+/).filter(Boolean);
  const verbIdx = words.findIndex((w) => QUIET_ACTION.test(w));
  // Keep the actor words up to and including its action verb; drop the rest.
  const head = (verbIdx >= 0 ? words.slice(0, verbIdx + 1) : words)
    .join(" ")
    .replace(/\s+\b(?:the|a|an|to|of|in|at|on|with|and|from)\b$/i, "")
    .trim();
  if (!head) return "";
  return tidy(`${head} ${place}`);
}

/** Remove every detected claim marker (the last-resort, always-honest shape). */
function stripClaimMarkers(text: string): string {
  const masked = maskBenign(text);
  let out = text;
  // Delete claim markers right-to-left so earlier offsets stay valid.
  const spans: { start: number; end: number }[] = [];
  for (const re of CLAIM_MARKERS) {
    const r = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = r.exec(masked)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  spans.sort((a, b) => b.start - a.start);
  for (const s of spans) out = `${out.slice(0, s.start)} ${out.slice(s.end)}`;
  return tidy(out);
}

/**
 * The quiet shape (§3.3): actor + outcome verb + place, with the claim removed.
 * Deterministic — it is built from the line's own words, never from a model call
 * — and it is the fallback for any claim phrasing the rewrite steps could not
 * certify, which is what makes the gate fail closed.
 */
export function quietShape(text: string, verb?: string): string {
  const outcome = verb ?? outcomeVerbFor(text);
  const lead = captionLead(text);
  const first = lead.split(/[.;!?]\s+|;\s*/)[0].trim() || lead.trim();
  const masked = maskBenign(first);
  let idx = -1;
  for (const re of CLAIM_MARKERS) {
    const m = new RegExp(re.source, "i").exec(masked);
    if (m && (idx < 0 || m.index < idx)) idx = m.index;
  }
  let head = idx > 0 ? first.slice(0, idx) : "";
  head = head.replace(/[\s,;:]+$/, "").replace(/\s+\b(?:and|then)\b$/i, "").trim();
  if (/^(?:a|an|the)$/i.test(head)) head = "";
  const place = (first.match(PLACE_TAIL)?.[0] ?? "").trim();
  const parts: string[] = [];
  if (head) parts.push(head);
  if (!head || !SHOT_VERB.test(head)) parts.push(idx > 0 ? outcome : "shot");
  if (place && !head.toLowerCase().includes(place.toLowerCase())) parts.push(place);
  let out = tidy(parts.join(" "));
  if (!out) out = stripClaimMarkers(first);
  if (!out) out = "Shot";
  // A shape that still carries a claim marker is never emitted.
  if (hasGoalClaim(out)) out = stripClaimMarkers(out) || "Shot";
  return out;
}


/**
 * Internal decision-reason tails that are appended to a decide `reason` for
 * audit ("| celebration of an already-delivered goal (anchor 120.0s, highlight
 * …): no independent score-transition evidence…"). They are never copy, and
 * rewriting their words produces nonsense ("shoots-transition"), so the whole
 * tail is removed before any other rule looks at the line.
 */
const INTERNAL_REASON_TAIL =
  /\s*\|\s*(?:celebration of an already-delivered|no independent|dedupe|suppressed|burst|downgraded|anchor\s)[^|]*/gi;
/** Evidence tags the pipeline appends to a decide reason ("; scoreboard score
 * change confirmed"). Not copy — removed before any other rule runs. */
const EVIDENCE_TAG =
  /;?\s*\b(?:scoreboard score change confirmed|score change confirmed|frame attestation confirmed|attestation confirmed)\b/gi;

/**
 * ADAAAA-7956 (contract v3, residual of ADAAAA-7949): a caption's colour /
 * atmosphere clause ("— crowd erupts") is appended after an em or en dash. It
 * belongs to a LOUD window (the crowd/bench channel), never to a quiet one.
 */
const COLOUR_CLAUSE_SPLIT = /\s+[—–]\s+/;

/** The lead beat of a caption (everything before its colour clause). */
export function captionLead(text: string): string {
  const m = COLOUR_CLAUSE_SPLIT.exec(text ?? "");
  return (m ? (text ?? "").slice(0, m.index) : (text ?? "")).trim();
}

/** The appended colour/atmosphere clause, or "" when the caption has none. */
export function captionColour(text: string): string {
  const m = COLOUR_CLAUSE_SPLIT.exec(text ?? "");
  return m ? (text ?? "").slice(m.index).replace(/^[\s—–]+/, "").trim() : "";
}

/** Drop the appended colour clause, keeping the lead beat (never blanks). */
export function dropColourClause(text: string): string {
  const lead = captionLead(text);
  return lead || text;
}

/** The calm-window word budget the fast contract grades (AC5). */
export const QUIET_MAX_WORDS = 8;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Tokens that are not a sentence end even when followed by a period: a jersey
 * number (`No. 9`), a title, a country code, or a single initial. Without this
 * guard, splitting `No. 10 strikes ball into net` on `No.` produces two beats.
 */
const NON_TERMINAL_ABBREV = /^(?:No|Nr|Mr|Mrs|Ms|Dr|St|Jr|Sr|vs|etc)$/i;

/** Split one stored line into the SENTENCES it carries (beats, in order). */
function sentenceBeats(line: string): string[] {
  const src = (line ?? "").trim();
  if (!src) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?](?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 1), m.index);
    const after = src.charAt(m.index + 1);
    // A decimal (`11.6`) or an abbreviation (`No. 9`) is not a sentence end.
    if (/\d/.test(before) && /\d/.test(after)) continue;
    const word = src.slice(0, m.index).trim().split(/\s+/).pop() ?? "";
    if (NON_TERMINAL_ABBREV.test(word) || /^[A-Z]$/.test(word)) continue;
    out.push(src.slice(start, m.index + 1).trim());
    start = m.index + 1;
  }
  const rest = src.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * ADAAAA-7961: the BEATS a stored summary string carries, one per line and one
 * per sentence within a line. A 15 s summary row is one beat; a stored row that
 * carries two sentences (`Player in possession in center circle. No. 10 strikes
 * ball into net`) is two beats, so the append seam can store one row each and a
 * read surface can render the first without cutting through the second.
 */
export function captionBeats(text: string): string[] {
  return (text ?? "")
    .split("\n")
    .flatMap((line) => sentenceBeats(line))
    .map((beat) => beat.trim())
    .filter(Boolean);
}

/**
 * Function words a delivered caption may never END on. A cut at a word boundary
 * can leave `… in`, `… from 2-1 to` or `… as score becomes`, which reads as a
 * sentence that stopped mid-phrase.
 */
const TRAILING_FUNCTION_WORD =
  /\s+\b(?:in|at|on|of|to|with|and|but|as|while|when|from|by|for|into|onto|the|a|an|if|than|that|which|who|whose|over|under|near|inside|outside|around|after|before|during|through|across|its?|his|her|their|was|were|is|are|has|have|had)\b[\s,;:—–-]*$/i;

/** A verb that owns an object: ending on it means the object was cut away. */
const OPEN_OBJECT_VERB =
  /\s+\b(?:becomes?|reads?|shows?|changes?|moves?|goes?|reaches?|levels?)\s*(?:to|at|from)?[\s,;:—–-]*$/i;

/** A score frame left behind by a removed scoreline (`… from 2-1 to 2-2`). */
function trailingScoreFrameRe(): RegExp {
  // Built lazily: `SCORE_TOKEN_SRC` is declared with the score gate below.
  return new RegExp(String.raw`\s+\b(?:from|to|at)\s+` + SCORE_TOKEN_SRC + String.raw`[\s,;:—–-]*$`, "gi");
}
const TRAILING_SCORE_NOUN =
  /\s+\b(?:(?:as|while|when|and|with)\s+(?:the\s+)?(?:score\s*board|score|scoreline)|(?:the\s+)?(?:score\s*board|scoreline))\s*[\s,;:—–-]*$/i;

/** A clause boundary inside a sentence (`… while players`, `… and shoots`). */
const TAIL_CLAUSE_OPENER = /\s+\b(while|as|when|and|but|with|which|that|who|because|although)\b/gi;

/**
 * Tokens that make a tail CLAUSE complete. A tail with none of these is an
 * unfinished clause (`… while players`), which is what a word-boundary cut
 * leaves behind; a tail with one (`… and shoots`) is a whole clause and stays.
 */
const VERBISH =
  /\b(?:reacts?|moves?|drives?|controls?|contests?|dribbles?|stands?|passes?|plays?|takes?|holds?|watches?|waits?|runs?|shoots?|strikes?|heads?|clears?|tackles?|blocks?|saves?|jumps?|turns?|attacks?|presses?|chases?|follows?|keeps?|sets?|scores?|scored|carries|carried|wins?|won|sends?|sent|puts?|makes?|made|finds?|found|gets?|got|comes?|came|goes?|went|rises?|rose|falls?|fell|lifts?|lofts?|rolls?|bounces?|crosses?|fires?|volleys?|tries?|tried|sees?|saw|looks?|appears?|erupts?|celebrates?|updates?|becomes?|reads?|shows?|is|are|was|were|has|have|had|does|did|can|could|will|would|may|might|must)\b/i;

/**
 * ADAAAA-7961 (§3.3/§3.4 residuals): repair a delivered string that stops
 * mid-phrase. Additive and extractive only — it never invents words, never
 * reorders them, and returns the input when it already ends on a complete
 * phrase (byte-identical). It removes, in order, the four shapes the served
 * build shipped:
 *
 *   `… while players`            -> the subordinated clause lost its verb
 *   `… from 2-1 to`              -> the score span took its object with it
 *   `… as score becomes`         -> the score frame outlived the scoreline
 *   `… updates from`             -> the preposition outlived its object
 *
 * A line that repairs down to nothing (or to a single token) keeps its original
 * text, so a caption is never blanked.
 */
export function repairDanglingTail(text: string): string {
  const input = (text ?? "").trim();
  if (!input) return input;
  let out = input;
  for (let i = 0; i < 4; i += 1) {
    const before = out;
    out = out
      .replace(trailingScoreFrameRe(), "")
      .replace(OPEN_OBJECT_VERB, "")
      .replace(TRAILING_SCORE_NOUN, "")
      .replace(TRAILING_FUNCTION_WORD, "")
      .replace(/\s*[—–-]\s*$/, "")
      .replace(/[\s,;:]+$/, "");
    // An unfinished clause after a conjunction/subordinator: keep the clause
    // before it (`A child stands in the foreground while players`).
    let tail: RegExpExecArray | null;
    let lastOpener: RegExpExecArray | null = null;
    TAIL_CLAUSE_OPENER.lastIndex = 0;
    while ((tail = TAIL_CLAUSE_OPENER.exec(out)) !== null) lastOpener = tail;
    if (lastOpener) {
      const rest = out.slice(lastOpener.index + lastOpener[0].length).trim();
      // Only a SHORT verb-less tail is a cut clause. A longer tail is a real
      // phrase (`… with the outside of the boot`) and stays.
      if (rest && wordCount(rest) <= 3 && !VERBISH.test(rest)) out = out.slice(0, lastOpener.index).trim();
    }
    if (out === before) break;
  }
  // A conjunction that introduced the removed clause is not a sentence end.
  out = out.replace(/\s+\b(?:as|while|when|and|but|with)\b$/i, "").trim();
  return wordCount(out) >= 2 ? out : input;
}

/** Words that OPEN a new clause: cutting just before one leaves a whole clause. */
const CLAUSE_OPENER =
  /^(?:and|but|while|as|when|which|that|who|because|although|with|then|from|to|in|at|on|of|into|by|for|near|inside|outside|around|over|under)$/i;

/**
 * Cut `text` at the LAST clause boundary that fits the budget, so a blunt quiet
 * line ends on a whole clause (`A child stands in the foreground`, never
 * `… while players`). "" when no boundary fits, so the caller can fall back.
 */
function cutAtClauseBoundary(text: string, maxWords: number): string {
  const tokens = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const limit = Math.min(maxWords, tokens.length);
  for (let n = limit; n >= 2; n -= 1) {
    const head = tokens.slice(0, n);
    const last = head[n - 1];
    const next = tokens[n];
    const endsSentence = /[.!?]$/.test(last);
    const endsClause = /[,;—–]$/.test(last);
    const startsNewClause = next != null && CLAUSE_OPENER.test(next);
    if (!(endsSentence || endsClause || startsNewClause)) continue;
    const body = head.join(" ").replace(/[,;—–]+$/, "").trim();
    if (!body) continue;
    return endsSentence ? body : `${body}.`;
  }
  return "";
}

/**
 * Ordered, honest shortenings for an over-long quiet line. Each removes detail
 * the window does carry (a second kit colour, the word "kit", "with the ball")
 * — none invents anything, none touches the named place, and the list is
 * applied longest-saving-first only until the 8-word budget is met.
 */
const QUIET_TRIMS: [RegExp, string][] = [
  // "penalty area" -> "box": the same place in the vocabulary the contract
  // already uses, four tokens shorter. ADAAAA-7965 puts it FIRST so an over-long
  // quiet line compresses the place instead of dropping an actor word (the v4
  // order produced "The striker player shoots in the penalty area").
  [/\bpenalty\s+area\b/gi, "box"],
  [/\s+\bwith\s+(?:the\s+)?ball\b/gi, ""],
  [
    /\s+\band\s+(?:white|blue|red|black|yellow|green|purple|orange|grey|gray)\b(?=\s+(?:kit|jersey|shirt|strip)\b)/gi,
    "",
  ],
  [/\s+\b(?:kit|jersey|shirt|strip|colours)\b/gi, ""],
  // "The No. 9 controls the ball in the penalty area." -> "No. 9 ..." (the
  // article before a jersey number is pure filler on a caption line).
  [/\bThe\s+(?=No\.?\s*\d+\b)/gi, ""],
  // ADAAAA-7956 (level 3, job 8c045146): "in the center circle" -> "in center
  // circle" — the contract's own compressed place form, one token shorter.
  [/\bin\s+the\s+(center|centre)\s+circle\b/gi, "in $1 circle"],
  // ADAAAA-7957: the actor's colour robe is the last honest detail to lose when
  // the place is what makes the line a beat ("Player in blue takes the goal
  // kick in midfield" -> "Player takes the goal kick in midfield").
  [/\s+\bin\s+(?:the\s+)?(?:white|blue|red|black|yellow|green|purple|orange|grey|gray)\b/gi, ""],
];

/**
 * Blunt a quiet line down to the 8-word budget (byte-identical when it fits).
 *
 * ADAAAA-7962 (contract v4 §3.4): a line that still carries a place phrase after
 * the trims is condensed to ACTOR + ACTION + PLACE rather than cut at the word
 * boundary, so the trim can never leave a dangling preposition or drop the zone.
 */
export function trimQuietLine(text: string, placeOverride?: string | null): string {
  const input = text ?? "";
  if (!input.trim() || wordCount(input) <= QUIET_MAX_WORDS) return repairDanglingTail(input);
  let out = input;
  // ADAAAA-7961: a row is ONE beat. When a pass stored two sentences on one row
  // (`Player in possession in center circle. No. 10 strikes ball into net`), keep
  // the first beat instead of cutting through the second (`… No. 10`).
  const beats = captionBeats(input);
  if (beats.length > 1 && wordCount(beats[0]) <= QUIET_MAX_WORDS) out = beats[0];
  for (const [re, replacement] of QUIET_TRIMS) {
    if (wordCount(out) <= QUIET_MAX_WORDS) break;
    out = out.replace(re, replacement);
  }
  if (wordCount(out) > QUIET_MAX_WORDS) {
    const condensed = condenseKeepingPlace(out, placeOverride);
    if (condensed && wordCount(condensed) <= QUIET_MAX_WORDS) out = condensed;
  }
  if (wordCount(out) > QUIET_MAX_WORDS) {
    // Last resort: cut at the last CLAUSE boundary that fits the budget (never
    // inside a clause), then repair a tail that still dangles. The v4 word cut
    // shipped `A child stands in the foreground while players` and
    // `The ball stays out and the scoreboard updates from 2-1 to`.
    const clause = cutAtClauseBoundary(out, QUIET_MAX_WORDS);
    out =
      clause ||
      out
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, QUIET_MAX_WORDS)
        .join(" ");
  }
  out = repairDanglingTail(out);
  if (out === input) return input;
  return tidy(out);
}

/** Verdicts that own a colour beat and the full line (AC4). */
const LOUD_VERDICTS = new Set(["scoring_play", "near_miss", "big_play"]);

/**
 * Is this a quiet window? §3.3: any verdict that is not goal/highlight. An
 * unrecognised verdict is treated as quiet (fail closed); a row with NO stored
 * verdict is a legacy row and is not length-gated.
 */
export function isQuietVerdict(verdict?: string | null): boolean {
  const v = (verdict ?? "").trim().toLowerCase();
  return v !== "" && !LOUD_VERDICTS.has(v);
}

/**
 * §3.5: scorebug / graphic OCR text is not a colour beat. A colour clause that
 * cites a graphic, overlay, scoreboard or OCR read is dropped — the crowd/bench
 * channel is the only colour evidence this contract accepts.
 */
const OCR_CITATION =
  /\b(?:graphic|graphics|scorebug|score ?board|ocr|overlay|on-?screen|banner|lower[- ]third|title card|telestrator)\b/i;

/** v4 §3.5: the char ceiling on a delivered colour beat. */
export const COLOUR_MAX_CHARS = 40;

/**
 * ADAAAA-7965 (contract v5 §3.1, R18): nouns a DERIVED level beat may never
 * name. The audit measured the source audio as a voice-like bed (88.6-89.9% of
 * energy in 300-3400 Hz, spectral flatness 0.0067-0.0097), so every reaction
 * word the v4 channel forwarded ("crowd erupts", "players celebrate") named
 * something the signal does not measure — and 14 of 14 such beats were
 * contradicted by their own frames. A beat words the LEVEL, never a reaction.
 */
const COLOUR_REACTION_NOUN =
  /\b(?:crowd|stand|stands|bench|dugout|celebrat\w*|roar\w*|erupt\w*|momentum|stadium|fans?|scenes?)\b/i;

/**
 * ADAAAA-7965 (contract v5 §3.1, R18): derive the colour beat from the measured
 * per-window audio-noise delta — the signal ADAAAA-7964 selected — instead of
 * forwarding the model's colour clause.
 *
 * The rule is the audit's §5 parameter block, verbatim: emit only when the
 * window carries a SHORT burst (`ratio >= 2.0`), not a plateau
 * (`sustained <= 0.35`), with real energy (`peak >= 0.15`), and only when a
 * stored frame confirms the instant the burst happened (frameTs / frameSeq).
 * Wording is a function of the measured ratio, so the same signal always yields
 * the same sentence and no sentence can outrun its evidence.
 *
 * Returns "" (the drop path) whenever the signal does not fire, is malformed, or
 * the drafted beat is outside the content rules. A dropped beat means the row
 * keeps its quiet shape — never a contradiction.
 */
export function colourBeatFromSignal(signal?: ColourSignal | null): string {
  if (!signal || signal.signal !== "audio_noise") return "";
  const { ratio, sustained, peak } = signal;
  if (![ratio, sustained, peak].every((n) => typeof n === "number" && Number.isFinite(n))) return "";
  if (ratio < 2 || sustained > 0.35 || peak < 0.15) return "";
  // §3.1: every delivered beat carries the frame/timestamp that confirms it.
  const hasFrame =
    (typeof signal.frameTs === "number" && Number.isFinite(signal.frameTs)) ||
    (typeof signal.frameSeq === "number" && Number.isFinite(signal.frameSeq));
  if (!hasFrame) return "";
  const beat =
    ratio >= 10
      ? "noise spikes over the play"
      : ratio >= 4
        ? "noise lifts, then settles"
        : "noise rises with the play";
  if (beat.length > COLOUR_MAX_CHARS) return "";
  if (COLOUR_GUARD(beat)) return "";
  return beat;
}

/** The content rules a derived beat must satisfy (§3.1 + v4 §3.5). */
function COLOUR_GUARD(beat: string): boolean {
  return (
    COLOUR_REACTION_NOUN.test(beat) ||
    OCR_CITATION.test(beat) ||
    hasGoalClaim(beat) ||
    hasProperName(beat)
  );
}

export function colourBeatAllowed(colour: string, ctx?: CaptionGroundingContext): boolean {
  const c = (colour ?? "").trim();
  if (!c) return false;
  if (c.length > COLOUR_MAX_CHARS) return false;
  if (COLOUR_GUARD(c)) return false;
  // §3.1: a beat is only allowed when it IS the beat this window's own signal
  // derives. A model clause (or any other sentence) fails closed.
  return colourBeatFromSignal(ctx?.colourSignal) === c;
}

/**
 * ADAAAA-7962 (contract v4 §3.5): does `text` carry a proper name? A colour beat
 * may never name a person or a club — an invented name in a colour clause is
 * exactly the invented-name failure AC4 grades ("Real Madrid player …").
 */
export function hasProperName(text: string): boolean {
  const matches = [...(text ?? "").matchAll(NAME_WORD)];
  for (const m of matches) {
    const word = stripDiacritics(m[0]);
    if (NAME_STOPWORDS.has(word)) continue;
    if (CODE_TOKENS.has(word)) continue;
    return true;
  }
  return false;
}

export function gateOcrColour(text: string): string {
  const colour = captionColour(text);
  if (!colour || !OCR_CITATION.test(colour)) return text;
  const out = tidy(dropColourClause(text));
  return out === text ? text : out;
}

/**
 * ADAAAA-7956 rule 1 + ADAAAA-7957 §3.3 — the quiet gate, enforced at EMISSION
 * and AFTER the claim and name rewrites, so a rewrite can never push a line back
 * over the bar. A quiet window emits ≤ 8 words and carries no unmeasured colour.
 *
 * ADAAAA-7965 (contract v5 §3.1, R18): the colour clause the MODEL wrote is
 * dropped on every window — it is not derived from anything and both v4 beats
 * measured were contradicted by their own frames. What rides instead is the beat
 * DERIVED from this window's audio-noise signal (§3.1), and only when that
 * signal fires. Quiet rows still cap at the 40% share at the write seam.
 *
 * A loud window keeps the derived beat; a legacy row with no stored verdict is
 * untouched apart from an OCR clause or a forwarded model clause.
 */
export function gateQuietWindow(text: string, ctx?: CaptionGroundingContext): string {
  let out = gateOcrColour(text);
  // R18: a forwarded model colour clause is never customer copy.
  if (captionColour(out)) out = tidy(dropColourClause(out));
  const beat = colourBeatFromSignal(ctx?.colourSignal);
  // A lead that already ended a sentence does not keep its period before the
  // appended beat ("No. 10 carries ball in center circle. — noise lifts").
  const withBeat = (lead: string) => tidy(`${lead.replace(/[.!?;:,]+$/, "")} — ${beat}`);
  if (!isQuietVerdict(ctx?.verdict)) {
    out = beat ? withBeat(out) : out;
    return out === text ? text : tidy(out);
  }
  const lead = trimQuietLine(captionLead(out), ctx?.place);
  out = beat ? withBeat(lead) : lead;
  if (/[—–]/.test(out) && !beat) out = out.replace(/\s*[—–]\s*/g, ", ");
  return out === text ? text : tidy(out);
}

/*
 * §3.1 claim gate. A goal verdict (and a corroborated one, §3.4) passes through
 * byte-identical; every other window has its goal claim rewritten to the
 * window's outcome verb, or to the quiet shape when the outcome is not
 * determinable. The colour clause that came with a rewritten claim is dropped
 * with it (a quiet beat cannot ride a claim) — R18: the ONLY colour a rewritten
 * line can carry is the beat derived from this window's signal, which the quiet
 * gate appends after this pass.
 */
export function gateGoalClaims(text: string, ctx?: CaptionGroundingContext): string {
  if (goalAllowed(ctx)) return text;
  if (!hasGoalClaim(text)) return text;
  // v4 §3.4: the claim goes, the place stays.
  let out = dropColourClause(text);
  const place = placePhraseOf(out) || (ctx?.place ?? "").trim();
  const verb = outcomeVerbFor(out);
  out = rewriteScoreClaims(out, verb);
  // Anything the rewrite steps cannot certify fails closed to the quiet shape.
  if (hasGoalClaim(out)) out = quietShape(out, verb);
  // A rewrite keeps actor + action + PLACE. When the rewrite dropped the zone
  // ("Saez strikes the ball wide" from a line that named one) re-attach it —
  // but never turn a rewrite that had no place into a claim of one.
  if (!/[A-Za-z]/.test(out)) return "";
  // A clause removed with the claim can leave a conjunction dangling at a
  // sentence edge ("… as."): drop it BEFORE any place is re-attached, so the
  // zone is not glued onto a half-clause.
  out = tidy(out.replace(/\b(?:and|but|as|then)\s*(?=[,.;:!?]|$)/gi, "")).replace(/^\s*(?:and|but|as|then)\s+/i, "");
  if (PLAY_VERB.test(out) && place && !placePhraseOf(out) && !out.toLowerCase().includes(place.toLowerCase())) {
    const withPlace = tidy(`${out} ${place}`);
    if (wordCount(withPlace) <= QUIET_MAX_WORDS + 2) out = withPlace;
  }
  out = repairLeadingCase(text, out);
  return out === text ? text : tidy(out);
}

/** Score-shaped token (`2-2`, `0 – 1`) that is not an `M:SS` clock. A trailing
 * sentence period is allowed (`updates to 2-1.`), a decimal is not. */
const SCORE_TOKEN_SRC = String.raw`(?<![\w:.])\d{1,2}\s*[-–—]\s*\d{1,2}(?![\w:]|\.\d)`;
const CLOCK_SRC = String.raw`\b\d{1,3}:\d{2}\b`;

/** Every score-shaped string in `text` (normalised, no spaces). */
export function findScoreClaims(text: string): string[] {
  const masked = (text ?? "").replace(new RegExp(CLOCK_SRC, "g"), "\u0000");
  const re = new RegExp(SCORE_TOKEN_SRC, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) out.push(m[0].replace(/\s+/g, ""));
  return out;
}

/**
 * ADAAAA-7965 (contract v5 §3.3, R20): removing a score span removes the
 * prepositions that introduced it. The v4 strip dropped only the `1-1` tokens,
 * so 4 of 5 accepted highlight reasons shipped ungrammatical copy:
 *
 *   `The scoreboard updates from to as the ball stays out.`
 *   `The ball stays out and the scoreboard updates from.`   (x2)
 *
 * Each of those strings is pinned in `caption-grounding-v5.test.ts` and must not
 * be producible. The order below is fixed: the `from X to Y` pair first (both
 * prepositions belong to the pair), then a single prepositioned span, then a
 * `leads/trails by` span (keeping its verb), then any bare token, then orphaned
 * prepositions and coordinate conjunctions left at a clause edge.
 */
const SCORE_OPT = String.raw`(?:the\s+)?(?:score\s*(?:of|is)?\s*)?`;
const SCORE_PAIR = new RegExp(
  String.raw`\bfrom\s+` + SCORE_OPT + SCORE_TOKEN_SRC + String.raw`\s+to\s+` + SCORE_OPT + SCORE_TOKEN_SRC,
  "gi"
);
const SCORE_LEAD = new RegExp(
  String.raw`\b(leads?|trails?)\s+by\s+` + SCORE_OPT + SCORE_TOKEN_SRC,
  "gi"
);
const SCORE_WITH_PREP = new RegExp(
  String.raw`\b(?:from|to|at|into|level\s+at)\s+` + SCORE_OPT + SCORE_TOKEN_SRC,
  "gi"
);
/** A preposition whose object was a score that has already been removed. */
const ORPHAN_PREP = /\b(?:from|to|at|into)\s+(?=(?:from|to)\b|and\b|as\b|[,.;:!?]|$)/gi;
/** The `from to` shape a double strip leaves behind. */
const PREP_PAIR = /\b(?:from\s+to|to\s+from)\b/gi;
/**
 * ADAAAA-7961: the FRAME that introduced a scoreline. When the number goes it
 * takes the frame's object with it, leaving `… crowd erupts as score becomes`.
 * The frame is removed whole, including the connective that introduced it.
 */
const SCORE_FRAME =
  /\b(?:as|while|when|and|with)?\s*(?:the\s+)?(?:score\s*board|score|scoreline)\s+(?:becomes?|became|reads?|is\s+now|stands?\s+at|moves?\s+to|goes?\s+to|updates?\s+to|changes?\s+to|shows?)\s*(?:to|at|from)?\s*/gi;

/** Strip one uncorroborated score span (and its prepositions) from `text`. */
function stripScoreSpan(text: string): string {
  const stripped = tidy(
    text
      .replace(SCORE_PAIR, "")
      .replace(SCORE_LEAD, "$1")
      .replace(SCORE_WITH_PREP, "")
      .replace(new RegExp(SCORE_TOKEN_SRC, "gi"), "")
      .replace(PREP_PAIR, "")
      .replace(ORPHAN_PREP, "")
      // A conjunction that lost its right-hand clause is not a sentence end.
      .replace(/\b(?:and|but|as)\s+(?=[,.;:!?]|$)/gi, "")
  );
  // ADAAAA-7961: the frame that introduced the scoreline stays behind when the
  // token goes (`… crowd erupts as score becomes 2-2`). Remove it whole — but
  // only when a real line remains, so a pure scoreboard statement never
  // degenerates to a bare article.
  const unframed = tidy(stripped.replace(SCORE_FRAME, ""));
  const out = wordCount(unframed) >= 2 ? unframed : stripped;
  return repairDanglingTail(out);
}

/** Rewrite/remove score strings that the window's prompt does not corroborate
 * (same shape as the summary ladder's fact gate, ADAAAA-7623). */
function gateScores(text: string, promptText: string): string {
  let out = text;
  while (findScoreClaims(out).some((claim) => !promptHas(promptText, claim))) {
    const before = out;
    out = stripScoreSpan(out);
    if (out === before) break;
  }
  if (out === text) return text;
  return out;
}

/**
 * ADAAAA-7965 (contract v5 §3.4, R21): the absence / no-goal assertions a gate
 * line can carry, with the connective that introduced them so removing one
 * leaves a sentence.
 *
 * A claim that something did NOT happen (`the ball stays out`, `no goal`,
 * `never crossed`) needs evidence on the same terms as a positive claim — the
 * window's stored verdict AND its frames. v4's fail-closed rewrite swapped one
 * ungrounded claim for another: all 5 accepted reasons on `fd9c0259` asserted
 * `The ball stays out` while their own `reason_raw` said the ball entered the
 * net and the T+12 frame showed a `GOL` overlay.
 */
const ABSENCE_CLAUSES: RegExp[] = [
  /\b(?:and|but|as|while)?\s*(?:the\s+)?ball\s+(?:stays?|stayed|is|was)\s+out\b/gi,
  /\b(?:and|but|as|while)?\s*(?:the\s+)?ball\s+(?:is|was)\s+out\s+of\s+play\b/gi,
  /\b(?:with\s+)?(?:no|not\s+a|never\s+a|without\s+a)\s+goal\b/gi,
  /\b(?:never|didn'?t|did\s+not|hasn'?t|has\s+not|wasn'?t|was\s+not)\s+(?:cross(?:ed|es)?|go(?:ne|es)?\s+in|entered|found\s+the\s+(?:back\s+of\s+the\s+)?net)\b/gi,
  /\b(?:wide\s+of|off)\s+the\s+(?:goal|target)\b(?=[^.;]*\b(?:no|never|not)\b)/gi,
];

/** Does this line assert an absence / no-goal? */
export function hasAbsenceClaim(text: string): boolean {
  if (!text) return false;
  return ABSENCE_CLAUSES.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * §3.4: an absence claim survives only when the window's own stored verdict and
 * frames back it. Otherwise the clause is removed and — when nothing else is
 * left — the row does not ship (the quiet shape is the only honest form, and a
 * line with no actor has none).
 */
export function gateAbsenceClaims(text: string, ctx?: CaptionGroundingContext): string {
  const input = text ?? "";
  if (!input.trim() || !hasAbsenceClaim(input)) return input;
  if (ctx?.absenceEvidence === true) return input;
  let out = input;
  for (const re of ABSENCE_CLAUSES) out = out.replace(re, " ");
  out = tidy(out)
    // A removal at the start of the line leaves its conjunction behind.
    .replace(/^\s*(?:and|but|as|while)\s+/i, "")
    .replace(/\b(?:and|but|as|while)\s*(?=[,.;:!?]|$)/gi, "");
  out = tidy(out);
  if (!out || !/[A-Za-z]/.test(out)) return "";
  return out === input ? input : repairLeadingCase(input, out);
}

/** Restore the capital a removed leading clause took with it. */
function repairLeadingCase(original: string, out: string): string {
  const first = original.trim().charAt(0);
  if (first && first === first.toUpperCase() && /[a-z]/.test(out.charAt(0))) {
    return out.charAt(0).toUpperCase() + out.slice(1);
  }
  return out;
}

/**
 * ADAAAA-7965 (contract v5 §3.2, R19): every lead names actor + action + place.
 * When the model's line names no zone, the write seam injects the stored one —
 * resolved from the window's own state (tracked ball position / stored
 * possession line), never from a prompt change and never invented here.
 *
 * A lead that cannot resolve a place does not ship in that form: the shot-only
 * leads QA measured (`Yamal shoots`, the repeat, `The striker shoots`) were the
 * three place misses in the v4 sample, and a place-less shot lead is exactly
 * what this drops. A line with no action verb (a scoreboard/colour statement) is
 * left alone — there is nothing to place.
 */
export function ensureLeadPlace(text: string, ctx?: CaptionGroundingContext): string {
  const input = text ?? "";
  if (!input.trim()) return input;
  const lead = captionLead(input);
  // The lead's place can sit mid-clause ("drives into the box and shoots"), not
  // only at the tail, so look across the whole lead.
  if (hasPlacePhrase(lead)) return input;
  // Only a play lead needs a place; a statement has no actor to place.
  if (!PLAY_VERB.test(lead)) return input;
  // `place: null` means "the fast rail looked and resolved nothing" -> drop the
  // form. An ABSENT key means this surface is not the fast rail (VOD, legacy,
  // the webapp's pre-v5 rows) -> leave the line exactly as it was (AC8).
  const resolved = ctx && Object.prototype.hasOwnProperty.call(ctx, "place");
  const place = (ctx?.place ?? "").trim();
  if (!place) return resolved ? "" : input;
  const colour = captionColour(input);
  return tidy(`${lead} ${place}${colour ? ` — ${colour}` : ""}`);
}

/** An action verb a play lead carries (the actor+action half of §3.2). */
const PLAY_VERB =
  /\b(?:shoots?|shot|strikes?|fires?|heads?|volleys?|drives?|dribbles?|carries?|moves?|controls?|passes?|tackles?|clears?|saves?|runs?|attacks?|presses?|chases?|reacts?|turns?|holds?|keeps?|jumps?|crosses?)\b/i;

/**
 * ADAAAA-7965 (contract v5 §3.5, R22): the stored surface strings one gated line
 * renders as. The card caption and every card option is one of these values,
 * byte-for-byte; a cap is resolved HERE (at the seam) and the cut value is what
 * is stored, so the page can never truncate, drop a colour clause or drop a
 * period on its own.
 */
export const MAX_CAPTION_CHARS = 180;
/** The card option ceiling — the contract's own hard max for a delivered line. */
export const CARD_TITLE_MAX_CHARS = 140;

/** Cut at a word boundary, never mid-word, and never past `max`. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return cut > 0 ? text.slice(0, cut).trim() : text.slice(0, max).trim();
}

/** The caption a stored gated line renders as (byte-identical when it fits). */
export function captionForStoredLine(line: string): string {
  return cutAtWord(repairDanglingTail((line ?? "").trim()), MAX_CAPTION_CHARS);
}

/** The card options a stored gated line renders as (each one a stored value). */
export function cardTitlesFor(line: string, label?: string): string[] {
  const text = repairDanglingTail((line ?? "").trim());
  const out: string[] = [];
  const push = (value: string) => {
    const v = (value ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  };
  if (text) push(cutAtWord(text, CARD_TITLE_MAX_CHARS));
  const lbl = (label ?? "").trim();
  if (lbl && text) push(cutAtWord(`${lbl}: ${text}`, CARD_TITLE_MAX_CHARS));
  if (lbl) push(lbl);
  return out.slice(0, 3);
}

/** Letters a proper name may contain (accented Latin, apostrophes, hyphens).
 * No trailing full stop: `No. 9` is a JERSEY, not the name "No." (ADAAAA-7957). */
const NAME_WORD = /[\p{Lu}][\p{L}'’\-]*/gu;

/** Function/event words that are capitalised but are not proper names. */
const NAME_STOPWORDS = new Set(
  [
    "the","a","an","this","that","these","those","then","after","before","when","while",
    "he","she","they","it","his","her","its","their","now","but","and","so","as","at",
    "in","on","with","from","both","one","two","three","four","five","goal","goals",
    "shot","shots","save","saves","ball","corner","free","kick","kickoff","kick-off",
    "whistle","referee","ref","half","first","second","final","home","away","midfield",
    "box","net","wide","blocked","cleared","crowd","bench","play","break","chance",
    "pressure","tension","substitute","sub","var","replay","cross","header","volley",
    "striker","winger","keeper","defender","midfielder","no","number","side","sides",
    "team","teams","player","players","coach","manager","fans","keeper's","saturday",
    "sunday","monday","tuesday","wednesday","thursday","friday","january","february",
    "march","april","may","june","july","august","september","october","november",
    "december","minute","minutes","seconds","end","start","secondhalf","firsthalf",
    "offside","penalty","foul","tackle","throw","throw-in","flag","post","bar",
    // Trigger / event vocabulary the pipeline itself emits (a "reason" such as
    // "Audio Burst" is an event label, not a name).
    "audio","burst","noise","roar","cheer","celebration","transition","scoreboard",
    "graphic","clock","signal","whistle","moment","passage","phase","interval",
  ].map((w) => w.toLowerCase())
);

/** All-caps tokens that are codes, not names (a graphic label or a unit). */
const CODE_TOKENS = new Set(["gol", "goal", "goals", "ocr", "var", "fc", "afc", "ht", "ft", "pk", "gk", "cb", "lb", "rb"]);

/** Club-name openers that make a multi-word candidate a SIDE, not a person. */
const CLUB_PREFIXES = new Set([
  "real","fc","afc","ac","as","ssc","cf","club","atletico","atlético","sporting",
  "deportivo","bayern","inter","psg","manchester","liverpool","arsenal","chelsea",
  "juventus","barcelona","madrid","united","city","rovers","athletic","olympique",
]);

const stripDiacritics = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Does `prompt` corroborate `needle` (accent/case-insensitive)? */
function promptHas(prompt: string, needle: string): boolean {
  if (!prompt || !needle) return false;
  return stripDiacritics(prompt).includes(stripDiacritics(needle));
}

/** Roles a grounded name is replaced with, shortest-first so the rewrite can
 * never lengthen the line more than the name it replaced. */
const ROLE_FOR_ACTION: [RegExp, string][] = [
  [/\b(?:save|saves|saved|keeper|parr(?:y|ies)|tip(?:s)? over)\b/i, "the No. 1"],
  [/\b(?:shot|shoots|shooting|strike|strikes|fires|header|volley|curler)\b/i, "the striker"],
  [/\b(?:pass|passes|cross|crosses|through ball|midfield|dribbl\w*)\b/i, "the midfielder"],
  [/\b(?:tackl\w*|clears|cleared|intercept\w*|block\w*)\b/i, "the defender"],
];

function roleFor(text: string, tokens: string[]): string {
  const teamish = tokens.length >= 3 || (tokens.length >= 2 && CLUB_PREFIXES.has(stripDiacritics(tokens[0])));
  if (teamish) return "the side";
  for (const [re, role] of ROLE_FOR_ACTION) if (re.test(text)) return role;
  return "the No. 9";
}

/**
 * Replace player/team proper names the window's prompt does not corroborate
 * with a role ("the striker", "the No. 9", "the side"). A legible jersey
 * number ("No. 9") is evidence in its own right and is left untouched.
 */
export function groundNames(text: string, promptText?: string | null): string {
  if (!text) return text;
  // ADAAAA-7957: `null` means the text was certified against this window's
  // prompt upstream (the server summary-log seam) and is not re-checked. A
  // string — INCLUDING `""` — is evidence, and no evidence fails closed: every
  // unsourced proper name becomes a role. The live seam used to pass `null`
  // whenever the decide analysis was absent, so the gate never ran and two
  // invented names ("Manuel Ordoñez", "David Saez") reached a caption.
  if (promptText === null) return text;
  const prompt = promptText ?? "";
  let out = text;
  // Widest-name-first so "Real Madrid CF" is replaced once, not twice.
  const runs: { start: number; end: number; tokens: string[]; name: string }[] = [];
  const matches = [...out.matchAll(NAME_WORD)];
  for (let i = 0; i < matches.length; i++) {
    const first = matches[i];
    const tokens = [first[0]];
    let end = (first.index ?? 0) + first[0].length;
    // Absorb following capitalised parts separated by one space (or a lowercase
    // connector such as "de"/"van"), e.g. "Manuel Ordoñez", "Real Madrid".
    let j = i + 1;
    while (j < matches.length) {
      const next = matches[j];
      const gap = out.slice(end, next.index);
      if (/^\s+$/.test(gap)) {
        tokens.push(next[0]);
        end = (next.index ?? 0) + next[0].length;
        j++;
        continue;
      }
      if (/^\s+(?:de|van|der|dos|da|di|del)\s+$/i.test(gap)) {
        tokens.push(next[0]);
        end = (next.index ?? 0) + next[0].length;
        j++;
        continue;
      }
      break;
    }
    i = j - 1;
    runs.push({ start: first.index ?? 0, end, tokens, name: out.slice(first.index ?? 0, end) });
  }
  // Replace from the end so earlier offsets stay valid.
  for (const run of runs.reverse()) {
    const name = run.name;
    const tokens = run.tokens;
    // A single capitalised word that is a function/event word is not a name.
    if (tokens.length === 1 && NAME_STOPWORDS.has(stripDiacritics(tokens[0]))) continue;
    // Every word of a multi-word run must be non-stopword for it to be a name,
    // except known connectors.
    const meaningful = tokens.filter((t) => !["de", "van", "der", "dos", "da", "di", "del"].includes(stripDiacritics(t)));
    if (meaningful.every((t) => NAME_STOPWORDS.has(stripDiacritics(t)))) continue;
    // ADAAAA-7962 (contract v4 §3.3): PROVENANCE IS THE WHOLE PHRASE.
    // v3 accepted any single token of a multi-token name, so "Real Madrid" was
    // grounded by the common word "real" on a window whose prompt never named
    // Madrid (level dcaa93c5, g90) and the invented club reached the page. A
    // person or club name may appear only when the name PHRASE occurs in this
    // window's own prompt (match context / ASR / scorebug OCR), diacritics- and
    // case-insensitively. Jersey numbers are evidence in their own right and
    // never reach this branch ("No. 9" is not a NAME_WORD run).
    if (promptHas(prompt, name)) continue;
    // A quoted token is a label being talked about, not a person.
    if (/['"‘“]$/.test(out.slice(0, run.start))) continue;
    // A bare ALL-CAPS token is a CODE, not a name ("GOL", "VAR", "OCR"). The list
    // is deliberately tiny so "DAVID SAEZ" / "MBAPPÉ" still fail closed.
    if (tokens.length === 1 && /^[A-Z0-9'’.]+$/.test(name) && CODE_TOKENS.has(stripDiacritics(name))) continue;
    out = `${out.slice(0, run.start)}${matchCase(roleFor(out, tokens), name)}${out.slice(run.end)}`;
  }
  if (out === text) return text;
  return tidy(out);
}

/**
 * Account for the "never lengthen" bar: if a rewrite produced a longer line
 * (a short name replaced by a longer role), cut it back at a word boundary so
 * the grounded caption is never longer than the input it replaced.
 */
function neverLonger(original: string, grounded: string): string {
  if (grounded.length <= original.length) return grounded;
  // ADAAAA-7962 (contract v4 §3.4/§3.5): the length rule is measured against
  // the LEAD, and two v4 rewrites legitimately add tail text:
  //   - a place-preserving rewrite (a role is longer than a short name, a
  //     restored zone longer than a dropped one) — cutting at the original
  //     length is what decapitated the zone ("The side player … in center");
  //   - an APPENDED grounded colour beat (§3.5, <= 40 chars), which must not be
  //     deleted just because the lead alone was already at the model's length.
  // Both are bounded by +12 on the lead, so the terseness bar (p50 <= 95, p95 <=
  // 140 on the delivered line) cannot regress.
  const leadIn = captionLead(original);
  const leadOut = captionLead(grounded);
  // ADAAAA-7965 (§3.2): a lead that earned a place grew by up to a place phrase
  // ("Yamal shoots" -> "The striker shoots in midfield"), and a derived colour
  // beat adds up to 40 chars + separator. Both are bounded, and both are the
  // contract's own deliverable, so they are allowed instead of being cut back to
  // the model's length (which is what decapitated the zone in v4).
  const placeGrowth = placePhraseOf(leadOut) && !placePhraseOf(leadIn) ? 24 : 0;
  const colourGrowth = captionColour(grounded) ? COLOUR_MAX_CHARS + 3 : 0;
  if (leadOut.length <= leadIn.length + 12 + placeGrowth + colourGrowth) {
    return grounded;
  }
  const cut = grounded.lastIndexOf(" ", original.length);
  const body = (cut > 0 ? grounded.slice(0, cut) : grounded).replace(/[\s,;:—–-]+$/, "").trim();
  return body || grounded;
}

/**
 * The grounding gate every user-visible fast caption crosses (ADAAAA-7948).
 *
 * Order matters and is fixed: internal tokens first (so a bracket label can
 * never be read as prose), then the goal claim (the verdict gate), then names
 * and scores (prompt evidence), then the length guard. Text that no rule
 * touches is returned BYTE-IDENTICAL, which is what lets a real goal verdict
 * pass through unchanged.
 */
export function groundCaption(text: string, ctx?: CaptionGroundingContext): string {
  const input = text ?? "";
  if (!input.trim()) return input;
  let out = stripInternalTokens(input);
  // ADAAAA-7957: the §3.3 quiet gate runs LAST (after the claim and name
  // rewrites), so a rewrite cannot push a line back over the 8-word bar.
  out = gateGoalClaims(out, ctx);
  // ADAAAA-7965 (contract v5 §3.4, R21): an absence claim needs the window's own
  // verdict + frames; without them it does not ship.
  out = gateAbsenceClaims(out, ctx);
  const prompt = ctx?.promptText;
  out = groundNames(out, prompt);
  // ADAAAA-7965 (contract v5 §3.2, R19): the place comes from stored window
  // state when the model line names none. A place-less play lead -> "".
  out = ensureLeadPlace(out, ctx);
  out = gateQuietWindow(out, ctx);
  if (typeof prompt === "string") out = gateScores(out, prompt);
  if (!(out ?? "").trim()) return "";
  if (out === input) return input;
  return neverLonger(input, out);
}

/**
 * Ground one summary-log entry's text. Convenience for the server seam; kept
 * here so the server and the webapp share the exact same gate. A multi-line
 * entry is grounded line by line (each line is one caption) and the newline
 * structure is preserved, so an entry never loses a line.
 */
export function groundSummaryText(text: string, ctx?: CaptionGroundingContext): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) => groundCaption(line, ctx))
    .join("\n");
}

// ---------------------------------------------------------------------------
// ADAAAA-7958 (contract v3 §3.4 + §3.6): the SURFACE pass.
//
// Inc 5 gated what the model WROTE. This pass makes the surfaces CONSUME the
// corroboration the pipeline already computed, and makes distinctness a
// property of the emitted set instead of the model's mood:
//
//   §3.4 corroboration propagation — a window the pipeline counted but never
//        corroborated may not assert a goal anywhere: caption option, card title
//        (`Goal: …`), summary item, or chapter/segment title. The banner and
//        every string then agree, and a Lull is never titled with a scoring
//        claim.
//   §3.6 dedupe at emission — an identical line may appear at most twice per
//        job; the third and later occurrence is dropped from the emitted set.
//        The comparison is cosmetic-insensitive (case, whitespace, trailing
//        punctuation), the same key the server log seam uses, so the two seams
//        cannot disagree about what "the same line" means.
//
// Everything here is pure, CPU-only, deterministic: no model call, no network,
// no clock, no randomness. The corroboration COMPUTATION is untouched — the
// flag is an input, never derived here.
// ---------------------------------------------------------------------------

/** One accepted highlight, as much as corroboration propagation needs. */
export interface CorroborationWindow {
  /** Clip window start (seconds from stream start). */
  start?: number | null;
  /** Clip window end (seconds). */
  end?: number | null;
  /** The localized highlight instant the clip is centred on (seconds). */
  localizedTs?: number | null;
  /**
   * The stored corroboration flag (ADAAAA-7162/7185/7402). `true` only when an
   * independent signal (measured scoreboard change / goal-calling audio /
   * two-signal frame attestation) backed the scoring read.
   */
  corroborated?: boolean | null;
  /**
   * The Stage-2 confirm verdict. A `confirmed_goal` is corroboration in its own
   * right — it is exactly the second half of the ladder's own `verified` rule
   * (`corroborated === true || goalConfirmed === "confirmed_goal"`), so the
   * banner and the strings CANNOT disagree about which goals were corroborated.
   */
  goalConfirmed?: string | null;
}

/** Seconds of slack around a clip window / anchor when matching a window instant. */
const CORROBORATION_SLACK_S = 0.5;
/** Seconds of slack around the localized anchor (the clip is centred there). */
const CORROBORATION_ANCHOR_S = 2;

/**
 * §3.4: is the observe window at `ts` covered by an accepted highlight that the
 * pipeline CORROBORATED? `false` when no covering highlight is corroborated —
 * including the case where no accepted highlight covers the window at all, in
 * which case a goal claim there was never corroborated by definition.
 *
 * A window can be corroborated by several highlights (a replay + the goal); one
 * corroborated cover is enough.
 */
export function windowCorroborated(
  highlights: readonly CorroborationWindow[] | undefined,
  ts: number
): boolean {
  if (!Number.isFinite(ts)) return false;
  for (const h of highlights ?? []) {
    const start = typeof h?.start === "number" && Number.isFinite(h.start) ? h.start : null;
    const end = typeof h?.end === "number" && Number.isFinite(h.end) ? h.end : null;
    const anchor = typeof h?.localizedTs === "number" && Number.isFinite(h.localizedTs) ? h.localizedTs : null;
    const inClip =
      start != null && end != null && ts >= start - CORROBORATION_SLACK_S && ts <= end + CORROBORATION_SLACK_S;
    const atAnchor = anchor != null && Math.abs(ts - anchor) <= CORROBORATION_ANCHOR_S;
    if (!inClip && !atAnchor) continue;
    if (isCorroboratedHighlight(h)) return true;
  }
  return false;
}

/**
 * §3.4: the banner's OWN corroboration rule, in one place —
 * `corroborated === true || goalConfirmed === "confirmed_goal"` (mirrors
 * `goalTimelineFrom`'s `verified`). A highlight that carries neither (the confirm
 * pass did not run, or it ran and did not corroborate) is NOT corroborated, which
 * is what the page counts as "not corroborated by frames".
 */
export function isCorroboratedHighlight(h: CorroborationWindow | undefined): boolean {
  if (!h) return false;
  if (h.corroborated === true) return true;
  return (h.goalConfirmed ?? "").trim().toLowerCase() === "confirmed_goal";
}

/** A ball-in-net shape, with or without the article, on the claim's own words. */
const NET_FORM = /\b(?:in|into|over)\s+(?:the\s+)?net\b/i;

/**
 * §3.4 for a line whose window VERDICT is no longer available at read time (a
 * stored summary item, a chapter's representative narrative): the line may
 * assert a goal only when its window is corroborated. A corroborated window is
 * returned BYTE-IDENTICAL (the real goal keeps its claim); an uncorroborated one
 * gets the claim rewritten to the stored-outcome beat by the same claim gate the
 * write seam uses — no second rule set, no second path.
 */
export function gateUncorroboratedGoal(text: string, corroborated: boolean): string {
  if (!text || corroborated) return text;
  const gated = gateGoalClaims(text, { corroborated: false });
  // Fail closed on the corroboration path specifically: a net-crossing shape the
  // claim lexicon has not learned yet ("No. 8 headers ball into net" — no "the")
  // still asserts a goal, and this surface has already been told the goal was
  // never corroborated. Degrading to the shared quiet shape (§3.3) keeps the
  // rewrite honest without introducing a second claim vocabulary.
  const netFree = gated.replace(new RegExp(NET_FORM.source, "gi"), "wide");
  if (netFree !== gated) return quietShape(netFree);
  return gated;
}

/**
 * §3.6: the comparison key for "the same emitted line" — byte-identical after
 * the only cosmetic differences a caption can carry (surrounding whitespace,
 * collapsed inner whitespace, a trailing full stop, letter case). The server's
 * `summaryLineKey` delegates here so the append seam and the surface seam agree.
 */
export function captionLineKey(text: string): string {
  return (text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?;,: ]+$/, "")
    .toLowerCase();
}

/** §3.6 / AC3b: an identical line may appear at most this many times per job. */
export const MAX_LINE_OCCURRENCES = 2;

/**
 * §3.6: cap every identical line at `max` occurrences across one job's emitted
 * set. Returns an array aligned with the input: the kept text, or `null` for a
 * dropped occurrence. Callers filter nulls, so a dropped line never renders as
 * an empty row. Purely positional/deterministic — the FIRST `max` occurrences
 * keep their place, which is the order the story was told in.
 */
export function dedupeEmittedLines(
  lines: readonly string[],
  max: number = MAX_LINE_OCCURRENCES
): (string | null)[] {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_LINE_OCCURRENCES;
  const seen = new Map<string, number>();
  return (lines ?? []).map((line) => {
    const key = captionLineKey(line ?? "");
    if (!key) return line ?? "";
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count <= limit ? line : null;
  });
}

/**
 * ADAAAA-7961 (§3.6): de-dup AFTER the goal gate. The gate is LOSSY — two lines
 * that were distinct when stored degrade to the same kept beat (`Player in blue
 * and yellow kit scores — …` -> `Player in blue and yellow kit shoots`, which
 * another row already states). De-dup ran on the stored set, so it could not see
 * the collision the gate itself created.
 *
 * Rule: a REWRITTEN line yields to a line that states that beat verbatim, and a
 * rewritten line never repeats another rewritten line. Untouched repeats still
 * obey the contract cap (`max`), so nothing that was legitimately stored twice
 * is dropped here.
 */
export function dedupeGatedLines<T extends { text: string; rewritten: boolean }>(
  lines: readonly T[],
  max: number = MAX_LINE_OCCURRENCES
): T[] {
  const storedKeys = new Set<string>();
  for (const line of lines ?? []) {
    if (line.rewritten) continue;
    const key = captionLineKey(line.text);
    if (key) storedKeys.add(key);
  }
  const seenRewritten = new Set<string>();
  const kept = (lines ?? []).filter((line) => {
    const key = captionLineKey(line.text);
    if (!key || !line.rewritten) return true;
    if (storedKeys.has(key) || seenRewritten.has(key)) return false;
    seenRewritten.add(key);
    return true;
  });
  const capped = dedupeEmittedLines(
    kept.map((line) => line.text),
    max
  );
  return kept.filter((_line, i) => capped[i] !== null);
}

/**
 * ADAAAA-7962 (contract v4 §3.7): cap identical delivered lines across a job's
 * STORED log at `max` occurrences and return the surviving lines of this pass.
 *
 * This is the WRITE-seam sibling of `dedupeEmittedLines`: the append path reads
 * the job's already-stored lines, so the third identical line is never persisted
 * and the stored set is the page set (same count, same strings) — v3 applied the
 * cap only when the page was built, so the API shipped 27 rows while the page
 * showed 26 (R13/R17).
 */
export function dedupeStoredLines(
  text: string,
  stored: readonly string[] | undefined,
  max: number = MAX_LINE_OCCURRENCES
): string {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_LINE_OCCURRENCES;
  const counts = new Map<string, number>();
  for (const line of stored ?? []) {
    const key = captionLineKey(line ?? "");
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const kept: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    const key = captionLineKey(trimmed);
    if (!key) continue;
    const count = counts.get(key) ?? 0;
    if (count >= limit) continue;
    counts.set(key, count + 1);
    kept.push(trimmed);
  }
  return kept.join("\n");
}

/** The minimal shape of one emitted summary item. */
export interface SummaryItemLike {
  text: string;
  windowTs?: number;
}

/**
 * §3.4 + §3.6 over a job's emitted summary items (the flat Video Summary log and
 * the ladder's window narratives): gate every item's goal claim against its
 * window's corroboration, keep one whole beat per row, then cap identical items
 * at `max` per job.
 *
 * FAST RAIL ONLY. VOD supplies no corroboration evidence and its long-form items
 * are graded unchanged (AC8), so the whole pass is a no-op when `fastRail` is
 * false — the items come back byte-identical and in order.
 */
export function groundSummaryItems<T extends SummaryItemLike>(
  items: readonly T[],
  opts: { highlights?: readonly CorroborationWindow[]; fastRail?: boolean; maxOccurrences?: number } = {}
): T[] {
  const list = [...(items ?? [])];
  if (!opts.fastRail) return list;
  const highlights = opts.highlights ?? [];
  const gated = list.map((item) => {
    const original = item.text ?? "";
    const ts = typeof item.windowTs === "number" && Number.isFinite(item.windowTs) ? item.windowTs : null;
    const corroborated = ts != null && windowCorroborated(highlights, ts);
    const claimed = gateUncorroboratedGoal(original, corroborated);
    // ADAAAA-7961: a row renders ONE beat and never a cut tail. A legacy row
    // that carries two sentences keeps its first; a row whose tail dangles
    // (`… while players`) is repaired. The stored log keeps the full text.
    const text = repairDanglingTail(captionBeats(claimed)[0] ?? claimed);
    return { item, text, rewritten: text !== original };
  });
  return dedupeGatedLines(gated, opts.maxOccurrences).map((g) => (g.text === (g.item.text ?? "") ? g.item : { ...g.item, text: g.text }));
}
