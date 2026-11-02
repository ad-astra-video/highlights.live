import type { LiveProgress } from "../lib/jobDetail";
import { liveProgressChipLabel } from "../lib/liveProgress";

/**
 * ADAAAA-7741: the customer's "how live is this" chip for an in-flight live job.
 *
 * The transport already streams (SSE + a 5 s light poll), but a window only
 * becomes visible once its gemma decide returns (~8-13 s wall per ~3 s of
 * content), so the feed is structurally ~25-30 s behind the live edge and a
 * missing window looks like a failure. This chip says how far behind the newest
 * DECIDED window is, and — when the 30 s budget swallowed windows
 * (ADAAAA-7676) — how many, so a gap reads as a bounded budget.
 *
 * Terminal jobs render NOTHING here: the status chip in the same header row is
 * the completion state, and a frozen lag number must never be left on screen
 * (AC6). `liveProgress.state === "unknown"` (no decided window yet) also renders
 * nothing rather than a fabricated "caught up".
 *
 * Stateless + DOM-free rendering so both states are pinned by a render test.
 */
export function LiveProgressChip({ progress }: { progress?: LiveProgress | null }) {
  const label = liveProgressChipLabel(progress);
  if (!label) return null;
  const behind = progress?.state === "behind";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-bold ${
        behind ? "border-yellow/40 bg-yellow/10 text-yellow" : "border-green/40 bg-green/10 text-green"
      }`}
      data-live-progress
      data-live-progress-state={progress?.state}
      title={`liveProgress: liveEdgeTs=${progress?.liveEdgeTs} processedThroughTs=${progress?.processedThroughTs} lagSec=${progress?.lagSec}`}
    >
      {label}
    </span>
  );
}
