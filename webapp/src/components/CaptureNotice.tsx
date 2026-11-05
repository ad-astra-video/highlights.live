import type { LiveCapture } from "../lib/jobDetail";

/**
 * ADAAAA-7750: the notice that replaces the bare `No analysis windows for this
 * job.` when the window list is empty.
 *
 * The empty list used to mean four different things at once — a share that
 * started ten seconds ago, a share whose browser never reached the media node, a
 * run whose windows were all judged "not a highlight", and a share that captured
 * no frames at all. The server now derives which one it is at read time
 * (`deriveLiveCapture`) and this component states it, with the retry action when
 * the capture surface is genuinely gone.
 *
 * Stateless + DOM-free rendering so the copy is pinned by a render test.
 */
export function CaptureNotice({ capture }: { capture?: LiveCapture | null }) {
  if (!capture || capture.state === "unknown" || !capture.cause) return null;
  const waiting = capture.state === "waiting_first_window" || capture.state === "connecting";
  // ADAAAA-8105: a live share that is storing no video is a real warning — the
  // clips for the highlights it accepts will be missing — so it reads as an
  // alert, not a quiet status line.
  const interrupted = capture.state === "interrupted" || capture.state === "recording_missing";
  const tone = interrupted
    ? "border-yellow/40 bg-yellow/10"
    : waiting
      ? "border-neon/30 bg-neon/5"
      : "border-mut/30 bg-ink/5";
  return (
    <div
      className={`mt-3 rounded-lg border px-3 py-2 text-sm ${tone}`}
      data-capture-notice
      data-capture-state={capture.state}
      data-capture-causes
      role={interrupted ? "alert" : "status"}
    >
      <div className={interrupted ? "font-bold text-yellow" : "text-ink"} data-capture-cause>
        {capture.cause}
      </div>
      {capture.action && (
        <div className="mt-1 text-mut" data-capture-action>
          {capture.action}
        </div>
      )}
    </div>
  );
}
