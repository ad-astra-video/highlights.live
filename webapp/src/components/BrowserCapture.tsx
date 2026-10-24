import { useEffect, useRef, useState } from "react";
import { Square, Play, Share2 } from "lucide-react";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";

const MAX_RECONNECT = 6; // consecutive media reconnect attempts before falling back to /ingest
// Transient /jobs/:id/media failures (e.g. HTTP 503 `no capacity available for
// runner` when the perceive runner's SessionRegistry is at capacity, ADAAAA-7335)
// are retried with backoff this many times BEFORE we surface. We deliberately do
// NOT silently degrade the screen share onto the HTTP /ingest rail on a transient
// media error — that was the bug (ADAAAA-7335).
const MAX_MEDIA_RETRIES = 3;

// Is this a transient (retryable) media-provision failure? A `/jobs/:id/media`
// HTTP 503 (incl. `no capacity available for runner` when the perceive runner's
// SessionRegistry is at capacity) means the media server is momentarily busy —
// back off and retry rather than silently degrading the screen share to /ingest.
// Any other non-2xx is a real error we surface instead. (ADAAAA-7335)
export function isTransientMediaError(e: any): boolean {
  const status = e?.status ?? e?.statusCode;
  const msg = String(e?.message ?? e ?? "");
  // A transport/network-level failure carries no HTTP status: `fetch` rejects
  // with a TypeError (e.g. "Failed to fetch") on a dropped/refused connection.
  // Treat that as a transient blip too, so openMedia retries instead of
  // aborting the share. A status-less plain Error with no transport/fetch
  // signal (e.g. a programming bug) stays non-transient. (ADAAAA-7335 follow-up)
  if (status == null && (e instanceof TypeError || /fetch|network|load failed/i.test(msg))) return true;
  return (
    status === 503 ||
    status === 502 ||
    status === 504 ||
    /no capacity available for runner/i.test(msg)
  );
}

// Client-side capture: getDisplayMedia (screen / tab / window). The REAL pixels
// never leave the browser as a big stream:
//   - WebRTC ingest (primary): the display video track is sent live over a
//     WebRTC connection to the media server, which decodes + samples the stream
//     onto the orchestrator video-in rail (C1). No canvas sampling happens in
//     the browser.
//   - WS / HTTP fallbacks: if the media server has no WebRTC ingest yet, we
//     fall back to the previous behaviour (sample the preview to a small canvas
//     and push JPEG frames over the media-server WS, else the /ingest rail).
// In every mode a MediaRecorder recording is chunked up so clips can be cut
// server-side.
export function BrowserCapture({ gameHint, onDone }: { gameHint: string; onDone: () => void }) {
  const { reasoningEffort } = useSettings();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const modeRef = useRef<"ingest" | "ws" | "rtc" | "pending">("pending");
  // True while we're intentionally stopping (so reconnects never fire on user
  // stop / unmount). Consecutive reconnect attempts, reset on a successful open.
  const stoppingRef = useRef(false);
  const rcRef = useRef(0);
  // In-flight MediaRecorder chunk uploads to the /recording rail. Finalize
  // awaits these (plus the rec.stop() flush) BEFORE POST /stop so the recording
  // is complete when the server cuts clips — the missing piece that left an
  // empty clipUri on every highlight (ADAAAA-6522).
  const pendingUploadsRef = useRef<Set<Promise<void>>>(new Set());

  /** Build the WebRTC offer -> answer + ICE signaling to the media server.
   *  The media server assigns the pcId on the offer round-trip, so candidates
   *  that gather before then are buffered and flushed once pcId is known. */
  function establishRtc(origin: string, sid: string, stream: MediaStream) {
    const pc = new RTCPeerConnection();
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
    const track = stream.getVideoTracks()[0];
    if (track) pc.addTransceiver(track, { direction: "sendonly" });
    // Trickle ICE candidates to the media server as they gather.
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
        })
      )
      .then((r) => {
        if (!r.ok) throw new Error(`rtc signaling failed: HTTP ${r.status}`);
        return r.json();
      })
      .then(async ({ answer, pcId: id }) => {
        pcId = id;
        await pc.setRemoteDescription(answer);
        // Flush any candidates that gathered during the offer round-trip.
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

  // Open the media-server ingest path: prefer WebRTC (C1), else the media WS,
  // else the HTTP /ingest rail. A HTTP 200 with neither an RTC nor a WS rail is
  // the ONLY case we degrade to /ingest (genuine "no media-server rail"). A
  // TRANSIENT /media failure (HTTP 503 `no capacity available for runner`, when
  // the perceive runner's SessionRegistry is at capacity) is retried with
  // backoff and then SURFACED — we never silently drop the screen share onto
  // the degrading /ingest rail (ADAAAA-7335). On any unexpected network-level
  // failure we re-ask the server for the current / freshly-rerouted details (it
  // reuses the session from the DB, or re-provisions on a healthy node) and
  // reconnect — seamless.
  async function openMedia(jobId: string, stream: MediaStream): Promise<void> {
    for (let attempt = 0; attempt <= MAX_MEDIA_RETRIES; attempt++) {
      try {
        const media = await api<{ wsUrl?: string; mediaOrigin?: string; mediaSessionId?: string; rtc?: boolean }>(
          `/jobs/${jobId}/media`,
          { method: "POST", body: {} }
        );
        if (media?.rtc && media.mediaOrigin && media.mediaSessionId) {
          modeRef.current = "rtc";
          try {
            await establishRtc(media.mediaOrigin, media.mediaSessionId, stream);
            rcRef.current = 0;
            return;
          } catch (e) {
            // RTC establishment failed (e.g. older media server has no RTC
            // routes): fall through to the WS path.
            console.error("rtc establish failed, falling back", e);
            teardownRtc();
          }
        }
        if (media?.wsUrl) {
          modeRef.current = "ws";
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
            scheduleReconnect(jobId);
          };
          return new Promise<void>((resolve) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => resolve(), { once: true });
          });
        }
        // HTTP 200 but no RTC and no WS rail — the media server genuinely has no
        // media rail for this job. ONLY here do we degrade to /ingest.
        modeRef.current = "ingest";
        return;
      } catch (e: any) {
        // A non-transient /media error (404/403/409/…) is not a capacity blip and
        // is never the "no rail" case — surface it rather than silently degrade.
        if (!isTransientMediaError(e)) throw e;
        if (attempt < MAX_MEDIA_RETRIES) await sleep(Math.min(600 * 2 ** attempt, 4000));
      }
    }
    // Every retry exhausted on a transient capacity/busy error: do NOT silently
    // fall back to /ingest. Surface an actionable message so the operator knows
    // the media server is busy and can retry.
    throw new Error("Media pipeline busy — retry. The media server has no free analyze slot right now.");
  }

  function scheduleReconnect(jobId: string) {
    if (stoppingRef.current || !streamRef.current) return;
    if (rcRef.current >= MAX_RECONNECT) {
      // The established media connection dropped and reconnect attempts are
      // exhausted. We keep the (already-established) share alive, but on the
      // degraded HTTP /ingest rail and now VISIBLY — surface it rather than
      // silently switching, the same silent-/ingest class the provisioning fix
      // removed (ADAAAA-7335 follow-up).
      modeRef.current = "ingest";
      setError("Media connection dropped — sharing continued on the degraded fallback rail. Stop and reshare to restore live RTC.");
      return;
    }
    const delay = Math.min(800 * 2 ** rcRef.current, 5000);
    rcRef.current += 1;
    modeRef.current = "pending";
    setTimeout(() => {
      if (!stoppingRef.current && streamRef.current) void openMedia(jobId, streamRef.current);
    }, delay);
  }

  // Upload one MediaRecorder chunk to the /recording rail, retrying on a
  // transient failure (drop / network / base64) before surfacing. The promise is
  // tracked so finalize can await every chunk before POST /stop, and a persistent
  // failure is surfaced to the user instead of being silently swallowed
  // (ADAAAA-6522).
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
      // Persistent failure: surface rather than silently drop the chunk (a lost
      // chunk means a truncated/absent recording -> empty clipUri at stop).
      if (jobIdRef.current === id) {
        setError("Recording upload failed — highlight clips may be incomplete. Check your connection and stop again.");
      }
    };
    const p = doRetry().finally(() => pendingUploadsRef.current.delete(p));
    pendingUploadsRef.current.add(p);
    return p;
  }

  // Await every in-flight recording chunk upload, re-sampling so a chunk enqueued
  // just after we sampled (e.g. the final rec.stop() flush) is also awaited, but
  // bounded so finalize never hangs the UI if the network is down.
  async function flushRecordingUploads() {
    for (let i = 0; i < 20; i++) {
      const pending = [...pendingUploadsRef.current];
      if (pending.length === 0) return;
      await Promise.race([Promise.allSettled(pending), sleep(250)]);
      if (pendingUploadsRef.current.size === 0) return;
    }
  }

  useEffect(() => {
    const onUnmount = () => {
      stopInternal(false);
    };
    return onUnmount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      // audio:true carries tab sound so clips + (future) audio analysis get real
      // audio. Chrome only yields audio when sharing a TAB (screen/window have none).
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // create the browser-capture job on the server
      const job = await api<{ job: { id: string } }>("/jobs", { body: { source: "browser", gameHint } });
      jobIdRef.current = job.job.id;

      // Media-server handshake: stream the live video track over WebRTC
      // (browser -> media server -> orchestrator video-in), with transparent
      // reconnect + reroute on node failover. Falls back to WS / HTTP /ingest.
      stoppingRef.current = false;
      rcRef.current = 0;
      await openMedia(job.job.id, stream);

      const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          blobToBase64(e.data).then((b64) => {
            uploadRecordingChunk(b64, mime);
          });
        }
      };
      rec.start(1000); // 1s chunks keep the uploads small
      recRef.current = rec;

      // WS / HTTP fallback only: sample the shared video element -> JPEG ->
      // push to the media-server WS (or /ingest). In RTC mode the media server
      // decodes the live track itself, so no sampling happens here.
      if (modeRef.current === "ws" || modeRef.current === "ingest") {
        ivRef.current = setInterval(() => {
          const v = videoRef.current;
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
            api(`/jobs/${id}/ingest`, {
              body: { seq, timestamp: seq, image, reasoningEffort },
            }).catch(() => {});
          }
        }, 1000);
      }

      setSharing(true);
      const track = stream.getVideoTracks()[0];
      track.onended = () => stopInternal(true); // user clicked the browser's stop-share affordance
    } catch (e: any) {
      if (e?.name === "NotAllowedError") setError("Screen share was denied. Click Start to share again.");
      else if (String(e?.status || e?.message || "").includes("402")) setError(`${e.message}`);
      else setError(String(e?.message || e));
      // We acquired a capture stream and/or created a browser job but the media
      // handshake failed (e.g. a transient /media 503 capacity error surfaced by
      // openMedia). Stop the local tracks and finalize the now-unused job so the
      // screen-share affordance/mic don't stay live and we don't leak the job
      // (ADAAAA-7335).
      if (ivRef.current) clearInterval(ivRef.current);
      ivRef.current = null;
      teardownRtc();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const id = jobIdRef.current;
      jobIdRef.current = null;
      if (id) {
        try {
          await api(`/jobs/${id}/stop`, { body: {} });
        } catch {
          /* job finalization is best-effort here */
        }
      }
      setSharing(false);
    } finally {
      setBusy(false);
    }
  }

  async function stopInternal(andNotify: boolean) {
    stoppingRef.current = true;
    rcRef.current = 0;
    if (ivRef.current) clearInterval(ivRef.current);
    ivRef.current = null;
    // Media path: closing the WebRTC/WS (after a short reconnect grace on the
    // media server) stops paying + releases the perceive slot; /stop is idempotent.
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    teardownRtc();
    modeRef.current = "pending";
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") {
      // Wait for the recorder's final dataavailable flush BEFORE POST /stop so
      // every recording chunk (incl. the last one) reaches the server and the
      // clip-cut sees a complete recording. Setting onstop before stop() so we
      // never miss the stop event; the flush below re-samples to catch the final
      // chunk's upload promise once blobToBase64 resolves (ADAAAA-6522).
      const flushed = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
      if (andNotify) {
        await Promise.race([flushed, sleep(3000)]);
        await flushRecordingUploads();
      }
    }
    // stop the sampler + tracks
    streamRef.current?.getTracks().forEach((t) => t.stop());
    const id = jobIdRef.current;
    if (id && andNotify) {
      try {
        await api(`/jobs/${id}/stop`, { body: {} });
        onDone();
      } catch {
        /* job may already be finalized */
      }
    }
    jobIdRef.current = null;
    seqRef.current = 0;
    setSharing(false);
  }

  async function stop() {
    await stopInternal(true);
  }

  return (
    <div className="mt-6 rounded-2xl border border-neon/40 bg-black/40 p-4">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-neon">
        <Share2 className="h-4 w-4" /> Client-side capture
        <span className="normal-case text-mut">— pixels stream live to the media server via WebRTC</span>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <video ref={videoRef} muted autoPlay playsInline className="aspect-video w-full max-w-md rounded-lg bg-black" />
        <div className="flex flex-col gap-2">
          {!sharing ? (
            <button className="btn-neon" onClick={start} disabled={busy}>
              <Play className="mr-2 inline h-4 w-4" /> {busy ? "Starting…" : "Share screen / tab / window"}
            </button>
          ) : (
            <button className="btn-neon btn-pink" onClick={stop}>
              <Square className="mr-2 inline h-4 w-4" /> Stop &amp; finalize
            </button>
          )}
          {sharing && (
            <p className="text-xs text-mut">
              Capturing live. Highlight clips are cut from the recording when you stop.
              Use the browser's "Stop sharing" control to end capture early.
            </p>
          )}
        </div>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
    </div>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
