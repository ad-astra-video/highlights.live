import { useEffect, useRef, useState } from "react";
import { Square, Play, Share2 } from "lucide-react";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import {
  makeAnalysisBatcher,
  type AnalysisEvent,
  type AnalysisSessionState,
  type AnalysisTrace,
} from "../lib/analysisRelay";

const MAX_RECONNECT = 6; // consecutive media reconnect attempts before surfacing an error (no /ingest fallback)
// Bound on buffered outbound media chunks (1/s chunks; well above any reconnect
// window, and far short of runaway memory). If the queue overflows the media
// socket has been down for a long stretch — surface it rather than silently
// dropping bytes (ADAAAA-6868 Phase 3 review, Medium).
const MAX_MEDIA_QUEUE = 500;

// Client-side capture: getDisplayMedia (screen / tab / window). The REAL pixels
// never leave the browser as a big stream:
//   - WebRTC ingest (primary): the display video track is sent live over a
//     WebRTC connection to the media server, which decodes + samples the stream
//     onto the orchestrator video-in rail (C1). No canvas sampling happens in
//     the browser.
//   - WS fallback: if the media server has no WebRTC ingest yet, we fall back to
//     the previous behaviour (sample the preview to a small canvas and push JPEG
//     frames over the media-server WS). There is no server /ingest fallback
//     (retired in Phase 3 / ADAAAA-6868); the browser connects to the media
//     server only.
// In every mode a MediaRecorder recording is chunked up and streamed to the
// media server (Phase 3 / ADAAAA-6868) so clips are cut ON the media node.
export function BrowserCapture({ gameHint, onDone }: { gameHint: string; onDone: () => void }) {
  const { reasoningEffort } = useSettings();
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Live analysis state snapshot + recent event kinds, surfaced in a small
  // panel while capturing (ADAAAA-6746 G1b).
  const [analysis, setAnalysis] = useState<AnalysisSessionState | null>(null);
  const [recentKinds, setRecentKinds] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Dedicated analysis WebSocket: always opened on the media handshake (BOTH
  // rtc and ws modes) so analysis messages are received even when video rides
  // the WebRTC path. Kept separate from the frame `wsRef`.
  const analysisWsRef = useRef<WebSocket | null>(null);
  const analysisWsUrlRef = useRef<string | null>(null);
  const analysisRcRef = useRef(0); // consecutive analysis reconnect attempts
  const batcherRef = useRef<ReturnType<typeof makeAnalysisBatcher> | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const modeRef = useRef<"ws" | "rtc" | "pending">("pending");
  // True while we're intentionally stopping (so reconnects never fire on user
  // stop / unmount). Consecutive reconnect attempts, reset on a successful open.
  const stoppingRef = useRef(false);
  const rcRef = useRef(0);
  // Dedicated media-server WS (for MediaRecorder chunks): opened in BOTH rtc and
  // ws modes so recording bytes never ride the analysis socket (ADAAAA-6868
  // Phase 3 review, Medium). Its URL is stashed so a short drop can reopen just
  // the recording socket (RTC mode) without tearing down the RTC connection.
  const mediaWsUrlRef = useRef<string | null>(null);
  // Outbound media-chunk queue: chunks are buffered and flushed over the media
  // socket, so a brief reconnect window does not drop recording bytes (they
  // resume on reopen instead of being lost), and the queue is drained before the
  // socket is closed at stop (ADAAAA-6868 Phase 3 review, Medium).
  const mediaQueueRef = useRef<Array<{ b64: string; mime: string }>>([]);
  // MediaRecorder recording chunks now stream to the MEDIA SERVER over its
  // WebSocket ({type:"media",...}), where they are reassembled + cut on the
  // media node (Phase 3 / ADAAAA-6868) — they never hit the server /recording
  // rail. The finalize settle below gives the last chunk a beat to flush before
  // POST /stop (which tears the media session down).

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

  // Open the dedicated media-server WS that carries the MediaRecorder recording
  // chunks. Opened in BOTH rtc and ws modes so recording bytes never ride the
  // analysis socket (ADAAAA-6868 Phase 3 review, Medium). On an unexpected
  // close: in WS mode the whole media path is re-handshaken; in RTC mode the
  // recording socket is reopened in place (keeping the live RTC video going).
  function openMediaSocket(wsUrl: string, jobId: string): Promise<void> {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => {
      rcRef.current = 0;
      // Flush any media chunks buffered while the socket was reconnecting.
      flushMediaChunks();
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
      if (stoppingRef.current) return;
      if (modeRef.current === "ws") scheduleReconnect(jobId);
      else if (modeRef.current === "rtc") scheduleRecordingReconnect(jobId);
    };
    return new Promise<void>((resolve) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => resolve(), { once: true });
    });
  }

  // Reopen just the recording socket in RTC mode (the live video stays on the
  // RTC connection). Bounded; on exhaustion the chunks stop arriving but the
  // RTC live feed is unaffected.
  function scheduleRecordingReconnect(jobId: string) {
    if (stoppingRef.current) return;
    if (rcRef.current >= MAX_RECONNECT) return;
    const delay = Math.min(800 * 2 ** rcRef.current, 5000);
    rcRef.current += 1;
    setTimeout(() => {
      if (stoppingRef.current) return;
      const url = mediaWsUrlRef.current;
      if (url && modeRef.current === "rtc") void openMediaSocket(url, jobId);
    }, delay);
  }

  // Open the media-server ingest path: prefer WebRTC (C1), else the media WS.
  // The server-side /ingest HTTP rail is retired (Phase 3 / ADAAAA-6868), so on
  // any unexpected failure we re-ask the server for the current / freshly-
  // rerouted details (it reuses the session from the DB, or re-provisions on a
  // healthy node) and reconnect — never through the server's frame rail.
  function openMedia(jobId: string, stream: MediaStream): Promise<void> {
    return api<{ wsUrl?: string; mediaOrigin?: string; mediaSessionId?: string; rtc?: boolean }>(
      `/jobs/${jobId}/media`,
      { method: "POST", body: {} }
    )
      .then(async (media) => {
        // Open a DEDICATED analysis WebSocket on the same media WS url as soon
        // as the handshake succeeds — even in RTC mode (where video rides the
        // WebRTC path and no frame WS is opened) — so the webapp receives the
        // media-server analysis messages (ADAAAA-6746 G1b).
        if (media?.wsUrl) openAnalysisWs(media.wsUrl, jobId);
        if (media?.wsUrl) mediaWsUrlRef.current = media.wsUrl;
        if (media?.rtc && media.mediaOrigin && media.mediaSessionId) {
          modeRef.current = "rtc";
          try {
            await establishRtc(media.mediaOrigin, media.mediaSessionId, stream);
            rcRef.current = 0;
            // RTC mode: the LIVE video rides WebRTC, but the MediaRecorder
            // recording chunks still need a dedicated media WS. Open it here so
            // recording bytes never fall through to the analysis socket
            // (ADAAAA-6868 Phase 3 review, Medium).
            if (media?.wsUrl) await openMediaSocket(media.wsUrl, jobId);
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
          await openMediaSocket(media.wsUrl, jobId);
          return;
        }
        // No media-server ingest endpoint available. The server-side /ingest
        // rail is retired (Phase 3 / ADAAAA-6868): surface a real error instead
        // of silently routing browser media through the server.
        throw new Error("No media-server ingest endpoint (WebRTC/WS) is available for this job");
      })
      .catch((e) => {
        // Media path unavailable (e.g. media node down / MEDIA_SERVER_URL unset).
        // Phase 3: do NOT fall back to the server /ingest rail.
        throw e;
      });
  }

  // Open the dedicated analysis WebSocket to the media server. Mirrors the
  // frame WS handling: bounded reconnect on unexpected close, never on a user
  // stop. In RTC mode this is the ONLY WS the webapp opens (the frame sampler
  // path is skipped), so it carries the full analysis feed.
  function openAnalysisWs(wsUrl: string, jobId: string) {
    if (stoppingRef.current || !wsUrl) return;
    analysisWsUrlRef.current = wsUrl;
    // Drop any previous analysis WS (e.g. after a media handshake reroute).
    const existing = analysisWsRef.current;
    if (existing) {
      try {
        existing.close();
      } catch {
        /* noop */
      }
      analysisWsRef.current = null;
    }
    const ws = new WebSocket(wsUrl);
    analysisWsRef.current = ws;
    ws.onopen = () => {
      analysisRcRef.current = 0;
    };
    ws.onmessage = (e) => handleAnalysisMessage(e, jobId);
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
    ws.onclose = () => {
      if (analysisWsRef.current === ws) analysisWsRef.current = null;
      if (stoppingRef.current) return;
      scheduleAnalysisReconnect(jobId);
    };
  }

  // Relay one media-server analysis message: update the live state, buffer
  // events for batched persistence, or POST a sparse trace. Best-effort: any
  // persistence failure is swallowed so it never fails the capture.
  function handleAnalysisMessage(e: MessageEvent, jobId: string) {
    let msg: any;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (!msg || msg.type !== "analysis") return;
    if (msg.status === "state" && msg.state) {
      setAnalysis(msg.state as AnalysisSessionState);
      return;
    }
    if (msg.status === "event" && msg.event) {
      const ev = msg.event as AnalysisEvent;
      if (ev?.kind) {
        // Track the last few distinct event kinds for the panel (deduped,
        // most-recent first, capped at 5).
        setRecentKinds((prev) => [ev.kind, ...prev.filter((k) => k !== ev.kind)].slice(0, 5));
      }
      batcherRef.current?.push(ev);
      return;
    }
    if (msg.status === "trace" && msg.trace) {
      api(`/jobs/${jobId}/analysis/trace`, { body: { trace: msg.trace as AnalysisTrace } }).catch(() => {});
    }
  }

  function scheduleAnalysisReconnect(jobId: string) {
    if (stoppingRef.current) return;
    if (analysisRcRef.current >= MAX_RECONNECT) return;
    const delay = Math.min(800 * 2 ** analysisRcRef.current, 5000);
    analysisRcRef.current += 1;
    setTimeout(() => {
      if (stoppingRef.current) return;
      const url = analysisWsUrlRef.current;
      if (url) openAnalysisWs(url, jobId);
    }, delay);
  }

  function scheduleReconnect(jobId: string) {
    if (stoppingRef.current || !streamRef.current) return;
    if (rcRef.current >= MAX_RECONNECT) {
      modeRef.current = "pending";
      // No server /ingest rail to fall back to (Phase 3 / ADAAAA-6868).
      setError("Could not reconnect to the media server — capture stopped. Check your connection and start again.");
      return;
    }
    const delay = Math.min(800 * 2 ** rcRef.current, 5000);
    rcRef.current += 1;
    modeRef.current = "pending";
    setTimeout(() => {
      if (!stoppingRef.current && streamRef.current) {
        openMedia(jobId, streamRef.current).catch((e) => {
          console.error("media reconnect failed", e);
          setError(String((e as any)?.message || e));
        });
      }
    }, delay);
  }

  // Flush buffered MediaRecorder chunks over the DEDICATED media WS. There is no
  // per-chunk ack over a raw WebSocket, but the queue + flush-on-open means a
  // brief reconnect window does not drop recording bytes — they resume on reopen
  // (ADAAAA-6868 Phase 3 review, Medium). Reassembly is arrival-order on the
  // media node; the container PTS is the authoritative clock for clip cutting,
  // so seq/timestamp are not consumed.
  function flushMediaChunks() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (mediaQueueRef.current.length) {
      const p = mediaQueueRef.current[0];
      try {
        ws.send(JSON.stringify({ type: "media", data: p.b64, mime: p.mime, seq: 0, timestamp: 0 }));
        mediaQueueRef.current.shift();
      } catch {
        // Socket died mid-send: stop flushing; the reconnect flushes the rest.
        return;
      }
    }
  }

  // Queue one MediaRecorder chunk (muxed video+audio) for the media server. The
  // media server reassembles the muxed recording ON the media node and cuts
  // clips from it — recording bytes never route through the server (Phase 3 /
  // ADAAAA-6868). A transient socket drop buffers the chunk for flush on reopen
  // instead of losing it.
  function sendMediaChunk(b64: string, mime: string) {
    mediaQueueRef.current.push({ b64, mime });
    if (mediaQueueRef.current.length > MAX_MEDIA_QUEUE) {
      // Only reachable if the media socket has been down for a long stretch;
      // surface it rather than silently dropping bytes (was: empty clipUri at
      // stop, ADAAAA-6522).
      setError("Recording is not reaching the media server — highlight clips may be incomplete. Check your connection and stop again.");
    }
    flushMediaChunks();
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

      // Analysis-event relay: buffer media-server events and flush them in
      // capped (200) batches to POST /jobs/:id/analysis/events. Best-effort.
      batcherRef.current = makeAnalysisBatcher((events) => {
        const id = jobIdRef.current;
        if (!id) return;
        void api(`/jobs/${id}/analysis/events`, { body: { events } }).catch(() => {});
      });
      setAnalysis(null);
      setRecentKinds([]);

      // Media-server handshake: stream the live video track over WebRTC
      // (browser -> media server -> orchestrator video-in), with transparent
      // reconnect + reroute on node failover (WebRTC main, WS fallback).
      stoppingRef.current = false;
      rcRef.current = 0;
      await openMedia(job.job.id, stream);

      const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          blobToBase64(e.data).then((b64) => {
            // Stream the muxed chunk to the media server (Phase 3): it
            // reassembles the recording on the media node for clip cutting.
            sendMediaChunk(b64, mime);
          });
        }
      };
      rec.start(1000); // 1s chunks keep the uploads small
      recRef.current = rec;

      // WS fallback only: sample the shared video element -> JPEG -> push to the
      // media-server WS at ~1fps. In RTC mode the media server decodes the live
      // track itself, so no sampling happens. The server-side /ingest rail is
      // retired (Phase 3 / ADAAAA-6868) — browser media never routes through the
      // server, so there is no HTTP frame fallback here.
      if (modeRef.current === "ws") {
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
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ seq, timestamp: seq, image, reasoningEffort }));
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
    } finally {
      setBusy(false);
    }
  }

  async function stopInternal(andNotify: boolean) {
    stoppingRef.current = true;
    rcRef.current = 0;
    if (ivRef.current) clearInterval(ivRef.current);
    ivRef.current = null;
    // Phase 3 (ADAAAA-6868): recording chunks stream to the media server over its
    // WS. Stop the MediaRecorder FIRST so its final dataavailable fires and the
    // last muxed chunk is sent to the media node over the STILL-OPEN media WS —
    // then give it a beat to flush before we close the WS and POST /stop (which
    // tears the media session down + flushes the reassembled recording).
    const rec = recRef.current;
    let flushed: Promise<void> = Promise.resolve();
    if (rec && rec.state !== "inactive") {
      // Set onstop before stop() so we never miss the stop event (ADAAAA-6522).
      flushed = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.stop();
    }
    if (andNotify) {
      await Promise.race([flushed, sleep(3000)]);
      await sleep(250); // bound; let the final chunk flush over the WS
      // Drain the media-chunk queue so the last chunk (and any buffered during a
      // reconnect) is on the wire before the media WS is closed (ADAAAA-6868
      // Phase 3 review, Medium).
      flushMediaChunks();
      await sleep(50);
    }
    // Now close the media WS connections (frame + analysis) and stop sampling.
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    // Flush any buffered analysis events (best-effort) so nothing is lost.
    try {
      analysisWsRef.current?.close();
    } catch {
      /* noop */
    }
    analysisWsRef.current = null;
    analysisWsUrlRef.current = null;
    analysisRcRef.current = 0;
    batcherRef.current?.flush();
    batcherRef.current?.stop();
    batcherRef.current = null;
    teardownRtc();
    modeRef.current = "pending";
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
      {sharing && (
        <div className="mt-3 rounded-lg border border-neon/40 bg-black/40 px-3 py-2 text-xs text-mut">
          <div className="mb-1 flex items-center gap-2 font-bold uppercase tracking-wide text-neon">
            <span className={`h-2 w-2 animate-pulse rounded-full ${analysis?.active ? "bg-green" : "bg-mut"}`} />
            Live analysis
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
            <span>
              audio <span className="text-ink">{analysis?.audioSamples ?? "—"}</span>
            </span>
            <span>
              frames <span className="text-ink">{analysis?.frameSnapshots ?? "—"}</span>
            </span>
            <span>
              captions <span className="text-ink">{analysis?.captionLines ?? "—"}</span>
            </span>
            <span>
              last <span className="text-ink">{formatAnalysisTs(analysis?.lastTs ?? analysis?.startedTs)}</span>
            </span>
          </div>
          {recentKinds.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {recentKinds.map((k) => (
                <span key={k} className="rounded-full border border-neon/40 px-1.5 py-0.5 text-[10px] leading-none text-neon">
                  {k}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
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

// Format an epoch-ms analysis timestamp for the panel; "—" when unknown.
function formatAnalysisTs(ms?: number): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString();
}
