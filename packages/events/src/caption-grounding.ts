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
   * Contract v8 §3b.3 (diagnostic, shipped): WHY the derivation produced no
   * signal for this window, when `colourSignal` is absent. Set by the write seam
   * from the measurement itself (`insufficient-taps` / `low-energy` / `no-frame` /
   * `no-window-ts`), so the per-row trace can tell "the gate refused" from "the
   * derivation never reached this row" without re-reading code. Audit only — no
   * surface reads it.
   */
  colourSignalReason?: ColourSignalDecisionReason;
  /**
   * ADAAAA-7965 (contract v5 §3.4, R21): the window's stored evidence that a
   * negative / absence claim (`the ball stays out`, `no goal`, `never crossed`)
   * is true — the stored verdict plus the frame attestation for this window.
   * Absent / false => no absence claim survives (the quiet shape ships).
   */
  absenceEvidence?: boolean | null;
  /**
   * ADAAAA-8806 (AC9 on the served body): whether this window's MEASURED
   * attestation records a ball OUTCOME at all — `goal` / `out` / `off_target` /
   * `wide` / `saved` / `blocked` / `cleared` / `cross` from the decide's
   * `ballOutcome`, or a measured `goalCrossed`.
   *
   * - `false` => the attestation recorded NO outcome (`ballOutcome: "none"` /
   *   null, `goalCrossed: false`). No caption may assert what the ball did: the
   *   claim-removal path's synthesised outcome verb ("The ball shoots on the
   *   right." on job `3740585f` row `6ff00ac9`, whose own attestation reads
   *   `ballOutcome: none` / `goalCrossed: false`) is the epic's headline
   *   complaint, and it is an unattested fact.
   * - `true` => an outcome is attested; the existing claim rewrite may name it.
   * - absent / null => no attestation on this surface (VOD and legacy rows), so
   *   behaviour is byte-identical to today.
   */
  attestedBallAction?: boolean | null;
  /**
   * ADAAAA-7962 (contract v4 §3.4, extended by v5 §3.2): the window's stored
   * zone/place, used when the model's line names none (§3.2 place injection) and
   * when a rewrite would otherwise drop the place. Resolved at the write seam
   * from the window's own state (tracked ball position / stored possession
   * line), never invented.
   */
  place?: string | null;
  /**
   * ADAAAA-8411: the row's OWN copy for this window — the model's sentence for
   * the decision (the gated line plus, when it differs, the raw line). Set by the
   * write seam only. The post-title gate holds a headline's names to this string
   * exactly as the READ seam holds a stored title's names to `postTitleRowCopy`
   * (ADAAAA-8405 S3), so a name the model read off the ASR transcript on a
   * different play (`the ASR names the player in a save; the title attributes a
   * score`) can no longer be emitted as the headline. Absent -> prompt-only
   * grounding, unchanged.
   */
  ownCopy?: string | null;
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
    // ADAAAA-8127 (Defect B): removing a phrase INSIDE parentheses
    // (`(score change confirmed)` — an evidence tag, never copy) left the
    // brackets behind as `()`, which shipped as
    // `The scoreboard updates from 2-1 to 2-1 ().`. An empty pair is a strip
    // artifact, never punctuation a sentence needs.
    .replace(/\(\s*\)/g, " ")
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
 * ADAAAA-8806 (AC9): a caption that asserts what the BALL did. The shot verbs
 * above plus the outcome shapes `outcomeVerbFor` can synthesise and the
 * net-crossing family — every one of them is a fact about the ball, so it needs
 * the row's own attestation to say so.
 */
export const BALL_OUTCOME_ASSERTION =
  /\b(?:shoots?|shot|strikes?|struck|fires?|fired|drills?|curls?|curled|hooks?|hooked|hammers?|smashes?|volleys?|heads?|headed|nods?|nodded|pokes?|prods?|bundles?|blasts?|flashes?|squeezes?|goes?\s+wide|went\s+wide|is\s+(?:saved|blocked|cleared|deflected)|was\s+(?:saved|blocked|cleared|deflected)|enters?\s+the\s+net|is\s+in\s+the\s+net)\b/i;

/**
 * ADAAAA-8806: does this window's measurement record a ball OUTCOME at all?
 * Pure, so the write seam and the caption contract cannot disagree.
 *
 * Returns `null` when the surface carries no attestation (legacy / VOD rows):
 * the caller then keeps today's behaviour, byte-identically.
 */
export function attestedBallActionFrom(
  attest?: { ballOutcome?: string | null; goalCrossed?: boolean | null } | null
): boolean | null {
  if (!attest) return null;
  if (attest.goalCrossed === true) return true;
  const outcome = String(attest.ballOutcome ?? "").trim().toLowerCase();
  if (outcome && outcome !== "none" && outcome !== "null" && outcome !== "false") return true;
  // The attestation was READ (it carries its own flags) and recorded no outcome.
  // A recorded `ballOutcome: null` beside `goalCrossed: false` IS a measurement
  // ("nothing measured", `refusalReason: no_measured_authority`); an object with
  // neither field is not, so legacy callers keep the old behaviour.
  if (attest.ballOutcome !== undefined || attest.goalCrossed !== undefined) return false;
  return null;
}

/** ADAAAA-8806: a caption candidate that asserts a ball outcome the row's own
 *  attestation does not record. `attestedBallAction` absent => never fires. */
export function captionAssertsUnattestedAction(text: string, ctx?: CaptionGroundingContext): boolean {
  if (ctx?.attestedBallAction !== false) return false;
  return BALL_OUTCOME_ASSERTION.test(text ?? "");
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
  // ADAAAA-8043 (contract v7 §3.3, AC9): a net-crossing outcome the window never
  // grounded is DELETED, never inverted. v6 replaced `into the net` with `wide`,
  // so row 22 on `3544e617` (verdict `scoring_play`, raw `strikes the ball into
  // the net`) shipped `strikes the ball wide on the left` — a fabricated miss,
  // strictly worse than the ungrounded clause. The outcome goes; the actor, the
  // action and the place stay.
  out = out.replace(/\b(?:in|into|inside)\s+(?:the\s+)?net\b/gi, "");
  out = out.replace(/\binto\s+net\b/gi, "");
  // ADAAAA-8053 (measured on the Inc 11 level, row @188.7 s): the `in the net`
  // form above is a PREPOSITIONAL PHRASE, so a bare `net` marker under it made
  // `quietShape` slice the sentence inside the phrase and substitute the outcome
  // VERB there — `The keeper stands in the net as the crowd celebrates the
  // previous goal.` shipped as `The keeper stands in the shoots in midfield.`
  // A claim carried by a subordinate/manner clause cannot be grounded from this
  // window, so the clause is dropped and the actor clause is kept.
  if (hasGoalClaim(out)) {
    out = out.replace(/[\s,;]+(?:as|while|when|which)\b[^.;!?]*[.;!?]?$/i, "").trim();
  }
  out = out.replace(/\b(?:the\s+)?net\s+(?:ripples|bulges|swells|shakes|billows)\b/gi, "");
  // A verb whose object WAS the net (`finds the back of the net`) keeps the
  // shot verb it already carries — a shot is grounded by the window's own read;
  // the goal is not. Never `wide`.
  out = out.replace(/\b(?:finds?|found|hits?|hit)\s+(?:the\s+)?(?:back\s+of\s+the\s+)?net\b/gi, (m) =>
    matchCase(verb, m)
  );
  out = out.replace(/\b(?:cross(?:es|ed)?|over|past)\s+the\s+(?:goal\s+)?line\b/gi, (m) =>
    matchCase(verb, m)
  );
  // Putting it in with a foot/head.
  out = out.replace(
    /\b(?:taps?|tapped|slots?|slotted|buries?|buried|puts?|put)\s+(?:it\s+|the\s+ball\s+)?(?:in|home|away)\b/gi,
    (m) => matchCase(verb, m)
  );
  out = out.replace(/\bconver(?:ts|ted)\b/gi, (m) => matchCase(verb, m));
  // ADAAAA-8043 (v7 §3.3): `levels it` is an equaliser claim; its outcome cannot
  // be grounded, so it degrades to the shot verb — never to `goes wide`.
  out = out.replace(/\b(?:levels?|levelled)\s+it\b/gi, (m) => matchCase(verb, m));
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

/** Tokens that END an action verb's object NP (ADAAAA-8014: never a preposition,
 * conjunction or clause opener — the object stops where the adjunct starts). */
const OBJECT_STOP =
  /^(?:in|at|on|with|from|near|inside|outside|around|into|onto|of|to|for|and|or|but|as|while|when|that|which|who|by|over|under|off|through|across)$/i;

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
  // ADAAAA-8014 (§2): the action verb's OBJECT is half the beat. Cutting right
  // after the verb shipped `A player takes in midfield` — a transitive verb left
  // holding no object. Keep the short object NP that follows the verb (stopping at
  // the first preposition/conjunction, at most three tokens), so the condensed
  // line is `A player takes a shot in midfield` and the place still rides the end.
  let keep = verbIdx >= 0 ? verbIdx + 1 : words.length;
  for (let i = verbIdx + 1; verbIdx >= 0 && i < words.length && i < verbIdx + 4; i += 1) {
    if (OBJECT_STOP.test(words[i])) break;
    keep = i + 1;
  }
  // Keep the actor words, its action verb and that verb's object; drop the rest.
  const head = words
    .slice(0, keep)
    .join(" ")
    .replace(/\s+\b(?:the|a|an|to|of|in|at|on|with|and|from)\b$/i, "")
    // ADAAAA-8043 (v7 §3.2): a directional preposition whose object was the
    // place we are re-attaching would double up (`toward in midfield`, measured
    // row 6 on `dece44c3`). It goes with its object.
    .replace(/\s+\b(?:toward|towards|to|into|onto)\b$/i, "")
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
  // ADAAAA-7995 (§2): removing a claim mid-clause leaves the verb that introduced
  // it behind, and appending the outcome verb then produces a mangled phrase —
  // `The ball clearly enters the net and the keeper is beaten.` shipped as
  // `The ball clearly enters the shoots`. An open-object verb (whose object was
  // the removed claim) is dropped with its article, then a bare adverb, so the
  // head is the ACTOR and the outcome verb is the only verb.
  head = head
    .replace(
      /\s+\b(?:enters?|entered|cross(?:es|ed)?|finds?|found|hits?|hit|go(?:es)?|went|gets?|got|puts?|put|taps?|tapped|slots?|slotted|rolls?|sends?|sent|smashes?|rifles?|blasts?|drills?|hammers?|bangs?)\b(?:\s+\b(?:the|a|an|it|ball)\b)?$/i,
      ""
    )
    .replace(
      /\s+\b(?:clearly|almost|nearly|just|straight|directly|somehow|eventually|finally|still|again)\b$/i,
      ""
    )
    .replace(/[\s,;:]+$/, "")
    .trim();
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
 *
 * ADAAAA-8221: the LIVE scoring lane's refusal tail belongs to the same family
 * (`| live scoring lane: no measured attestation in this window (…) — delivered
 * as a celebration, not a GOAL`). It is audit text by ADAAAA-8040/8209's own
 * contract, but it used to survive `stripInternalTokens`, so a demoted
 * celebration whose own sentence has no terminal punctuation before the tail
 * carried the whole evidence paragraph into `wholeStoredSentence` /
 * `quietStoredCopy` / `outcomeVerbFor`. The tail's own `GOAL`/`celebration`
 * words also made the claim gate refuse a line it should have kept: on the 188
 * stored rows that carry this tail (box replay 2026-11-06, 0 GPU) the derived
 * sentence leaked the paragraph on 8 rows, and the write-seam line was refused
 * to `""` on 109 rows that now keep their own beat. Quiet copy is byte-identical
 * on all 188 rows, and a row whose lead already ends a sentence is untouched.
 */
const INTERNAL_REASON_TAIL =
  /\s*\|\s*(?:celebration of an already-delivered|no independent|dedupe|suppressed|burst|downgraded|anchor\s|live scoring lane:)[^|]*/gi;
/**
 * ADAAAA-8806: the PROVISIONAL-goal marker tail (`| provisional goal: …` /
 * `| provisional shot: …`) is DIAGNOSTIC text, and it stays on the row's stored
 * `reason` / `reason_raw` on purpose (ADAAAA-8139: a reader of the reason alone
 * learns the row is waiting on a score read). It is never copy.
 *
 * Measured defect (job `3740585f`, row `2d8e9521`, served build `cdf6445`):
 * `attestationDetailCopy` split this tail's own sentence at its em dash and
 * served the refusal fragment **"No measured scoreboard change yet."** as the
 * card caption, contradicting the same row's `reason_raw` (which says the
 * scoreboard changed to 2-1).
 *
 * So every CAPTION source strips it first. This is deliberately NOT folded into
 * `stripInternalTokens`: that function also feeds the stored `reason`, whose
 * provisional marker is the audit value ADAAAA-8139 pinned. A caption-only strip
 * is the narrow fix.
 */
const CAPTION_DIAGNOSTIC_TAIL = /\s*\|\s*provisional (?:goal|shot):[^|]*/gi;

/** The text a CAPTION surface may derive from: internal tokens AND the
 *  diagnostic marker tails removed. `stripInternalTokens` stays the single
 *  definition of the token strip; this adds only the caption-only tail. */
export function captionSourceText(text: string | null | undefined): string {
  const input = text ?? "";
  return stripInternalTokens(input.replace(CAPTION_DIAGNOSTIC_TAIL, ""));
}

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
/**
 * ADAAAA-8040 (§2 residual): `with` is deliberately ABSENT — `with ball`,
 * `with the outside of the boot` is a complete prepositional adjunct, not a
 * clause waiting for a verb, so deleting it turned a whole stored sentence into
 * a prefix cut (`Player in center field with ball` -> `Player in center field`).
 * A verb-less tail introduced by a SUBORDINATOR (`while players`) is the cut.
 */
const TAIL_CLAUSE_OPENER = /\s+\b(while|as|when|and|but|which|that|who|because|although)\b/gi;

/**
 * Tokens that make a tail CLAUSE complete. A tail with none of these is an
 * unfinished clause (`… while players`), which is what a word-boundary cut
 * leaves behind; a tail with one (`… and shoots`) is a whole clause and stays.
 */
const VERBISH =
  /\b(?:reacts?|moves?|drives?|controls?|contests?|dribbles?|stands?|passes?|plays?|takes?|holds?|watches?|waits?|runs?|shoots?|strikes?|heads?|clears?|tackles?|blocks?|saves?|jumps?|turns?|attacks?|presses?|chases?|follows?|keeps?|sets?|scores?|scored|carries|carried|wins?|won|sends?|sent|puts?|makes?|made|finds?|found|gets?|got|comes?|came|goes?|went|rises?|rose|falls?|fell|lifts?|lofts?|rolls?|bounces?|crosses?|fires?|volleys?|tries?|tried|attempts?|sees?|saw|looks?|appears?|erupts?|celebrates?|updates?|changes?|becomes?|reads?|shows?|is|are|was|were|has|have|had|does|did|can|could|will|would|may|might|must)\b/i;

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
      // phrase (`… with the outside of the boot`) and stays. ADAAAA-8040 (§2
      // residual): a verb-less tail that carries its OWN sentence end is a whole
      // coordinate phrase (`… and defensive areas.`), not a clause that was cut
      // mid-way — deleting it left the row as a prefix cut of its stored
      // sentence (`Players move in the center` for `Players move in the center
      // and defensive areas.`).
      if (
        rest &&
        wordCount(rest) <= 3 &&
        !VERBISH.test(rest) &&
        !hasTerminalPunctuation(rest) &&
        out.slice(0, lastOpener.index).trim().length > 0
      ) {
        out = out.slice(0, lastOpener.index).trim();
      }
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
    // ADAAAA-8014 (§2): before CUTTING the tail (a cut is a prefix cut of the
    // stored sentence), try deleting an interior adjunct phrase so the line keeps
    // its own ending and stays a complete clause.
    const complete = completeQuietSentence(out, QUIET_MAX_WORDS);
    if (complete) out = complete;
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
  // ADAAAA-8043 (v7 §3.2): a directional preposition left with no object after
  // the trim (`moves the ball toward`) reads as a double preposition once the
  // injected zone lands (`toward in midfield` — measured row 6 on `dece44c3`).
  out = out.replace(/\s+\b(?:toward|towards|to|into|onto)\s*$/i, "").trim();
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

/* ------------------------------------------------------------------------- *
 * Contract v8 §3b.3 — the colour derivation TRACE.
 *
 * QA v7 measured 0/4 eligible rows carrying a beat on build `93fae4a` while the
 * Developer's own level (`dece44c3`, build `86ccf80`) measured 6/6 on the same
 * gate file and clip. Nobody could tell from the artifacts whether the
 * derivation never reached the row (no audio taps / no frame / the job lost its
 * decide runner), whether a gate clause refused it, or whether the 40 % quiet
 * share removed it. So every stored caption row now carries the decision that
 * produced it: signal present?, the measured signal, which clause decided, and
 * the beat (or none). Audit-only, additive-optional on the record.
 * ------------------------------------------------------------------------- */

/** Why the write-seam derivation did not yield a signal for a window. */
export type ColourSignalDecisionReason =
  | "ok"
  | "no-window-ts"
  | "insufficient-taps"
  | "low-energy"
  | "no-frame";

/** Which gate clause decided whether a row carries a beat. */
export type ColourGateClause =
  /** the derived beat reached the row */
  | "beat"
  /** a beat was derived but the 40 % quiet-row share removed it */
  | "quiet-cap"
  /** the signal fired but the wording/threshold rules refused the beat */
  | "wording-filter"
  /** the derivation never produced a signal (no taps / no energy / no frame) */
  | "derivation-not-reached";

/** Per-row colour decision, stored on the caption row (v8 §3b.3). */
export interface ColourTrace {
  /** The window centre the decision was made for (content seconds). */
  windowTs?: number;
  /** The window's stored verdict. */
  verdict?: string | null;
  /** Did the write seam see a measurable audio-noise signal at all? */
  signalPresent: boolean;
  /** The signal itself, when present (the evidence for the beat). */
  signal?: ColourSignal | null;
  /** Why the derivation produced no signal (only when `signalPresent` is false). */
  signalReason?: Exclude<ColourSignalDecisionReason, "ok">;
  /** The clause that decided this row's colour. */
  clause: ColourGateClause;
  /** Sub-reason inside the governing clause (audit only). */
  reason?: string;
  /** The beat the row carries, or `undefined` when it carries none. */
  beat?: string;
}

/** Why a PRESENT signal did not become a beat (v8 trace sub-reason). */
function colourWordingReason(signal: ColourSignal): string {
  if (signal.signal !== "audio_noise") return "not-audio-noise";
  const { ratio, sustained, peak } = signal;
  if (![ratio, sustained, peak].every((n) => typeof n === "number" && Number.isFinite(n))) return "malformed-signal";
  if (ratio < 2) return "ratio-floor";
  if (sustained > 0.35) return "plateau";
  if (peak < 0.15) return "peak-floor";
  const hasFrame =
    (typeof signal.frameTs === "number" && Number.isFinite(signal.frameTs)) ||
    (typeof signal.frameSeq === "number" && Number.isFinite(signal.frameSeq));
  if (!hasFrame) return "no-frame";
  if (colourBeatFromSignal(signal).length > COLOUR_MAX_CHARS) return "too-long";
  return "guard";
}

/**
 * The ONE decision function every trace reads: the beat a signal derives (or
 * `""`), the clause that decided it, and the sub-reason. `colourBeatFromSignal`
 * stays the derivation itself, so no caller can disagree with it.
 */
export function colourGateDecision(signal?: ColourSignal | null): {
  beat: string;
  clause: ColourGateClause;
  reason?: string;
} {
  if (!signal) return { beat: "", clause: "derivation-not-reached" };
  const beat = colourBeatFromSignal(signal);
  if (beat) return { beat, clause: "beat" };
  return { beat: "", clause: "wording-filter", reason: colourWordingReason(signal) };
}

/**
 * Build the stored per-row colour trace (v8 §3b.3) from the window's grounding
 * context and the line it delivered. `clause` starts as the derivation's own
 * decision; the write seam's 40 % quiet-row share may later flip it to
 * `quiet-cap` (see `applyQuietColourCap`), which is why the trace is mutable
 * until the row is stored.
 */
export function colourTraceFor(
  ctx: Pick<CaptionGroundingContext, "colourSignal" | "colourSignalReason" | "verdict">,
  delivered: string,
  windowTs?: number
): ColourTrace {
  const signal = ctx.colourSignal ?? null;
  const decision = colourGateDecision(signal);
  // The beat the DELIVERED line carries, without the terminal period the seam
  // appends to the row (so `trace.beat` is the derivation's own wording and can
  // be compared with `colourBeatFromSignal` directly).
  const beat = captionColour(delivered ?? "").replace(/[.!?…]+$/, "").trim();
  const present = !!signal;
  return {
    ...(typeof windowTs === "number" && Number.isFinite(windowTs) ? { windowTs } : {}),
    verdict: (ctx.verdict ?? null) as string | null,
    signalPresent: present,
    ...(present ? { signal } : ctx.colourSignalReason && ctx.colourSignalReason !== "ok" ? { signalReason: ctx.colourSignalReason } : {}),
    clause: decision.clause,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(beat ? { beat } : {}),
  };
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
 *
 * ADAAAA-8043 (contract v7 §3.1) SUPERSEDES the ADAAAA-7995 "no colour on a
 * quiet row" rule. QA v6 measured that the drop rule made AC4 coverage 0% by
 * construction: all 13 eligible windows on job `3544e617` were `not_highlight`,
 * so no row could ever carry the beat the signal derives. AC4 clause 3 caps
 * quiet-row beats at 40%; it never banned them. The quiet branch therefore
 * appends the derived beat — the LEAD is still trimmed to the 8-word budget
 * first (AC5 measures the lead before the separator) and the write seam still
 * enforces the 40% share (`MAX_QUIET_COLOUR_SHARE`).
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
    // ADAAAA-7995: a beat never ships on its own. When the claim gate emptied the
    // lead (`The ball enters the net — keeper beaten.` on a `big_play` window), the
    // appended beat would be the WHOLE row (`noise spikes over the play`), which is
    // not a caption.
    out = out.trim() && beat ? withBeat(out) : out;
    return out === text ? text : tidy(out);
  }
  const lead = trimQuietLine(captionLead(out), ctx?.place);
  out = tidy(lead.replace(/\s*[—–]\s*/g, ", "));
  // ADAAAA-8043 (contract v7 §3.1): the derivation fires on a quiet row within
  // the 40% share the write seam enforces. The lead is already at the 8-word
  // budget, so the beat rides after the separator and AC5 measures the lead.
  if (out && beat) out = withBeat(out);
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
  // ADAAAA-8040 (§2 residual): the suppressed claim clause carried the
  // sentence's own end punctuation (`… — the ball misses the goal.`), so
  // dropping the clause left the pre-dash lead with NO sentence end and the
  // ladder served it as a prefix cut. The period belongs to the SENTENCE, not to
  // the clause that was removed, so it is restored here — the line is then a
  // whole sentence with the claim suppressed INSIDE it.
  const terminal = text.match(/[.!?…]+$/)?.[0] ?? ".";
  // v4 §3.4: the claim goes, the place stays.
  let out = dropColourClause(text);
  // The shortened line is a SENTENCE: it keeps the source's own end mark, or
  // earns a full stop when the model never wrote one (`… — goal 22:15`).
  if (out && !/[.!?…]+$/.test(out.trim())) out = `${out.replace(/[\s,;:—–-]+$/, "").trim()}${terminal}`;
  const place = placePhraseOf(out) || (ctx?.place ?? "").trim();
  const verb = outcomeVerbFor(out);
  out = rewriteScoreClaims(out, verb);
  // Contract v8 §3b.2: a rewrite that substituted the window's own verb can leave
  // `<verb> and <same verb>` (the source already carried it). Rejoin before the
  // claim re-check, so the doubled verb never reaches a surface.
  out = collapseRepeatedVerbPhrase(out);
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
    // ADAAAA-8027 (§2): the zone belongs INSIDE the sentence. Attaching it after
    // a lead that already ended one shipped `… to reflect a shot. on the left` —
    // a sentence break followed by a dangling fragment (the claim rewrite lands
    // on `shot`, which `PLAY_VERB` takes as its noun alternative). The lead's own
    // terminal punctuation moves to the end of the line first, the same shape
    // `ensureLeadPlace` uses, so no lowercase continuation can follow a sentence
    // end in the emitted string.
    const terminal = out.match(/[.!?…]+$/)?.[0] ?? "";
    const body = (terminal ? out.slice(0, -terminal.length) : out).trim();
    const withPlace = body ? tidy(`${body} ${place}${terminal}`) : "";
    if (withPlace && wordCount(withPlace) <= QUIET_MAX_WORDS + 2) out = withPlace;
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

/* ------------------------------------------------------------------------- *
 * ADAAAA-8059 (PO ruling, lever 3): the SCORELINE fact gate belongs at the WRITE
 * seam, not at read time.
 *
 * An uncorroborated scoreline is a CLAIM, and the viewer-facing surface may never
 * assert one. The old shape suppressed it while building the ladder, so the page
 * disagreed with its own store (`2-1` stored, dropped on the way out) and that
 * hole is what hid write-seam defects through v3-v8. The string
 * `summaryLog.text` stores is now ALREADY the suppressed string: stored == served
 * stays absolute, the read path stays a pure read (contract v7 decision 4) and
 * the gate keeps failing closed.
 *
 * Unlike `gateScores` above this gate is UNCONDITIONAL — it does not consult the
 * window's prompt, because a prompt scoreboard read is not a measured
 * corroboration. It is pure and idempotent: re-running it over its own output is
 * byte-identical, which is what makes a stored row replayable byte-for-byte.
 * ------------------------------------------------------------------------- */

/** A HYPHEN/dash scoreline (`2-2`, `0 – 1`). `M:SS` clocks are timestamps. */
const FACT_SCORE_SRC = String.raw`(?<![\w:.])\d{1,2}\s*[-–—]\s*\d{1,2}(?![\w:.])`;
/** `M:SS` clock; masked so a clock is never read as a score. */
const FACT_CLOCK_SRC = String.raw`\b\d{1,3}:\d{2}\b`;
const FACT_CLOCK_MASK = "\u0000";

function maskFactClocks(text: string): string {
  // Replace the WHOLE clock (digits included) so no digit run survives to pair
  // with a dash; a clock is a timestamp, never a scoreline.
  return (text ?? "").replace(new RegExp(FACT_CLOCK_SRC, "g"), FACT_CLOCK_MASK);
}

/** Tidy the whitespace/punctuation the gate leaves behind. */
function tidyFactGate(text: string): string {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])\s*([,.;:!?])/g, "$1")
    .replace(/\ba\s+(?=[,.;:!?])/gi, "")
    .replace(/\blevel\s+level\b/gi, "level")
    .replace(/^\s+/, "")
    .trim();
}

/**
 * Remove every scoreboard/score string from narrative text. Contextual patterns
 * are rewritten in place so the sentence still parses, then any surviving score
 * token is deleted outright. Deterministic: the same input always yields the
 * same output, so a stored row's served reading is stable across reads.
 */
export function suppressScoreClaims(text: string): string {
  let out = text ?? "";
  // "locked in a 0-0 stalemate" -> "locked in a stalemate"
  out = out.replace(
    new RegExp(String.raw`\b(?:an?\s+)?${FACT_SCORE_SRC}\s+(stalemate|deadlock)\b`, "gi"),
    "a $1"
  );
  // "scoreboard flashes to 0-1" -> "scoreboard updates"
  out = out.replace(
    new RegExp(
      String.raw`\bscore\s*board\s+(?:shows|reads|flashes\s+to|moves\s+to|displays|switches\s+to)\s+${FACT_SCORE_SRC}`,
      "gi"
    ),
    "scoreboard updates"
  );
  // "takes a 2-1 lead" -> "takes the lead"
  out = out.replace(new RegExp(String.raw`(?:an?\s+)?${FACT_SCORE_SRC}\s+lead\b`, "gi"), "the lead");
  // "leads 2-1" / "trails 0-2" -> "leads" / "trails"
  out = out.replace(
    new RegExp(String.raw`\b(leads?|trails?)\s+(?:by\s+)?(?:an?\s+)?${FACT_SCORE_SRC}`, "gi"),
    (_m, verb: string) => verb
  );
  // "at 1-1" / "to 0-1" -> "level" (only when the preposition dangles on a score)
  out = out.replace(new RegExp(String.raw`\b(?:at|to)\s+${FACT_SCORE_SRC}`, "gi"), "level");
  // Anything left: the token itself is not evidence — drop it.
  out = out.replace(new RegExp(FACT_SCORE_SRC, "gi"), "");
  return tidyFactGate(out);
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
  // ADAAAA-7995 (§2): the injected place belongs INSIDE the sentence. Appending
  // it after a lead that already ended one shipped `The scoreboard updates to
  // reflect a shot. on the right` — a sentence break followed by a dangling
  // fragment. The lead's own terminal punctuation moves to the end of the line.
  const terminal = lead.match(/[.!?…]+$/)?.[0] ?? "";
  // ADAAAA-8043 (v7 §3.2): a directional preposition whose OBJECT was the place
  // we are replacing would read as a double preposition once the zone lands
  // (`moves the ball toward in midfield` — measured row 6 on `dece44c3`). The
  // preposition goes with the object; the zone is the object.
  const body = tidy(
    (terminal ? lead.slice(0, -terminal.length) : lead)
      .trim()
      .replace(/\s+\b(?:toward|towards|to|into|onto)\s*$/i, "")
  );
  if (!body) return input;
  return tidy(`${body} ${place}${terminal}${colour ? ` — ${colour}` : ""}`);
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

/**
 * ADAAAA-8027 (§2): cut at a SENTENCE boundary that fits `max`, so a capped card
 * option is a whole sentence and never a prefix cut of the stored line. `""` when
 * no complete sentence fits, so the caller serves the label alone.
 */
function cutAtSentence(text: string, max: number): string {
  const src = (text ?? "").trim();
  if (!src) return "";
  if (src.length <= max) return src;
  let out = "";
  for (const beat of captionBeats(src)) {
    const next = out ? `${out} ${beat}` : beat;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** The caption a stored gated line renders as (byte-identical when it fits). */
export function captionForStoredLine(line: string): string {
  return cutAtWord(repairDanglingTail((line ?? "").trim()), MAX_CAPTION_CHARS);
}

/** The card options a stored gated line renders as (each one a stored value). */
/**
 * Contract v8 §3b.1 — a card OPTION is a sentence, not a label.
 *
 * Measured on `86f6ada4` (build `93fae4a`): the served options were
 * `["The ball shoots in midfield", "big play: The ball shoots in midfield",
 * "big play"]`. Option 3 is the raw event-type token, option 2 a token prefix on
 * an otherwise good sentence. Both are user-facing strings, so both fail AC7
 * (0 internal tokens) and AC10 (every served string byte-identical to a gated
 * stored string). Inc 10 corroboration-gated the card LABEL, but the option list
 * is generated here and still emitted the raw type.
 *
 * Every option returned is therefore a whole GATED SENTENCE. The accepted
 * caption is the first (and, on this rail, usually only) option; `alternatives`
 * lets a caller offer another stored gated sentence (byte-identical by
 * construction). A label is never served — not bare, not as a `label: sentence`
 * prefix — because that variant is minted here and is not a stored string.
 * When nothing else is grounded the option set is ONE option, which v8 §3b.1
 * explicitly calls valid.
 */
export function cardTitlesFor(line: string, alternatives?: readonly string[]): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const v = repairDanglingTail((value ?? "").trim());
    if (!v || out.includes(v)) return;
    if (!isServableCardOption(v)) return;
    out.push(v);
  };
  // ADAAAA-8053 (v8 §3b.1): the option IS the accepted caption, whole. The
  // ADAAAA-8027 sentence-boundary cut is gone: a cut at a boundary is still a
  // PREFIX of the stored string, and AC10 requires byte-identity for every served
  // option. A long option is served long rather than served cut.
  push(line);
  for (const alt of alternatives ?? []) push(alt);
  return out.slice(0, 3);
}

/**
 * Bare taxonomy tokens the pipeline uses as its own event types. A served card
 * option may never be one of these (v8 §3b.1 / AC7).
 */
const TAXONOMY_TOKENS = new Set([
  "big play",
  "scoring play",
  "near miss",
  "not highlight",
  "no highlight",
  "highlight",
  "sporting moment",
  "goal",
  "shot",
  "save",
  "corner",
  "penalty",
  "free kick",
  "audio burst",
  "near miss moment",
  "big play moment",
  "goal moment",
  "highlight moment",
  "sporting moment moment",
]);

/** `big play: …`, `scoring_play: …`, `near_miss — …`: a type-token prefix. */
const TYPE_PREFIX = /^\s*([a-z][a-z_ -]{0,24}?)\s*[:—–]\s+\S/i;

/** The normalized taxonomy form of an option (`Big-play` -> `big play`). */
export function taxonomyKey(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Is this string a bare event-type token (`big play`, `scoring_play`, …)? */
export function isTaxonomyToken(text: string): boolean {
  return TAXONOMY_TOKENS.has(taxonomyKey(text));
}

/**
 * May this string be SERVED as a card option (v8 §3b.1)?
 *
 * It must be a sentence — a verb, at least three words, a terminal sentence
 * mark — and it must not be a taxonomy token or carry a `<type>: ` prefix. The
 * "byte-identical to a gated stored string" half is the caller's contract: the
 * strings pushed here are the accepted caption and stored gated alternatives.
 */
export function isServableCardOption(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || isTaxonomyToken(t)) return false;
  if (TYPE_PREFIX.test(t)) return false;
  // A token is one or two words; a sentence that names a moment is at least
  // three. The caption gate upstream already guarantees actor + action + place,
  // so this predicate only has to keep TOKENS off the surface — adding a verb
  // whitelist here would refuse honest lines whose verb the list lacks
  // (`Argentina breaks the deadlock`).
  const words = normalizeServed(t).split(" ").filter(Boolean);
  return words.length >= 3;
}

/* ------------------------------------------------------------------------- *
 * ADAAAA-8014 (§2) — the SERVED post-condition.
 *
 * The gate above shapes what the model WROTE; this is the last test over what a
 * surface actually EMITS. Measured on build `eba8e7c` (ADAAAA-8010), five served
 * ladder rows still stopped mid-phrase:
 *
 *   `A player and a player are.`                     (ends on a copula)
 *   `The side.`                                      (2-word prefix cut)
 *   `A player takes in midfield`                     (transitive verb, no object)
 *   `Players compete for the ball in the center.`    (prefix cut)
 *   `The broadcast shows a replay.`                  (prefix cut)
 *
 * Each is a deterministic property of the emitted string, not of one helper, so
 * the test lives here and every surface (ladder row, chapter digest, rollup
 * bullet, card caption) calls it. A candidate is refused when ANY holds:
 *
 *   1. its last lexical token is a function word / copula, or a verb that needs
 *      an object and got none;
 *   2. it is a prefix of a stored sentence (normalized), i.e. the stored text
 *      continues after it;
 *   3. it ends inside a clause (no terminal punctuation while stored continues);
 *   4. it has no verb at all while a stored source has one (any word count —
 *      `A player in the midfield.` for `… dribbles in the midfield.`), or it is
 *      a two-word caption with no verb (`The side.`).
 *
 * The fallback order is fixed: the WHOLE first sentence of the stored raw line
 * (re-gated on the same terms), that sentence reduced only by deleting interior
 * adjunct phrases when a quiet row is over the 8-word budget, then the stored
 * gated line WHOLE. It never falls back to a trimmed prefix of the refused
 * candidate; when nothing passes, the caller drops the row (it is not rendered
 * mangled). Extractive throughout: words are only ever deleted, never invented.
 * ------------------------------------------------------------------------- */

/** Function words and copulas a served line may never END on. */
const SERVED_TAIL_WORDS = new Set([
  "and", "or", "of", "in", "at", "on", "with", "from", "to", "for", "the", "a", "an",
  "are", "is", "was", "were", "be", "been", "has", "have", "had", "as", "but", "while",
  "when", "by", "into", "onto", "than", "that", "which", "who", "whose", "its", "his",
  "her", "their", "over", "under", "near", "inside", "outside", "around", "after",
  "before", "during", "through", "across", "not", "no", "then", "if", "so",
]);

/** Verbs that need an object: ending the clause on one means the object was cut. */
const SERVED_OBJECT_VERB =
  /^(?:takes?|makes?|sends?|holds?|keeps?|brings?|puts?|gets?|finds?|gives?|receives?|shows?|needs?|wants?|sees?|leaves?|adds?|opens?|passes?|crosses?|blocks?|smashes?|rifles?|blasts?|drills?|hammers?|bangs?)$/i;

export type ServedShapeViolation =
  | "empty"
  | "function-tail"
  | "object-missing"
  | "prefix-cut"
  | "internal-break"
  | "open-clause"
  | "fragment"
  | "verbless"
  /** Contract v8 §3b.2: an immediately repeated verb phrase (`shoots and shoots`). */
  | "verb-repeat"
  /** ADAAAA-8209: the model's window-relative `at t=…` audit marker as copy. */
  | "audit-marker"
  /** ADAAAA-8209: the quiet §3.3 lead budget (<= 8 words) exceeded. */
  | "quiet-budget";

/** Comparison form: case, punctuation and whitespace are not content. */
function normalizeServed(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The last lexical token (punctuation stripped) of a string. */
function lastLexicalToken(text: string): string {
  const words = normalizeServed(text).split(" ").filter(Boolean);
  return words[words.length - 1] ?? "";
}

/** A served string ends a clause when it carries terminal punctuation. */
export function hasTerminalPunctuation(text: string): boolean {
  return /[.!?…]["'”’)\]]*$/.test((text ?? "").trim());
}

/**
 * ADAAAA-8040 (§2 residual): a served row is a SENTENCE. When a rule removed a
 * clause that carried the sentence's own end punctuation (the claim-suppression
 * path excises a post-dash goal clause), the remaining line is a complete clause
 * with no sentence end — the shape that shipped as
 * `A player shoots from the penalty area`. Punctuation is the only thing added
 * here: no word is invented, deleted or reordered, and a string that already
 * ends a sentence is returned byte-identical.
 */
export function restoreTerminalPunctuation(text: string): string {
  const input = (text ?? "").trim();
  if (!input || hasTerminalPunctuation(input)) return input;
  // A line that stops on a dangling marker (`… —`, `… ,`) has nothing to
  // close; those are refused by the shape rules instead of being patched here.
  const body = input.replace(/[\s,;:—–-]+$/, "").trim();
  return body ? `${body}.` : input;
}

/**
 * A dash clause that is an atmosphere/colour beat (`— crowd erupts`,
 * `— noise spikes over the play`). §3.1: model colour copy is never a served
 * sentence part, so it is the ONE excision that may shorten a stored sentence
 * without the row being a prefix cut. A dash clause that carries a scoreline or
 * a goal mention is a CLAIM clause, not a colour beat.
 */
function isColourClause(clause: string): boolean {
  const c = (clause ?? "").trim();
  if (!c || c.length > COLOUR_MAX_CHARS) return false;
  if (findScoreClaims(c).length > 0) return false;
  return COLOUR_REACTION_NOUN.test(c);
}

/**
 * ADAAAA-8040 (§2 residual): the stored SENTENCE a served row is compared with.
 *
 * `wholeFirstSentence` (above) drops everything after an em dash, because a
 * colour beat is never copy. That is right for a colour beat and WRONG for a
 * claim clause: `A player shoots from the penalty area — the ball misses the
 * goal.` is ONE sentence whose second clause was claim-suppressed, so dropping
 * the clause made the served lead compare equal to its own source and the cut
 * went unnoticed. This helper keeps a non-colour dash clause, so the claim
 * suppression is visible as a prefix of the sentence it happened inside.
 */
export function wholeStoredSentence(text: string): string {
  const first = (captionBeats(text ?? "")[0] ?? (text ?? "")).trim();
  if (!first) return "";
  const clause = captionColour(first);
  return clause && isColourClause(clause) ? captionLead(first) : first;
}

/**
 * Why `candidate` may not be served, given the stored sentences it was derived
 * from (the gated line and the model's raw line). Empty = it may be served.
 */
export function servedShapeViolations(
  candidate: string,
  sources: Array<string | null | undefined> = []
): ServedShapeViolation[] {
  const text = (candidate ?? "").trim();
  if (!text) return ["empty"];
  const words = normalizeServed(text).split(" ").filter(Boolean);
  if (words.length === 0) return ["empty"];
  const out: ServedShapeViolation[] = [];
  // ADAAAA-8027 (§2): terminal punctuation followed by a lowercase word is a
  // sentence break INSIDE the line (`The scoreboard updates to reflect a shot. on
  // the left`) — the shape that had no rule before, so a card could carry it.
  // A jersey (`No. 9`) or a decimal (`11.6`) is not a sentence end either way.
  if (/[.!?…]["'”’)\]]*\s+\p{Ll}/u.test(text)) out.push("internal-break");
  // Contract v8 §3b.2: an immediately repeated verb phrase is malformed on every
  // surface, not only the one path that produced it (`shoots and shoots`).
  if (hasRepeatedVerbPhrase(text)) out.push("verb-repeat");
  const last = words[words.length - 1];
  if (SERVED_TAIL_WORDS.has(last)) out.push("function-tail");
  // A transitive verb whose object was cut: drop the trailing place phrase first,
  // so `A player takes in midfield` is tested on `A player takes`.
  const lead = text.replace(/[.!?…]+$/, "").trim();
  const tailPlace = lead.match(PLACE_TAIL)?.[0] ?? "";
  const body = (tailPlace ? lead.slice(0, lead.length - tailPlace.length) : lead).trim();
  const bodyLast = lastLexicalToken(body);
  if (bodyLast && SERVED_OBJECT_VERB.test(bodyLast)) out.push("object-missing");
  // A two-word caption with no verb is a dropped predicate (`The side.`).
  if (words.length <= 2 && !VERBISH.test(text)) out.push("fragment");
  // ADAAAA-8015: a served line with NO verb at all has lost its predicate at any
  // length, not just at two words — `A player in the midfield.` (5) shipped where
  // the stored sentence said `… dribbles …`, and `A player for the ball in center
  // circle.` (8) shipped where it said `… contests for the ball …`. It is a defect
  // only when a stored source CARRIES a verb: a line the model itself wrote without
  // one (`No goals in the second half.`) is its own honest text and still stands.
  if (!VERBISH.test(text) && sources.some((s) => VERBISH.test(s ?? ""))) out.push("verbless");
  const normalized = normalizeServed(text);
  const terminal = hasTerminalPunctuation(text);
  // A subordinate clause left without a verb (`… while players`) is a cut clause,
  // however it was produced.
  const openers = [...text.matchAll(/\s+\b(?:while|as|when|and|but|with|which|that|who)\b/gi)];
  const lastOpener = openers[openers.length - 1];
  if (lastOpener) {
    const rest = text.slice((lastOpener.index ?? 0) + lastOpener[0].length).trim();
    // ADAAAA-8040 (§2 residual): a verb-less tail that carries its OWN sentence
    // end is a whole coordinate phrase (`… and defensive areas.`), not a clause
    // cut mid-way — the same rule `repairDanglingTail` now applies.
    if (
      rest &&
      rest.split(/\s+/).filter(Boolean).length <= 3 &&
      !VERBISH.test(rest) &&
      !hasTerminalPunctuation(rest)
    ) {
      out.push("open-clause");
    }
  }
  for (const source of sources) {
    const storedText = (source ?? "").trim();
    const stored = normalizeServed(storedText);
    if (!stored || stored === normalized) continue;
    // A stored sentence that itself ends in a dangling clause is the broken one:
    // the candidate that drops that clause is the REPAIR, not a prefix cut of it.
    const remainder = stored.slice(normalized.length).trim();
    // ... but only when the stored sentence itself does NOT end a sentence there:
    // `Players move in the center and defensive areas.` is a whole sentence, so
    // the candidate that stops before `and` is a prefix cut, not its repair.
    const remainderIsCutClause =
      /^(?:while|as|when|and|but|which|that|who)\b/i.test(remainder) &&
      !VERBISH.test(remainder) &&
      !hasTerminalPunctuation(storedText);
    if (remainderIsCutClause) continue;
    if (stored.startsWith(`${normalized} `)) {
      // ADAAAA-8040 (§2 residual): a dash CLAUSE inside the stored sentence
      // (a goal/score mention or an atmosphere beat) is excised by the claim and
      // colour gates. A candidate that IS the sentence's own lead — the whole
      // clause before the dash — is the sanctioned "claim suppressed INSIDE the
      // sentence" shape, not a prefix cut: the sentence keeps its actor, action
      // and place and ends on a real clause boundary. What the shipped build got
      // wrong was serving that lead with NO terminal punctuation (the period had
      // belonged to the removed clause), so the sentence end is the test here.
      const lead = normalizeServed(captionLead(storedText));
      if (lead && lead === normalized) {
        if (!terminal) out.push("open-clause");
        continue;
      }
      // ADAAAA-8130: the row's own LEADING clause, ended at its own clause
      // boundary, where the clause it drops is the CLAIM FRAME
      // (`Crowd erupts in celebration | as the scoreboard shows a goal for FCB.`).
      // That is the same sanctioned shape as the dash lead above — the claim is
      // suppressed INSIDE the sentence, which keeps its actor, its verb and a
      // real clause boundary — so it is not a prefix cut. Strictly gated: the
      // candidate ends its own sentence, carries a verb, is the sentence's WHOLE
      // leading clause (no connector inside it), is not the event ledger, and the
      // CLAIM lives in the remainder it drops. Any other truncation is a prefix
      // cut.
      if (
        terminal &&
        VERBISH.test(text) &&
        !CLAUSE_CONNECTOR.test(text) &&
        CLAUSE_JOINER.test(remainder.split(/\s+/)[0] ?? "") &&
        !hasGoalClaim(text) &&
        hasGoalClaim(remainder) &&
        !FRAME_LEDGER.test(text)
      ) {
        continue;
      }
      // ADAAAA-8411: the row's own LEDGER FRAME is the sanctioned lead when the
      // text it drops is PROVENANCE ONLY — the window audit marker and the
      // attestation clause that cites a channel:
      //
      //     Scoreboard changes to 2-2 | at t=-3.3s and ASR confirms 'il gol!'
      //
      // No customer fact is lost (the remainder is the model citing its own
      // evidence, never copy), the candidate is a real clause boundary and keeps
      // the row's own ledger words verbatim. Any other remainder is a prefix cut.
      if (terminal && FRAME_LEDGER.test(text) && remainderIsProvenanceOnly(remainder)) continue;
      out.push("prefix-cut");
      if (!terminal) out.push("open-clause");
    } else if (stored.startsWith(normalized) && !terminal) {
      out.push("open-clause");
    }
  }
  return [...new Set(out)];
}

/**
 * ADAAAA-8209: the post-conditions a STORED `reason` must cross.
 *
 * The quiet candidate gate (`serveQuietCandidate`) has always applied these, but
 * the PRIMARY store path in `services/server/src/analyzer.ts` applied only
 * `servedShapeViolations` to its shaped line. The model's window-relative audit
 * marker and a lead over the quiet budget therefore reached the stored row on
 * that path:
 *
 *     Scoreboard changes from 2-1 to 2-2 at t=-4.0s and t=-3.0s.   (10-word lead)
 *     Scoreboard changes from 2-2 to 1-1 at t=-3.0s and ball shoots on the left. (14)
 *
 * A store-time post-condition is the only place every shape crosses, so the
 * refusal lives here instead of only inside the quiet gate. Two scopes:
 *
 *  - the `at t=` audit marker is refused on EVERY shape (evidence provenance is
 *    never copy);
 *  - the quiet lead budget (`QUIET_MAX_WORDS`, measured on the `captionLead`,
 *    not the whole line) is refused on a LEDGER line that carries the
 *    `from X to Y` transition — a longer PROSE read with an attribution tail is
 *    not a ledger line and keeps its copy.
 */
export function storedReasonViolations(
  candidate: string,
  sources: Array<string | null | undefined> = []
): ServedShapeViolation[] {
  const out = (candidate ?? "").trim();
  if (!out) return ["empty"];
  const violations = servedShapeViolations(out, sources);
  // Evidence provenance is never copy, on every path.
  if (/\bat\s+t=-?[\d.]+\s*s\b/i.test(out)) violations.push("audit-marker");
  // The quiet §3.3 budget, measured on the LEAD (the same measure the quiet gate
  // uses), so a folded colour clause does not count against it. Scoped to a
  // LEDGER line that carries the `from X to Y` transition (the shape this ticket
  // refuses): a 10-12-word prose line with an attribution tail is not a ledger
  // line and keeps its copy (`Scoreboard changes to 2-1 and commentary confirms
  // the shot on the left.` stays stored byte-identically).
  if (
    wordCount(captionLead(out)) > QUIET_MAX_WORDS &&
    FRAME_LEDGER.test(out) &&
    /\bfrom\s+(?:the\s+)?(?:score\s*(?:of|is)?\s*)?\d+\s*[-–:]\s*\d+\s+to\s+/i.test(out)
  ) {
    violations.push("quiet-budget");
  }
  return [...new Set(violations)];
}

/** The whole FIRST sentence of a stored line (never a cut of it). */
export function wholeFirstSentence(text: string): string {
  const lead = captionLead(text ?? "");
  return (captionBeats(lead)[0] ?? lead).trim();
}

/** A preposition that opens an adjunct (a place/object phrase we may delete). */
const ADJUNCT_HEAD =
  /^(?:in|at|on|with|from|for|near|inside|outside|around|of|into|onto|by|over|under|through|across|after|before|during)$/i;

/** Clause openers a served reduction may never orphan. */
const CLAUSE_JOINER = /^(?:and|or|but|while|as|then|that|which|who|because|although)$/i;

/**
 * Reduce a WHOLE sentence to the quiet-word budget by deleting INTERIOR adjunct
 * phrases — never by cutting its tail (§2: a tail cut is a prefix cut) and never
 * by inventing a word. `""` when no deletion leaves a complete, in-budget clause,
 * so the caller can try another shape or drop the row.
 */
export function completeQuietSentence(sentence: string, max: number = QUIET_MAX_WORDS): string {
  const src = (sentence ?? "").trim();
  if (!src) return "";
  const terminal = src.match(/[.!?…]+$/)?.[0] ?? "";
  let words = (terminal ? src.slice(0, -terminal.length) : src).trim().split(/\s+/).filter(Boolean);
  const build = (tokens: string[]): string => {
    const body = tokens.join(" ").trim().replace(/[,;:—–-]+$/, "").trim();
    return body ? tidy(terminal ? `${body}${terminal}` : body) : "";
  };
  if (words.length <= max) return build(words);
  let guard = 0;
  while (words.length > max && guard < 6) {
    guard += 1;
    let best: { at: number; len: number } | null = null;
    for (let i = 1; i < words.length - 2; i += 1) {
      if (!ADJUNCT_HEAD.test(words[i])) continue;
      let end = i + 1;
      if (/^(?:the|a|an)$/i.test(words[end] ?? "")) end += 1;
      while (
        end < words.length - 1 &&
        /^[\p{L}][\p{L}'’-]*$/u.test(words[end]) &&
        !ADJUNCT_HEAD.test(words[end]) &&
        !CLAUSE_JOINER.test(words[end]) &&
        !SERVED_TAIL_WORDS.has(words[end].toLowerCase())
      ) {
        end += 1;
      }
      const len = end - i;
      if (len < 2 || end >= words.length) continue;
      // The phrase must leave words on BOTH sides, be followed by another adjunct
      // or a clause joiner (so the sentence still reads), and not sit behind a
      // preposition or copula (which would lose its predicate: `… are of field`).
      if (!ADJUNCT_HEAD.test(words[end]) && !CLAUSE_JOINER.test(words[end])) continue;
      const before = words[i - 1];
      if (ADJUNCT_HEAD.test(before) || /^(?:is|are|was|were|be|has|have|had)$/i.test(before)) continue;
      if (!best || len > best.len) best = { at: i, len };
    }
    if (!best) break;
    words = words.slice(0, best.at).concat(words.slice(best.at + best.len));
  }
  while (words.length > 0 && SERVED_TAIL_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  if (words.length > max || words.length < 3) return "";
  return build(words);
}

/**
 * Extractive reductions of a stored sentence, cheapest deletion first, cumulative
 * (ADAAAA-8014 §2). Each variant is still a WHOLE sentence — words are only ever
 * deleted, never reordered or invented — and the caller re-tests every variant
 * against the stored text, so one that lands on a prefix cut is simply skipped.
 */
const SERVED_REDUCTIONS: Array<[RegExp, string]> = [
  // a kit-colour phrase is the least content a beat carries (`in blue`,
  // `in a blue kit`, `in the white shirt`)
  [
    /\s+\bin\s+(?:an?\s+|the\s+)?(?:white|blue|red|black|yellow|green|purple|orange|grey|gray)\b(?:\s+(?:kit|jersey|shirt|strip|colours?))?/gi,
    "",
  ],
  [/\s+\bwith\s+(?:the\s+)?ball\b/gi, ""],
  // the contract's own compressed place vocabulary (§3.2): `penalty area` /
  // `goal area` -> `box` (one token shorter, same zone, never a prefix cut)
  [/\bpenalty\s+area\b/gi, "box"],
  [/\bgoal\s+area\b/gi, "box"],
  // the contract's compressed place form ("in the center" -> "in center")
  [/\bin\s+the\s+(center|centre)\b/gi, "in $1"],
  // ADAAAA-8022: the painted `center circle` compresses to the same `center`
  // zone, one token shorter — the step that lets a quiet row keep a transitive
  // verb's object (`A player contests for the ball in center.`) instead of
  // deleting the object phrase to fit the 8-word budget.
  [/\bin\s+(?:the\s+)?(center|centre)\s+circle\b/gi, "in $1"],
  // a trailing place modifier ("of the pitch", "of the field")
  [/\s+\bof\s+the\s+(?:pitch|field|ground|box|area)\b(?=\s*[.,;]|$)/gi, ""],
];

/** Every extractive variant of a stored sentence, cheapest first. */
function servedReductions(sentence: string): string[] {
  const out: string[] = [];
  let current = (sentence ?? "").trim();
  if (!current) return out;
  out.push(current);
  for (const [re, replacement] of SERVED_REDUCTIONS) {
    const next = tidy(current.replace(re, replacement));
    if (next && next !== current) {
      current = next;
      out.push(current);
    }
  }
  const complete = completeQuietSentence(current);
  if (complete && !out.includes(complete)) out.push(complete);
  return out;
}

export interface ServedShapeInput {
  /** The string the surface was about to emit. */
  candidate: string;
  /** The model's stored pre-gate line (`summaryLog.text_raw`), when present. */
  storedRaw?: string | null;
  /** The stored gated line the candidate was derived from (`summaryLog.text`). */
  storedGated?: string | null;
  /** Quiet row: the 8-word budget applies. */
  quiet?: boolean;
  /** Re-gate a fallback sentence on the same terms (goal claim / absence). */
  regate?: (sentence: string) => string;
}

export interface ServedShapeResult {
  /** The string to emit; `""` means DROP the row (nothing honest to render). */
  text: string;
  /** Why the candidate was refused (empty when it passed unchanged). */
  violations: ServedShapeViolation[];
  /** True when a fallback replaced the candidate (or the row was dropped). */
  replaced: boolean;
}

/** The served post-condition: pass, replace with a whole sentence, or drop. */
export function servedShape(input: ServedShapeInput): ServedShapeResult {
  // ADAAAA-8040 (§2 residual): a ladder row is a sentence, so the candidate is
  // closed with its sentence end before it is graded. The shipped build served
  // `A player shoots from the penalty area` because the claim gate removed the
  // clause that carried the period; punctuation is restored here rather than
  // invented into the words.
  const candidate = restoreTerminalPunctuation(
    // Contract v8 §3b.2: a stored row written before the repair existed still
    // carries `<verb> and <same verb>`. The read path is a pure read of WORDS (it
    // only deletes the duplicate verb, inventing nothing), so a legacy row is
    // served rejoined instead of being dropped.
    collapseRepeatedVerbPhrase((input.candidate ?? "").trim())
  );
  const raw = (input.storedRaw ?? "").trim();
  const gated = (input.storedGated ?? "").trim();
  // The stored SENTENCE (first sentence, keeping a claim/place clause after a
  // dash) is the text a served row may not be a prefix cut of. A COLOUR clause
  // after an em dash is a contract-level excision, not a cut of the sentence, so
  // it is not part of the comparison — but a claim clause IS part of it (§2).
  const gatedSentence = wholeStoredSentence(gated);
  const rawSentence = wholeStoredSentence(raw);
  // ADAAAA-8059 (lever 1, PO ruling): the STORE is the contract. `text_raw` still
  // bears witness to CONTENT LOSS (a verb the stored line dropped, ADAAAA-8015) so
  // it stays a comparison source — but a "prefix cut" of it is not a defect of the
  // served string when the store itself ends there, so that one class is ignored
  // for the candidate (see `refused` below). It is never a FALLBACK when it carries
  // a claim the store refused.
  const sources = [gatedSentence, rawSentence].filter(Boolean);
  const quiet = input.quiet === true;
  // ADAAAA-8043 (v7 §3.1): AC5 measures the LEAD before the beat separator, and
  // a derived beat is a delivered clause the row carries — so the quiet budget
  // applies to the lead, never to the lead + beat.
  const fits = (text: string): boolean =>
    !!text && (!quiet || wordCount(captionLead(text)) <= QUIET_MAX_WORDS);
  // ADAAAA-7995 AC4: a quiet row carries no colour, so a fallback variant that
  // still names one is skipped (the reduction list removes it).
  const QUIET_COLOUR_PHRASE =
    /\bin\s+(?:an?\s+|the\s+)?(?:white|blue|red|black|yellow|green|purple|orange|grey|gray)\b/i;
  const punctuated = (text: string): string => restoreTerminalPunctuation((text ?? "").trim());
  // ADAAAA-8059 (lever 1, PO ruling): the STORE is the contract. When the row has a
  // stored gated line and the string under test IS that line, a cut relative to the
  // longer `text_raw` is not a defect: the write seam decided the string, and the
  // read path may DELETE but never RESTORE what the seam refused. Before this, the
  // raw line turned every gated row into a "prefix cut" of itself, the row fell into
  // the raw fallback, and the surface served the refused clause back
  // (`— ball goes wide` on a window whose verdict says no shot was taken).
  const isStoredLine = (text: string): boolean =>
    !!gatedSentence && normalizeServed(text) === normalizeServed(gatedSentence);
  const clean = (text: string): boolean => {
    const t = punctuated(text);
    const violations = servedShapeViolations(t, sources).filter(
      (v) => !(v === "prefix-cut" && isStoredLine(t))
    );
    return (
      fits(t) &&
      (!quiet || !QUIET_COLOUR_PHRASE.test(t)) &&
      violations.length === 0
    );
  };
  const accepted = (text: string): ServedShapeResult => {
    const served = punctuated(text);
    return { text: served, violations: [], replaced: served !== candidate };
  };
  const refused = servedShapeViolations(candidate, sources).filter(
    (v) => !(v === "prefix-cut" && isStoredLine(candidate))
  );
  if (refused.length === 0) {
    if (fits(candidate)) return { text: candidate, violations: [], replaced: false };
    // Quiet row over the word budget: reduce it extractively, never cut its tail.
    for (const variant of servedReductions(candidate)) {
      if (clean(variant)) return accepted(variant);
    }
  }
  // A raw sentence may only be served when the write seam did not ANONYMISE a
  // name in it: the ladder has no prompt evidence to re-ground that name, and
  // re-introducing it would undo the §3.3 name gate. It is re-gated for the
  // window's corroboration before it may assert a goal.
  // ADAAAA-8040 (§2 residual): the stored SENTENCE keeps a claim/place clause
  // after a dash (that is the "claim suppressed INSIDE the sentence" source the
  // fallback order names); a dash COLOUR beat is still removed before it is
  // re-gated, because model colour copy is never served (§3.1).
  const sentenceOf = (text: string): string => {
    const sentence = wholeStoredSentence(text);
    if (!sentence) return "";
    const clause = captionColour(sentence);
    return clause && isColourClause(clause) ? captionLead(sentence) : sentence;
  };
  const rawFallback = sentenceOf(raw);
  const gatedFallback = sentenceOf(gated);
  // ADAAAA-8059 (lever 1, PO ruling): the READ path may DELETE but never RESTORE a
  // clause, and the STORE is the contract. The stored gated sentence is therefore
  // the only comparison source: a served line may not be a cut of it, and a raw
  // line that merely carries a claim or an absence the store refused
  // (`— ball goes wide`, `… of Saez's goal`) is never a fallback either.
  // `text_raw` still repairs a row whose stored line is itself malformed (a
  // function-word tail, a dropped predicate): a mangled row is never rendered.
  const rawAddsClaim =
    !!rawFallback &&
    !!gatedFallback &&
    ((hasGoalClaim(rawFallback) && !hasGoalClaim(gatedFallback)) ||
      (hasAbsenceClaim(rawFallback) && !hasAbsenceClaim(gatedFallback)));
  // A raw line that merely EXTENDS the stored sentence is the clause the write seam
  // dropped (`… — ball goes wide` beside a gated `… from the box.`). It may witness
  // content loss (it stays a comparison source) but it is never served back.
  const rawExtends =
    !!rawFallback &&
    !!gatedFallback &&
    normalizeServed(rawFallback) !== normalizeServed(gatedFallback) &&
    normalizeServed(rawFallback).startsWith(normalizeServed(gatedFallback));
  // ... unless the stored line is ITSELF malformed (`A player.` beside a raw that
  // supplies the whole sentence): then the raw is the sanctioned repair source — a
  // mangled row is repaired or dropped, never rendered.
  const storedStandaloneValid =
    !!gatedSentence && servedShapeViolations(punctuated(gatedSentence), []).length === 0;
  const rawExtendsBlocked = rawExtends && storedStandaloneValid;
  const rawUsable =
    !!rawFallback && !rawAddsClaim && !rawExtendsBlocked && (!hasProperName(rawFallback) || hasProperName(gated));
  // Order: the raw sentence when it is name-safe, then the stored gated line
  // (already anonymised by the seam), then — as the LAST resort before losing the
  // row — the raw sentence again even when the gate anonymised a name in it. A
  // lost row is a graded regression (AC3); a role for a name the seam could not
  // corroborate is the lesser cost, and it is still the model's own sentence.
  const sentences = [
    ...(rawUsable ? [rawFallback] : []),
    gatedFallback,
    gated,
    ...(rawUsable || rawAddsClaim || rawExtendsBlocked ? [] : [rawFallback]),
  ];
  for (const sentence of sentences) {
    if (!sentence) continue;
    const reclaimed = collapseRepeatedVerbPhrase(input.regate ? input.regate(sentence) : sentence);
    for (const variant of servedReductions(reclaimed)) {
      if (clean(variant)) return accepted(variant);
    }
  }
  return { text: "", violations: refused.length ? refused : ["empty"], replaced: true };
}

/* ------------------------------------------------------------------------- *
 * ADAAAA-8043 (contract v7 §3.2) — the COMPLETENESS gate.
 *
 * "Being under the word bar is not the same as being to the point." QA v6
 * measured 4 of 25 delivered rows that were shorter than the 8-word budget by
 * being INCOMPLETE (job `3544e617`):
 *
 *   `The ball remains of the pitch.`        the score-strip took `in the center`
 *                                           and left `of the pitch` behind
 *   `A player in a blue dribbles the ball.` actor + action, no place
 *   `A player from the box.`                actor + place, no action
 *   `A player in a white attempts a shot.`  actor + action, no place
 *
 * A delivered line carries actor + action + place, or it is suppressed. The
 * repair is extractive and happens at the WRITE seam: the line the gate
 * accepted, then the stored zone injected where only the place is missing, then
 * the model's own stored sentence reduced by deletion only. Nothing is
 * invented, and the most specific grounded actor token survives because the
 * repair never replaces words — it only removes them.
 * ------------------------------------------------------------------------- */

/** The three parts a delivered line must carry (§3.2). */
export type CompletenessGap = "actor" | "action" | "place" | "fragment";

/**
 * Actor openers a line may start with: a player noun, a jersey, the ball, or the
 * EVENT itself (`Kickoff taken at center circle.` — the play is the subject).
 */
const ACTOR_HEAD =
  /^(?:(?:a|an|the)\s+)?(?:players?|strikers?|wingers?|keepers?|goalkeepers?|defenders?|midfielders?|referees?|officials?|sides?|teams?|balls?|boys?|girls?|child|children|coach|coaches|attackers?|forwards?|substitutes?|kick-?off|corner|free\s+kick|throw-?in|penalty|goal\s+kick|clearance|whistle|No\.?\s*\d+|number\s+\d+|both\s+teams)\b/i;

/**
 * §3.2 actor test: the line's OWN subject, the most specific grounded token. A
 * corroborated proper name (`Saez strikes the ball in the box.`) IS the actor —
 * the name gate only anonymises names the prompt cannot corroborate.
 */
function hasActorHead(line: string): boolean {
  if (ACTOR_HEAD.test(line)) return true;
  // A determiner + noun is a subject (`The scoreboard updates to reflect a shot`):
  // the §3.2 test asks whether the line HAS an actor, not which noun it named.
  if (/^(?:a|an|the)\s+[\p{L}][\p{L}'’-]*/iu.test(line)) return true;
  const first = line.match(/^[\p{Lu}][\p{L}'’-]*/u)?.[0] ?? "";
  if (!first) return false;
  return !NAME_STOPWORDS.has(stripDiacritics(first)) && !CODE_TOKENS.has(first.toLowerCase());
}

/** The action verbs a complete beat carries (VERBISH plus state/stative play).
 * Stems, so every inflection (`press` / `presses` / `pressed`) is one entry. */
const COMPLETENESS_VERB =
  /\b(?:react|mov|driv|control|contest|dribbl|stand|pass|play|tak(?:e|es|en|ing|ed)?|took|hold|watch|wait|run|shoot|shot|strik|struck|head|clear|tackl|block|sav|beat(?:en|s)?|jump|turn|attack|press|chas|follow|keep|set|score|carri|win|send|sent|put|make|made|find|found|get|got|come|came|go|went|rise|rose|fall|fell|lift|loft|roll|bounc|cross|fire|volley|try|tried|see|saw|look|appear|erupt|celebrat|updat|becom|read|show|interact|attempt|remain|stay|sit|rest|touch|kick|throw|lose|lost|defend|mark|trap|chest|nod|poke|bundle)(?:s|es|ed|ing)?\b/i;

/** Two prepositions in a row (`moves the ball toward in midfield`). */
const DOUBLE_PREP = /\b(?:toward|towards|to|into|onto)\s+(?:in|at|on|from|near|inside)\b/i;
/** A place remnant that lost its head (`remains of the pitch`). */
const ORPHAN_PLACE_REMNANT = /\b(?:of|in|at|on|from)\s+(?:the\s+)?(?:pitch|field|ground)\b/i;
/** A place noun left holding `of the pitch` (`remains in center of the pitch`). */
const SPLIT_PLACE = /\b(?:cent(?:er|re)|box|area|midfield|circle)\s+of\s+the\s+(?:pitch|field|ground)\b/i;
const PLACE_HEAD_PRESENT =
  /\b(?:in|at|on|from|near|inside|outside|around|into)\s+(?:the\s+)?(?:cent(?:er|re)|box|midfield|third|half|halves|wing|area|circle|touchline|post|range|left|right)\b/i;

/** Why `text` is not a complete line (empty when it is). */
export function completenessGaps(text: string): CompletenessGap[] {
  const line = captionLead((text ?? "").trim());
  if (!line) return ["actor", "action", "place"];
  const gaps: CompletenessGap[] = [];
  if (!hasActorHead(line)) gaps.push("actor");
  if (!COMPLETENESS_VERB.test(line)) gaps.push("action");
  if (!hasPlacePhrase(line)) gaps.push("place");
  // The grammar class measured on `3544e617`: a reduction deleted the place's
  // head phrase and left the preposition that modified it (`remains of the
  // pitch`). It reads as a place but names none, so it fails as a fragment.
  if (SPLIT_PLACE.test(line)) gaps.push("fragment");
  if (DOUBLE_PREP.test(line)) gaps.push("fragment");
  if (ORPHAN_PLACE_REMNANT.test(line) && !PLACE_HEAD_PRESENT.test(line)) gaps.push("fragment");
  return gaps;
}

export interface CompleteCaptionInput {
  /** The line the gates accepted (a colour beat, if any, is stripped by the caller). */
  candidate: string;
  /** The model's stored pre-gate sentence (`text_raw`), the repair source. */
  raw?: string | null;
  /** Quiet row: the 8-word budget applies to the lead (AC5). */
  quiet?: boolean;
  /** The window's stored zone, injected when only the place is missing. */
  place?: string | null;
  /** Re-gate a fallback sentence on the same terms (claim / absence / name). */
  regate?: (sentence: string) => string;
}

/**
 * Make `candidate` a complete delivered line, or `""` to suppress it (§3.2).
 * The order is fixed and extractive: the accepted line, the stored zone where
 * only the place is missing, then the model's own stored sentence reduced by
 * deletion only. A candidate that already carries all three parts is returned
 * with its terminal punctuation and is otherwise byte-identical.
 */
export function completeCaptionLine(input: CompleteCaptionInput): string {
  const quiet = input.quiet === true;
  const budget = quiet ? QUIET_MAX_WORDS : Infinity;
  // §3.2 asks for actor + action + place. On a LOUD row the place is optional:
  // the row is a whole sentence about a moment (`The scoreboard updates to 2-1,
  // followed by player celebrations.`), and a zone it never named cannot be
  // invented. The measured defects (all four) were quiet rows, and the quiet
  // branch keeps the full three-part bar.
  const ok = (text: string): boolean => {
    const t = restoreTerminalPunctuation((text ?? "").trim());
    if (!t) return false;
    if (wordCount(captionLead(t)) > budget) return false;
    const gaps = completenessGaps(t);
    return quiet ? gaps.length === 0 : gaps.filter((g) => g !== "place").length === 0;
  };
  const candidate = restoreTerminalPunctuation(captionLead(input.candidate ?? ""));
  if (ok(candidate)) return candidate;
  const gaps = completenessGaps(candidate);
  const zone = (input.place ?? "").trim();
  // 1. Only the place is missing: keep the accepted actor + action verbatim and
  //    attach the window's own stored zone inside the sentence.
  if (
    candidate &&
    zone &&
    !gaps.includes("actor") &&
    !gaps.includes("action") &&
    !gaps.includes("fragment")
  ) {
    const terminal = candidate.match(/[.!?…]+$/)?.[0] ?? "";
    const body = tidy((terminal ? candidate.slice(0, -terminal.length) : candidate).trim());
    const injected = body ? tidy(`${body} ${zone}${terminal}`) : "";
    if (ok(injected)) return restoreTerminalPunctuation(injected);
  }
  // 2. The model's own sentence, re-gated on the same terms, reduced by
  //    deletion only (the variant order is longest-first, so the most specific
  //    actor token that still fits the budget wins).
  const rawSentence = wholeFirstSentence(input.raw ?? "");
  if (rawSentence && rawSentence !== candidate) {
    const reclaimed = input.regate ? input.regate(rawSentence) : rawSentence;
    for (const variant of servedReductions(reclaimed)) {
      if (ok(variant)) return restoreTerminalPunctuation(tidy(variant));
    }
  }
  // 3. Nothing groundable -> no line. A malformed row is worse than no row.
  return "";
}

/* ------------------------------------------------------------------------- *
 * ADAAAA-8027 (§2, card clause) — the STORE-TIME post-condition.
 *
 * `servedShape` above guards the LADDER. A caption card never crossed it: the
 * write seam stored `captionForStoredLine(gatedReason)` for any non-empty gated
 * line, so a card could carry an internal sentence break (the `gateGoalClaims`
 * seam), a prefix cut (`cutAtWord` at 140/180) or no predicate at all while the
 * stored raw sentence carried one (`Shot in midfield` for `… the keeper is
 * beaten …`). This helper is the ONE gate a stored card crosses, before any
 * caption/title is derived:
 *
 *   1. the caption (the gated line, capped) is tested against the §2 rules with
 *      the stored raw sentence as its source;
 *   2. refused -> the WHOLE first sentence of `decision.reason` (the stored
 *      raw), re-gated on the same terms (goal-claim / absence / name) so the
 *      fallback cannot assert an uncorroborated goal — §3.4 forbids that on a
 *      caption exactly as it does on a ladder row;
 *   3. still refused -> the row stores NO card. A violating string is
 *      unstoreable by construction.
 *
 * Card options are derived from the ACCEPTED caption string, never from an
 * independent word cut.
 * ------------------------------------------------------------------------- */

/** A verb phrase repeated immediately across a coordinator: `shoots and shoots`. */
const REPEATED_VERB_SRC =
  String.raw`\b([A-Za-z]+(?:s|es|ed|ing))\s+and\s+\1\b|\b([A-Za-z]+(?:s|es|ed|ing)(?:\s+[A-Za-z]+){0,2})\s+and\s+\2\b`;

/** Does this line carry an immediately repeated verb phrase (`<verb> and <same verb>`)? */
export function hasRepeatedVerbPhrase(text: string): boolean {
  return new RegExp(REPEATED_VERB_SRC, "i").test(text ?? "");
}

/**
 * Contract v8 §3b.2 — claim removal must REJOIN, not amputate.
 *
 * Deleting an ungrounded outcome clause and substituting the window's own
 * non-goal verb left the verb twice, because the source already carried it:
 *
 *   stored `text_raw`       `The white team player shoots and scores a goal — crowd reacts`
 *   claim rewrite           `The white team player shoots and shoots`     (verb doubled)
 *   delivered on `86f6ada4` `The white team player shoots and shoots in midfield.`
 *
 * `<verb> and <same verb>` is one action, so the second copy is deleted. The
 * repair is extractive and deterministic — no word is invented, and a line
 * without a repeat is returned byte-identical.
 */
export function collapseRepeatedVerbPhrase(text: string): string {
  const input = text ?? "";
  if (!input) return input;
  // Iterate to a fixed point (bounded): `shoots and shoots and shoots` and a
  // phrase repeat (`takes a shot and takes a shot`) can both appear at once.
  let out = input;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(new RegExp(REPEATED_VERB_SRC, "gi"), (_m, one: string, two: string) => one || two);
    if (next === out) break;
    out = next;
  }
  return out === input ? input : tidy(out);
}

export interface StoredCardSurfaceInput {
  /** The gated line the row stores as its `reason`. */
  gated: string;
  /** The model's stored raw line (`decision.reason`), the §2 source. */
  raw?: string | null;
  /** The card option label (`shot`, `big play`, …). ADAAAA-8053: DEPRECATED as
   * an option source — contract v8 §3b.1 forbids serving a bare taxonomy token
   * or a `<type>: ` prefix, so the label no longer becomes a card option. The
   * field is kept so call sites stay stable; it is not read. */
  label?: string;
  /** Quiet row: the 8-word budget applies to the card (the verdict's own rule). */
  quiet?: boolean;
  /**
   * ADAAAA-8043 (contract v7 §3.4): the window's corroboration verdict. An
   * uncorroborated goal may not render `goal:` / bare `goal` in a card option —
   * corroboration must reach the card-title surface, not only the caption.
   * `undefined` keeps the verdict rule alone (VOD, legacy rows -> AC8).
   */
  corroborated?: boolean | null;
  /** The window's stored verdict, so the LABEL is gated on the same terms. */
  verdict?: string | null;
  /** Re-gate a fallback sentence on the same terms (goal claim / absence). */
  regate?: (sentence: string) => string;
}

export interface StoredCardSurface {
  /** The accepted caption, `""` when the row must carry NO card. */
  caption: string;
  /** Options derived from the accepted caption (empty when the card is dropped). */
  cardTitles: string[];
  /** Why the gated caption was refused (`[]` when it passed unchanged). */
  violations: ServedShapeViolation[];
}

/** The whole first sentence, capped at a sentence boundary (never a prefix cut). */
function captionForWholeSentence(sentence: string): string {
  const text = repairDanglingTail((sentence ?? "").trim());
  if (!text) return "";
  return cutAtSentence(text, MAX_CAPTION_CHARS);
}

export function storedCardSurface(input: StoredCardSurfaceInput): StoredCardSurface {
  const gated = (input.gated ?? "").trim();
  const raw = (input.raw ?? "").trim();
  if (!gated) return { caption: "", cardTitles: [], violations: ["empty"] };
  const rawSentence = wholeFirstSentence(raw);
  const sources = [captionLead(wholeFirstSentence(gated)), captionLead(rawSentence)].filter(Boolean);
  const quiet = input.quiet === true;
  // Quiet rows keep the 8-word budget; loud rows do not have one.
  const fits = (text: string): boolean => !!text && (!quiet || wordCount(text) <= QUIET_MAX_WORDS);
  // ADAAAA-7995 AC4: a quiet row carries no colour, so a fallback variant that
  // still names one is skipped (the reduction list removes it).
  const QUIET_COLOUR_PHRASE =
    /\bin\s+(?:an?\s+|the\s+)?(?:white|blue|red|black|yellow|green|purple|orange|grey|gray)\b/i;
  const clean = (text: string): boolean =>
    fits(text) &&
    (!quiet || !QUIET_COLOUR_PHRASE.test(text)) &&
    // ADAAAA-8043 (v7 §3.2): a card caption is a delivered line, so it carries
    // actor + action + place exactly like a ladder row. A card whose only
    // honest string is incomplete is not stored (it was the source of the
    // read-time rewrite AC10 measured).
    (quiet
      ? completenessGaps(text).length === 0
      : completenessGaps(text).filter((g) => g !== "place").length === 0) &&
    servedShapeViolations(text, sources).length === 0;
  // ADAAAA-8043 (v7 §3.4) label gate removed by contract v8 §3b.1: the label is
  // no longer an option (a bare token or a `label: sentence` prefix is not a
  // gated stored string), so there is nothing to corroboration-gate here. AC4b
  // is still enforced on the caption itself (`regate` -> `gateGoalClaims`).
  // ADAAAA-8127 (Defect B): a stored line whose sentence end was carried by the
  // clause the gate excised (`The keeper is beaten` for `… and the keeper is
  // beaten as the player in white scores.`) is a SENTENCE, not a label. The end is
  // restored only when the row's OWN source carried one — a line whose source
  // itself stops without a stop is the model's own text, and a stored row keeps
  // that byte-identical (ADAAAA-8125 AC3). The candidate is closed BEFORE the
  // post-condition, so a bare caption cannot be accepted as its own source.
  const droppedStop =
    hasTerminalPunctuation(rawSentence) && !hasTerminalPunctuation(gated);
  const candidate = captionForStoredLine(
    droppedStop ? restoreTerminalPunctuation(gated) : gated
  );
  const violations = servedShapeViolations(candidate, sources);
  if (clean(candidate)) {
    return { caption: candidate, cardTitles: cardTitlesFor(candidate), violations: [] };
  }
  // Fallback (a): the WHOLE first sentence of the stored raw, re-gated on the same
  // terms, then reduced ONLY extractively (the ladder's `servedReductions`) so a
  // quiet row that lost its predicate at the quiet trim (`A player in the
  // midfield.` for `… dribbles …`) is re-served WITH the verb, at the budget.
  const reclaimed = input.regate ? input.regate(rawSentence) : rawSentence;
  for (const variant of servedReductions(reclaimed)) {
    const whole = captionForWholeSentence(variant);
    if (clean(whole)) {
      return { caption: whole, cardTitles: cardTitlesFor(whole), violations: [] };
    }
  }
  // Fallback (b): no honest string -> no card. Never store a violating string.
  return { caption: "", cardTitles: [], violations };
}

/**
 * ADAAAA-8125 (ADAAAA-8124 product ruling, clause 1): the QUIET copy derived from
 * this row's own window.
 *
 * The gap this closes: the write seam stored `card.caption || (reasonClean ?
 * gatedLine : "")`, so a REFUSED goal-claim card on a NON-EMPTY but shape-unclean
 * gated line stored neither a `reason` nor a `caption` — 22 of 61 accepted rows
 * (36%) on the ADAAAA-8124 post-deploy sweep. Copy is owed by the row; a claim
 * card is earned by corroboration (§3.4).
 *
 * The copy is derived from THIS row's own sentence (`raw` = the model's stored
 * line for this decision, the same string the card gate refused — never a
 * neighbouring ladder entry, never a model call) and is purely extractive:
 *
 *   1. `quietShape` keeps the row's own actor words + the window's own outcome
 *      verb (and its own place), so no word is invented;
 *   2. the SAME gate order the stored line and the card cross is applied
 *      (claim -> absence -> names -> place -> quiet window -> score facts), so
 *      the copy cannot say more than either surface may;
 *   3. the lead is trimmed to the quiet budget (<= 8 words, never longer than the
 *      row's own sentence) and closed with `restoreTerminalPunctuation`;
 *   4. the result must be a FIXED POINT of the gate order (`gateGoalClaims` then
 *      `gateQuietWindow`), carry 0 `servedShapeViolations` against its own
 *      `wholeStoredSentence(raw)`, and carry no internal token, claim, absence
 *      claim or uncorroborated score/name.
 *
 * `""` means this window has no honest sentence: the caller stores NO `reason`
 * (clause 3) and keeps the row — never a placeholder, never an invented word,
 * never a card surface (a card title is still earned only by corroboration).
 */
export function quietStoredCopy(raw: string | null | undefined, ctx?: CaptionGroundingContext): string {
  // ADAAAA-8806: the CAPTION source, not the audit reason — the provisional-goal
  // marker tail is diagnostic text and can never become copy.
  const src = captionSourceText(raw).trim();
  if (!src) return "";
  const storedSentence = wholeStoredSentence(src);
  // The quiet shape is `quietShape`'s claim removal when this row's own sentence
  // carries a goal claim (it keeps the row's actor words + the window's own
  // outcome verb); a row that carries NO claim already IS the quiet shape — its
  // own first sentence, which `quietShape` would reduce to a bare "shot" because
  // it has no claim to cut at.
  const claimBearing = hasGoalClaim(storedSentence);
  const quiet = claimBearing ? quietShape(src) : storedSentence;
  if (!quiet) return "";
  // Candidate order: the row's own quiet shape, then — when that still carries
  // the event frame (`The scoreboard updates from 1-1 to 2-1 as …`) — the row's
  // own BEAT clauses, the clause carrying the window's outcome verb, then the
  // row's own LEADING clause when it carries its own verb (ADAAAA-8130:
  // `Crowd erupts in celebration as the scoreboard shows a goal for FCB.`). All
  // are extractive; whichever passes the gate order is the row's honest copy.
  //
  // ADAAAA-8193: the beat clauses are offered for a CLAIM-FREE row too when its
  // sentence leads with the event ledger (`Scoreboard changes to 1-1 at t=0.0s
  // and players celebrate.`). Such a row never had a claim to cut, so
  // `outcomeVerbFor` substituted nothing and the tail beat (`Players celebrate.`)
  // was never a candidate — the whole 9-word ledger sentence failed the 8-word
  // quiet budget, and clause 3 emptied a row that carries an honest beat. The
  // `quiet` shape is still tried FIRST, so a row that already served copy keeps
  // serving it byte-identically.
  //
  // ADAAAA-8193 (AC2, PO ruling: "scoreboard changes can be delayed"): when the
  // row's only honest content is the event LEDGER itself — the score transition
  // was measured in this window, the clause that named the play (`the ball is in
  // the net`) is unmeasured — the row's own corroborated score line is the copy.
  // Offered LAST, so every row that already has a beat keeps it byte-identically.
  const beats = quietBeatClauses(quiet, src, claimBearing);
  const ledger = ledgerScoreLines(quiet, ctx, storedSentence);
  const candidates = [quiet, ...beats, ...ledger];

  for (const candidate of candidates) {
    const served = serveQuietCandidate(candidate, storedSentence, ctx);
    if (served) return served;
  }
  return "";
}

/**
 * ADAAAA-8125: the row's own BEAT clauses — the clauses that carry the window's
 * outcome verb and, since ADAAAA-8130, the row's LEADING clause when it carries
 * its own verb (`Crowd erupts in celebration` in
 * `Crowd erupts in celebration as the scoreboard shows a goal for FCB.`).
 *
 * The clause before a beat is the event FRAME (the ledger line the model read),
 * not the beat: serving the frame alone is a prefix of the row's own sentence,
 * which §2 refuses. Extractive only — the words are the row's own, the verb is
 * the one `quietShape` already substituted (or the row's own verb, for the
 * leading clause), and the capitalisation is the sentence start.
 *
 * Candidates are ordered: the tail clauses nearest the substitution first (they
 * carry the window's own outcome verb), then the leading clause.
 */
function quietBeatClauses(quiet: string, src: string, claimBearing = true): string[] {
  const clauses = splitQuietClauses(quiet);
  if (clauses.length < 2) return [];
  // ADAAAA-8193: the ONE claim-free shape that owns a beat is a sentence that
  // LEADS with the event ledger — `Scoreboard changes to 1-1 at t=0.0s and
  // players celebrate.` No claim was cut, so no outcome verb was substituted;
  // the tail clauses are scanned on their OWN verb instead. A claim-free
  // sentence that does not lead with the ledger keeps its single quiet shape
  // (the ADAAAA-8125 candidate set), so this stays a two-shape fix.
  const ledgerLead = FRAME_LEDGER.test(clauses[0]);
  if (!claimBearing && !ledgerLead) return [];
  const verb = outcomeVerbFor(src);
  const verbRe = new RegExp(`\\b${verb.replace(/\s+/g, "\\s+")}\\b`, "i");
  const out: string[] = [];
  for (let i = clauses.length - 1; i >= 1; i -= 1) {
    // The clause must carry the outcome verb BEFORE the substituted tail is
    // stripped: the tail is the gate's own word, not evidence for this clause.
    // A claim-free row substituted nothing, so any clause that passes
    // `quietBeatFromClause` (its own verb, no claim/score/ledger) is a beat.
    if (claimBearing && !verbRe.test(clauses[i])) continue;
    const beat = quietBeatFromClause(clauses[i]);
    if (beat && !out.includes(beat)) out.push(beat);
  }
  // ADAAAA-8130: the LEADING clause is the row's own actor-first beat. It is
  // never offered while a tail clause already carries the window's outcome, and
  // only when it carries its own verb and no claim/score/internal token
  // (`quietBeatFromClause` enforces the last part).
  const lead = quietBeatFromClause(clauses[0]);
  if (lead && !out.includes(lead)) out.push(lead);
  return out;
}

/** Split a quiet line into its clauses at the event-frame connectors. */
function splitQuietClauses(text: string): string[] {
  return (text ?? "")
    .split(/\s*[—–]\s*|\s+(?:as|while|when|and|but)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * ADAAAA-8209: the event FRAME clause of a stored sentence, independent of how
 * many connector clauses the sentence has.
 *
 * A provenance/attribution phrase is COMMA-appended, not connector-opened:
 *
 *     Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.
 *
 * is ONE clause for `splitQuietClauses`, so the ledger reader used to bail on
 * `clauses.length < 2` before it ever saw the `from X to Y` transition. The
 * frame is the leading clause up to the first comma/semicolon; the provenance
 * tail is never part of the copy (and never a beat, see `PROVENANCE_CLAUSE`).
 */
function ledgerFrameOf(text: string): string {
  const lead = splitQuietClauses(text)[0] ?? "";
  const head = lead.split(/\s*[,;]\s*/)[0] ?? "";
  // The model's own PARENTHETICAL speculation (`(likely a goal/reset)`) is
  // commentary, never copy: a frame whose claim annotation was cut by
  // `quietShape` leaves an unclosed `(likely a …` — drop the parenthetical (or
  // the truncated remainder of one) so the ledger words are the row's frame.
  return head
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s*\(.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ADAAAA-8130: ONE clause as a beat candidate, or `""` when it is not a beat.
 *
 * `quietShape` appends the window's outcome verb after the determiner a claim
 * noun left behind (`players celebrate a shoots`, `the scoreboard shows a
 * shoots`). That substituted tail is stripped BEFORE the beat check, so the
 * gate's own word can never be what makes a clause a beat, and a clause whose
 * only verb is the substituted outcome stays a non-beat (it strips down to a
 * bare phrase and fails the verb test).
 */
function quietBeatFromClause(clauseText: string): string {
  const clause = (clauseText ?? "").trim();
  if (!clause) return "";
  // `quietShape` appends the outcome verb after the determiner a claim noun left
  // behind (`players celebrate a shoots`). Dropping that substituted tail keeps
  // the clause's OWN verb, which is the honest beat
  // (`Players celebrate in the penalty area.`).
  const mangled = MANGLED_QUIET_SUBSTITUTE.test(clause);
  const stripped = (mangled ? clause.replace(SUBSTITUTED_QUIET_TAIL, "") : clause).trim();
  if (!stripped) return "";
  const out = stripped.replace(/^[a-z]/, (m) => m.toUpperCase());
  // A beat clause is the actor + a verb; a bare phrase is not.
  if (wordCount(out) < 2 || !VERBISH.test(out)) return "";
  // A claim, a scoreline or an internal token is never a beat: clause 3 keeps
  // the window empty rather than serving one.
  if (hasGoalClaim(out) || findScoreClaims(out).length > 0) return "";
  if (stripInternalTokens(out) !== out) return "";
  // The event LEDGER is never a beat: a scoreboard/graphic line (`The scoreboard
  // updates from 1-1 to 2-1`) reports the frame the model read, not the play.
  if (FRAME_LEDGER.test(out)) return "";
  // ADAAAA-8209: a PROVENANCE clause is the model citing its own evidence
  // (`confirmed by ball in net at t=-2.0s`, `ASR confirms a goal for Real
  // Madrid`, any clause carrying the `at t=` audit marker), never a beat. Without
  // this a comma/connector split would offer `Confirmed by ball in shoots.` before
  // the ledger candidate and ship mangled attribution as copy.
  if (PROVENANCE_CLAUSE.test(out)) return "";
  // The clause the claim was cut OUT of is the event FRAME, not the beat: a
  // display verb that outlived its claim object (`the scoreboard shows a goal
  // for FCB` -> `the scoreboard shows`) reports the claim, it does not beat it.
  if (mangled && FRAME_DISPLAY_VERB.test(out)) return "";
  return out;
}

/**
 * ADAAAA-8193 (AC2): the LEDGER-LINE copy for a row whose only honest content is
 * a MEASURED score transition.
 *
 * The shape this closes (`highlight c8d843fe`, GOAL): the model's sentence is
 * ledger-only —
 *
 *     Scoreboard changes from 2-1 to 2-2 at t=-5.0s and the ball is in the net.
 *
 * The play clause (`the ball is in the net`) is UNMEASURED for this row
 * (`goalCrossed=false`, `ballOutcome=null`) so it can never ship, the leading
 * clause is the event frame so it is not a beat, and the whole sentence is over
 * the 8-word quiet budget -> clause 3 stored no copy. The one corroborated fact
 * the window HAS is the score change itself: the prompt reads `2-1` at the
 * earlier taps and `2-2` from the transition tap on, i.e. the board caught up
 * with the play a tap or two late ("scoreboard changes can be delayed", the PO's
 * ruling on this ticket).
 *
 * So the row's own score line is the copy — extractive and gated:
 *
 *   1. the stored sentence must LEAD with the event ledger, and its leading
 *      clause must carry a `from X to Y` transition (a bare `changes to Y`
 *      sentence is a static read, not a change, and is never served here);
 *   2. BOTH ends of the transition must be measured in THIS window's own prompt
 *      (`X` and `Y` both appear) — that is what makes the change a measurement
 *      rather than a claim, and it is why a delayed board is allowed: the pre
 *      score was read first, the post score later;
 *   3. the served line drops only the uncorroborated old score and the audit
 *      `at t=…` marker, keeping the row's own frame verbs
 *      (`Scoreboard changes to 2-2.`) — no word is invented, and the play clause
 *      the window could not attest is dropped whole;
 *   4. it then crosses the same gate order as every other quiet candidate
 *      (`serveQuietCandidate`: claim -> absence -> names -> place -> quiet window
 *      -> score facts -> served-shape post-condition -> fixed points), so a line
 *      the prompt does not corroborate is refused HERE too.
 *
 * Offered AFTER the beat clauses, so a row that has an honest beat keeps it
 * (row 1 of this ticket still serves `Players celebrate.`).
 */
function ledgerScoreLines(quiet: string, ctx?: CaptionGroundingContext, storedSentence = ""): string[] {
  const prompt = typeof ctx?.promptText === "string" ? ctx.promptText : "";
  if (!prompt) return [];
  // ADAAAA-8209: the FRAME is the leading clause, and a provenance tail is
  // comma-appended rather than opened by an `as/while/when/and/but` connector:
  //   `Scoreboard changes from 2-2 to 1-1 at t=-3.0s, confirmed by ball in net at t=-2.0s.`
  // `splitQuietClauses` returns that as ONE clause, and the old `clauses.length <
  // 2` bail refused the row before it ever read the transition. The frame is
  // taken up to the first comma/semicolon instead, so the ledger line does not
  // depend on the sentence having a connector clause.
  const frame = ledgerFrameOf(quiet);
  if (!frame) return [];
  // The CLOCK form (`Scoreboard reads 22:19`) is not a score change.
  if (!FRAME_LEDGER.test(frame)) return [];
  // `from X to Y` — both ends of the transition, in the row's own words.
  const pair = frame.match(SCORE_PAIR);
  if (!pair) return [];
  const ends = findScoreClaims(pair[0]);
  if (ends.length < 2) return [];
  const pre = ends[0];
  const post = ends[ends.length - 1];
  if (!pre || !post || pre === post) return [];
  // The row must cite WHEN the change was read (`at t=-5.0s`): that marker is the
  // model's own measured instant inside the window, which is what tells a read
  // transition from a prose restatement of the score. The marker may ride ANY
  // clause of the ROW'S OWN sentence (ADAAAA-8209: `… and crowd erupts at
  // t=-5.0s`), so the test reads the stored sentence as well as the quiet shape —
  // `quietShape` can drop the clause the marker rode. The marker is dropped from
  // the copy (audit provenance is never served).
  if (!/\bat\s+t=-?[\d.]+\s*s\b/i.test(`${quiet} ${storedSentence}`)) return [];
  // Both ends MEASURED in this window: the pre score was read before the change
  // and the post score after it (the delayed-board shape). A prompt carrying only
  // the post score is a static read and earns no copy.
  if (!promptHas(prompt, pre) || !promptHas(prompt, post)) return [];
  // Extractive reduction of the row's own frame clause: drop the superseded old
  // score and the audit marker, keep the row's own ledger words.
  const line = tidy(
    frame
      .replace(SCORE_PAIR, `to ${post}`)
      .replace(/\s+at\s+t=[^,;]*$/i, "")
      .replace(/\s+at\s+-?[\d.]+\s*s$/i, "")
  ).trim();
  if (!line) return [];
  const out = restoreTerminalPunctuation(line.replace(/^[a-z]/, (m) => m.toUpperCase()));
  // The served line reports exactly ONE score — the post score. The old score is
  // never served beside it (a both-ends line is the uncorroborated read).
  const claims = findScoreClaims(out);
  if (claims.length !== 1 || claims[0] !== post) return [];
  if (!LEDGER_VERB.test(out) || hasGoalClaim(out)) return [];
  return [out];
}

/** The ledger's own verbs: the frame's report words, never a play verb. */
const LEDGER_VERB = /\b(?:changes?|updates?|changes?|becomes?|goes?|moves?|reads?|shows?|stands?|is\s+now)\b/i;

/** Display verbs whose object is a claim the gate cut: the frame, not a beat. */
const FRAME_DISPLAY_VERB =
  /\b(?:shows?|showed|displays?|displayed|reads?|announces?|announced|reports?|reported|indicates?|indicated|confirms?|confirmed|reveals?|revealed)\b/i;

/**
 * ADAAAA-8209: a provenance/attribution clause — the model citing its own
 * evidence, or a clause carrying the window-relative audit marker. Never copy,
 * never a beat: `confirmed by ball in net at t=-2.0s`, `ASR confirms a goal for
 * Real Madrid`, `commentary confirms the shot`, `… and crowd erupts at t=-5.0s`.
 */
const PROVENANCE_CLAUSE =
  /\b(?:confirmed|confirms)\b|\b(?:asr|commentary|commentator|replay)\s+(?:confirms?|confirmed)\b|\bat\s+t=-?[\d.]+\s*s\b/i;

/**
 * ADAAAA-8130: the event LEDGER — a scoreboard/graphic/clock line or a raw
 * scoreline. It is the frame the model read, never the row's beat, so it can be
 * neither a quiet candidate nor the sanctioned prefix of its own sentence.
 */
const FRAME_LEDGER =
  /\b(?:scoreboard|score ?bug|score[- ]?line|score[- ]?(?:graphic|overlay|card))\b|\b\d+\s*[-–:]\s*\d+\b/i;

/** The connectors that open a new clause in a stored sentence. */
const CLAUSE_CONNECTOR = /\b(?:as|while|when|and|but)\b/i;

/** The determiner + outcome verb `quietShape` appends to a cut claim clause. */
const SUBSTITUTED_QUIET_TAIL =
  /\s+(?:a|an|the)\s+(?:shoots|is\s+saved|is\s+blocked|is\s+cleared|goes\s+wide)$/i;

/* ------------------------------------------------------------------------- *
 * ADAAAA-8411 — the CLOCK-BRACKETED ATTESTATION sentence.
 *
 * Measured defect (Phase D on the served build, job 755fd1f5, row f4407757 /
 * card `GOAL · 2:38`): a scoring row's ONLY model sentence was
 *
 *     Scoreboard changes to 2-2 at t=-3.3s and ASR confirms 'il gol!'
 *
 * The sentence is an ATTESTATION, not a description: it cites the window clock
 * (`at t=-3.3s`) and the ASR read, and the ledger frame is the only customer
 * fact in it. `stripInternalTokens` strips the `T+` clock form only, so the
 * `at t=` marker survives; `storedCardSurface` refuses the line,
 * `storedReasonViolations` refuses it (`audit-marker`), `ledgerScoreLines` needs
 * a `from X to Y` transition this line does not carry, and `quietStoredCopy`
 * refuses provenance — so the row stored NO copy and the detail route served the
 * post TITLE as the announcer line (`caption == postTitle`).
 *
 * The function below derives the row's own FACT sentence by DELETION only:
 *
 *   1. the sentence is split at its own clause boundaries; ATTESTATION clauses
 *      (a channel word + a reporting verb: `ASR confirms …`, `commentary says
 *      …`, `confirmed by …`) and QUOTED reads are dropped whole — they cite
 *      evidence for the model, they are not copy, and a quote is an OCR/ASR
 *      string;
 *   2. the window-relative audit marker (`at t=-3.3s`, `at 19s`, a
 *      `… to 0.0s` range) is deleted from whatever survives;
 *   3. the survivor must be a complete clause with its own verb, one score fact
 *      at most, no claim this window cannot carry, no internal token, no
 *      parenthetical;
 *   4. a score fact must be MEASURED: at the write seam this window's prompt
 *      must carry the same scoreline (`promptHas`) and `gateScores` must return
 *      the line unchanged; on the read path (no prompt to consult) the row's own
 *      stored verdict must be `scoring_play`, so a scoreline is never served on
 *      a non-scoring row;
 *   5. the survivor crosses the SAME gate order every stored copy crosses
 *      (claim -> absence -> names) and the store-time post-condition
 *      (`storedReasonViolations` against this row's own stored sentence), and is
 *      a fixed point of it.
 *
 * `""` means the window has no honest residue: the caller keeps its own
 * fallback (the read path's deterministic fact sentence, see
 * `projectAnnouncerCaption`) and never serves the sentence as written.
 * ------------------------------------------------------------------------- */

/** The window-relative AUDIT marker the model cites for its own evidence. */
const ATTESTATION_MARKER_TEST = /\bat\s+t=-?[\d.]+\s*s\b/i;

/** A channel word (`ASR`, `commentary`, `OCR` …) — evidence, never copy. */
const ATTESTATION_CHANNEL =
  /\b(?:asr|commentary|commentator|replay|audio|timeline|perceive|ocr|score ?bug|scoreboard\s+read(?:ing)?s?)\b/i;
/** A reporting verb: what turns a channel word into an attestation clause. */
const ATTESTATION_REPORT =
  /\b(?:confirms?|confirmed|says?|said|notes?|noted|indicates?|indicated|shows?|showed|reads?|reading|reports?|reported|mentions?)\b/i;

/**
 * ADAAAA-8411: is `remainder` (the text a candidate clause drops from its own
 * stored sentence) PROVENANCE ONLY — the window audit marker and the attestation
 * clauses that cite a channel? Used by `servedShapeViolations` so the row's own
 * LEDGER FRAME can be served as a clause-precise lead instead of being refused as
 * a prefix cut. `true` only when nothing customer-readable is dropped.
 */
function remainderIsProvenanceOnly(remainder: string): boolean {
  const text = (remainder ?? "").trim();
  if (!text) return true;
  const clauses = text
    .split(/\s*(?:[—–;,]|\b(?:and|as|while|when|but)\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clauseRaw of clauses) {
    const clause = dropAttestationMarker(clauseRaw);
    if (!clause) continue;
    // `servedShapeViolations` compares NORMALISED strings, so the remainder it
    // hands here has already lost the marker's punctuation (`at t 3 3s`). The
    // residue carries no words, only the clock digits.
    const residue = clause.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (/^at\s+(?:t\s+)?[\d\s.]+s?$/.test(residue) || /^t\s+[\d\s.]+s?$/.test(residue)) continue;
    if (ATTESTATION_CHANNEL.test(clause) && ATTESTATION_REPORT.test(clause)) continue;
    if (PROVENANCE_CLAUSE.test(clause)) continue;
    return false;
  }
  return true;
}

function dropAttestationMarker(clause: string): string {
  return clause
    // `at t=-3.3s`, optionally a range (`at t=-3.3s to 0.0s`)
    .replace(/\s*\bat\s+t=-?[\d.]+\s*s(?:\s*(?:to|-|–|—)\s*(?:t=)?-?[\d.]+\s*s)?/gi, " ")
    // `at 19s` / `at 19:00` — the same provenance in the other clock form
    .replace(/\s*\bat\s+(?:\d{1,3}:\d{2}|\d+(?:\.\d+)?\s*s)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function attestationDetailCopy(
  raw: string | null | undefined,
  ctx?: CaptionGroundingContext
): string {
  const src = captionSourceText(raw).trim();
  if (!src) return "";
  // ONLY the clock-bracketed attestation shape: a sentence that cites its own
  // window-relative marker. Every other sentence is the card gate's business.
  if (!ATTESTATION_MARKER_TEST.test(src)) return "";
  const clauses = src
    .split(/\s*(?:[—–;,]|\b(?:and|as|while|when|but)\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clauseRaw of clauses) {
    const clause = dropAttestationMarker(clauseRaw);
    if (!clause) continue;
    // An attestation clause and a quoted read are the model citing evidence.
    if (ATTESTATION_CHANNEL.test(clause) && ATTESTATION_REPORT.test(clause)) continue;
    if (PROVENANCE_CLAUSE.test(clause)) continue;
    if (/['"‘’“”]/.test(clause)) continue;
    if (/\(/.test(clause)) continue;
    if (wordCount(clause) < 3) continue;
    const candidate = restoreTerminalPunctuation(clause.replace(/^[a-z]/, (m) => m.toUpperCase()));
    if (!candidate) continue;
    // Extractive only: the gate may REFUSE this clause, never rewrite it.
    if (gateGoalClaims(candidate, ctx) !== candidate) continue;
    if (gateAbsenceClaims(candidate, ctx) !== candidate) continue;
    if (groundNames(candidate, ctx?.promptText) !== candidate) continue;
    if (hasGoalClaim(candidate) || hasAbsenceClaim(candidate)) continue;
    if (stripInternalTokens(candidate) !== candidate) continue;
    if (!VERBISH.test(candidate)) continue;
    const scores = findScoreClaims(candidate);
    if (scores.length > 1) continue;
    const promptKnown = typeof ctx?.promptText === "string";
    if (scores.length === 1) {
      if (promptKnown) {
        // A string prompt is the evidence: an EMPTY one fails closed like no
        // evidence at all (an unmeasured scoreline is a claim).
        if (!promptHas(ctx?.promptText as string, scores[0])) continue;
        if (gateScores(candidate, ctx?.promptText as string) !== candidate) continue;
      } else if ((ctx?.verdict ?? "").trim().toLowerCase() !== "scoring_play") {
        // No prompt to corroborate a scoreline: only the row's own scoring
        // verdict may carry one (S2 — a score claim on a non-scoring row is the
        // defect the claim bar exists to stop).
        continue;
      }
    }
    // ADAAAA-8806: an extractive clause that says what the ball did is only
    // honest when the row's own attestation recorded an outcome.
    if (captionAssertsUnattestedAction(candidate, ctx)) continue;
    if (storedReasonViolations(candidate, [wholeStoredSentence(src)]).length > 0) continue;
    return candidate;
  }
  return "";
}

/** The gate order + post-conditions ONE quiet candidate must pass (AC1/AC2). */
function serveQuietCandidate(
  candidate: string,
  storedSentence: string,
  ctx?: CaptionGroundingContext
): string {
  const sources = storedSentence ? [storedSentence] : [];
  let out = restoreTerminalPunctuation((candidate ?? "").trim());
  if (!out) return "";
  out = gateGoalClaims(out, ctx);
  out = gateAbsenceClaims(out, ctx);
  out = groundNames(out, ctx?.promptText);
  out = ensureLeadPlace(out, ctx);
  // §3.3 budget: the quiet LEAD is <= 8 words. Applied before the colour beat so
  // the trim can never cut through an appended clause.
  const lead = captionLead(out);
  const budgeted = wordCount(lead) > QUIET_MAX_WORDS ? trimQuietLine(lead, ctx?.place) : lead;
  out = restoreTerminalPunctuation((budgeted ?? "").trim());
  out = gateQuietWindow(out, ctx);
  if (typeof ctx?.promptText === "string") out = gateScores(out, ctx.promptText);
  out = restoreTerminalPunctuation((out ?? "").trim());
  if (!out) return "";
  // The post-condition the gated line already crosses (`reasonClean`): 0
  // served-shape violations against THIS row's own stored sentence, plus the
  // store-time post-conditions (no `at t=` audit marker, lead within the quiet
  // budget) that ADAAAA-8209 moved into `storedReasonViolations`.
  if (storedReasonViolations(out, sources).length > 0) return "";
  // … and the copy gates it must be a FIXED POINT of (AC2): re-running the gate
  // order returns the same string, so no read or re-emit can derive another.
  const claimed = gateGoalClaims(out, ctx);
  if (claimed !== out) return "";
  if (gateQuietWindow(claimed, ctx) !== out) return "";
  if (gateAbsenceClaims(out, ctx) !== out || hasAbsenceClaim(out)) return "";
  if (hasGoalClaim(out)) return "";
  if (stripInternalTokens(out) !== out) return "";
  // A scoreline is a CLAIM too: it ships only when this window's own prompt
  // corroborates it (`gateScores`), never on a pure quiet fallback.
  const scores = findScoreClaims(out);
  if (scores.length > 0 && scores.some((claim) => typeof ctx?.promptText !== "string" || !promptHas(ctx.promptText, claim))) {
    return "";
  }
  // Quiet budget + never longer than the row's own sentence.
  if (wordCount(captionLead(out)) > QUIET_MAX_WORDS) return "";
  if (storedSentence && wordCount(out) > wordCount(storedSentence)) return "";
  // A claim-substituted tail (`… celebrate a shoots`) is malformed copy: the
  // outcome verb cannot follow a determiner the row left behind.
  if (MANGLED_QUIET_SUBSTITUTE.test(out)) return "";
  // A capitalised determiner mid-sentence is a mangled substitution too
  // (`The commentator announces The striker shoots`): the clause extraction or
  // the name gate left a second sentence inside the line.
  if (/\p{Ll}\s+(?:The|A|An)\b/u.test(out)) return "";
  // ADAAAA-8193: the model's window-relative AUDIT marker (`at t=-5.0s`) is
  // evidence provenance, never copy — a line that keeps it reads as a log row
  // (`Scoreboard changes at t=-5.0s.`). Refused here so no shape can serve one.
  if (/\bat\s+t=-?[\d.]+\s*s\b/i.test(out)) return "";
  // ADAAAA-8209: an attribution/provenance line (`Commentary confirms Real
  // Madrid shoots.`) is the model citing evidence, never the row's beat; and a
  // parenthetical (`(likely a goal/reset)`, `(implied shot)`) is model
  // speculation, never copy — an unbalanced `(` is a truncation of one.
  if (PROVENANCE_CLAUSE.test(out)) return "";
  if (/\(/.test(out)) return "";
  // A quote is an OCR label the model quoted, never copy
  // (`… the stadium displays 'GOAL' …` reduced to `displays '`).
  if (/['"‘’“”]/.test(out)) return "";
  // ADAAAA-8806 (AC9): the row's own attestation recorded NO ball outcome, so a
  // line that says what the ball did is invented. Measured defect on job
  // `3740585f` row `6ff00ac9`: `quietShape` removed the net-crossing claim and
  // substituted its own generic shot verb, serving "The ball shoots on the
  // right." while the row's attestation read `ballOutcome: none` /
  // `goalCrossed: false`. Deleting the claim (and, when nothing honest remains,
  // the copy) is the contract; never a substitute the row cannot attest.
  if (captionAssertsUnattestedAction(out, ctx)) return "";
  return out;
}

/** The outcome verbs `quietShape` substitutes, and the determiners a mangled
 * substitution leaves in front of them (`players celebrate a shoots`). */
const MANGLED_QUIET_SUBSTITUTE =
  /(?:^|\s)(?:a|an|the|of|to|as|and|but|while)\s+(?:shoots|is\s+saved|is\s+blocked|is\s+cleared|goes\s+wide)\b/i;

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
    // ADAAAA-8356: a ROLE noun is not a proper name. The gate already carried
    // striker/winger/keeper/defender/midfielder; the card headline's WHO slot
    // reads "Goalkeeper holds ball" / "Children stand together" on a window with
    // no readable name, and refusing those cost model copy on honest rows.
    "goalkeeper","goalie","attacker","attackers","forward","forwards","centreback",
    "centerback","centre-back","center-back","fullback","full-back","wingback",
    "wing-back","defenders","midfielders","strikers","wingers","keepers","children",
    "kids","boys","girls","teammate","teammates","squad",
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
      // ADAAAA-8014 (§2): a capitalised FUNCTION word or CODE is not part of a
      // name. Absorbing `No` into `Real Madrid's No` replaced the run with
      // `The side` and left the jersey behind a period — the served row shipped
      // as `The side. 9 shoots on the right`, a sentence break inside a caption.
      if (NAME_STOPWORDS.has(stripDiacritics(next[0])) || CODE_TOKENS.has(stripDiacritics(next[0]))) break;
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
  // ADAAAA-8806 (AC9): the claim rewrite SUBSTITUTES an outcome verb when it
  // deletes a net-crossing claim, so a row whose own attestation recorded no
  // ball outcome can leave this gate with an invented action ("The ball shoots
  // on the right." on job `3740585f` row `6ff00ac9`, `ballOutcome: null` /
  // `goalCrossed: false`). Deleting is the contract; the substitution is not
  // available on a row that measured nothing, so the gated line is refused and
  // the row keeps its headline plus whatever honest sentence it still owes.
  if (captionAssertsUnattestedAction(out, ctx)) return "";
  if (out === input) return input;
  return neverLonger(input, out);
}

/**
 * ADAAAA-8027: re-gate a FALLBACK sentence for the §2 post-condition — the
 * claim, absence, name and score gates only. The quiet trim is NOT re-applied:
 * it is what dropped the predicate in the first place (`A player in the
 * midfield.` for `… dribbles …`), and the caller re-serves the verb from the
 * stored raw sentence, extractively, inside the card's budget.
 */
export function regateServedSentence(text: string, ctx?: CaptionGroundingContext): string {
  const input = text ?? "";
  if (!input.trim()) return input;
  let out = stripInternalTokens(input);
  out = gateGoalClaims(out, ctx);
  out = gateAbsenceClaims(out, ctx);
  out = groundNames(out, ctx?.promptText);
  if (typeof ctx?.promptText === "string") out = gateScores(out, ctx.promptText);
  // ADAAAA-8806: the same unattested-action bar as `groundCaption` — a re-gate
  // must not restore an invented outcome verb either.
  if (captionAssertsUnattestedAction(out, ctx)) return "";
  return out;
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
   * A `near_miss` / `not_goal` verdict is a REFUTATION whatever this flag says
   * (the flag tracks frame evidence support, not the goal verdict).
   */
  goalConfirmed?: string | null;
  /**
   * ADAAAA-8645: the LIVE row's own attestation record. A live highlight stores
   * its goal evidence HERE (`attestationUsed` = what the accept lane measured;
   * `confirmAttestation` = the async Stage-2 dive verdict written after accept),
   * and never in the legacy top-level `corroborated` / `goalConfirmed` fields.
   * Reading only the legacy pair made every live goal read "never corroborated"
   * in the MATCH SUMMARY while its card served CONFIRMED — the banner and the
   * badge contradicting each other on the same page.
   */
  attestationUsed?: {
    scoreBoardChanged?: boolean | null;
    goalCrossed?: boolean | null;
    ballOutcome?: string | null;
    corroborated?: boolean | null;
    goalConfirmed?: string | null;
  } | null;
  /** The Stage-2 dive verdict as it is written on a live highlight row. */
  confirmAttestation?: {
    corroborated?: boolean | null;
    goalConfirmed?: string | null;
  } | null;
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
  ts: number,
  /** ADAAAA-8645: the caller's corroboration decision (the served lane). Defaults
   *  to the row-only rule, which a caller WITHOUT candidate records can use. */
  corroboratedOf: (h: CorroborationWindow) => boolean = isCorroboratedHighlight
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
    if (corroboratedOf(h)) return true;
  }
  return false;
}

/**
 * §3.4: the banner's OWN corroboration rule, in one place — the STORED evidence
 * a live row carries, or the legacy top-level pair a VOD row carries.
 *
 * ADAAAA-8645 (measured on the served build, browser job `f02ec0bf`): the rule
 * was `corroborated === true || goalConfirmed === "confirmed_goal"` on the
 * TOP-LEVEL fields, which the live write path never populates. A live highlight
 * stores its evidence in `attestationUsed` (accept lane) and its Stage-2 verdict
 * in `confirmAttestation`, so on that job the MATCH SUMMARY read
 * "2 accepted goals (0 corroborated)" / "2 of 2 accepted goals are not
 * corroborated by frames" while BOTH cards served `CONFIRMED` (one measured
 * 1-1 -> 2-1, one dive-confirmed). The banner and the badge are two surfaces of
 * one claim, so they must read one authority.
 *
 * Precedence mirrors the served confirmation lane (`deriveConfirmation`), which
 * is what the card's badge is derived from:
 *
 *   1. a stored Stage-2 verdict WINS — `confirmed_goal` certifies (unless it is
 *      explicitly uncorroborated), `near_miss` / `not_goal` refute whatever the
 *      frame flag says (ADAAAA-8647 follow-up, row `f48cdbfa`);
 *   2. otherwise a MEASURED attestation on the row certifies: the accept lane's
 *      own corroboration flag, a measured scoreboard change, the goal line, or a
 *      measured ball-in-net outcome;
 *   3. otherwise the legacy top-level pair (VOD rows, pre-attestation rows);
 *   4. an attestation that measured NOTHING is not corroboration.
 *
 * This is a widening ONLY over evidence the row itself stores, and it is the
 * same rule the badge applies; it never invents a corroboration a row lacks.
 */
export function isCorroboratedHighlight(h: CorroborationWindow | undefined): boolean {
  if (!h) return false;
  const dive = storedDiveVerdict(h);
  if (dive) return dive.corroborated;
  const measured = h.attestationUsed;
  if (measured) {
    if (measured.corroborated === true) return true;
    if (measured.scoreBoardChanged === true) return true;
    if (measured.goalCrossed === true) return true;
    if (/^goal$/i.test((measured.ballOutcome ?? "").trim())) return true;
    // The row carries a measured attestation that certified nothing.
    if (measured.scoreBoardChanged === false || measured.goalCrossed === false) return false;
  }
  if (h.corroborated === true) return true;
  return (h.goalConfirmed ?? "").trim().toLowerCase() === "confirmed_goal";
}

/**
 * The Stage-2 dive verdict a STORED row carries, in whichever shape the writer
 * used: `confirmAttestation` (the async lane's own record) or `attestationUsed`
 * (the accept lane's copy of the same verdict). `null` when no verdict exists —
 * a dropped / passthrough dive produced none and can never refute a goal.
 */
function storedDiveVerdict(
  h: CorroborationWindow
): { goalConfirmed: string; corroborated: boolean } | null {
  for (const attestation of [h.confirmAttestation, h.attestationUsed]) {
    const goalConfirmed = (attestation?.goalConfirmed ?? "").trim().toLowerCase();
    if (goalConfirmed !== "confirmed_goal" && goalConfirmed !== "near_miss" && goalConfirmed !== "not_goal") {
      continue;
    }
    // Same read as `diveVerdictFromAttestation` (services/server): the stored
    // `corroborated` flag tracks FRAME evidence, so it can never certify a goal
    // on its own — only `confirmed_goal` does.
    return {
      goalConfirmed,
      corroborated: goalConfirmed === "confirmed_goal" ? attestation?.corroborated !== false : false,
    };
  }
  return null;
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
  // never corroborated. ADAAAA-8043 (v7 §3.3): the outcome clause is REMOVED —
  // the v6 rewrite substituted `wide`, which asserted a miss nobody measured.
  const netFree = gated.replace(new RegExp(NET_FORM.source, "gi"), "");
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

/**
 * §3.6 / AC3b: the WRITE-seam cap on an identical delivered line per job.
 *
 * ADAAAA-7995 supersedes the v4 value of 2: the served reading was re-measured
 * on five fresh jobs and the cap-2 stored set is what produced BOTH remaining
 * AC1 failures — byte-equal pairs in the rendered ladder (34 rows / 28 distinct,
 * 36/29, 35/29, 30/25, 7/5) and repeated sentences in the stored `summaryLog`
 * (6,7,6,5,2 pairs). The product AC is one beat per row: a beat the model
 * re-narrates is the SAME row of the story, so it is stored once. This is the
 * v3 behaviour (`unduplicatedSummaryLines`) restored, with the v4 machinery
 * (`dedupeStoredLines`, the refusal to lose non-duplicate rows) kept.
 */
export const MAX_LINE_OCCURRENCES = 1;

/**
 * ADAAAA-7995 (AC1): the DISPLAY cap. The page set is a story, so it is capped
 * at ONE row per beat on `captionLineKey` — independently of the write seam,
 * because a stored log written before this fix (or by any pass that lands
 * between fixes) still carries up to the old cap, and a beat the WRITE-seam gate
 * produced (two distinct goal claims collapsed to one non-goal shape) is
 * persisted twice with `text_raw` on both rows.
 */
export const MAX_DISPLAY_LINE_OCCURRENCES = 1;

/**
 * ADAAAA-7995 (AC1/AC2): cap the DISPLAY set on `captionLineKey` ACROSS gated and
 * untouched rows.
 *
 * `dedupeGatedLines` only resolves collisions the READ gate creates. It cannot
 * see collisions the WRITE seam already persisted: two distinct goal claims
 * (`No. 7 strikes the ball into the net …`, `Yamal scores — …`) both gated to the
 * same non-goal beat, stored twice (`text` gated, `text_raw` keeps the original),
 * and at read time neither looks rewritten — so the old cap let both render.
 *
 * Rule: a beat the gate PRODUCED (any row in the set carrying `gateProduced`, set
 * from a stored `text_raw`) is kept once, wherever it appears; every other beat
 * is capped at `max` (1 by default). The FIRST occurrence keeps its place, which
 * is the order the story was told in. Row order is otherwise preserved, so a
 * dropped row never shifts a survivor.
 */
export function dedupeDisplayLines<T extends { text: string; gateProduced?: boolean }>(
  lines: readonly T[],
  max: number = MAX_DISPLAY_LINE_OCCURRENCES
): T[] {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : MAX_DISPLAY_LINE_OCCURRENCES;
  const gateProducedKeys = new Set<string>();
  for (const line of lines ?? []) {
    if (!line.gateProduced) continue;
    const key = captionLineKey(line.text);
    if (key) gateProducedKeys.add(key);
  }
  const seen = new Map<string, number>();
  const kept: T[] = [];
  for (const line of lines ?? []) {
    const key = captionLineKey(line.text);
    if (!key) {
      kept.push(line);
      continue;
    }
    const limitForKey = gateProducedKeys.has(key) ? 1 : limit;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count <= limitForKey) kept.push(line);
  }
  return kept;
}

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
