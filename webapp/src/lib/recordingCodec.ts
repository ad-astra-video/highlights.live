/**
 * Container/codec choice for the browser capture recording (ADAAAA-8055).
 *
 * The rail recorded with `video/mp4;codecs=avc1` first (mp4 stream-copies into
 * the mp4 clip container when the codecs fit). In a browser that CLAIMS mp4
 * (`MediaRecorder.isTypeSupported` returns true) but has no usable H.264
 * encoder — headless Chromium is the reliable example, and 24 of the box's
 * capture files are sub-100 KB mp4 headers from real shares — that recorder
 * emits the container header and then no frame data at all: a 752-byte
 * `capture.mp4`. The server therefore cut every highlight from a recording that
 * held no video, and the card shipped
 * "No screen-share recording was captured, so this highlight's clip could not be
 * produced."
 *
 * `isTypeSupported` cannot be trusted for this decision, so the ladder is
 * ordered by what the rail has actually produced: WebM/VP9 recordings of 40 MB
 * and 57 MB exist on the box, and the clip cut re-encodes either container into
 * mp4 anyway (`cutClip`), so mp4-first buys nothing today. MP4 stays as the
 * last resort for a browser that cannot record WebM at all (e.g. Safari).
 */
export const RECORDING_MIME_LADDER = [
  "video/webm;codecs=vp9",
  "video/webm",
  "video/mp4;codecs=avc1",
] as const;

/** A capture that produces less than this in its first `RECORDING_STALL_MS` is
 *  not recording video: a header-only mp4 is ~750 B and a header-only webm
 *  ~49 B, while a healthy 3 Mbps share produces ~3 MB in 8 s. */
export const MIN_RECORDED_BYTES = 1024;

/** How long a recorder is given to produce real chunk bytes before the capture
 *  owner tells the user its clips will be missing. Long enough that encoder
 *  start-up never trips it, short enough to warn during the share. */
export const RECORDING_STALL_MS = 8000;

/** The recording mime types this browser can plausibly produce, best first.
 *  `isSupported` is injected so the choice is testable without a browser. */
export function supportedRecordingMimes(isSupported: (mime: string) => boolean): string[] {
  return RECORDING_MIME_LADDER.filter((mime) => {
    try {
      return isSupported(mime);
    } catch {
      return false;
    }
  });
}

/** True when a live recorder has produced no usable video bytes: it is
 *  `recording` but has only emitted (at most) a container header. */
export function recordingStalled(stats: { bytes: number; ms: number; state: string }): boolean {
  if (stats.state !== "recording") return false;
  if (stats.ms < RECORDING_STALL_MS) return false;
  return stats.bytes < MIN_RECORDED_BYTES;
}
