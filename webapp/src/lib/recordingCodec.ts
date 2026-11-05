/**
 * Container/codec choice for the browser capture recording (ADAAAA-8055,
 * ADAAAA-8105).
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
 *
 * ADAAAA-8105 measured the residual case the ladder order alone cannot fix: a
 * browser can claim a mime, accept `MediaRecorder.start()`, and then emit ZERO
 * chunks (job `ccc9f1aa`: `isTypeSupported('video/mp4;codecs=avc1')` true while
 * `VideoEncoder.isConfigSupported('avc1.42001E')` false). Nothing is uploaded,
 * so there is no header to size-check and the stop path reports accepted
 * highlights with no clip. The ladder is therefore no longer trusted as a
 * capability answer: `chooseRecordingMime` PROVES each arm can encode (a real
 * first chunk with real bytes) before it commits, and walks down on failure.
 */
export const RECORDING_MIME_LADDER = [
  "video/webm;codecs=vp9",
  "video/webm",
  "video/mp4;codecs=avc1",
] as const;

/** A capture that produces less than this in its first `RECORDING_STALL_MS` is
 *  not recording video: a header-only mp4 is ~752 B and a header-only webm
 *  ~49 B, while a healthy 3 Mbps share produces ~3 MB in 8 s.
 *
 *  ADAAAA-8105 raised this from 1024 B: job `202d0dad`'s webm was 1,194 B —
 *  above the old guard and header-only in practice, so it passed a check that
 *  exists to catch exactly that. 4 KB clears every measured header size (max
 *  1,194 B) by more than 3x and is far below the smallest REAL footage the suite
 *  produces (a 2-frame 320x180 mp4 is 6,096 B), so it rejects headers without
 *  rejecting a short share. The server keeps the matching floors in
 *  `services/server/src/api.ts` and `live-capture.ts`. */
export const MIN_RECORDED_BYTES = 4096;

/** How long a recorder is given to produce real chunk bytes before the capture
 *  owner tells the user its clips will be missing. Long enough that encoder
 *  start-up never trips it, short enough to warn during the share. */
export const RECORDING_STALL_MS = 8000;

/** How often the live share re-reads its own recorder health (ADAAAA-8105).
 *  The old one-shot check at `RECORDING_STALL_MS` could only ever fire once:
 *  a recorder that died 30 s into a healthy share was never reported. */
export const RECORDING_HEALTH_POLL_MS = 2000;

/** How long a ladder arm gets to prove it can encode before we move on
 *  (ADAAAA-8105). One `timeslice` interval (1 s) plus slack for encoder
 *  start-up: a working arm emits its first chunk at ~1 s, a broken one emits
 *  nothing (or a header) and never recovers. */
export const ENCODER_PROBE_MS = 1500;

/** Bytes an arm must emit inside `ENCODER_PROBE_MS` to count as proof that it
 *  can encode. A container header alone is NOT proof (752 B mp4 / 49 B webm /
 *  1,194 B webm measured on the box), and a real 1.5 s capture of a 3 Mbps
 *  screen share is ~500 KB, so this is a wide margin on both sides — it rejects
 *  every header-only arm measured on the box while a slow/static screen still
 *  proves in its first chunk. Same value as `MIN_RECORDED_BYTES`: both answer
 *  "are these bytes frames, or only a container header?". */
export const ENCODER_PROBE_MIN_BYTES = MIN_RECORDED_BYTES;

/** Copy the views show while the recorder is not producing video (ADAAAA-8105).
 *  States the consequence (clips missing) and the action, during the share —
 *  not only at stop, which is where the loss used to become visible. */
export const RECORDING_STALL_NOTICE =
  "No screen video is being recorded for this share, so highlight clips will be missing. " +
  "Stop and share again — if it repeats, use another browser.";

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

/** Health of a live recorder, from bytes it has PRODUCED (before upload). */
export type RecordingHealth = "ok" | "pending" | "stalled";

/** `ok`      enough bytes landed to be real video
 *  `pending` still inside the stall window (encoder start-up), or paused
 *  `stalled` nothing usable despite a full window — clips will be missing
 *
 *  ADAAAA-8105: an `inactive` recorder past the window with no bytes counts as
 *  stalled. That is the zero-chunk case measured on job `ccc9f1aa` — the
 *  recorder died before its first chunk, uploaded nothing at all, and the old
 *  predicate (which ignored anything not actively `recording`) stayed silent
 *  until the share ended with accepted highlights and no clips. */
export function recordingHealth(stats: { bytes: number; ms: number; state: string }): RecordingHealth {
  if (stats.bytes >= MIN_RECORDED_BYTES) return "ok";
  // A paused recorder produces nothing by design; it resumes on its own.
  if (stats.state === "paused") return "pending";
  if (stats.ms < RECORDING_STALL_MS) return "pending";
  return "stalled";
}

/** True when a live recorder has produced no usable video bytes. */
export function recordingStalled(stats: { bytes: number; ms: number; state: string }): boolean {
  return recordingHealth(stats) === "stalled";
}

/** One tried ladder arm and the bytes it produced during its probe window. */
export interface MimeProbe {
  mime: string;
  bytes: number;
}

export interface MimeCommit {
  /** Mime to start the committed recorder with. `""` means "no candidate at
   *  all" — the caller should let the browser pick its default. */
  mime: string;
  /** True when the committed arm PROVED it can encode inside the probe window. */
  proved: boolean;
  /** Every arm tried, in ladder order (evidence for the caller's telemetry). */
  attempts: MimeProbe[];
}

/** Does a probe's byte count prove the arm can actually encode? */
export function probeProvesEncoding(bytes: number): boolean {
  return bytes >= ENCODER_PROBE_MIN_BYTES;
}

/**
 * Choose the recording mime by PROBING the ladder instead of trusting
 * `isTypeSupported` alone (ADAAAA-8105).
 *
 * `probe` starts (or inspects) a recorder for one mime and resolves with the
 * bytes it produced inside `ENCODER_PROBE_MS`; it is injected so the walk is
 * unit-testable without a browser. The first arm whose probe produces real
 * bytes wins. When NO arm proves, the arm that emitted the most bytes is
 * committed (an arm that at least writes a header has a chance of recovering,
 * and a zero-byte commit would upload nothing at all), falling back to the
 * ladder's preferred arm when every probe was empty.
 */
export async function chooseRecordingMime(
  candidates: readonly string[],
  probe: (mime: string) => Promise<number>,
): Promise<MimeCommit> {
  const attempts: MimeProbe[] = [];
  for (const mime of candidates) {
    let bytes = 0;
    try {
      const got = await probe(mime);
      bytes = Number.isFinite(got) ? Math.max(0, Math.round(got)) : 0;
    } catch {
      bytes = 0;
    }
    attempts.push({ mime, bytes });
    if (probeProvesEncoding(bytes)) return { mime, proved: true, attempts };
  }
  if (attempts.length === 0) return { mime: "", proved: false, attempts };
  const best = attempts.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  return { mime: best.bytes > 0 ? best.mime : attempts[0].mime, proved: false, attempts };
}
