// ADAAAA-7623: the SUMMARY LADDER, derived at read time from STORED data only —
// the append-only `job.summaryLog` (ADAAAA-7237) plus the persisted accepted
// highlights. No decide call, no GPU second, no new column: the cost delta is
// structurally ~$0 because nothing is generated, only re-shaped.
//
// Rungs, broadest first (each rung is the drill-down target of the one above):
//   1. match summary  (<= 1500 chars, one rollup over the chapters + the goals)
//   2. chapters       (<= 10 phases / moments, from the summary log + highlights)
//   3. window narratives (chapter -> its summary-log entries)
//   4. frame/decide audit (existing /jobs/:id/detail sections, unchanged)
//
// The FACT GATE is part of the same derivation, because the stored narratives
// carry specifics the evidence never corroborated (a 3 s window citing both
// `0-0` and `0-1`, invented scores like `5-4`, a decreasing goal count):
//   - scoreboard/score strings are SUPPRESSED from the emitted text. Nothing in
//     the payload corroborates a scoreline (no per-window scoreboard read is
//     persisted on the job), so every score string is refused and recorded in
//     `refusedScoreClaims` for audit. The goal timeline is the only score-like
//     fact we emit, and it is index-based (goal #1..#N in time order), so the
//     count is monotonic by construction.
//   - stock template openers ("The action intensifies as…") are stripped by
//     deletion (never rewritten from whole cloth), so the opening states the
//     concrete action the entry actually described.
import type {
  HighlightRecord,
  MatchSummary,
  SummaryChapter,
  SummaryChapterGoal,
  SummaryLadder,
  SummaryLogEntry,
} from "@highlights/events";

/** Hard cap on chapters (acceptance criterion: <= 10). */
export const MAX_CHAPTERS = 10;
/** Hard cap on the match rollup. */
export const MAX_MATCH_SUMMARY_CHARS = 1500;
/** One chapter line stays readable at rung 2. */
const CHAPTER_SUMMARY_MAX_CHARS = 200;
/** Window length used when an entry carries no `windowTs` (VOD cadence). */
const DEFAULT_WINDOW_S = 3;

/** Score-shaped token: `2-2`, `0 – 1`. A HYPHEN/dash form only — `M:SS` clock
 * values (`0:31`, `1:15`) are timestamps, not scorelines. */
const SCORE_TOKEN_SRC = String.raw`(?<![\w:.])\d{1,2}\s*[-–—]\s*\d{1,2}(?![\w:.])`;
/** `M:SS` clock; masked so a clock is never read as a score. */
const CLOCK_SRC = String.raw`\b\d{1,3}:\d{2}\b`;
const CLOCK_MASK = "\u0000";

function maskClocks(text: string): string {
  // Replace the WHOLE clock (digits included) so no digit run survives to pair
  // with a dash; a clock is a timestamp, never a scoreline.
  return (text ?? "").replace(new RegExp(CLOCK_SRC, "g"), CLOCK_MASK);
}

/** Every score-shaped string in `text` (normalized, no spaces). */
export function findScoreClaims(text: string): string[] {
  const re = new RegExp(SCORE_TOKEN_SRC, "g");
  const masked = maskClocks(text);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) out.push(m[0].replace(/\s+/g, ""));
  return out;
}

/** True when the text still carries a score-shaped token. */
export function hasScoreClaim(text: string): boolean {
  return new RegExp(SCORE_TOKEN_SRC).test(maskClocks(text));
}

/**
 * FACT GATE (scores): remove every scoreboard/score string from narrative text.
 * Contextual patterns are rewritten in place so the sentence still parses, then
 * any surviving score token is deleted outright. Pure and deterministic — the
 * same input always yields the same output, so a stored job's ladder is stable
 * across reads.
 */
export function factGateScores(text: string): string {
  let out = text ?? "";
  // "locked in a 0-0 stalemate" -> "locked in a stalemate"
  out = out.replace(
    new RegExp(String.raw`\b(?:an?\s+)?${SCORE_TOKEN_SRC}\s+(stalemate|deadlock)\b`, "gi"),
    "a $1"
  );
  // "scoreboard flashes to 0-1" -> "scoreboard updates"
  out = out.replace(
    new RegExp(
      String.raw`\bscore\s*board\s+(?:shows|reads|flashes\s+to|moves\s+to|displays|switches\s+to)\s+${SCORE_TOKEN_SRC}`,
      "gi"
    ),
    "scoreboard updates"
  );
  // "takes a 2-1 lead" -> "takes the lead"
  out = out.replace(new RegExp(String.raw`(?:an?\s+)?${SCORE_TOKEN_SRC}\s+lead\b`, "gi"), "the lead");
  // "leads 2-1" / "trails 0-2" -> "leads" / "trails"
  out = out.replace(
    new RegExp(String.raw`\b(leads?|trails?)\s+(?:by\s+)?(?:an?\s+)?${SCORE_TOKEN_SRC}`, "gi"),
    (_m, verb: string) => verb
  );
  // "at 1-1" / "to 0-1" -> "level" (only when the preposition dangles on a score)
  out = out.replace(new RegExp(String.raw`\b(?:at|to)\s+${SCORE_TOKEN_SRC}`, "gi"), "level");
  // Anything left: the token itself is not evidence — drop it.
  out = out.replace(new RegExp(SCORE_TOKEN_SRC, "gi"), "");
  return tidy(out);
}

/** Collapse the whitespace/punctuation the score gate leaves behind. */
function tidy(text: string): string {
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
 * Stock narrative openers observed across a 260-window match (66-99 of 260
 * entries). Each pattern captures the concrete content that followed the stock
 * phrase; the rewrite DELETES the boilerplate and keeps that content, so the
 * fact set never changes and nothing is invented.
 */
const STOCK_OPENERS: RegExp[] = [
  // "The action intensifies as …" / "The action unfolds in the midfield as …"
  /^the action\s+(?:intensifies|develops|continues|unfolds|builds|quickens|heats up)\s+(?:rapidly\s+|in\s+(?:the\s+)?[^.,;:]{0,40}?\s+)?(?:as|when)\s+/i,
  // "The tension is palpable as …" / "The pressure mounts as …"
  /^the (?:tension|pressure)\s+(?:is palpable|is mounting|is building|mounts|builds|rises|is high)\s+(?:in\s+[^.,;:]{0,40}?\s+)?(?:as|when)\s+/i,
  // "The pressure mounts as …" (verb-first form, no filler)
  /^the pressure\s+(?:mounts|builds|is building|remains|is on|intensifies)\s+(?:in\s+[^.,;:]{0,40}?\s+)?as\s+/i,
  // "The match is locked in a 0-0 stalemate as …" / "The match is tied 1-1 as …"
  /^the match is locked\s+(?:in\s+)?(?:an?\s+)?(?:\d{1,2}\s*[-–—]\s*\d{1,2}\s+)?(?:stalemate|deadlock)?\s*(?:at\s+\S+\s+)?as\s+/i,
  /^the match is (?:tied|level)\b[^.,;:]{0,30}?\s+as\s+/i,
  // "The match is at a standstill as …" / "The match is currently in a lull as …"
  /^the match\s+(?:is|remains|stays)\s+(?:currently\s+)?(?:at\s+a\s+|in\s+a\s+)?(?:standstill|lull|stoppage|stalemate)\s+(?:as|while)\s+/i,
  /^the match is (?:heating up|coming alive|hotting up)\s+as\s+/i,
  // "The match between Real Madrid and FC Barcelona is heating up as …"
  /^the match between\b[^.!?]{0,90}?\b(?:as|while)\s+/i,
  /^the scene opens\s+(?:on|with)\s+/i,
  /^the atmosphere is building\s+as\s+/i,
  /^the video\s+(?:begins|starts|opens)\s+(?:with|on|by)\s+/i,
  /^the (?:sequence|clip|footage)\s+(?:begins|starts|opens|shows)\s+(?:with|on|by)\s+/i,
];

/** True when the text opens with a stock template phrase. */
export function hasStockOpener(text: string): boolean {
  const t = (text ?? "").trim();
  if (STOCK_OPENERS.some((re) => re.test(t))) return true;
  // The stored narrative also opens on short, content-free frame-setting
  // sentences ("The play moves into the final third.") that are the same
  // template habit without the "as …" clause. Those count as openers too, so
  // the measured template share cannot be flattered by a narrow pattern list.
  return stripFillerSentence(t) !== t;
}

/**
 * A short opening sentence that sets the frame without describing any concrete
 * action ("The action intensifies in the final minutes.", "The play develops
 * toward the goal."). Anything naming an actor or the ball is real content and
 * is kept — only the empty lead sentence is dropped.
 */
const GENERIC_LEAD = /^the (?:action|tension|pressure|pace|play|game|match|atmosphere|contest|tempo)\b/i;
const CONCRETE =
  /\b(ball|players?|strik|keeper|goalkeeper|defend|midfield|attacker|winger|referee|shot|strike|header|volley|pass|cross|corner|tackle|dribbl|save|net|post|bar|whistle|coach|celebrat)\b/i;
const FILLER_SENTENCE_MAX_CHARS = 100;

function stripFillerSentence(text: string): string {
  let out = (text ?? "").trim();
  for (let pass = 0; pass < 2; pass += 1) {
    const m = out.match(/^([^.!?]{1,120}[.!?])\s+/);
    if (!m) break;
    const sentence = m[1];
    if (sentence.length > FILLER_SENTENCE_MAX_CHARS) break;
    if (!GENERIC_LEAD.test(sentence) || CONCRETE.test(sentence)) break;
    out = out.slice(m[0].length).trim();
  }
  return out;
}

/**
 * Strip a stock opener by deletion. Returns the concrete tail with a capitalized
 * first letter, or "" when the text does not open with a stock phrase (or the
 * phrase is all there was) — callers keep the original in that case.
 */
export function stripStockOpener(text: string): string {
  let out = (text ?? "").trim();
  let changed = false;
  // Repeat: a stock opener can expose ANOTHER stock opener underneath it
  // ("The match is locked in a 0-0 stalemate as the action intensifies in the
  // final minutes. A player …"), so one pass is not enough.
  for (let pass = 0; pass < 3; pass += 1) {
    let matched = false;
    for (const re of STOCK_OPENERS) {
      const m = re.exec(out);
      if (!m) continue;
      out = out.slice(m[0].length).trim();
      changed = true;
      matched = true;
      break;
    }
    if (!matched) {
      const afterFiller = stripFillerSentence(out);
      if (afterFiller && afterFiller !== out) {
        out = afterFiller;
        changed = true;
        continue;
      }
      break;
    }
    if (!out) break;
  }
  if (!changed || !out) return "";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** De-template + fact-gate one narrative entry. */
export function gateNarrative(text: string): string {
  const stripped = stripStockOpener(text);
  return factGateScores(stripped || (text ?? "").trim());
}

/** `M:SS` clock for video-relative seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Rule-path fallback lines (`[near_miss] SPORTING_EVENT — 1 track(s); …`). */
const RULE_LINE = /^\[(?:not_highlight|near_miss|big_play|scoring_play)\]/i;

interface NormalizedEntry {
  seq: number;
  windowTs: number;
  text: string;
  clean: string;
  kind: "build-up" | "lull" | "phase";
}

const ATTACK_WORDS =
  /\b(attack|press|shot|strike|cross|counter|final third|chance|run|break|dribbl|pass|surge|push|sprint|corner|free kick|header|volley)\b/i;
const LULL_WORDS =
  /\b(ceremony|line ?up|lined? ?up|starting eleven|graphic|anthem|crowd|celebrat|half[- ]time|interval|waiting|standstill|lull|stadium|warm[- ]?up|replay|close[- ]up|stands|tunnel|walk[- ]?out|no (?:active|live) (?:play|action)|no ball|posing|pre-match|presentation|players? (?:gather|regroup)|sideline|kick[- ]off preparations)\b/i;

function classifyEntry(text: string): "build-up" | "lull" | "phase" {
  // Classify on the OPENING sentence: the ladder renders that sentence as the
  // chapter lead, so a long paragraph that ends in an attack must not label a
  // chapter that opens on a lull.
  const first = (text ?? "").split(/(?<=[.!?])\s+/)[0] ?? "";
  const t = first.length > 240 ? first.slice(0, 240) : first;
  if (LULL_WORDS.test(t) && !ATTACK_WORDS.test(t)) return "lull";
  if (ATTACK_WORDS.test(t)) return "build-up";
  return "phase";
}

/** Normalize the log: ordered, `windowTs` filled forward, narrative gated once. */
function normalizeLog(log: SummaryLogEntry[]): NormalizedEntry[] {
  const entries = [...(log ?? [])].sort((a, b) => a.seq - b.seq);
  let prev = -DEFAULT_WINDOW_S;
  return entries.map((e) => {
    const windowTs = typeof e.windowTs === "number" && Number.isFinite(e.windowTs) ? e.windowTs : prev + DEFAULT_WINDOW_S;
    prev = windowTs;
    const text = (e.text ?? "").trim();
    return { seq: e.seq, windowTs, text, clean: gateNarrative(text), kind: classifyEntry(text) };
  });
}

/** Accepted GOAL highlights, in time order, with a monotonic 1-based index. */
export function goalTimelineFrom(highlights: HighlightRecord[]): Array<SummaryChapterGoal & { highlightId: string }> {
  return (highlights ?? [])
    .filter((h) => (h as any).eventType === "GOAL" && (h as any).status === "accepted")
    .slice()
    .sort((a, b) => Number((a as any).start ?? 0) - Number((b as any).start ?? 0))
    .map((h, i) => {
      const anyH = h as any;
      return {
        index: i + 1,
        // Round to 0.1 s so stored float noise (31.300000000000004) never leaks
        // into the rendered ladder.
        ts: Math.round(Number(anyH.start ?? 0) * 10) / 10,
        // Corroborated only by a persisted measured attestation; a bare Stage-1
        // accept with no confirm record stays `verified: false`.
        verified: anyH.corroborated === true || anyH.goalConfirmed === "confirmed_goal",
        highlightId: String(anyH.id ?? ""),
      };
    });
}

interface Run {
  kind: "build-up" | "lull" | "phase";
  entries: NormalizedEntry[];
}

function spanOf(run: Run): number {
  return run.entries[run.entries.length - 1].windowTs - run.entries[0].windowTs;
}

/** Contiguous same-kind runs over the log. */
function buildRuns(entries: NormalizedEntry[]): Run[] {
  const runs: Run[] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last.kind === e.kind) last.entries.push(e);
    else runs.push({ kind: e.kind, entries: [e] });
  }
  return runs;
}

/**
 * Merge adjacent runs until `<= MAX_CHAPTERS`, always choosing the cheapest
 * merge (same-kind first, then the shortest combined span). Deterministic, so
 * the same stored log always yields the same chapters.
 */
function mergeRuns(runs: Run[]): Run[] {
  const out = runs.slice();
  while (out.length > MAX_CHAPTERS) {
    let bestCost = Number.POSITIVE_INFINITY;
    let bestIdx = 0;
    for (let i = 0; i < out.length - 1; i += 1) {
      const a = out[i];
      const b = out[i + 1];
      const cost = (a.kind === b.kind ? 0 : 1e6) + spanOf(a) + spanOf(b);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    const a = out[bestIdx];
    const b = out[bestIdx + 1];
    out.splice(bestIdx, 2, {
      kind: a.kind === b.kind ? a.kind : dominantKind([...a.entries, ...b.entries]),
      entries: [...a.entries, ...b.entries],
    });
  }
  return out;
}

function dominantKind(entries: NormalizedEntry[]): "build-up" | "lull" | "phase" {
  const tally = { "build-up": 0, lull: 0, phase: 0 } as Record<string, number>;
  for (const e of entries) tally[e.kind] += 1;
  return (Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0] as "build-up" | "lull" | "phase") ?? "phase";
}

/** Trim to a sentence-ish excerpt at a word boundary. */
function excerpt(text: string, max = CHAPTER_SUMMARY_MAX_CHARS): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max * 0.6 ? space : max).trim()}…`;
}

/** Representative narrative for a chapter: the first entry that actually
 * belongs to the chapter's kind (so a "Build-up" chapter does not open on a
 * lull line), or the entry nearest its first goal for a goal cluster. */
function leadingNarrative(
  entries: NormalizedEntry[],
  kind: SummaryChapter["kind"],
  firstGoalTs?: number
): string {
  const usable = (e: NormalizedEntry | undefined): boolean =>
    !!e && !!e.clean && !RULE_LINE.test(e.clean);
  if (kind === "goal-cluster" && firstGoalTs != null) {
    const near = entries[nearestEntryIndex(entries, firstGoalTs)];
    if (usable(near)) return near.clean;
  }
  if (kind === "build-up" || kind === "lull" || kind === "phase") {
    const match = entries.find((e) => e.kind === kind && usable(e));
    if (match) return match.clean;
  }
  for (const e of entries) {
    if (usable(e)) return e.clean;
  }
  return entries.length > 0 ? entries[0].clean : "";
}

function chapterKindOf(entries: NormalizedEntry[], goals: SummaryChapterGoal[]): SummaryChapter["kind"] {
  const span = entries.length > 0 ? entries[entries.length - 1].windowTs - entries[0].windowTs : 0;
  // A genuine goal cluster: >= 2 accepted goals inside a <= 2 min stretch.
  // A single goal keeps the chapter's content kind — the goal is an EVENT in the
  // chapter (`goalCount`/`goals`), not the chapter's whole identity.
  if (goals.length >= 2 && span <= 120) return "goal-cluster";
  return dominantKind(entries);
}

function chapterTitle(kind: SummaryChapter["kind"], startS: number, endS: number, goals: SummaryChapterGoal[]): string {
  const clock = `${formatClock(startS)}–${formatClock(endS)}`;
  switch (kind) {
    case "goal-cluster":
      return `${goals.length === 1 ? "Goal" : `Goal cluster (${goals.length})`} · ${clock}`;
    case "build-up":
      return `Build-up · ${clock}`;
    case "lull":
      return `Lull · ${clock}`;
    default:
      return `Phase · ${clock}`;
  }
}

/** Index of the log entry whose window CONTAINS `ts`, else the nearest window. */
function entryIndexForTs(entries: NormalizedEntry[], ts: number): number {
  for (let i = 0; i < entries.length; i += 1) {
    const start = entries[i].windowTs;
    const end = i + 1 < entries.length ? entries[i + 1].windowTs : start + DEFAULT_WINDOW_S;
    if (ts >= start && ts < end) return i;
  }
  return nearestEntryIndex(entries, ts);
}

/** Nearest log entry (by window start) to a goal timestamp. */
function nearestEntryIndex(entries: NormalizedEntry[], ts: number): number {
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < entries.length; i += 1) {
    const delta = Math.abs(entries[i].windowTs - ts);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/** Compose the match rollup, then enforce the 1500-char cap by dropping chapter
 * bullets from the END (the header and the goal timeline always survive). */
function composeMatchSummary(
  gameHint: string,
  chapters: SummaryChapter[],
  goals: SummaryChapterGoal[],
  logEntries: number
): string {
  const duration = chapters.length > 0 ? chapters[chapters.length - 1].endS : 0;
  const verified = goals.filter((g) => g.verified).length;
  const header = `${gameHint || "Video"} · ${formatClock(duration)} · ${chapters.length} chapter${chapters.length === 1 ? "" : "s"} · ${goals.length} accepted goal${goals.length === 1 ? "" : "s"} (${verified} corroborated)`;
  const chapterBullet = (c: SummaryChapter, chars: number): string => `- ${c.title}: ${excerpt(c.summary, chars)}`;
  const goalLine =
    goals.length === 0
      ? "Goals: none accepted."
      : `Goals in order: ${goals
          .map((g) => `#${g.index} ${formatClock(g.ts)}${g.verified ? "" : " (never corroborated)"}`)
          .join(", ")}`;
  const footer = `Derived from ${logEntries} stored window narratives + ${goals.length} accepted highlights; no extra inference.`;

  const build = (keep: number, excerptChars: number): string =>
    [header, ...chapters.slice(0, keep).map((c) => chapterBullet(c, excerptChars)), goalLine, footer].join("\n");

  // Prefer covering EVERY chapter: shrink the per-chapter excerpt first, then
  // drop trailing bullets only if even a short excerpt cannot fit.
  for (const excerptChars of [80, 56, 44, 32]) {
    const text = build(chapters.length, excerptChars);
    if (text.length <= MAX_MATCH_SUMMARY_CHARS) return text;
  }
  let keep = chapters.length;
  let text = build(keep, 32);
  while (text.length > MAX_MATCH_SUMMARY_CHARS && keep > 0) {
    keep -= 1;
    text = build(keep, 32);
  }
  if (text.length > MAX_MATCH_SUMMARY_CHARS) text = text.slice(0, MAX_MATCH_SUMMARY_CHARS);
  return text;
}

/**
 * Derive the whole ladder from stored data. Pure: same stored log + highlights
 * always produce the same ladder, so the payload is reproducible without a
 * decide call (and without touching the DB).
 */
export function buildSummaryLadder(input: {
  summaryLog?: SummaryLogEntry[];
  highlights?: HighlightRecord[];
  gameHint?: string;
}): SummaryLadder {
  const entries = normalizeLog(input.summaryLog ?? []);
  const accepted = (input.highlights ?? []).filter((h) => (h as any).status === "accepted");
  const timeline = goalTimelineFrom(input.highlights ?? []);

  // Hard-gate EVERY narrative once; the audit list is what the gate removed.
  const refused = new Set<string>();
  for (const e of entries) {
    for (const claim of findScoreClaims(e.text)) refused.add(claim);
  }

  if (entries.length === 0) {
    const goals = timeline.map(({ highlightId: _id, ...g }) => g);
    const text = composeMatchSummary(input.gameHint ?? "", [], goals, 0);
    return {
      chapters: [],
      matchSummary: {
        text,
        charCount: text.length,
        chapterCount: 0,
        goalCount: goals.length,
        verifiedGoalCount: goals.filter((g) => g.verified).length,
        goalTimeline: goals,
        refusedScoreClaims: [...refused].sort(),
      },
      derivedFrom: { summaryLogEntries: 0, acceptedHighlights: accepted.length },
    };
  }

  // Goal -> chapter attribution: the window that CONTAINS the goal timestamp,
  // so a chapter never claims a goal that falls outside its own [startS, endS).
  const goalEntryIdx = timeline.map((g) => entryIndexForTs(entries, g.ts));
  const runs = mergeRuns(buildRuns(entries));

  let cursor = 0;
  const chapters: SummaryChapter[] = runs.map((run, index) => {
    const from = cursor;
    const to = cursor + run.entries.length - 1;
    cursor = to + 1;
    const goals = timeline
      .filter((_g, gi) => goalEntryIdx[gi] >= from && goalEntryIdx[gi] <= to)
      .map(({ highlightId: _id, ...g }) => g);
    const startS = run.entries[0].windowTs;
    const endS = run.entries[run.entries.length - 1].windowTs + DEFAULT_WINDOW_S;
    const kind = chapterKindOf(run.entries, goals);
    const lead = leadingNarrative(run.entries, kind, goals[0]?.ts);
    const goalNote =
      goals.length === 0
        ? ""
        : ` ${goals.length} accepted goal${goals.length === 1 ? "" : "s"} (${goals.filter((g) => g.verified).length} corroborated).`;
    return {
      index,
      kind,
      title: chapterTitle(kind, startS, endS, goals),
      startS,
      endS,
      summary: excerpt(`${lead}${goalNote}`),
      goalCount: goals.length,
      goals,
      seqFrom: run.entries[0].seq,
      seqTo: run.entries[run.entries.length - 1].seq,
      entries: run.entries.map((e) => ({ seq: e.seq, windowTs: e.windowTs, text: e.clean })),
    };
  });

  // Goal indices must be monotonic across the ladder; sort defensively by ts.
  const goals = timeline
    .map(({ highlightId: _id, ...g }) => g)
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map((g, i) => ({ ...g, index: i + 1 }));

  const text = composeMatchSummary(input.gameHint ?? "", chapters, goals, entries.length);
  const matchSummary: MatchSummary = {
    text,
    charCount: text.length,
    chapterCount: chapters.length,
    goalCount: goals.length,
    verifiedGoalCount: goals.filter((g) => g.verified).length,
    goalTimeline: goals,
    refusedScoreClaims: [...refused].sort(),
  };

  return {
    chapters,
    matchSummary,
    derivedFrom: { summaryLogEntries: entries.length, acceptedHighlights: accepted.length },
  };
}
