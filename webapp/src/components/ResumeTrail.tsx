// ADAAAA-7907 (VOD resume, Increment 3): the two resume surfaces on the job
// page — the "resumed from" trail line and the failed-state Resume action.
//
// Split into presentational components (no data fetching) so both are pinned by
// a render test, exactly like JobDetail.failureReason.test.tsx pins the
// FailureReasonChip. The page owns the POST and the refresh.
//
// Token-only rule: every colour, radius, spacing and type value comes from the
// token layer in index.css (text-mut / text-neon / border-neon / bg-mut /
// rounded-full / px-2 / py-0.5 / text-xs ...). No hex, no raw px.

import { Loader2, RotateCcw } from "lucide-react";
import { canResume, readResume, resumeTrailText, type ResumeView } from "../lib/resume";

/**
 * "Resumed from T+12:30 · attempt 2 of 3" — rendered on the job header and on
 * the in-flight progress row. Renders nothing for a first pass (the checkpoint
 * exists on every VOD job; only a retried one has a resume point), so a normal
 * job never gains a line it did not earn.
 */
export function ResumeTrail({ resume }: { resume?: ResumeView | null }) {
  const text = resumeTrailText(resume);
  const reading = readResume(resume);
  if (!text || !reading) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-neon/30 bg-neon/10 px-2 py-0.5 text-xs font-bold text-neon"
      data-detail-resume-trail
      data-detail-resume-point={reading.point ?? ""}
      data-detail-resume-attempt={reading.attempt ?? ""}
      title={`resume: ${text}`}
    >
      <RotateCcw className="h-3 w-3" aria-hidden />
      {text}
    </span>
  );
}

/** The three states of the Resume action. */
export type ResumeActionState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "queued" }
  | { kind: "error"; message: string };

/**
 * The Resume action on the FAILED state of /app/jobs/:id (AC8).
 *
 * Offered only where the server will accept it (`canResume`: a VOD file job,
 * `failed`, with a checkpoint). The click is a plain callback — the page posts
 * `/jobs/:id/resume` and re-reads the job, because a resume only re-arms the
 * durable worker (202) and the pass then runs off the request path.
 */
export function ResumeAction({
  job,
  state,
  onResume,
}: {
  job: { source?: string; status?: string; resume?: ResumeView | null };
  state: ResumeActionState;
  onResume: () => void;
}) {
  if (!canResume(job)) return null;
  const working = state.kind === "working";
  const queued = state.kind === "queued";
  return (
    <div className="flex flex-col gap-1" data-detail-resume-action>
      <button
        type="button"
        className="btn-neon flex items-center gap-1 px-2 py-1 text-xs"
        onClick={onResume}
        disabled={working || queued}
        data-detail-resume-button
      >
        {working ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        )}
        {working ? "Resuming…" : queued ? "Resume queued" : "Resume"}
      </button>
      {state.kind === "queued" && (
        <span className="text-xs text-mut" data-detail-resume-note>
          Queued — it resumes from the last completed point, not from the start.
        </span>
      )}
      {state.kind === "error" && (
        <span className="text-xs text-red" data-detail-resume-error>
          {state.message}
        </span>
      )}
    </div>
  );
}
