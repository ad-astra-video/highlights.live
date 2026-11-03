// Posting helpers for a highlight (ADAAAA-7622): the job-detail card had no
// posting path at all — it rendered the clip, badges and review controls, but
// no download, no copy-link and no caption. These are the pure pieces behind
// the card actions + the multi-select batch export, kept out of the React
// component so they are unit-testable without a DOM.
import type { JobDetailHighlight, SummaryLogEntry } from "./jobDetail";

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

/**
 * The instant a highlight is "about": the clip is centered on `localizedTs`
 * when the localization pass recorded one, else its window start.
 */
export function highlightInstant(h: Pick<JobDetailHighlight, "localizedTs" | "start">): number {
  return typeof h.localizedTs === "number" ? h.localizedTs : h.start;
}

/**
 * The narrative line for a highlight from the job's append-only summary log.
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
  const entries = (log ?? []).filter(
    (e): e is SummaryLogEntry & { windowTs: number } => typeof e.windowTs === "number" && !!e.text?.trim()
  );
  if (entries.length === 0) return (h.reason ?? "").trim();
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
  return best.text.trim();
}

/**
 * Human-readable label for a pipeline event type (ADAAAA-7881).
 *
 * A caption / post title is customer copy, so the raw enum (`SPORTING_EVENT`,
 * `GOAL`, …) must never reach it. Known types map to plain words; an unknown
 * type degrades to its title-cased words rather than leaking the enum.
 */
const EVENT_LABELS: Record<string, string> = {
  GOAL: "goal",
  SPORTING_EVENT: "sporting moment",
  NEAR_MISS: "near miss",
  BIG_PLAY: "big play",
  HIGHLIGHT: "highlight",
};

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

/**
 * Rewrite an observe-log line into customer copy: drop the internal codes
 * (`T+69s`, `outcome=near_miss`, SCREAMING_SNAKE enums, the `·` separator and
 * any leading event-code prefix) and leave the prose. Deterministic and pure —
 * no model call, no network, no randomness.
 */
function scrubInternal(text: string): string {
  const out = text
    .replace(/\bT\+\s*\d+(?:\.\d+)?\s*s\b/gi, " ")
    .replace(/\boutcome\s*=\s*[A-Za-z0-9_-]+/gi, " ")
    .replace(SCREAMING_TOKEN, (m) => humanEventLabel(m))
    .replace(/[·•]/g, ", ");
  return out
    // A bare leading event enum ("GOAL — …") is an internal code, not copy.
    .replace(/^\s*[A-Z][A-Z0-9]{1,}\b\s*[,;:—–-]*\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:—–\-\s]+|[,;:—–\-\s]+$/g, "");
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
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason" | "eventType">,
  log?: SummaryLogEntry[]
): string {
  const narrative = scrubInternal(captionNarrative(h, log));
  const fallback = `A ${humanEventLabel(h.eventType)} was captured in this clip`;
  if (!narrative) return sentenceCase(fallback);
  // One sentence: a multi-sentence narrative keeps its first sentence only.
  const firstSentence = narrative.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? narrative;
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
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason" | "eventType">,
  log?: SummaryLogEntry[]
): string[] {
  const narrative = scrubInternal(captionNarrative(h, log));
  const lead = titleLine(leadingClause(narrative));
  const label = humanEventLabel(h.eventType);
  const labelTitle = label.charAt(0).toUpperCase() + label.slice(1);
  const reasonLead = titleLine(leadingClause(scrubInternal(h.reason ?? "")));

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
