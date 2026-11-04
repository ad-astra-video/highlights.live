// Posting helpers for a highlight (ADAAAA-7622): the job-detail card had no
// posting path at all — it rendered the clip, badges and review controls, but
// no download, no copy-link and no caption. These are the pure pieces behind
// the card actions + the multi-select batch export, kept out of the React
// component so they are unit-testable without a DOM.
import type { JobDetailHighlight, SummaryLogEntry } from "./jobDetail";
import {
  gateGoalClaims,
  groundCaption,
  humanEventLabel as sharedHumanEventLabel,
  stripInternalTokens,
  type CaptionGroundingContext,
} from "@highlights/events";

/**
 * Absolute, public URL for a highlight clip.
 *
 * `clipUri` is a web path like `/clips/<uuid>.mp4` — the server serves clips
 * without auth, so the URL a user copies must be the plain public one: no
 * token, no signed query. Anything already absolute is passed through.
 */
export function clipUrl(clipUri: string, origin?: string): string {
  if (!clipUri) return "";
  if (/^https?:\/\//i.test(clipUri)) return clipUri;
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  if (!base) return clipUri;
  const path = clipUri.startsWith("/") ? clipUri : `/${clipUri}`;
  return `${base.replace(/\/+$/, "")}${path}`;
}

// --- ADAAAA-7896: export URLs + mark-on-copy ------------------------------
// The playback URL (`clipUri`) is public and never marks anything — it is the
// `<video>` src, so a page view must not count as "left the app". The server
// mints a DISTINCT export URL (`exportUri`, clip path + a per-highlight token)
// and the download anchor / copy payload / batch fetches use it, so the server
// can stamp the highlight the first time its clip is actually exported.

/**
 * The URL a download / copy / batch fetch must use: the server-minted export
 * URL when the projection carries one, else the plain clip URL (older servers /
 * records with no clip). The webapp never mints a token itself.
 */
export function exportUrl(
  h: Pick<JobDetailHighlight, "exportUri" | "clipUri">,
  origin?: string
): string {
  return clipUrl(h.exportUri || h.clipUri, origin);
}

export type ExportVia = "download" | "copy_link" | "batch_zip" | "copy_urls";

/**
 * The single-highlight export-intent call (R3): marks ONE clip with `via`.
 * `post` is injected so this path is testable without a network (the component
 * passes `api`).
 */
export function markExportIntent(
  post: (path: string, body: unknown) => Promise<unknown>,
  id: string,
  via: ExportVia
): Promise<unknown> {
  return post(`/highlights/${id}/export-intent`, { via });
}

/** The bounded batch export-intent call (R3): marks up to 50 clips in ONE
 * request (`copy_urls` for "Copy URLs", `batch_zip` for the zip export). */
export const EXPORT_INTENT_MAX_IDS = 50;

export function markExportIntentBatch(
  post: (path: string, body: unknown) => Promise<unknown>,
  ids: string[],
  via: ExportVia
): Promise<unknown> | null {
  const bounded = ids.slice(0, EXPORT_INTENT_MAX_IDS);
  if (bounded.length === 0) return null;
  return post("/highlights/export-intent", { ids: bounded, via });
}

/**
 * Copy a highlight's export link and mark it as exported on clipboard SUCCESS
 * only (R3): a failed copy shares nothing, so it must not lock the clip. The
 * intent POST is best-effort — the copy already succeeded, so a failed mark
 * must never turn a working "Copied" into "Copy failed".
 *
 * Takes its dependencies so the flow is testable without a DOM or network.
 */
export async function copyExportLink(
  h: { id: string; exportUri?: string; clipUri: string },
  deps: {
    copy?: (text: string) => Promise<boolean>;
    mark: (id: string) => Promise<unknown>;
  }
): Promise<boolean> {
  const url = exportUrl(h);
  if (!url) return false;
  const ok = await (deps.copy ?? copyText)(url);
  if (ok) {
    try {
      await deps.mark(h.id);
    } catch {
      /* the clipboard write is the user-visible result; marking is audited */
    }
  }
  return ok;
}

export function highlightInstant(h: Pick<JobDetailHighlight, "localizedTs" | "start">): number {
  return typeof h.localizedTs === "number" ? h.localizedTs : h.start;
}

/** The narrative the seed reads, with WHERE it came from (the summary log or
 * the highlight's own decide `reason`). The source decides whether names can be
 * re-checked: a summary-log line is already server-grounded (ADAAAA-7948),
 * while a raw decide `reason` is not. */
function selectNarrative(
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason">,
  log?: SummaryLogEntry[]
): { text: string; fromLog: boolean } {
  const entries = (log ?? []).filter(
    (e): e is SummaryLogEntry & { windowTs: number } => typeof e.windowTs === "number" && !!e.text?.trim()
  );
  if (entries.length === 0) return { text: (h.reason ?? "").trim(), fromLog: false };
  const anchor = highlightInstant(h);
  let best = entries[0];
  let bestDistance = Math.abs(best.windowTs - anchor);
  for (const e of entries.slice(1)) {
    const distance = Math.abs(e.windowTs - anchor);
    if (distance < bestDistance || (distance === bestDistance && e.seq > best.seq)) {
      best = e;
      bestDistance = distance;
    }
  }
  return { text: best.text.trim(), fromLog: true };
}

/** The narrative line for a highlight from the job's append-only summary log.
 *
 * Each summary-log entry covers one observe window (`windowTs` = seconds into
 * the stream), which is what the reviewer asked to seed captions from. Pick
 * the entry whose window is closest to the highlight instant; ties go to the
 * later entry (the narrative that has seen the most of the window). Falls back
 * to the highlight's own decide `reason` when no summary log exists.
 */
export function captionNarrative(
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason">,
  log?: SummaryLogEntry[]
): string {
  return selectNarrative(h, log).text;
}

/**
 * ADAAAA-7948 (Inc 3): the grounding context a seeded caption carries.
 *
 * The verdict is the window's STORED outcome, read off the highlight row (the
 * same value the server gates its summary text on).
 *
 * ADAAAA-7957 (Inc 5): the certification that matters is the SERVER's — a
 * summary-log narrative is verified against this window's `prompt_text` before it
 * is persisted (the seam passes `""`, never `null`, when the decide analysis is
 * absent, so the name gate always runs and fails closed). That is why this
 * surface may pass `null` for log text ("certified upstream") while a raw decide
 * `reason` — which has no certification — passes `""` and has every unsourced
 * proper name replaced by a role.
 */
export function captionGroundingFor(
  h: Pick<JobDetailHighlight, "outcome" | "eventType" | "localizedTs" | "start" | "reason" | "corroborated">,
  opts: { fromLog: boolean; promptText?: string | null } 
): CaptionGroundingContext {
  return {
    verdict: h.outcome ?? null,
    eventType: h.eventType ?? null,
    promptText: opts.promptText ?? (opts.fromLog ? null : ""),
    // ADAAAA-7958 (contract v3 §3.4): carry the stored corroboration flag into
    // the gate, so a goal the page counts but never corroborates cannot be
    // seeded as a caption or titled "Goal: …" — the card, the ladder banner and
    // the story log then agree. Absent/undefined means no evidence either way
    // (legacy rows, a job whose confirm pass never ran): the verdict rule decides.
    corroborated: typeof h.corroborated === "boolean" ? h.corroborated : null,
  };
}

/**
 * ADAAAA-7958 (contract v3 §3.4): the grounding context for a card's SEEDED
 * caption + titles, carrying the corroboration verdict the page's own banner
 * uses (`corroborated === true || goalConfirmed === "confirmed_goal"`, the same
 * rule as `goalTimelineFrom`'s `verified`).
 *
 * Fast rail only: the long-form VOD path carries no corroboration evidence and
 * its strings are graded unchanged (AC8), so `fastRail` false keeps the shipped
 * verdict-only behaviour. When it is true, a goal the banner counts as
 * uncorroborated is rewritten to the non-goal beat here, in the same shared gate
 * the summary log crosses — so the card, the log, the chapter titles and the
 * banner read as one story.
 */
export function highlightGrounding(
  h: Pick<JobDetailHighlight, "outcome" | "eventType" | "localizedTs" | "start" | "reason" | "corroborated" | "goalConfirmed">,
  log?: SummaryLogEntry[],
  fastRail = false
): CaptionGroundingContext {
  const selected = selectNarrative(h, log);
  const ctx = captionGroundingFor(h, { fromLog: selected.fromLog });
  if (!fastRail) return ctx;
  const verified = h.corroborated === true || (h.goalConfirmed ?? "").trim().toLowerCase() === "confirmed_goal";
  return { ...ctx, corroborated: verified };
}

/**
 * Human-readable label for a pipeline event type (ADAAAA-7881).
 *
 * A caption / post title is customer copy, so the raw enum (`SPORTING_EVENT`,
 * `GOAL`, …) must never reach it. Known types map to plain words; an unknown
 * type degrades to its title-cased words rather than leaking the enum.
 *
 * ADAAAA-7948 (Inc 3): the label table lives in the shared caption gate so the
 * server seam and this one cannot drift apart on a new enum.
 */
export function humanEventLabel(eventType?: string): string {
  return sharedHumanEventLabel(eventType);
}

/** A SCREAMING_SNAKE pipeline enum (`SPORTING_EVENT`, `NOT_HIGHLIGHT`, …). */

/**
 * Rewrite an observe-log line into customer copy: drop the internal codes
 * (`T+69s`, `outcome=near_miss`, SCREAMING_SNAKE enums, the `·` separator and
 * any leading event-code prefix) and leave the prose. Deterministic and pure —
 * no model call, no network, no randomness.
 *
 * ADAAAA-7948 (Inc 3): the strip itself now lives in the shared caption gate
 * (`@highlights/events`) so the server summaryLog seam and this seeded-
 * caption seam run the SAME rules — a bracket verdict label (`[near_miss]`) can
 * no longer reach a user surface through either path.
 */
function scrubInternal(text: string): string {
  return stripInternalTokens(text);
}

/** The leading clause of a narrative: cut at an em/en dash or a semicolon. */
function leadingClause(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const cut = t.search(/\s+[—–]\s+|;\s*/);
  const body = cut > 0 ? t.slice(0, cut) : t;
  return body.replace(/[\s,;:—–-]+$/, "").trim();
}

/** Trim to a word boundary no longer than `max`; never returns a cut word. */
function trimToWords(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max);
  return cut > 0 ? t.slice(0, cut).trim() : "";
}

/** Capitalise the first letter and end in sentence punctuation. */
function sentenceCase(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/** Caption length ceiling (a post caption, not an observe-log line). */
export const MAX_CAPTION_CHARS = 180;

/**
 * Suggested caption for a highlight (ADAAAA-7881) — one social-ready sentence
 * built from the same summary-log window narrative the card used to dump
 * verbatim behind a `GOAL · T+69s —` prefix.
 *
 * Deterministic and pure: no network, no model call, no `Math.random`. The user
 * edits this in the card; the edited value is what the batch export ships.
 */
export function suggestCaption(
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason" | "eventType" | "outcome" | "corroborated"> &
    Pick<Partial<JobDetailHighlight>, "caption">,
  log?: SummaryLogEntry[],
  ctx?: CaptionGroundingContext
): string {
  // ADAAAA-7965 (contract v5 §3.5, R22): the stored gated caption is the
  // customer copy — render it byte-for-byte, never re-derive it at read time.
  if (typeof h.caption === "string" && h.caption.trim()) return h.caption;
  const selected = selectNarrative(h, log);
  // ADAAAA-7948 (Inc 3): every seeded caption crosses the grounding gate —
  // verdict-gated goal claims, sourced names, no internal tokens.
  const narrative = groundCaption(
    scrubInternal(selected.text),
    ctx ?? captionGroundingFor(h, { fromLog: selected.fromLog })
  );
  const fallback = `A ${humanEventLabel(h.eventType)} was captured in this clip`;
  if (!narrative) return sentenceCase(fallback);
  // One sentence: a multi-sentence narrative keeps its first sentence only.
  // A period inside a jersey number ("No. 9 …") is not a sentence end.
  const firstSentence =
    narrative.match(/^.*?[.!?](?=\s+[A-Z"'“'(]|\s*$)/)?.[0] ?? narrative;
  let body = firstSentence;
  if (body.length > MAX_CAPTION_CHARS - 1) body = leadingClause(body);
  body = trimToWords(body, MAX_CAPTION_CHARS - 1).replace(/[\s,;:—–-]+$/, "");
  return sentenceCase(body) || sentenceCase(fallback);
}

/** Longest post title the card will suggest. */
const MAX_TITLE_CHARS = 60;

/** A title line: trimmed at a word boundary, no trailing punctuation. */
function titleLine(text: string): string {
  const body = trimToWords(text.trim(), MAX_TITLE_CHARS).replace(/[\s,;:.!?—–-]+$/, "");
  return body;
}

/**
 * One-line post titles for a highlight (ADAAAA-7881), extractive and pure.
 *
 * (a) the narrative's leading clause, (b) the human event label joined to that
 * clause when the join still fits, (c) the decide `reason`'s leading clause when
 * it differs. Empties/duplicates are dropped and the list is capped at 3, so the
 * card always offers 2–3 distinct one-line titles and never a cut word.
 */
export function postTitles(
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason" | "eventType" | "outcome" | "corroborated"> &
    Pick<Partial<JobDetailHighlight>, "cardTitles">,
  log?: SummaryLogEntry[],
  ctx?: CaptionGroundingContext
): string[] {
  // ADAAAA-7965 (contract v5 §3.5, R22): the card options were an ungated
  // derivative of the stored string — the title trim dropped the trailing period
  // on 5/5 measured cards, `leadingClause` dropped the colour clause (page
  // caption colour 0/15), and the 60-char cap cut a last word on one card. When
  // the write seam stored the gated options, render THEM, verbatim.
  const stored = (h.cardTitles ?? []).filter((t): t is string => typeof t === "string" && !!t.trim());
  if (stored.length) return stored.slice(0, 3);
  const selected = selectNarrative(h, log);
  const grounding = ctx ?? captionGroundingFor(h, { fromLog: selected.fromLog });
  const narrative = groundCaption(scrubInternal(selected.text), grounding);
  const lead = titleLine(leadingClause(narrative));
  // A title carries the same event label as the caption, so the label is gated
  // too: an unverified goal never becomes "Goal: …" (ADAAAA-7948).
  const label = gateGoalClaims(humanEventLabel(h.eventType), grounding);
  const labelTitle = label.charAt(0).toUpperCase() + label.slice(1);
  const reasonLead = titleLine(leadingClause(groundCaption(scrubInternal(h.reason ?? ""), grounding)));

  const out: string[] = [];
  const push = (value: string) => {
    const title = titleLine(value);
    if (title.length >= 1 && title.length <= MAX_TITLE_CHARS && !out.includes(title)) out.push(title);
  };
  push(sentenceCaseLead(lead));
  if (lead) push(`${labelTitle}: ${lead}`);
  if (reasonLead && reasonLead !== lead) push(sentenceCaseLead(reasonLead));
  push(labelTitle);
  push(`${labelTitle} moment`);
  return out.slice(0, 3).map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}

/** Title casing helper that never appends punctuation (titles carry none). */
function sentenceCaseLead(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

/**
 * The caption a `Use as caption` click applies (ADAAAA-7881): the title as-is
 * when it already ends in sentence punctuation, else the title plus a period so
 * the caption stays a sentence.
 */
export function captionFromTitle(title: string): string {
  const t = title.trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** `T+359s – T+372s`, the card's dominant moment identifier. */
export function momentRangeLabel(start: number, end: number): string {
  return `T+${Math.round(start)}s – T+${Math.round(end)}s`;
}

/** Filename-safe slug for a clip label. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/**
 * Download filename for one clip. Includes the event type, the timestamp and a
 * short highlight id so a batch of same-type clips never collides in the
 * archive (or in the user's Downloads folder).
 */
export function clipFileName(h: Pick<JobDetailHighlight, "id" | "eventType" | "localizedTs" | "start">): string {
  const label = slug(h.eventType || "highlight") || "highlight";
  const instant = Math.round(highlightInstant(h));
  const id = slug(h.id).slice(0, 8).replace(/-+$/, "") || "clip";
  return `${label}-t${instant}s-${id}.mp4`;
}

export interface BatchItem {
  caption: string;
  /** Absolute public clip URL (already resolved, no auth in it). */
  url: string;
  /** Set when the clip bytes could not be fetched for the archive. */
  error?: string;
}

/**
 * Plain-text manifest of a batch: caption + public URL per clip. It ships as
 * `captions.txt` inside the archive, is what "Copy URLs" puts on the
 * clipboard, and is the whole deliverable when a clip fetch fails — the URL
 * still plays in a fresh private window.
 */
export function batchManifest(items: BatchItem[]): string {
  const lines: string[] = [`# Highlights batch — ${items.length} clip(s)`, ""];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.caption}`.trimEnd());
    if (item.error) {
      lines.push(`   clip download failed (${item.error}) — open the URL to grab the clip`);
    }
    lines.push(`   ${item.url}`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Copy text to the clipboard. Uses the async Clipboard API on a secure
 * context and falls back to a hidden textarea + execCommand for plain-http /
 * older environments — a "Copy link" button that silently does nothing is
 * exactly the DevTools workaround this feature exists to remove.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      (typeof window === "undefined" || window.isSecureContext)
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Save in-memory bytes as a user download (no server round-trip). */
export function saveBlob(bytes: Uint8Array, filename: string): void {
  if (typeof document === "undefined") return;
  // Copy into a plain ArrayBuffer so the Blob part type is unambiguous
  // (Uint8Array<ArrayBufferLike> is not assignable to BlobPart under TS 5.7).
  const buffer =
    bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new Uint8Array(bytes).buffer;
  const blob = new Blob([buffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next task so the click has actually queued the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
