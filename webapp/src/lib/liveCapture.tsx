import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, getToken } from "./api";
import { readSSE } from "./sse";
import { captureEndedNotice } from "./captureLoss";
import { useSettings } from "./settings";
import { blobToBase64 } from "./blobToBase64";
import { RECORDING_STALL_MS, recordingStalled, supportedRecordingMimes } from "./recordingCodec";
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
  start: (gameHint: string) => Promise<void>;
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
  // In-flight MediaRecorder chunk uploads to the /recording rail. Finalize awaits
  // these (plus the rec.stop() flush) BEFORE POST /stop so the recording is
  // complete when the server cuts clips (ADAAAA-6522).
  const pendingUploadsRef = useRef<Set<Promise<void>>>(new Set());
  // Bytes the recorder has PRODUCED (before upload) this share, plus the type it
  // actually chose. Feeds the stall check below (ADAAAA-8055).
  const recStatsRef = useRef<{ bytes: number; startedAt: number }>({ bytes: 0, startedAt: 0 });
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (track) pc.addTransceiver(track, { direction: "sendonly" });
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

  /** Upload one MediaRecorder chunk, retrying a transient failure before
   *  surfacing. The promise is tracked so finalize can await every chunk. */
  function uploadRecordingChunk(b64: string, mime: string): Promise<void> {
    const id = jobIdRef.current;
    if (!id) return Promise.resolve();
    const attempt = async (): Promise<boolean> => {
      try {
        await api(`/jobs/${id}/recording`, { body: { base64: b64, mime } });
        return true;
      } catch {
        return false;
      }
    };
    const doRetry = async (): Promise<void> => {
      for (let i = 0; i < 4; i++) {
        if (await attempt()) return;
        await sleep(400 * (i + 1));
      }
      if (jobIdRef.current === id) {
        setError("Recording upload failed — highlight clips may be incomplete. Check your connection and stop again.");
      }
    };
    const p = doRetry().finally(() => pendingUploadsRef.current.delete(p));
    pendingUploadsRef.current.add(p);
    return p;
  }

  /** ADAAAA-8055: warn (once, during the share) when the recorder has started
   *  but produced no usable video bytes — a container the browser claimed but
   *  cannot encode emits only a header (~752 B mp4 / ~49 B webm). Silent in the
   *  healthy case; the stop path still reports an honest clipError per highlight
   *  and the server refuses to cut from a frame-less recording. */
  function scheduleRecordingStallCheck(jobId: string) {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    stallTimerRef.current = setTimeout(() => {
      stallTimerRef.current = null;
      const rec = recRef.current;
      if (!rec || stoppingRef.current || jobIdRef.current !== jobId) return;
      const stats = recStatsRef.current;
      if (!recordingStalled({ bytes: stats.bytes, ms: Date.now() - stats.startedAt, state: rec.state })) return;
      setError(
        "This browser started a screen recorder that produced no video data, so highlight clips may be missing for this share. Stop and share again (or use another browser) if no clips appear."
      );
    }, RECORDING_STALL_MS);
  }

  /** Await every in-flight recording chunk upload, re-sampling (bounded). */
  async function flushRecordingUploads() {
    for (let i = 0; i < 20; i++) {
      const pending = [...pendingUploadsRef.current];
      if (pending.length === 0) return;
      await Promise.race([Promise.allSettled(pending), sleep(250)]);
      if (pendingUploadsRef.current.size === 0) return;
    }
  }

  function stopJobPoll() {
    if (jobPollRef.current) clearInterval(jobPollRef.current);
    jobPollRef.current = null;
  }

  /** Clear every capture resource and put the views in their stopped state. */
  function finishCapture() {
    if (stallTimerRef.current) {
      clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    }
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

  async function start(gameHint: string) {
    if (startingRef.current || sharingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    setError(null);
    setStopped(false);
    try {
      // audio:true carries tab sound so clips + audio analysis get real audio.
      const capture = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
      const job = await api<{ job: { id: string } }>("/jobs", { body: { source: "browser", gameHint } });
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

      // ADAAAA-8055: the ladder is ordered by containers this rail has actually
      // produced (see recordingCodec.ts). `isTypeSupported('video/mp4;codecs=avc1')`
      // is true in browsers that then record a header and no frames, which left
      // every accepted highlight with "No screen-share recording was captured".
      const mimes = supportedRecordingMimes((m) => MediaRecorder.isTypeSupported(m));
      const mime = mimes[0] ?? "";
      const rec = new MediaRecorder(capture, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
      recStatsRef.current = { bytes: 0, startedAt: Date.now() };
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recStatsRef.current.bytes += e.data.size;
          blobToBase64(e.data).then((b64) => {
            // Report the type the recorder actually chose, so the server names the
            // file after the real container instead of the requested one.
            uploadRecordingChunk(b64, rec.mimeType || mime);
          });
        }
      };
      rec.start(1000); // 1 s chunks keep the uploads small
      recRef.current = rec;
      scheduleRecordingStallCheck(job.job.id);

      // WS / HTTP fallback only: sample the stream -> JPEG -> push to the media
      // WS (or /ingest). In RTC mode the media server decodes the track itself.
      if (modeRef.current === "ws" || modeRef.current === "ingest") {
        ivRef.current = setInterval(() => {
          const v = sampleVideoRef.current;
          if (!v || !v.videoWidth) return;
          const cv = document.createElement("canvas");
          cv.width = 320;
          cv.height = 180;
          const ctx = cv.getContext("2d")!;
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          const image = cv.toDataURL("image/jpeg", 0.6).split(",")[1];
          const seq = seqRef.current++;
          const id = jobIdRef.current;
          if (modeRef.current === "ws") {
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ seq, timestamp: seq, image, reasoningEffort }));
            }
          } else if (id) {
            api(`/jobs/${id}/ingest`, { body: { seq, timestamp: seq, image, reasoningEffort } }).catch(() => {});
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
    start,
    stop,
    dismissError: () => setError(null),
  };

  return <LiveCaptureContext.Provider value={value}>{children}</LiveCaptureContext.Provider>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
