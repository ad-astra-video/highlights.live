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
  const verdict = (ctx?.verdict ?? "").trim().toLowerCase();
  if (verdict) return verdict === "scoring_play";
  // Legacy row with no stored verdict: fall back to the accepted event type.
  const eventType = (ctx?.eventType ?? "").trim().toUpperCase();
  return eventType === "GOAL" || eventType === "GOL";
}

/**
 * Non-goal rewrites for goal claims (ADAAAA-7933 §3 item 4). Longest first, and
 * every target is the same length or SHORTER than its source — the rewrite may
 * never lengthen a caption.
 */
const GOAL_REWRITES: [RegExp, string][] = [
  [/\bthe\s+net\s+ripples\b/gi, "shot wide"],
  [/\bnet\s+ripples\b/gi, "shot wide"],
  [/\binto\s+the\s+back\s+of\s+the\s+net\b/gi, "wide"],
  [/\bfinds?\s+the\s+back\s+of\s+the\s+net\b/gi, "goes wide"],
  [/\binto\s+the\s+net\b/gi, "wide"],
  [/\bfinds?\s+the\s+net\b/gi, "goes wide"],
  [/\bscores?\s+(?:a|the)\s+goal\b/gi, "shoots"],
  [/\bscores?\b/gi, "shoots"],
  [/\bscored\b/gi, "shot"],
  [/\blevels\s+it\b/gi, "goes wide"],
  [/\blevel\s+it\b/gi, "goes wide"],
  [/\bburied\s+it\b/gi, "shot it"],
  [/\bGOAL\s*!/g, "Shot!"],
  // `goal` only as an isolated event word — never `goal kick` / `goal line`,
  // and never the legitimate non-goal phrasings `shot on goal` / `towards goal`.
  [/(?<!\bon )(?<!\btoward )(?<!\btowards )\bGOAL\b/g, "Shot"],
  [/(?<!\bon )(?<!\btoward )(?<!\btowards )\bgoal\b(?!\s*(?:kick|line|area|mouth|frame|post|net))/gi, "shot"],
];

/** Goal words that survive a rewrite table miss; their clause is dropped. */
const RESIDUAL_GOAL =
  /\b(?:scores?|scored|scoring|goals|net ripples|levels it)\b|(?<!\bon )(?<!\btoward )(?<!\btowards )\bgoal\b/i;

/** Clause separators a caption uses: em/en dash, semicolon, or a comma-space. */
const CLAUSE_SPLIT = /\s+[—–]\s+|;\s+|,\s+/;

/** Drop the clauses that still assert a goal; keep at least the first clause. */
function dropGoalClauses(text: string): string {
  const parts = text.split(CLAUSE_SPLIT);
  if (parts.length <= 1) return text;
  const kept = parts.filter((p) => !RESIDUAL_GOAL.test(p));
  // Never blank the caption: if every clause asserted a goal there is nothing
  // honest left to keep, so fall back to the neutral non-goal rewrite of the
  // first clause rather than emitting nothing.
  return (kept.length > 0 ? kept : [parts[0].replace(RESIDUAL_GOAL, "shot")]).join(" — ");
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
/** A hyphenated technical compound is a term, not a claim (`score-transition`). */
const HYPHEN_COMPOUND = /(?:^|\s)(\S*\b(?:score|goal)s?-\S+)/gi;

/** A net-crossing claim ("the ball enters the net"). A NEGATED form
 * ("the ball does not enter the net") states the opposite and is left alone. */
const NET_CLAIM = /\b(?:the\s+)?ball\s+(?:clearly\s+)?(?:enters?|is\s+in|goes?\s+into|is\s+into)\s+the\s+net\b/gi;

/** Rewrite an un-negated net-crossing claim to a neutral non-goal beat. */
function rewriteNetClaims(text: string): string {
  return text.replace(NET_CLAIM, (m, offset: number) => {
    const before = text.slice(Math.max(0, offset - 24), offset);
    if (/\b(?:not|never|n't|without|no)\s*$/i.test(before)) return m; // negated
    return matchCase("the ball stays out", m);
  });
}

/** Rewrite goal claims to shot/wide beats when the verdict is not a goal. */
export function gateGoalClaims(text: string, ctx?: CaptionGroundingContext): string {
  if (goalAllowed(ctx)) return text;
  // Mask hyphenated technical compounds (`score-transition`) so a word inside a
  // term is never rewritten into nonsense; restored at the end.
  const masked: string[] = [];
  let out = text.replace(HYPHEN_COMPOUND, (m) => {
    masked.push(m);
    return `\u0001${masked.length - 1}\u0001`;
  });
  for (const [re, replacement] of GOAL_REWRITES) {
    out = out.replace(re, (m) => matchCase(replacement, m));
  }
  out = rewriteNetClaims(out);
  if (RESIDUAL_GOAL.test(out)) out = dropGoalClauses(out);
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => masked[Number(i)] ?? "");
  return out === text ? text : tidy(out);
}

/** Score-shaped token (`2-2`, `0 – 1`) that is not an `M:SS` clock. */
const SCORE_TOKEN_SRC = String.raw`(?<![\w:.])\d{1,2}\s*[-–—]\s*\d{1,2}(?![\w:.])`;
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

/** Rewrite/remove score strings that the window's prompt does not corroborate
 * (same shape as the summary ladder's fact gate, ADAAAA-7623). */
function gateScores(text: string, promptText: string): string {
  let out = text;
  for (const claim of findScoreClaims(out)) {
    if (promptHas(promptText, claim)) continue;
    if (!new RegExp(SCORE_TOKEN_SRC).test(out)) break;
    // Drop the score token in place; contextual forms already degrade cleanly
    // because a caption is a single beat ("level at 1-1" -> "level at").
    out = out.replace(new RegExp(SCORE_TOKEN_SRC), "");
  }
  if (out === text) return text;
  return tidy(
    out
      .replace(/\b(?:at|to|the)\s+(?=[,.;:!?]|$)/gi, "")
      .replace(/\bleads?\s+by\s*(?=[,.;:!?]|$)/gi, "leads")
      .replace(/\btrails?\s+by\s*(?=[,.;:!?]|$)/gi, "trails")
  );
}

/** Letters a proper name may contain (accented Latin, apostrophes, hyphens). */
const NAME_WORD = /[\p{Lu}][\p{L}'’.-]*/gu;

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
export function groundNames(text: string, promptText: string): string {
  if (!text) return text;
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
    // Corroborated by the window's prompt => the name is grounded, keep it.
    if (promptHas(prompt, name) || meaningful.some((t) => promptHas(prompt, t))) continue;
    // A bare ALL-CAPS token is an abbreviation/enum, not a person or club name
    // ("the 'GOL' graphic"), and a quoted token is a label being talked about.
    if (tokens.length === 1 && /^[A-Z0-9.'’]+$/.test(name)) continue;
    if (/['"‘“]$/.test(out.slice(0, run.start))) continue;
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
  out = gateGoalClaims(out, ctx);
  const prompt = ctx?.promptText;
  if (typeof prompt === "string") {
    out = groundNames(out, prompt);
    out = gateScores(out, prompt);
  }
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
