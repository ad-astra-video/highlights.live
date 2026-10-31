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
 * Seed caption for a highlight: the event type and the clip timestamp are
 * always prefilled so a bare "Download" still yields a labelled clip, and the
 * window narrative is appended when the job carries one. The user edits this
 * in the card; the edited value is what the batch export ships.
 */
export function seedCaption(
  h: Pick<JobDetailHighlight, "localizedTs" | "start" | "reason" | "eventType">,
  log?: SummaryLogEntry[]
): string {
  const instant = Math.round(highlightInstant(h));
  const head = `${(h.eventType || "Highlight").trim()} · T+${instant}s`;
  const narrative = captionNarrative(h, log);
  return narrative ? `${head} — ${narrative}` : head;
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
