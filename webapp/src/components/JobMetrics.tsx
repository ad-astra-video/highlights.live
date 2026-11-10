import type { Job } from "../lib/api";
import { candidateCountLabel, decideCallsCount, stageACountLabel } from "../lib/jobDetail";
import { sourceLabel } from "../lib/vodJobs";
import { decideKnobReadout } from "../lib/decideKnob";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726): the per-job metric readouts were rendered
// for every signed-in user, so a customer session showed spend, decide/perceive
// counters and the audio Stage-A snapshot — the internal pipeline lens the CEO
// saw on a screen share. Both components below take the resolved `admin` flag
// (from `useIsAdmin()` at the call site) and render ONLY the customer-facing
// work counters when it is false:
//
//   customer: frames analyzed, accepted/rejected clips, span, source, game
//   admin:    + cost, decide calls, candidates, audio Stage-A, frame partition
//
// Keeping the gate in one presentational component means the tile, the job
// detail header and any future surface share one rule, and it renders without a
// React context so the gate itself is SSR-testable.

type MetricJob = Pick<Job, "source" | "gameHint" | "framesAnalyzed"> &
  Partial<Pick<Job, "costUsd" | "decideCalls" | "observeMetrics" | "candidatesTriggered" | "decideKnob">> & {
    stageAMetrics?: any;
    stageAMetricsStatus?: "measured" | "n/a";
  };

/** The completed-job tile's metric line (Highlights page). */
export function JobTileMetrics({
  job,
  acceptedCount,
  rejectedCount,
  mergedCount = 0,
  span,
  admin,
}: {
  job: MetricJob;
  acceptedCount: number;
  rejectedCount: number;
  /** ADAAAA-7854: overlapping duplicate clips folded into an accepted moment.
   * They are persisted rows but NOT a separate clip the customer sees, so they
   * render as a secondary read next to the deduped accepted count. */
  mergedCount?: number;
  span: string | null;
  admin: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mut" data-job-tile-metrics>
      <span>{job.framesAnalyzed ?? 0} frames</span>
      {/* Internal spend/pipeline counters — admin only. */}
      {admin && <span data-job-tile-cost>${(job.costUsd ?? 0).toFixed(2)}</span>}
      {admin && <span data-job-tile-decide-calls>{decideCallsCount(job)} decide</span>}
      {/* ADAAAA-7854: the accepted read is the DEDUPED postable moment count the
          server derives (`job.postableHighlights`), never a client count of raw
          rows — merged duplicates do not count as clips the customer can watch. */}
      <span data-job-tile-accepted>{acceptedCount} accepted</span>
      {mergedCount > 0 && (
        <span className="text-mut" data-job-tile-merged>
          {mergedCount} merged
        </span>
      )}
      {rejectedCount > 0 && (
        <span className="text-mut" data-job-tile-rejected>
          {rejectedCount} rejected
        </span>
      )}
      {span && <span data-job-span>{span}</span>}
    </div>
  );
}

/** The job detail page's header readout row. */
export function JobDetailMetrics({
  job,
  frameCount,
  partition,
  admin,
}: {
  job: MetricJob;
  frameCount: number;
  partition: { ok: boolean } | null | undefined;
  admin: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
      <div>
        <div className="text-xs uppercase tracking-wide text-mut">Source</div>
        <div>{sourceLabel(job.source)}</div>
      </div>
      {job.gameHint && (
        <div>
          <div className="text-xs uppercase tracking-wide text-mut">Game</div>
          <div>{job.gameHint}</div>
        </div>
      )}
      <div>
        <div className="text-xs uppercase tracking-wide text-mut">Frames</div>
        <div>{job.framesAnalyzed ?? frameCount}</div>
      </div>
      {/* ADAAAA-7727: decide/candidates/Stage-A/cost are pipeline + spend
          internals; a customer never sees them on their own job. */}
      {admin && (
        <div data-detail-decide-calls>
          <div className="text-xs uppercase tracking-wide text-mut">Decide calls</div>
          <div>{decideCallsCount(job)}</div>
        </div>
      )}
      {/* ADAAAA-7624: candidates are counted by the path that actually ran (the
          observe cadence decide pass), and the audio Stage-A counters read `n/a`
          when that gate judged nothing — never a fabricated `0`.
          ADAAAA-7854: this counter's basis is PERSISTED ROWS (it includes
          overlapping duplicates), while the customer-facing clip count is the
          deduped postable moments. The label states the raw basis so an operator
          cannot read it as the clip total; the row is admin-only, so no
          customer-facing surface shows a merged-inclusive count. */}
      {admin && (
        <div data-detail-candidates>
          <div className="text-xs uppercase tracking-wide text-mut">Candidates (raw rows)</div>
          <div>{candidateCountLabel(job)}</div>
        </div>
      )}
      {admin && (
        <div data-detail-stage-a>
          <div className="text-xs uppercase tracking-wide text-mut">Audio Stage-A</div>
          <div>{stageACountLabel(job)}</div>
        </div>
      )}
      {admin && job.decideKnob && (
        // ADAAAA-8544 item 7 (monitor side): the posture this live job is
        // RUNNING, read from the frozen stamp — never a re-estimate of the
        // current form state. Admin-only for the same reason as the cost read
        // beside it (ADAAAA-7727): it is a spend figure on a completed row.
        <div data-detail-decide-knob>
          <div className="text-xs uppercase tracking-wide text-mut">Decide posture</div>
          <div>{decideKnobReadout(job.decideKnob)}</div>
        </div>
      )}
      {admin && (
        <div data-detail-cost>
          <div className="text-xs uppercase tracking-wide text-mut">Cost</div>
          <div>${(job.costUsd ?? 0).toFixed(2)}</div>
        </div>
      )}
      {admin && (
        <div data-detail-partition>
          <div className="text-xs uppercase tracking-wide text-mut">Frames shown</div>
          <div className={partition && !partition.ok ? "font-bold text-red" : ""}>
            {frameCount}
            {partition && !partition.ok && <span className="ml-1 text-red">· overlap!</span>}
          </div>
        </div>
      )}
    </div>
  );
}
