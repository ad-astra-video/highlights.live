// Bounds the pixels and the encode budget a screen share is allowed to ask for
// (ADAAAA-8848 F1).
//
// `getDisplayMedia({ video: true })` asks for the display's NATIVE pixels: a 4K
// share encodes at 3840x2160, and one decoded frame is 31.6 MB (1080p is
// 7.9 MB) with Chrome's encoder/decoder pools scaling to match. Nothing
// downstream reads those pixels — the WS/HTTP fallback sampler draws 320x180
// and decide reads a bounded frame budget per window — so the extra pixels buy
// nothing and are the largest single contributor to the tab OOM the CEO hit
// during a share.
//
// The capture asks for at most 1920x1080 @ 30 fps, and the RTC sender is capped
// at 2.5 Mbps with `maintain-resolution` degradation, so the encoder never
// outruns the bitrate the media node can decode.

/** Widest capture a share may request. */
export const MAX_CAPTURE_WIDTH = 1920;
/** Tallest capture a share may request. */
export const MAX_CAPTURE_HEIGHT = 1080;
/** Frame-rate ceiling for a share (decide cadence is seconds, not frames). */
export const MAX_CAPTURE_FPS = 30;
/** Per-sender encode ceiling. A 1080p30 screen at 2.5 Mbps is ample for the
 *  scoreboard/celebration evidence decide reads. */
export const MAX_SEND_BITRATE = 2_500_000;

/** The exact constraints `start()` hands to `getDisplayMedia`. Exported so a
 *  unit test pins the numbers rather than a shape that can drift. */
export const DISPLAY_CAPTURE_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    width: { max: MAX_CAPTURE_WIDTH },
    height: { max: MAX_CAPTURE_HEIGHT },
    frameRate: { max: MAX_CAPTURE_FPS },
  },
  audio: true,
};

/** Whether a captured track's REAL settings honour the requested ceiling.
 *  `getSettings()` reports what the browser actually gave us (a display larger
 *  than the request is downscaled by the browser, but a browser that ignores
 *  `max` reports the native size), so this is the check the in-browser
 *  acceptance test asserts on. */
export function captureSettingsAreBounded(settings: MediaTrackSettings | null | undefined): boolean {
  if (!settings) return false;
  const width = settings.width ?? 0;
  const height = settings.height ?? 0;
  const fps = settings.frameRate ?? 0;
  if (width > MAX_CAPTURE_WIDTH) return false;
  if (height > MAX_CAPTURE_HEIGHT) return false;
  if (fps > MAX_CAPTURE_FPS) return false;
  return true;
}

/** The RTC sender parameters with the encode ceiling applied.
 *
 *  Kept pure (no RTCPeerConnection) so a unit test can grade the exact object a
 *  sender receives: an existing `encodings` list keeps its SSRC/RTX ids and only
 *  gains `maxBitrate`; an empty list (pre-negotiation) becomes one bounded
 *  encoding. `degradationPreference` is `maintain-resolution` so a transient
 *  bandwidth dip lowers the frame rate instead of the resolution that the
 *  scoreboard OCR reads. */
export function boundedSenderParameters(params: RTCRtpSendParameters): RTCRtpSendParameters {
  const encodings = params.encodings && params.encodings.length > 0 ? params.encodings : [{} as RTCRtpEncodingParameters];
  return {
    ...params,
    encodings: encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: Math.min(encoding.maxBitrate ?? MAX_SEND_BITRATE, MAX_SEND_BITRATE),
    })),
    degradationPreference: "maintain-resolution",
  } as RTCRtpSendParameters;
}

/** Apply the ceiling to one sender. Best-effort: a sender that is not yet
 *  negotiated can reject `setParameters`, and the share must not fail because
 *  the cap could not be placed on the first attempt. */
export async function applySenderBounds(sender: RTCRtpSender | null | undefined): Promise<boolean> {
  if (!sender) return false;
  try {
    const params = sender.getParameters();
    await sender.setParameters(boundedSenderParameters(params));
    return true;
  } catch {
    return false;
  }
}
