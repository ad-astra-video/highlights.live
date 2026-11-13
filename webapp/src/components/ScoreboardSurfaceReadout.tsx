/**
 * ADAAAA-8835 (Inc 1): read-only provenance of the score surface the scoreboard
 * OCR actually cropped for a job.
 *
 * The per-job pin (and every discovered/adopted box) used to live only inside the
 * perceive session, so the next "a foreign score bug cut a clip" report was
 * undiagnosable from the board. This chip is the board-visible half: the box, where
 * it came from (`explicit` = the operator pinned it, `discovery` = auto-detected,
 * `default_top_band` = the shipped prior), the first frame that reported it, and
 * whether that box ever read a score.
 *
 * Rendered for every live and VOD job. With no block on the record (a job that
 * predates the field, or one whose session has not reported a crop yet) it says
 * "not recorded" — it never implies a pin that was not declared.
 */
import { describeScoreboardSurface, type ScoreboardSurface } from "../lib/scoreboardSurface";

export function ScoreboardSurfaceReadout({ surface }: { surface?: ScoreboardSurface }) {
  return (
    <span
      className="rounded-full border border-neon/30 px-2 py-0.5 text-xs text-mut"
      data-scoreboard-surface
      data-scoreboard-surface-source={surface?.source ?? "none"}
      title="Score bug region the scoreboard OCR cropped (normalized 0..1)"
    >
      score bug: {describeScoreboardSurface(surface)}
    </span>
  );
}
