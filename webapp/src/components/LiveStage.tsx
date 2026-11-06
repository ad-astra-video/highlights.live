import { useEffect, useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";
import { api } from "../lib/api";
import { useLiveCapture } from "../lib/liveCapture";
import { liveStageView, noPreviewText, type LiveStageView } from "../lib/liveStage";
import type { JobDetail, LiveProgress } from "../lib/jobDetail";
import { LiveProgressChip } from "./LiveProgressChip";
import { AnalyzePositionChip } from "./AnalyzePositionChip";

// ADAAAA-7976: the live stage on the job detail page.
//
// First block of the detail content, ABOVE the match summary (`data-detail-ladder`):
//   data-live-stage
//     data-live-stage-video     - the playing browser-capture stream (muted,
//                                  autoPlay, playsInline, srcObject = capture)
//     data-live-stage-nopreview - RTMP/WebRTC ingest (no playback route exists)
//                                  or a browser capture this page no longer holds
//     data-live-stage-status    - real job status + elapsed + the existing lag chip
//     data-live-stage-stop      - Stop & finalize: flush recording chunks, then
//                                  POST /jobs/:id/stop, stay on this page
//
// Stop is the SAME finalize path as the /app capture panel (ADAAAA-6522): when
// this tab owns the capture it calls the provider's stop (recorder flush +
// pending chunk uploads BEFORE /stop); for an external-ingest or reloaded job it
// posts /jobs/:id/stop directly. No new server route, no new job state.

export interface LiveStageProps {
  job: JobDetail["job"];
  liveProgress?: LiveProgress;
  /** Seconds the light lag read has been failing (ADAAAA-7759 chip honesty). */
  staleSec?: number;
}

/** Presentational stage, split out so every state is pinned by an SSR test. */
export function LiveStageViewBlock({
  view,
  jobId,
  source,
  stream,
  liveProgress,
  staleSec = 0,
  stopping = false,
  stopError = null,
  captureNotice = null,
  onStop,
}: {
  view: LiveStageView;
  jobId: string;
  source: string;
  stream: MediaStream | null;
  liveProgress?: LiveProgress;
  staleSec?: number;
  stopping?: boolean;
  stopError?: string | null;
  /** ADAAAA-8105: live "recording not captured" copy while this tab owns the
   *  share and its recorder is producing no video bytes. */
  captureNotice?: string | null;
  onStop?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
    return () => {
      if (v.srcObject === stream) v.srcObject = null;
    };
  }, [stream, view.showVideo]);

  return (
    <div
      className="card card-accent mt-6 p-5"
      data-live-stage
      data-live-stage-mode={view.mode}
      data-live-stage-job={jobId}
      data-live-stage-source={source}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-black text-ink">Live stage</h2>
        <div
          className="flex flex-wrap items-center gap-2 text-sm"
          data-live-stage-status
          data-live-stage-state={view.statusLabel}
          role="status"
        >
          <span className="font-mono text-xs font-bold uppercase tracking-wide text-yellow" data-live-stage-job-status>
            {view.statusLabel}
          </span>
          <span className="font-mono text-xs text-mut" data-live-stage-elapsed>
            {view.elapsedLabel}
          </span>
          {/* The existing lag readout (ADAAAA-7741): only while the job is live. */}
          {view.inFlight && <LiveProgressChip progress={liveProgress} staleSec={staleSec} />}
          {/* ADAAAA-8121: where the analysis IS (content position) and its delay
              vs the live edge — same in-flight-only rule, so a finished job never
              leaves a frozen position on screen. */}
          {view.inFlight && <AnalyzePositionChip progress={liveProgress} />}
        </div>
        {view.canStop && (
          <button
            type="button"
            className="btn-neon btn-pink ml-auto"
            data-live-stage-stop
            onClick={onStop}
            disabled={stopping}
          >
            {stopping ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Square className="mr-2 inline h-4 w-4" />}
            {stopping ? "Finalizing…" : "Stop & finalize"}
          </button>
        )}
      </div>

      {captureNotice && (
        <div
          className="mt-3 rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm font-bold text-yellow"
          data-live-stage-capture-notice
          role="alert"
        >
          {captureNotice}
        </div>
      )}

      {view.showVideo && (
        <video
          ref={videoRef}
          data-live-stage-video
          muted
          autoPlay
          playsInline
          className="mt-3 aspect-video w-full max-w-3xl rounded-lg border border-neon/30 bg-black"
        />
      )}

      {view.showNoPreview && (
        <div
          className="mt-3 rounded-lg border border-mut/30 bg-black/30 px-3 py-2 text-sm text-mut"
          data-live-stage-nopreview
          data-live-stage-nopreview-reason={view.noPreviewReason ?? "local-capture-absent"}
        >
          {noPreviewText(view.noPreviewReason, source)}
        </div>
      )}

      {view.mode === "stopped" && (
        <p className="mt-3 text-sm text-mut" data-live-stage-finalized>
          This capture is finalized — the clips it produced are below.
        </p>
      )}

      {stopError && (
        <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-live-stage-stop-error>
          {stopError}
        </div>
      )}
    </div>
  );
}

export function LiveStage({ job, liveProgress, staleSec = 0 }: LiveStageProps) {
  const cap = useLiveCapture();
  const [now, setNow] = useState(() => Date.now());
  const [localStopped, setLocalStopped] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const inFlight = !["done", "failed", "cancelled"].includes(job.status);
  // Tick only while live so the elapsed readout advances without a re-render
  // storm on a finished job.
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [inFlight]);

  const ownsCapture = cap.jobId === job.id || (cap.lastJobId === job.id && cap.stopped);
  const view = liveStageView({
    jobStatus: job.status,
    jobSource: job.source,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    ownsCapture,
    hasCaptureStream: !!cap.stream,
    stopped: localStopped || (cap.lastJobId === job.id && cap.stopped),
    now,
  });

  async function onStop() {
    if (!view.canStop || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      // The tab that owns this capture: provider stop = recorder flush + await
      // every pending chunk upload + POST /jobs/:id/stop (ADAAAA-6522).
      if (cap.jobId === job.id) {
        await cap.stop();
      } else {
        await api(`/jobs/${job.id}/stop`, { body: {} });
      }
      setLocalStopped(true);
    } catch (e: any) {
      setStopError(e?.message || String(e));
    } finally {
      setStopping(false);
    }
  }

  return (
    <LiveStageViewBlock
      view={view}
      jobId={job.id}
      source={job.source}
      stream={cap.jobId === job.id ? cap.stream : null}
      liveProgress={liveProgress}
      staleSec={staleSec}
      stopping={stopping}
      stopError={stopError}
      captureNotice={cap.jobId === job.id ? cap.recordingNotice : null}
      onStop={() => void onStop()}
    />
  );
}
