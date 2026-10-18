// Increment 3 T2 (ADAAAA-6871): shared "Job detail" panel. Any job row/card can
// open it (row onClick + a "Details" chip; the Delete control stops propagation
// so deleting never opens the panel). It shows:
//   - status + progress + source + scheduled/completed times
//   - the decision trail (job.candidates + live SSE candidate/highlight frames)
//   - for a `done` job, the embedded Frame debugger (per-frame detection boxes)
// The panel subscribes to /jobs/:id/events (reusing readSSE) while open, appends
// candidate/highlight frames live, and reconciles against the 15s poll; closing
// unsubscribes.
import { useEffect, useRef, useState } from "react";
import { X, Activity, CheckCircle2, Loader2 } from "lucide-react";
import { api, getToken, type Highlight, type Job } from "../lib/api";
import { readSSE } from "../lib/sse";
import {
  VOD_POLL_MS,
  isInFlight,
  jobProgressPct,
  sourceLabel,
  formatJobTime,
  jobSpanLabel,
} from "../lib/vodJobs";
import { trailFromJob, trailFromEvent, mergeTrail, hasCandidateTrigger, reconcileTrail, type TrailEntry } from "../lib/jobTrail";
import { FrameDebugger } from "./FrameDebugger";

function statusChipClass(status: string): string {
  switch (status) {
    case "queued":
      return "border-mut/40 bg-mut/10 text-mut";
    case "active":
      return "border-neon/40 bg-neon/10 text-neon";
    case "done":
      return "border-green/40 bg-green/10 text-green";
    case "failed":
      return "border-red/40 bg-red/10 text-red";
    default:
      return "border-mut/40 bg-mut/10 text-mut";
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
}

/** One decision-trail row: a candidate trigger or a highlight verdict. */
function TrailRow({ entry }: { entry: TrailEntry }) {
  const isHigh = entry.kind === "highlight";
  return (
    <li
      data-trail-entry
      data-trail-kind={entry.kind}
      data-trail-decision={entry.decision}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
        isHigh
          ? "border-green/40 bg-green/10 text-green"
          : "border-neon/30 bg-neon/5 text-neon"
      }`}
    >
      {isHigh ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <Activity className="h-4 w-4 shrink-0" />}
      <span className="font-mono text-xs text-mut">#{entry.seq}</span>
      <span className="font-bold uppercase">{entry.eventType}</span>
      <span className="ml-auto text-xs text-mut">{fmtTime(entry.ts)}</span>
      <span className="rounded-full border border-mut/30 px-2 py-0.5 text-xs uppercase">{entry.decision}</span>
    </li>
  );
}

export function JobDetailPanel({ jobId, initialJob, onClose }: { jobId: string; initialJob: Job; onClose: () => void }) {
  const [job, setJob] = useState<Job>(initialJob);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [trail, setTrail] = useState<TrailEntry[]>(() => trailFromJob(initialJob));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef<number | null>(null);

  // Subscribe to the job's live SSE while the panel is open, and tear it down on
  // close/unmount. Each candidate/highlight frame is appended to the trail;
  // progress frames keep the in-flight progress bar live.
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    let cancelled = false;

    const refresh = async () => {
      try {
        const r = await api<{ job: Job; highlights: Highlight[] }>(`/jobs/${jobId}`);
        if (cancelled) return;
        setJob(r.job);
        setHighlights(r.highlights ?? []);
        // Reconcile the trail against the persisted snapshot without wiping the
        // live SSE-appended frames: for an in-flight live job `job.candidates`
        // is empty (persistDecision does not populate it), so re-seeding from
        // that empty snapshot dropped the trail to "No decisions yet". Keep the
        // SSE trail when the snapshot is empty and merge (dedupe) when it is
        // non-empty (the VOD `file` path) so the 15s poll preserves both.
        setTrail((prev) => reconcileTrail(prev, trailFromJob(r.job)));
        setLoading(false);
        return r;
      } catch (e: any) {
        if (!cancelled) {
          setError(String(e?.message || e));
          setLoading(false);
        }
        return null;
      }
    };

    // Initial fetch (fresh job + highlights) then SSE live append.
    refresh();

    readSSE(
      `/jobs/${jobId}/events`,
      getToken(),
      (name, data) => {
        if (name === "progress" && data && typeof data.progress === "number") {
          setJob((prev) => ({ ...prev, progress: data.progress, progressLabel: data.progressLabel }));
          return;
        }
        const entry = trailFromEvent(name, data);
        if (entry) setTrail((prev) => mergeTrail(prev, [entry]));
      },
      ac.signal
    ).catch(() => {
      // stream ended/failed — the 15s poll still reconciles; if the job reached
      // a terminal state the poll will stop and the panel shows the persisted
      // decision trail.
    });

    // 15s poll backstop: while the job is in flight, re-fetch so status
    // transitions and the persisted decision trail are reconciled even if the
    // SSE socket drops. Stop once the job reaches a terminal state (polling for
    // a done job would only re-fetch static data).
    const iv = window.setInterval(() => {
      // Only reconcile an in-flight job; a done/failed job's data is static.
      const st = jobRef.current?.status;
      if (!st || !isInFlight(st)) return;
      refresh();
    }, VOD_POLL_MS);
    pollingRef.current = iv;

    return () => {
      cancelled = true;
      ac.abort();
      if (iv) window.clearInterval(iv);
      if (pollingRef.current === iv) pollingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Keep a ref to the latest job so the poll interval can decide whether to keep
  // reconciling without re-creating the subscription on every status change.
  const jobRef = useRef<Job>(job);
  useEffect(() => {
    jobRef.current = job;
  }, [job]);

  const progress = jobProgressPct(job);
  const span = jobSpanLabel(job);
  const scheduled = formatJobTime(job.scheduledAt);
  const completed = formatJobTime(job.completedAt);
  const done = job.status === "done";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-void/60 p-4 sm:items-center" data-job-detail-panel>
      <div className="card max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-black text-ink">Job detail</h3>
            <span className="font-mono text-sm text-mut">{job.id.slice(0, 8)}</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChipClass(job.status)}`} data-job-detail-status>
              {job.status}
            </span>
          </div>
          <button type="button" className="chip" onClick={onClose} data-job-detail-close aria-label="Close job detail">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mut" data-job-detail-meta>
          <span>{sourceLabel(job.source)}</span>
          {scheduled && <span>Scheduled {scheduled}</span>}
          {completed && <span>Completed {completed}</span>}
          {span && <span data-job-detail-span>{span}</span>}
        </div>

        {isInFlight(job.status) && (
          <div className="mt-3 flex items-center gap-2" data-job-detail-progress>
            <Loader2 className="h-4 w-4 animate-spin text-neon" />
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-mut/20">
              <div className="h-full rounded-full bg-neon" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-xs text-mut">{Math.round(progress)}%{job.progressLabel ? ` · ${job.progressLabel}` : ""}</span>
          </div>
        )}

        {error && <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}

        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-mut">
            <Activity className="h-4 w-4" /> Decision trail
            <span className="rounded-full bg-ink/15 px-2 py-0.5 text-xs font-bold text-ink" data-trail-count>{trail.length}</span>
          </div>
          {loading ? (
            <div className="text-sm text-mut">Loading…</div>
          ) : trail.length === 0 ? (
            <div className="text-sm text-mut" data-trail-empty>
              {isInFlight(job.status)
                ? "No decisions yet — waiting for the first candidate."
                : "No decision trail recorded for this job."}
            </div>
          ) : (
            <ul className="flex flex-col gap-2" data-trail-list>
              {trail.map((e) => (
                <TrailRow key={`${e.kind}:${e.seq}:${e.eventType}`} entry={e} />
              ))}
            </ul>
          )}
        </div>

        {highlights.length > 0 && (
          <div className="mt-5" data-job-detail-highlights>
            <div className="mb-2 text-sm font-bold uppercase tracking-wide text-mut">
              {highlights.filter((h) => h.status !== "rejected").length} accepted highlight(s)
            </div>
            <ul className="flex flex-col gap-2">
              {highlights
                .filter((h) => h.status !== "rejected")
                .map((h) => (
                  <li key={h.id} className="flex items-center gap-2 rounded-lg border border-mut/30 px-3 py-2 text-sm text-slate-ink" data-job-detail-highlight>
                    <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">{h.eventType || "EVENT"}</span>
                    <span className="text-xs text-mut">T+{Math.round(h.start)}s → T+{Math.round(h.end)}s</span>
                    <span className="ml-auto text-xs text-green">{h.status}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {done && (
          <div data-job-detail-frame-debugger>
            <FrameDebugger jobId={jobId} />
          </div>
        )}
      </div>
    </div>
  );
}
