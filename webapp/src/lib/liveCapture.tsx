import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getToken } from "./api";
import { readSSE } from "./sse";
import { captureEndedNotice } from "./captureLoss";
import { useSettings } from "./settings";
import { DISPLAY_CAPTURE_CONSTRAINTS, applySenderBounds } from "./captureBounds";
import { BoundedRecordingQueue, RECORDING_QUEUE_LIMIT, recordingGapNotice, type RecordingGap } from "./recordingQueue";
import { postRecordingChunk } from "./recordingUpload";
import { createFrameSampler, createTickGate, type FrameSampler } from "./frameSampler";
import {
  ENCODER_PROBE_MS,
  ENCODER_PROBE_MIN_BYTES,
  RECORDING_HEALTH_POLL_MS,
  RECORDING_STALL_NOTICE,
  chooseRecordingMime,
  recordingProbeCandidates,
  recordingCommitPlan,
  recordingHealth,
  type RecordingHealth,
} from "./recordingCodec";
import { useStreamHealth } from "./useStreamHealth";
import type { ChipView } from "./streamHealth";

// Route-level browser-capture owner (ADAAAA-7976, spec ADAAAA-7973).
//
// Before this module the whole screenshare session lived in BrowserCapture's
// component refs, so navigating to `/app/jobs/:id` — the PO's required routing
// change — unmounted it, stopped the recorder and killed the share. The session
// (MediaStream, MediaRecorder, RTCPeerConnection, pending recording uploads,
// reconnect loop, job poll) now lives in this provider, mounted ABOVE <Routes>
// in App.tsx. BrowserCapture (the /app start surface) and LiveStage (the detail
// page) are views over it; neither owns stream state.
//
// Two invariants pinned by this module:
// 1. ONE capture owner — `start()` is guarded, so a double click / StrictMode
//    remount can never open a second getDisplayMedia or create a second job.
// 2. A user stop is final — `stoppingRef` gates the reconnect loop, so a
//    scheduled reconnect can never re-arm after Stop (or after the server ends
//    the job underneath us).
//
// The finalize contract (ADAAAA-6522) is unchanged: Stop awaits the
// MediaRecorder flush AND every in-flight recording-chunk upload BEFORE
// `POST /jobs/:id/stop`, otherwise clips are cut from a truncated recording and
// ship an empty `clipUri`.

const MAX_RECONNECT = 6; // consecutive media reconnect attempts before falling back to /ingest
// Transient /jobs/:id/media failures (HTTP 503 `no capacity available for
// runner`, ADAAAA-7335) are retried with backoff before surfacing. We never
// silently degrade the share onto the HTTP /ingest rail on a transient error.
const MAX_MEDIA_RETRIES = 3;
// How often the capture owner re-reads its own job row while a share is live
// (ADAAAA-7700). The media node can die with the RTC session and say nothing to
// the browser, so the JOB RECORD is the source of truth for "is this share
// still alive" — polled every 3 s it surfaces a media-node restart well inside
// the ~10 s budget. Cheap: one small GET per tick, same-origin, authenticated.
const JOB_POLL_MS = 3000;

export type CaptureMode = "ingest" | "ws" | "rtc" | "pending";

// Is this a transient (retryable) media-provision failure? A `/jobs/:id/media`
// HTTP 503 (incl. `no capacity available for runner`) means the media server is
// momentarily busy — back off and retry rather than silently degrading the
// screen share to /ingest. Any other non-2xx is a real error we surface instead.
export function isTransientMediaError(e: any): boolean {
  const status = e?.status ?? e?.statusCode;
  const msg = String(e?.message ?? e ?? "");
  // A transport/network-level failure carries no HTTP status: `fetch` rejects
  // with a TypeError (e.g. "Failed to fetch") on a dropped/refused connection.
  // Treat that as a transient blip too, so openMedia retries instead of aborting
  // the share. A status-less plain Error with no transport/fetch signal (e.g. a
  // programming bug) stays non-transient.
  if (status == null && (e instanceof TypeError || /fetch|network|load failed/i.test(msg))) return true;
  return status === 503 || status === 502 || status === 504 || /no capacity available for runner/i.test(msg);
}

export interface LiveCaptureValue {
  /** A capture is running (or starting) in this tab. */
  sharing: boolean;
  busy: boolean;
  error: string | null;
  /** The job this session is capturing, null before start and after stop. */
  jobId: string | null;
  /** The most recent job this session captured; retained after stop so the
   *  detail stage can tell the capture it shows is its own. */
  lastJobId: string | null;
  /** The live capture stream to attach to a <video srcObject>. */
  stream: MediaStream | null;
  mode: CaptureMode;
  /** ms timestamp the share started (for elapsed). */
  startedAt: number | null;
  /** True after a user/server stop until the next start. */
  stopped: boolean;
  /** Stream-health chips (ADAAAA-7730) for the views. */
  healthChips: ChipView[];
  /** ADAAAA-8105: whether the share's recorder is producing real video bytes.
   *  `stalled` means the clips for this share will be missing, and it is known
   *  WHILE the share is live (not only at stop). */
  recording: RecordingHealth;
  /** The live "recording not captured" copy, `null` while the recorder is
   *  healthy or still starting. */
  recordingNotice: string | null;
  /** ADAAAA-8848: a truthful recording-gap notice once the bounded chunk queue
   *  had to drop bytes because upload could not keep up with capture. `null`
   *  while every produced chunk made it to the server. */
  recordingGapNotice: string | null;
  start: (gameHint: string, decideKnob?: { cadenceSec: 3 | 5; rateCapPer300s: number | null }) => Promise<void>;
  stop: () => Promise<void>;
  dismissError: () => void;
}

const noop = async () => {};

const LiveCaptureContext = createContext<LiveCaptureValue>({
  sharing: false,
  busy: false,
  error: null,
  jobId: null,
  lastJobId: null,
  stream: null,
  mode: "pending",
  startedAt: null,
  stopped: false,
  healthChips: [],
  recording: "pending",
  recordingNotice: null,
  recordingGapNotice: null,
  start: noop,
  stop: noop,
  dismissError: () => {},
});

/** Read the tab's capture session. Outside the provider this is an inert view
 *  (no share, nothing to stop), which keeps SSR/component tests provider-free. */
export function useLiveCapture(): LiveCaptureValue {
  return useContext(LiveCaptureContext);
}

export function LiveCaptureProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { reasoningEffort } = useSettings();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [stopped, setStopped] = useState(false);
  const [mode, setMode] = useState<CaptureMode>("pending");

  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const modeRef = useRef<CaptureMode>("pending");
  // True while we're intentionally stopping (so reconnects never fire on a user
  // stop). Consecutive reconnect attempts are reset on a successful open.
  const stoppingRef = useRef(false);
  const rcRef = useRef(0);
  // Guards a double start (quick double click or a StrictMode remount): one
  // getDisplayMedia + one POST /jobs per start, ever.
  const startingRef = useRef(false);
  // ADAAAA-8848: the bounded chunk queue owns the in-flight recording uploads.
  // Finalize awaits its flush (plus the rec.stop() flush) BEFORE POST /stop so
  // the recording is complete when the server cuts clips (ADAAAA-6522).
  // Bytes the recorder has PRODUCED (before upload) this share, plus the type it
  // actually chose. Feeds the live health readout below (ADAAAA-8055/8105).
  const recStatsRef = useRef<{ bytes: number; startedAt: number }>({ bytes: 0, startedAt: 0 });
  // ADAAAA-8105: chunks are uploaded through ONE serial queue so the server's
  // append-only recording file keeps chunk order (two overlapping POSTs could
  // land out of order and corrupt the container), and so the chunks a probe
  // buffered before commit are flushed ahead of the ones that follow.
  // ADAAAA-8848: that queue is now BOUNDED (30 chunks = ~30 s): overflow drops
  // the oldest chunk and raises a recording-gap notice, so memory tracks a fixed
  // buffer instead of growing with the share's duration.
  const queueRef = useRef<BoundedRecordingQueue | null>(null);
  // ADAAAA-8848 (F4): the whole share keeps ONE canvas + ONE 2d context, and the
  // HTTP ingest rail allows at most one POST in flight.
  const frameSamplerRef = useRef<FrameSampler | null>(null);
  const ingestGateRef = useRef<ReturnType<typeof createTickGate> | null>(null);
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [recording, setRecording] = useState<RecordingHealth>("pending");
  // ADAAAA-8848: set once the bounded queue drops a chunk, so the share says its
  // recording has a gap instead of silently shipping an incomplete clip.
  const [recordingGap, setRecordingGap] = useState<RecordingGap | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stream-health strip sources (ADAAAA-7730): only ARRIVAL times and a clip
  // count are read from the job event feed (frame seq etc. stay admin-only).
  const eventsAbortRef = useRef<AbortController | null>(null);
  const obsAtRef = useRef(0);
  const clipsRef = useRef(0);
  const detectingRef = useRef(false);
  const sharingRef = useRef(false);
  // DOM-free sample source for the WS/HTTP fallback rails. The preview <video> is
  // a view now (it unmounts on navigation), so the sampler must not depend on it.
  // A 1px offscreen element is appended to <body> only while sampling is needed.
  const sampleVideoRef = useRef<HTMLVideoElement | null>(null);
  // Deferred teardown so React StrictMode's mount->unmount->mount dev cycle does
  // not stop a live share (the remount cancels the timer below).
  const mountedRef = useRef(false);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Release the share-scoped bounded queue, sampler canvas and ingest gate.
   *  A function (not inline assignments) so TypeScript's narrowing of a ref's
   *  `.current` cannot turn a later call into `never` (ADAAAA-8848). */
  function resetCaptureResources() {
    queueRef.current?.close();
    queueRef.current = null;
    frameSamplerRef.current?.dispose();
    frameSamplerRef.current = null;
    ingestGateRef.current = null;
  }

  /** Build the WebRTC offer -> answer + ICE signaling to the media server. */
  function establishRtc(origin: string, sid: string, capture: MediaStream, iceServers?: RTCIceServer[]) {
    const pc = new RTCPeerConnection(iceServers && iceServers.length ? { iceServers } : undefined);
    pcRef.current = pc;
    const pendingCandidates: any[] = [];
    let pcId = "";
    const sendCandidate = (c: any) => {
      if (!pcId) {
        pendingCandidates.push(c);
        return;
      }
      void fetch(`${origin}/sessions/${sid}/rtc/ice/${pcId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      }).catch(() => {});
    };
    const track = capture.getVideoTracks()[0];
    // ADAAAA-8848 (F1): cap the sender's encode budget. Without this the browser
    // encodes at whatever the capture gives it (a 4K share = 31.6 MB decoded
    // frames) and the encoder pool scales with it.
    const videoSender = track ? pc.addTransceiver(track, { direction: "sendonly" }).sender : null;
    // ADAAAA-7594: attach the captured audio track when the user shared a TAB.
    const audioTrack = capture.getAudioTracks()[0];
    if (audioTrack) pc.addTransceiver(audioTrack, { direction: "sendonly" });
    pc.onicecandidate = (e) => {
      if (e.candidate) sendCandidate(e.candidate.toJSON());
    };
    // Node failover / transport drop -> transparently reconnect (the server
    // re-provisions on a healthy node if the one serving us went down).
    pc.onconnectionstatechange = () => {
      if (stoppingRef.current) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        teardownRtc();
        if (modeRef.current === "rtc") scheduleReconnect(jobIdRef.current || "");
      }
    };
    return pc
      .createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() =>
        fetch(`${origin}/sessions/${sid}/rtc/offer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offer: pc.localDescription }),
        }),
      )
      .then((r) => {
        if (!r.ok) throw new Error(`rtc signaling failed: HTTP ${r.status}`);
        return r.json();
      })
      .then(async ({ answer, pcId: id }) => {
        pcId = id;
        await pc.setRemoteDescription(answer);
        // ADAAAA-8848 (F1): place the 2.5 Mbps / maintain-resolution cap once the
        // sender is negotiated (setParameters rejects before an answer lands).
        await applySenderBounds(videoSender);
        pendingCandidates.forEach(sendCandidate);
        pendingCandidates.length = 0;
      });
  }

  function teardownRtc() {
    const pc = pcRef.current;
    if (pc) {
      try {
        pc.close();
      } catch {
        /* noop */
      }
      pcRef.current = null;
    }
  }

  /**
   * Open the media-server ingest path: prefer WebRTC, else the media WS, else
   * the HTTP /ingest rail. A 200 with neither rail is the ONLY case we degrade
   * to /ingest; a TRANSIENT failure is retried and then surfaced (ADAAAA-7335).
   */
  async function openMedia(id: string, capture: MediaStream): Promise<void> {
    for (let attempt = 0; attempt <= MAX_MEDIA_RETRIES; attempt++) {
      try {
        const media = await api<{ wsUrl?: string; mediaOrigin?: string; mediaSessionId?: string; rtc?: boolean; iceServers?: RTCIceServer[] }>(
          `/jobs/${id}/media`,
          { method: "POST", body: {} },
        );
        if (media?.rtc && media.mediaOrigin && media.mediaSessionId) {
          modeRef.current = "rtc";
          setMode("rtc");
          try {
            await establishRtc(media.mediaOrigin, media.mediaSessionId, capture, media.iceServers);
            rcRef.current = 0;
            return;
          } catch (e) {
            console.error("rtc establish failed, falling back", e);
            teardownRtc();
          }
        }
        if (media?.wsUrl) {
          modeRef.current = "ws";
          setMode("ws");
          const ws = new WebSocket(media.wsUrl);
          wsRef.current = ws;
          ws.onopen = () => {
            rcRef.current = 0;
          };
          ws.onerror = () => {
            try {
              ws.close();
            } catch {
              /* noop */
            }
          };
          ws.onclose = () => {
            if (wsRef.current === ws) wsRef.current = null;
            if (stoppingRef.current || modeRef.current !== "ws") return;
            scheduleReconnect(id);
          };
          return new Promise<void>((resolve) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => resolve(), { once: true });
          });
        }
        modeRef.current = "ingest";
        setMode("ingest");
        return;
      } catch (e: any) {
        if (!isTransientMediaError(e)) throw e;
        if (attempt < MAX_MEDIA_RETRIES) await sleep(Math.min(600 * 2 ** attempt, 4000));
      }
    }
    throw new Error("Media pipeline busy — retry. The media server has no free analyze slot right now.");
  }

  function scheduleReconnect(id: string) {
    if (stoppingRef.current || !streamRef.current) return;
    if (rcRef.current >= MAX_RECONNECT) {
      modeRef.current = "ingest";
      setMode("ingest");
      setError("Media connection dropped — sharing continued on the degraded fallback rail. Stop and reshare to restore live RTC.");
      return;
    }
    const delay = Math.min(800 * 2 ** rcRef.current, 5000);
    rcRef.current += 1;
    modeRef.current = "pending";
    setMode("pending");
    setTimeout(() => {
      if (!stoppingRef.current && streamRef.current) void openMedia(id, streamRef.current);
    }, delay);
  }

  /** Upload one MediaRecorder chunk as RAW BYTES (ADAAAA-8848 F3 — no base64 /
   *  data-URL copy in the hot path), retrying a transient failure before
   *  surfacing. The queue serialises chunks because the server appends them to
   *  one file. */
  async function uploadRecordingChunk(blob: Blob, mime: string): Promise<void> {
    const id = jobIdRef.current;
    if (!id) return;
    for (let i = 0; i < 4; i++) {
      try {
        await postRecordingChunk(id, blob, mime, getToken());
        return;
      } catch {
        if (i === 3) {
          if (jobIdRef.current === id) {
            setError("Recording upload failed — highlight clips may be incomplete. Check your connection and stop again.");
          }
          return;
        }
        await sleep(400 * (i + 1));
      }
    }
  }

  /** The queue belongs to ONE share: created on start, closed on stop. */
  function ensureRecordingQueue(): BoundedRecordingQueue {
    if (!queueRef.current) {
      queueRef.current = new BoundedRecordingQueue({
        limit: RECORDING_QUEUE_LIMIT,
        upload: ({ blob, mime }) => uploadRecordingChunk(blob, mime),
        onGap: (gap) => setRecordingGap(gap),
      });
    }
    return queueRef.current;
  }

  /** Queue one MediaRecorder chunk for upload, in order. Every chunk of a share
   *  is appended to ONE file server-side, so overlapping POSTs could reorder the
   *  bytes and corrupt the container — and the chunks a probe buffered before
   *  commit must go out ahead of the chunks that follow it. */
  function queueRecordingChunk(data: Blob, mime: string) {
    ensureRecordingQueue().push(data, mime);
  }

  /** One ladder arm kept running while we decide whether it can encode. The
   *  chunks it produces during the probe are HELD (not uploaded): if the arm
   *  wins they are the recording's first chunks, and if it loses they are a
   *  header we must not append to the file. */
  interface ProbeArm {
    mime: string;
    rec: MediaRecorder;
    bytes: number;
    held: Blob[];
    /** When this arm started, so health measures from the recorder's real
     *  start (a walk that tried two arms first is older than one window). */
    startedAt: number;
  }

  /** Start `mime` and watch it for `ENCODER_PROBE_MS`. Resolves as soon as the
   *  arm proves itself (real bytes), on an encoder error, or at the deadline. */
  function probeRecorderArm(
    capture: MediaStream,
    mime: string,
    onChunk: (arm: ProbeArm, blob: Blob) => void,
  ): Promise<ProbeArm | null> {
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(capture, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
    } catch {
      return Promise.resolve(null); // constructor rejects this mime outright
    }
    const arm: ProbeArm = { mime, rec, bytes: 0, held: [], startedAt: Date.now() };
    return new Promise<ProbeArm>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(arm);
      };
      const timer = setTimeout(finish, ENCODER_PROBE_MS);
      rec.ondataavailable = (e) => {
        if (!e.data || e.data.size <= 0) return;
        arm.bytes += e.data.size;
        onChunk(arm, e.data);
        if (arm.bytes >= ENCODER_PROBE_MIN_BYTES) finish();
      };
      // A recorder that errors emits nothing further: stop waiting for it.
      rec.onerror = () => finish();
      try {
        rec.start(1000); // 1 s chunks keep the uploads small
      } catch {
        finish();
      }
    });
  }

  /** ADAAAA-8105: PROVE the chosen container can encode before committing to it.
   *
   *  `isTypeSupported` is not a capability answer: job `ccc9f1aa` claimed
   *  `video/mp4;codecs=avc1`, accepted `start()` and then emitted zero chunks,
   *  so nothing was uploaded and the whole recording was lost silently. Each
   *  ladder arm now runs for `ENCODER_PROBE_MS` and must produce real bytes
   *  (`ENCODER_PROBE_MIN_BYTES`) before it is committed; a header-only or silent
   *  arm is stopped and the next arm is tried.
   *
   *  The winning arm keeps running, so a healthy browser records from the same
   *  instant it did before this change — the probe IS the first chunk. Only a
   *  failing arm costs timeline (~1.5 s lost mid-window, well inside the 7 s
   *  clip pad), and that arm produced nothing to begin with. */
  async function commitRecordingArm(capture: MediaStream): Promise<MediaRecorder | null> {
    // Probe the WHOLE ladder, with the claimed containers first. Filtering by
    // `isTypeSupported` first was the ADAAAA-8107 AC2 bug: a browser that
    // claims only avc1 left a one-arm ladder, that arm failed its own probe,
    // and the caller committed it anyway (0 chunks, no recording at all).
    const candidates = recordingProbeCandidates((m) => MediaRecorder.isTypeSupported(m));
    const arms = new Map<string, ProbeArm>();
    let committed: ProbeArm | null = null;

    const commit = await chooseRecordingMime(candidates, async (mime) => {
      const arm = await probeRecorderArm(capture, mime, (a, blob) => {
        if (a === committed) {
          // Keep the live health counter on the SAME object the probe filled
          // (ADAAAA-8110 finding 2): it used to be frozen at the probe
          // snapshot, so a healthy mp4 share whose first frames flushed after
          // the window read 0 bytes and showed a false "nothing is recorded".
          recStatsRef.current.bytes += blob.size;
          queueRecordingChunk(blob, a.mime);
        } else a.held.push(blob);
      });
      if (!arm) return 0;
      arms.set(mime, arm);
      return arm.bytes;
    });

    // What to do with the walk (ADAAAA-8110 finding 1): commit a proven arm,
    // keep a header-only arm running, or drop a ladder that was entirely
    // silent and let the browser pick its own container.
    const plan = recordingCommitPlan(commit);

    // Stop every arm that is not the one being committed, so no second
    // recorder keeps encoding (and no probe arm keeps a claim on the stream).
    for (const [mime, arm] of arms) {
      if (plan.mode !== "default" && mime === plan.mime) continue;
      stopRecorderQuietly(arm.rec);
    }

    const kept = plan.mode === "default" ? null : arms.get(plan.mime) ?? null;
    if (kept) {
      recStatsRef.current = { bytes: kept.bytes, startedAt: kept.startedAt };
      recRef.current = kept.rec;
      // Flush the chunks the probe held, in order, ahead of the chunks that
      // follow (the chain guarantees the order). Do it BEFORE flipping
      // `committed`, so a chunk that lands mid-flush cannot overtake them.
      for (const blob of kept.held) queueRecordingChunk(blob, kept.mime);
      kept.held.length = 0;
      committed = kept;
      return kept.rec;
    }

    // Every arm was silent (the measured AC2 shape: the only claimed arm
    // committed nothing at all): fall back to the browser's own default
    // container rather than committing a recorder that uploads zero bytes.
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(capture);
    } catch {
      return null;
    }
    recStatsRef.current = { bytes: 0, startedAt: Date.now() };
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size <= 0) return;
      recStatsRef.current.bytes += e.data.size;
      queueRecordingChunk(e.data, rec.mimeType || "");
    };
    try {
      rec.start(1000);
    } catch {
      return null;
    }
    recRef.current = rec;
    return rec;
  }

  function stopRecorderQuietly(rec: MediaRecorder) {
    try {
      if (rec.state !== "inactive") rec.stop();
    } catch {
      /* already gone */
    }
  }

  /** ADAAAA-8105: keep reading the recorder's health for the WHOLE share.
   *
   *  The old check was a single timeout at `RECORDING_STALL_MS`: it could fire
   *  once, so a recorder that died 30 s into a healthy share was never reported,
   *  and a recorder that died before its first chunk (`state` flipped to
   *  inactive, zero chunks) was treated as "not running" and stayed silent until
   *  stop. The views now render `recordingNotice` while the share is live. */
  function startRecordingMonitor(jobId: string) {
    stopRecordingMonitor();
    const tick = () => {
      if (stoppingRef.current || jobIdRef.current !== jobId) return;
      const rec = recRef.current;
      const stats = recStatsRef.current;
      if (!rec || !stats.startedAt) return;
      const next = recordingHealth({
        bytes: stats.bytes,
        ms: Date.now() - stats.startedAt,
        state: rec.state,
      });
      setRecording((prev: RecordingHealth) => (prev === next ? prev : next));
    };
    healthTimerRef.current = setInterval(tick, RECORDING_HEALTH_POLL_MS);
    tick();
  }

  function stopRecordingMonitor() {
    if (healthTimerRef.current) clearInterval(healthTimerRef.current);
    healthTimerRef.current = null;
  }


  /** Await the share's bounded chunk queue before `POST /stop`, bounded at 5 s
   *  (the same budget the old pending-upload wait used, ADAAAA-6522). */
  async function flushRecordingUploads() {
    const queue = queueRef.current;
    if (!queue) return;
    await Promise.race([queue.flush(), sleep(5000)]);
  }

  function stopJobPoll() {
    if (jobPollRef.current) clearInterval(jobPollRef.current);
    jobPollRef.current = null;
  }

  /** Clear every capture resource and put the views in their stopped state. */
  function finishCapture() {
    stopRecordingMonitor();
    setRecording("pending");
    if (ivRef.current) clearInterval(ivRef.current);
    ivRef.current = null;
    // ADAAAA-8848: release the share's bounded queue, sampler canvas and gate.
    resetCaptureResources();
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    teardownRtc();
    modeRef.current = "pending";
    setMode("pending");
    const sample = sampleVideoRef.current;
    if (sample) {
      sample.srcObject = null;
      try {
        sample.remove();
      } catch {
        /* noop */
      }
      sampleVideoRef.current = null;
    }
    streamRef.current = null;
    setStream(null);
    seqRef.current = 0;
    sharingRef.current = false;
    setSharing(false);
    jobIdRef.current = null;
    setJobId(null);
    setStopped(true);
  }

  /**
   * End the share from the SERVER's answer, not the user's click (ADAAAA-7700):
   * once the job row is terminal we stop capturing, release the tracks and show
   * the attributed message. No /stop call — the job is already finalized.
   */
  async function endFromServer(message: string | null) {
    stoppingRef.current = true;
    rcRef.current = 0;
    stopJobPoll();
    abortCaptureEvents();
    const rec = recRef.current;
    recRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    finishCapture();
    if (message) setError(message);
  }

  /** Subscribe to the capture job's own event feed for freshness/activity. */
  function subscribeCaptureEvents(id: string) {
    abortCaptureEvents();
    obsAtRef.current = Date.now();
    clipsRef.current = 0;
    detectingRef.current = false;
    const ac = new AbortController();
    eventsAbortRef.current = ac;
    readSSE(
      `/jobs/${id}/events`,
      getToken(),
      (name) => {
        if (name === "observation") {
          obsAtRef.current = Date.now();
          detectingRef.current = true;
        } else if (name === "candidate") {
          detectingRef.current = true;
        } else if (name === "highlight") {
          clipsRef.current += 1;
        }
      },
      ac.signal,
    ).catch(() => {
      /* a dropped event feed only costs freshness accuracy */
    });
  }

  function abortCaptureEvents() {
    if (eventsAbortRef.current) eventsAbortRef.current.abort();
    eventsAbortRef.current = null;
  }

  /** Poll the job row while sharing; surface a server-side end. */
  function startJobPoll(id: string) {
    stopJobPoll();
    jobPollRef.current = setInterval(() => {
      if (stoppingRef.current) return;
      void api<{ job: { status?: string; failureReason?: string | null; error?: string | null } }>(`/jobs/${id}`)
        .then((res) => {
          if (stoppingRef.current || jobIdRef.current !== id) return;
          const notice = captureEndedNotice(res?.job);
          if (notice.stop) void endFromServer(notice.message);
        })
        .catch(() => {
          /* transient poll failure: the next tick retries */
        });
    }, JOB_POLL_MS);
  }

  /** Create the DOM-free sample video used by the WS/HTTP fallback rails. */
  function ensureSampleVideo(capture: MediaStream): HTMLVideoElement {
    let v = sampleVideoRef.current;
    if (!v) {
      v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("aria-hidden", "true");
      // Offscreen but still rendered: a detached/hidden video can be throttled
      // in Chrome and would sample stale frames.
      v.style.position = "fixed";
      v.style.left = "-10000px";
      v.style.top = "0";
      v.style.width = "1px";
      v.style.height = "1px";
      v.style.opacity = "0";
      v.style.pointerEvents = "none";
      document.body.appendChild(v);
      sampleVideoRef.current = v;
    }
    v.srcObject = capture;
    void v.play().catch(() => {});
    return v;
  }

  async function start(gameHint: string, decideKnob?: { cadenceSec: 3 | 5; rateCapPer300s: number | null }) {
    if (startingRef.current || sharingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    setStopped(false);
    // ADAAAA-8848: a share owns ONE bounded queue, ONE sampler canvas and one
    // ingest gate. Reset them at start so a stopped share's buffer or drop count
    // can never leak into the next one.
    setRecordingGap(null);
    resetCaptureResources();
    try {
      // ADAAAA-8848 (F1): ask for at most 1080p30. Native pixels (a 4K share =
      // 31.6 MB decoded per frame) are not read by anything downstream, and they
      // are the largest single contributor to the tab OOM on share.
      const capture = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CAPTURE_CONSTRAINTS);
      if (stoppingRef.current) {
        capture.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = capture;
      setStream(capture);
      setStartedAt(Date.now());
      ensureSampleVideo(capture);

      // ONE job per start. Navigation happens on the id in the 202; it must
      // never re-submit this request.
      //
      // ADAAAA-8544: the decide knob the user set on `/app` rides this POST. It
      // is omitted when the caller has no posture (an older caller), which the
      // route resolves to the shipped default exactly as before.
      const job = await api<{ job: { id: string } }>("/jobs", {
        body: { source: "browser", gameHint, ...(decideKnob ?? {}) },
      });
      jobIdRef.current = job.job.id;
      setJobId(job.job.id);
      setLastJobId(job.job.id);
      startJobPoll(job.job.id);
      subscribeCaptureEvents(job.job.id);
      stoppingRef.current = false;
      rcRef.current = 0;
      // Navigate BEFORE the media handshake so the user is on the detail page
      // within ~1 s of the 202 (AC1). The provider lives above <Routes>, so
      // this route change does not unmount the capture.
      navigate(`/app/jobs/${job.job.id}`);

      await openMedia(job.job.id, capture);

      // ADAAAA-8055/8105: the ladder is ordered by containers this rail has
      // actually produced (see recordingCodec.ts), and every arm must now PROVE
      // it can encode before it is committed. `isTypeSupported('video/mp4;codecs=avc1')`
      // is true in browsers that then record a header and no frames — or, as
      // measured on job `ccc9f1aa`, nothing at all, which lost the whole
      // recording with no clip and no warning until stop.
      const rec = await commitRecordingArm(capture);
      if (rec) startRecordingMonitor(job.job.id);

      // WS / HTTP fallback only: sample the stream -> JPEG -> push to the media
      // WS (or /ingest). In RTC mode the media server decodes the track itself.
      // ADAAAA-8848 (F4): ONE canvas + ONE 2d context for the whole share (not a
      // new pair per tick), and at most one ingest POST in flight.
      if (modeRef.current === "ws" || modeRef.current === "ingest") {
        const sampler = (frameSamplerRef.current ??= createFrameSampler());
        const gate = (ingestGateRef.current ??= createTickGate());
        ivRef.current = setInterval(() => {
          const v = sampleVideoRef.current;
          if (!v || !v.videoWidth) return;
          const seq = seqRef.current;
          const id = jobIdRef.current;
          if (modeRef.current === "ws") {
            const image = sampler.capture(v);
            if (!image) return;
            seqRef.current = seq + 1;
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ seq, timestamp: seq, image, reasoningEffort }));
            }
          } else if (id && gate.tryEnter()) {
            // Skip the tick entirely while one ingest POST is pending: a slow
            // uplink must not stack requests (ADAAAA-8848 F4).
            try {
              const image = sampler.capture(v);
              if (!image) return;
              seqRef.current = seq + 1;
              api(`/jobs/${id}/ingest`, { body: { seq, timestamp: seq, image, reasoningEffort } })
                .catch(() => {})
                .finally(() => gate.leave());
            } catch {
              gate.leave();
            }
          }
        }, 1000);
      }

      sharingRef.current = true;
      setSharing(true);
      const track = capture.getVideoTracks()[0];
      track.onended = () => void stopInternal(true); // browser's "Stop sharing"
    } catch (e: any) {
      if (e?.name === "NotAllowedError") setError("Screen share was denied. Click Start to share again.");
      else if (String(e?.status || e?.message || "").includes("402")) setError(`${e.message}`);
      else setError(String(e?.message || e));
      stopJobPoll();
      abortCaptureEvents();
      teardownRtc();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const id = jobIdRef.current;
      streamRef.current = null;
      jobIdRef.current = null;
      setStream(null);
      setJobId(null);
      if (id) {
        try {
          await api(`/jobs/${id}/stop`, { body: {} });
        } catch {
          /* job finalization is best-effort here */
        }
      }
      modeRef.current = "pending";
      setMode("pending");
      sharingRef.current = false;
      setSharing(false);
      setStopped(true);
      resetCaptureResources();
      const sample = sampleVideoRef.current;
      if (sample) {
        sample.srcObject = null;
        sample.remove();
        sampleVideoRef.current = null;
      }
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  }

  async function stopInternal(andNotify: boolean) {
    stoppingRef.current = true;
    rcRef.current = 0;
    stopJobPoll();
    abortCaptureEvents();
    if (ivRef.current) clearInterval(ivRef.current);
    ivRef.current = null;
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    teardownRtc();
    modeRef.current = "pending";
    setMode("pending");
    const rec = recRef.current;
    recRef.current = null;
    if (rec && rec.state !== "inactive") {
      // Wait for the recorder's final dataavailable flush BEFORE POST /stop so
      // every chunk (incl. the last) reaches the server (ADAAAA-6522).
      const flushed = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      if (andNotify) {
        await Promise.race([flushed, sleep(3000)]);
        await flushRecordingUploads();
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    const id = jobIdRef.current;
    if (id && andNotify) {
      try {
        await api(`/jobs/${id}/stop`, { body: {} });
      } catch {
        /* job may already be finalized */
      }
    }
    finishCapture();
  }

  async function stop() {
    await stopInternal(true);
  }

  useEffect(() => {
    mountedRef.current = true;
    if (teardownTimerRef.current !== null) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }
    return () => {
      mountedRef.current = false;
      // Defer: StrictMode unmount+remount is synchronous, so the remount above
      // clears this timer and a live share survives the dev double-mount.
      teardownTimerRef.current = setTimeout(() => {
        teardownTimerRef.current = null;
        if (!mountedRef.current) void stopInternal(false);
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The 5-chip strip sampler (ADAAAA-7730). Enabled only while a share is live.
  const healthChips = useStreamHealth({
    enabled: sharing,
    getPeer: () => pcRef.current,
    getLink: () => ({ sharing: sharingRef.current, mode: modeRef.current, reconnectAttempt: rcRef.current }),
    getObservationAgeMs: () => (obsAtRef.current > 0 ? Date.now() - obsAtRef.current : null),
    getActivity: () => ({ clips: clipsRef.current, detecting: detectingRef.current }),
  });

  const value: LiveCaptureValue = {
    sharing,
    busy,
    error,
    jobId,
    lastJobId,
    stream,
    mode,
    startedAt,
    stopped,
    healthChips,
    recording,
    // ADAAAA-8105: one persistent notice, driven by the monitor above, so the
    // loss is visible DURING the share (the job page the user is routed to
    // rendered no capture health at all before this).
    recordingNotice: sharing && recording === "stalled" ? RECORDING_STALL_NOTICE : null,
    // ADAAAA-8848: once the bounded queue had to drop recording, say so — a gap
    // is truthful and stays visible (the server file really lacks those bytes).
    recordingGapNotice: recordingGap ? recordingGapNotice(recordingGap) : null,
    start,
    stop,
    dismissError: () => setError(null),
  };

  return <LiveCaptureContext.Provider value={value}>{children}</LiveCaptureContext.Provider>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
