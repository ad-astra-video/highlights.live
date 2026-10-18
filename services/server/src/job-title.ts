// Job-title generation (ADAAAA-6798 Inc 1). A completed job gets a short,
// human-readable title via a single text-only `/app/title` decide call, with a
// deterministic fallback when the decide service is unavailable. Kept in its
// own module so the title logic (exactly-one-call, fallback, non-blocking) can
// be unit-tested without driving the full VOD/live pipeline.
import type { Job, HighlightRecord } from "@highlights/events";
import type { Store } from "./store";
import type { ServerConfig } from "./config";

/** p95 title budget (~2 s): how long to wait on the decide title call. */
export const TITLE_TIMEOUT_MS = 2500;

/** Deterministic fallback title: `<gameHint or source> · <n> highlights · <date>`. */
export function fallbackJobTitle(job: Pick<Job, "gameHint" | "source">, highlights: HighlightRecord[]): string {
  const who = job.gameHint || job.source || "Highlight reel";
  const n = highlights.filter((h) => h.status !== "rejected").length;
  const date = new Date().toISOString().slice(0, 10);
  return `${who} · ${n} highlight${n === 1 ? "" : "s"} · ${date}`;
}

/** One text-only `/app/title` decide call. Returns the LLM title string, or
 * null on any failure (decide down, non-2xx, unparseable) so the caller falls
 * back. Never throws. */
export async function requestJobTitle(
  cfg: Pick<ServerConfig, "decideUrl">,
  job: Pick<Job, "id" | "gameHint">,
  highlights: HighlightRecord[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!cfg.decideUrl) return null;
  const accepted = highlights.filter((h) => h.status === "accepted");
  const eventTypes: string[] = [...new Set(highlights.map((h) => h.eventType).filter(Boolean) as string[])];
  const reasons: string[] = accepted.map((h) => h.reason).filter(Boolean) as string[];
  try {
    const r = await fetchImpl(`${cfg.decideUrl.replace(/\/+$/, "")}/app/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameHint: job.gameHint ?? "",
        eventTypes,
        reasons,
        highlightCount: accepted.length,
      }),
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const data: any = await r.json();
    if (data && typeof data.title === "string" && data.title.trim()) return data.title.trim();
  } catch (e: any) {
    console.error(`[title:${job.id}] decide title call failed:`, e?.message || e);
  }
  return null;
}

/** Fire-and-forget title application at job completion. Exactly one title call
 * per completed job (guarded by an existing title). Never rejects — the job
 * always ends up with a title (LLM or fallback) and never blocks/fails. */
export async function applyJobTitle(
  store: Pick<Store, "getJob" | "highlightsForJob" | "patchJob">,
  cfg: Pick<ServerConfig, "decideUrl">,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const job = store.getJob(jobId) as Job | undefined;
    if (!job || job.title) return; // already titled — exactly one title call
    const highlights = store.highlightsForJob(jobId);
    const llm = await requestJobTitle(cfg, job, highlights, fetchImpl);
    await store.patchJob(jobId, { title: llm || fallbackJobTitle(job, highlights) });
  } catch (e: any) {
    console.error(`[title:${jobId}] apply title failed:`, e?.message || e);
  }
}
