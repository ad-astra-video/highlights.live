import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { Square, Play, Share2 } from "lucide-react";
import { useLiveCapture } from "../lib/liveCapture";
import { StreamHealthStrip } from "./StreamHealthStrip";

// ADAAAA-7976: BrowserCapture is now a VIEW over the route-level capture
// provider (lib/liveCapture.tsx). It no longer owns the MediaStream/recorder —
// that session survives the route change to `/app/jobs/:id`, where the live
// stage renders the same stream above the match summary.
//
// The start path is unchanged for the user: Share screen / tab / window ->
// getDisplayMedia -> POST /jobs -> (provider) navigate to the job detail page.
// This component only starts/stops the provider's session and previews it.
export function BrowserCapture({
  gameHint,
  decideKnob,
  knobInvalid = false,
}: {
  gameHint: string;
  /** ADAAAA-8544: the per-stream decide knob resolved by the /app form. The
   *  capture path POSTs `/jobs` itself (`source: "browser"`), so the control's
   *  posture has to travel with the start — a capture that ignored it would run
   *  the deploy-time default while the price on screen said otherwise. */
  decideKnob?: { cadenceSec: 3 | 5; rateCapPer300s: number | null };
  /** ADAAAA-8544: the form's cap failed its floor check. The message renders in
   *  the knob block above; this only keeps the capture from POSTing a knob the
   *  route would 422. */
  knobInvalid?: boolean;
}) {
  const cap = useLiveCapture();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = cap.stream;
    if (cap.stream) void v.play().catch(() => {});
    return () => {
      if (v.srcObject === cap.stream) v.srcObject = null;
    };
  }, [cap.stream]);

  return (
    <div className="mt-6 rounded-2xl border border-neon/40 bg-black/40 p-4" data-capture-panel>
      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-neon">
        <Share2 className="h-4 w-4" /> Client-side capture
        <span className="normal-case text-mut">— pixels stream live to the media server via WebRTC</span>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <video
          ref={videoRef}
          data-capture-preview
          muted
          autoPlay
          playsInline
          className="aspect-video w-full max-w-md rounded-lg bg-black"
        />
        <div className="flex flex-col gap-2">
          {!cap.sharing ? (
            <button
              className="btn-neon"
              data-capture-start
              onClick={() => void cap.start(gameHint, decideKnob)}
              disabled={cap.busy || knobInvalid}
            >
              <Play className="mr-2 inline h-4 w-4" /> {cap.busy ? "Starting…" : "Share screen / tab / window"}
            </button>
          ) : (
            <>
              <button className="btn-neon btn-pink" data-capture-stop onClick={() => void cap.stop()}>
                <Square className="mr-2 inline h-4 w-4" /> Stop &amp; finalize
              </button>
              {cap.jobId && (
                <Link to={`/app/jobs/${cap.jobId}`} className="text-xs text-neon" data-capture-open-job>
                  Open the live job page →
                </Link>
              )}
            </>
          )}
          {cap.sharing && (
            <p className="text-xs text-mut">
              Capturing live. The video, status and Stop button are on the job detail page; each highlight's clip is cut
              from the recording as soon as its window lands, so it plays during the share.
            </p>
          )}
        </div>
      </div>
      {/* Stream health (ADAAAA-7726 Inc 2): five plain-language chips, 2 s cadence. */}
      {cap.sharing && <StreamHealthStrip chips={cap.healthChips} className="mt-3" />}
      {cap.recordingNotice && (
        <div
          className="mt-3 rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm font-bold text-yellow"
          data-capture-recording-notice
          role="alert"
        >
          {cap.recordingNotice}
        </div>
      )}
      {cap.recordingGapNotice && (
        <div
          className="mt-3 rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm font-bold text-yellow"
          data-capture-recording-gap
          role="alert"
        >
          {cap.recordingGapNotice}
        </div>
      )}
      {cap.error && (
        <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-capture-error>
          {cap.error}
        </div>
      )}
    </div>
  );
}

// Kept exported from this module so the ADAAAA-7335 classifier test keeps its
// import path; the implementation moved with the capture engine.
export { isTransientMediaError } from "../lib/liveCapture";
