import type { LiveProgress } from "../lib/jobDetail";
import { analysePositionLabel } from "../lib/liveProgress";

/**
 * ADAAAA-8121: where the live analysis currently is, and how far behind live
 * that position is.
 *
 * The board's ask on ADAAAA-8097 — "I lost the live analyze position tracking".
 * The chip reads the server's `liveProgress` projection ONLY: the analysed
 * position (content ts of the newest ANALYSED frame) and the delay
 * (`liveEdgeTs - analysedPositionTs`) are both content-clock numbers computed
 * server-side on the job record, so nothing here is a client estimate and
 * nothing ticks off the wall clock.
 *
 * A strided window is content the analysis never reached, so it can never be a
 * position: `strideFramesSkipped` is rendered as a COUNT beside the position,
 * never as a marker on the track (AC-3). When the record carries no stride
 * evidence at all (the content-fps knob was unset on that run) the chip says
 * "no stride data" instead of inventing a position (AC-6).
 *
 * Terminal jobs and jobs with no decided window render NOTHING (AC-4): a frozen
 * or zero position on screen would be a fabricated reading.
 */
export function AnalyzePositionChip({ progress }: { progress?: LiveProgress | null }) {
  const label = analysePositionLabel(progress);
  if (!label) return null;
  const behind = Number(progress?.analysedLagSec) > 0;
  const strideState =
    progress?.strideData === false ? "no-data" : Number(progress?.strideFramesSkipped) > 0 ? "skipped" : "none";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-bold ${
        behind ? "border-neon/40 bg-neon/10 text-neon" : "border-green/40 bg-green/10 text-green"
      }`}
      data-analyze-position
      data-analyze-position-ts={Number(progress?.analysedPositionTs ?? 0).toFixed(3)}
      data-analyze-position-lag={Number(progress?.analysedLagSec ?? 0).toFixed(3)}
      data-analyze-position-stride={strideState}
      data-analyze-position-skipped={Math.max(0, Math.round(Number(progress?.strideFramesSkipped ?? 0)))}
      title={`liveProgress: analysedPositionTs=${progress?.analysedPositionTs} liveEdgeTs=${progress?.liveEdgeTs} analysedLagSec=${progress?.analysedLagSec} strideFramesSkipped=${progress?.strideFramesSkipped} strideAnalysisFps=${progress?.strideAnalysisFps}`}
    >
      {label}
    </span>
  );
}
