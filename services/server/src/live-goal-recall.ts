/**
 * ADAAAA-7988: LIVE goal recall from a celebration/reaction window.
 *
 * The defect (CEO live share 2026-11-04 13:14Z, job `6d48c786`): the media node
 * samples JPEGs at 1 fps (`WebRtcIngestSession`, `sampleFps ?? 1`), so a judged
 * ~3 s window carries 1-3 frames and the sub-second ball-crossing instant
 * usually falls BETWEEN samples. The decide model saw both celebrations and
 * described them correctly ("The player is standing with arms raised", "players
 * are reacting to a previous event") but rejected them, because the accept
 * contract wants the net-crossing instant inside the judged window. All 273
 * decide notes read `outcome=not_highlight`, zero clips.
 *
 * This module is the live-only, deterministic recall floor for that class:
 *
 *   a window whose OWN description shows a celebration / reaction AND that
 *   follows an attack-or-shot window (within {@link LIVE_GOAL_RECALL_LEAD_S})
 *   is a goal CANDIDATE even though no frame shows the ball crossing the line.
 *
 * What it deliberately does NOT do: it never publishes a GOAL by itself. The
 * promotion is shaped as a goal-shaped, non-accept `near_miss` that still cites
 * the prior window's evidence, so the existing Stage-2 confirm dive
 * (`shouldRunConfirm` -> `isGateRejectedBareGoal`) adjudicates it against the
 * frames. A corroborated dive upgrades it to `scoring_play` (the delivered
 * highlight); anything else leaves the `near_miss` on the decide note. That
 * keeps the ADAAAA-7162/7185 corroboration rule intact - a celebration alone
 * can never put a false GOAL on the board.
 *
 * Live-only by construction: the analyzer feeds this ledger only on the
 * live/default pass (`liveObserveLoop` with `decideWindowN` unset). The VOD
 * goal-precision gate is untouched.
 */

import type { DecisionResult } from "./analyzer";

/** How the window's own description reads. */
export type LiveWindowKind = "attack" | "celebration" | "neutral";

/** ADAAAA-7988: how far (seconds) an attack/shot window may sit behind a
 * celebration window and still be cited as its cause. A celebration starts
 * within a few seconds of the goal; 30 s covers the decide lag + a slow
 * reaction without reaching back into a previous passage of play. */
export const LIVE_GOAL_RECALL_LEAD_S = 30;

/** ADAAAA-7988: bounded quote carried in the decision reason + the evidence
 * field (cost bound: the reason rides the decide note, not the prompt). */
export const LIVE_GOAL_RECALL_QUOTE_MAX = 140;

/** ADAAAA-7988: ledger bound. A live share runs ~20 windows/minute, and only
 * the recent attack windows are ever cited, so the ledger keeps the tail. */
export const LIVE_GOAL_RECALL_LEDGER_MAX = 96;

/** ADAAAA-7988: markers that make a window's description a celebration /
 * reaction. These are the phrases the 13:14Z notes actually carried, plus the
 * vocabulary the decide prompt itself asks the model to describe ("players with
 * arms raised, a group pile/team huddle, bench leaping up to celebrate"). */
const CELEBRATION_PATTERNS: readonly RegExp[] = [
  /\bcelebrat(?:e|es|ed|ing|ion)\b/i,
  /\barms?\s+(?:are\s+|is\s+|were\s+|being\s+)?raised\b/i,
  /\barms?\s+in\s+the\s+air\b/i,
  /\breacting\s+to\s+(?:a\s+)?previous\s+event\b/i,
  /\breact(?:s|ing|ion)\b/i,
  /\bstatic\s+(?:celebration|reaction)\b/i,
  /\bjubil(?:ant|ation)\b/i,
  /\bfist\s*pump\b/i,
  /\bgroup\s+hug\b|\bteam\s+huddle\b|\bhuddling\b|\bhugging\b/i,
  /\bplayers?\s+(?:are\s+)?(?:leaping|jumping)\b/i,
  /\bbench\b[^.]{0,40}\b(?:leap|jump|celebrat)/i,
];

/** ADAAAA-7988: markers that make a window's description an attack / shot - the
 * "a goal could have happened here" half of the pair. Kept to phrasing a shot,
 * a keeper intervention or a delivery towards the goal, never general play. */
const ATTACK_PATTERNS: readonly RegExp[] = [
  /\bshot\b|\bshooting\b|\bshots\b/i,
  /\bstrikes?\s+the\s+ball\b|\bstrike\b/i,
  /\bkeepers?\b|\bgoalkeepers?\b/i,
  /\bsaved?\b|\bsaves?\b|\bsave\b/i,
  /\bthrough\s+on\s+goal\b/i,
  /\bone[- ]on[- ]one\b/i,
  /\bbreakaway\b|\bcounter[- ]attack\b/i,
  /\bheader\b|\bheads?\s+the\s+ball\b/i,
  /\bfree\s*kick\b|\bpenalty\b|\bcorner\b/i,
  /\bcross(?:ed|es|ing)?\b[^.]{0,30}\b(?:box|goal)\b/i,
  /\bball\s+(?:is\s+)?(?:moving|headed|travel\w*|played)\s+(?:towards?|toward|at)\s+(?:the\s+)?goal\b/i,
  /\bshoots?\b|\bshot\s+on\s+(?:goal|target)\b/i,
];

/** ADAAAA-7988: flatten a description to one line (the note text is multi-line
 * model prose) so the quote that lands in a reason string stays readable. */
export function liveWindowQuote(text: unknown, cap = LIVE_GOAL_RECALL_QUOTE_MAX): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= cap ? flat : flat.slice(0, cap - 1).trimEnd() + "…";
}

/**
 * ADAAAA-7988: classify one window's own description.
 *
 * Celebration wins over attack: the 13:14Z celebration notes also mention "no
 * ball movement into the net", and a window that both describes a shot AND a
 * reaction is still the reaction window (that is exactly the recall case).
 */
export function classifyLiveWindowText(text: string | undefined | null): LiveWindowKind {
  if (typeof text !== "string" || !text.trim()) return "neutral";
  if (CELEBRATION_PATTERNS.some((re) => re.test(text))) return "celebration";
  if (ATTACK_PATTERNS.some((re) => re.test(text))) return "attack";
  return "neutral";
}

/** One decided window as the ledger remembers it. Measured inputs only: the
 * window's own content instant and its own description. */
export interface LiveGoalRecallWindow {
  /** Content instant of the judged window (seconds from stream start). */
  centerTs: number;
  kind: LiveWindowKind;
  /** Bounded quote of the window's own description (evidence). */
  quote: string;
}

/** The citation a promoted window carries: what the PRIOR window showed. */
export interface LiveGoalRecall {
  /** Content instant of the promoted (celebration/reaction) window. */
  centerTs: number;
  /** Content instant of the attack/shot window the citation names. */
  attackTs: number;
  /** Seconds between the cited attack window and this one. */
  leadS: number;
  /** Bounded quote of the attack window's own description. */
  attackQuote: string;
  /** Bounded quote of this window's celebration/reaction description. */
  windowQuote: string;
}

/**
 * ADAAAA-7988: the bounded per-run ledger of decided windows.
 *
 * Content-ordered (a re-produced older window never overwrites a newer note) and
 * capped, so a 3 h share cannot grow it. Pure bookkeeping: no inference, no
 * I/O - the caller feeds it the verdict it already computed.
 */
export class LiveWindowLedger {
  private windows: LiveGoalRecallWindow[] = [];

  /** Record one decided window. Returns the stored note, or null when the
   * timestamp is unusable. A repeat of the same content instant keeps the FIRST
   * note (the ledger is content-ordered; a re-decided window is the same
   * evidence). */
  record(centerTs: number, text: string | undefined | null): LiveGoalRecallWindow | null {
    if (!Number.isFinite(centerTs)) return null;
    const kind = classifyLiveWindowText(text);
    const quote = liveWindowQuote(text);
    const existing = this.windows.find((w) => w.centerTs === centerTs);
    if (existing) {
      // A re-decided window may carry a richer description (a recall re-decide).
      // Keep the classification stable, upgrade the quote when the new one says
      // more, so the citation names the best available evidence.
      if (quote.length > existing.quote.length) existing.quote = quote;
      return existing;
    }
    const note: LiveGoalRecallWindow = { centerTs, kind, quote };
    this.windows.push(note);
    this.windows.sort((a, b) => a.centerTs - b.centerTs);
    if (this.windows.length > LIVE_GOAL_RECALL_LEDGER_MAX) {
      this.windows.splice(0, this.windows.length - LIVE_GOAL_RECALL_LEDGER_MAX);
    }
    return note;
  }

  /** The window note recorded for `centerTs` (or undefined). */
  windowAt(centerTs: number): LiveGoalRecallWindow | undefined {
    return this.windows.find((w) => w.centerTs === centerTs);
  }

  /** Read-only snapshot, oldest -> newest (evidence for the run record). */
  snapshot(): readonly LiveGoalRecallWindow[] {
    return this.windows;
  }

  /**
   * ADAAAA-7988: the recall citation for the window at `centerTs`, or null.
   *
   * Fires only when ALL of these hold:
   *   1. this window's own description reads as a celebration / reaction;
   *   2. the nearest window behind it that is within `lead` seconds reads as an
   *      attack / shot (an intervening celebration is NOT skipped - two
   *      celebration windows in a row are one reaction, so the second one gets
   *      no fresh citation);
   *   3. no GOAL was already accepted between the cited attack window and this
   *      one (`acceptedGoalTs`), so the reaction cannot re-open a goal that is
   *      already on the board.
   */
  recallFor(
    centerTs: number,
    opts: { lead?: number; acceptedGoalTs?: readonly number[] } = {}
  ): LiveGoalRecall | null {
    if (!Number.isFinite(centerTs)) return null;
    const lead = opts.lead ?? LIVE_GOAL_RECALL_LEAD_S;
    const self = this.windowAt(centerTs);
    if (!self || self.kind !== "celebration") return null;
    // Nearest prior window inside the lead, whatever its class.
    let nearest: LiveGoalRecallWindow | null = null;
    for (const w of this.windows) {
      if (w.centerTs >= centerTs) break;
      if (centerTs - w.centerTs <= lead) nearest = w;
    }
    if (!nearest || nearest.kind !== "attack") return null;
    const attack = nearest;
    const already = (opts.acceptedGoalTs ?? []).some(
      (ts) => Number.isFinite(ts) && ts >= attack.centerTs && ts <= centerTs
    );
    if (already) return null;
    return {
      centerTs,
      attackTs: attack.centerTs,
      leadS: Math.max(0, Math.round((centerTs - attack.centerTs) * 10) / 10),
      attackQuote: attack.quote,
      windowQuote: self.quote,
    };
  }
}

/** ADAAAA-7988: whether a verdict is a candidate for promotion at all. Only a
 * window the decide pass REJECTED is promoted - an existing accept keeps its own
 * evidence, and a requested near-miss/big-play outcome is already a decision. */
export function isLiveGoalRecallCandidate(decision: DecisionResult | null | undefined): boolean {
  if (!decision) return false;
  if (decision.isHighlight) return false;
  return decision.outcome === undefined || decision.outcome === "not_highlight";
}

/** ADAAAA-7988: the reason line a promoted window carries (cited evidence). */
export function liveGoalRecallNote(recall: LiveGoalRecall): string {
  return (
    `goal-recall: this window's description is a celebration/reaction ` +
    `("${recall.windowQuote}") and it follows the attack/shot window @${recall.attackTs}s ` +
    `(${recall.leadS}s earlier, whose own read was "${recall.attackQuote}"). ` +
    `The goal instant can fall between 1 fps media-node samples, so the net-crossing ` +
    `frame is not required for the candidate; the Stage-2 dive adjudicates it.`
  );
}

/**
 * ADAAAA-7988: shape a rejected celebration window into a goal-shaped
 * `near_miss` that cites the prior attack window.
 *
 * `eventType: "GOAL"` + `isHighlight: false` is the ADAAAA-7357
 * delayed-corroboration shape, so `shouldRunConfirm` fires the Stage-2 dive
 * (`isGateRejectedBareGoal`) and the corroboration rule still owns the final
 * GOAL. `outcome: "near_miss"` is the floor the issue asks for: even when the
 * dive cannot corroborate, the decide note records a goal candidate with the
 * cited evidence instead of `not_highlight`.
 */
export function applyLiveGoalRecall(decision: DecisionResult, recall: LiveGoalRecall): DecisionResult {
  const prior = Number(decision.score);
  const score = Number.isFinite(prior) && prior > 55 ? prior : 55;
  const note = liveGoalRecallNote(recall);
  return {
    ...decision,
    isHighlight: false,
    outcome: "near_miss",
    nearMiss: true,
    eventType: "GOAL",
    score,
    reason: decision.reason ? `${decision.reason} | ${note}` : note,
    goalRecall: recall,
  } as DecisionResult;
}
