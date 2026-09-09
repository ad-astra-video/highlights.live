import { useEffect, useRef, useState } from "react";
import { Square, Play, Share2 } from "lucide-react";
import { api, getToken } from "../lib/api";

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

const SAMPLE_FPS = 1; // perceived frames/sec (CPU Florence is slow; 1fps is the plan target)

// Client-side capture: getDisplayMedia (screen / tab / window). The REAL pixels
// never leave the browser as a big stream — we sample the preview to a small
// canvas and POST JPEG frames to the server ingest rail (perceive -> decide),
// and a MediaRecorder recording is chunked up so clips can be cut server-side.
export function BrowserCapture({ gameHint, onDone }: { gameHint: string; onDone: () => void }) {
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const onUnmount = () => {
      stopInternal(false);
    };
    return onUnmount;
  }, []);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      // create the browser-capture job on the server
      const job = await api<{ job: { id: string } }>("/jobs", { body: { source: "browser", gameHint } });
      jobIdRef.current = job.job.id;

      const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 3_000_000 } : undefined);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          blobToBase64(e.data).then((b64) => {
            const id = jobIdRef.current;
            if (id) api(`/jobs/${id}/recording`, { body: { base64: b64, mime: mime } }).catch(() => {});
          });
        }
      };
      rec.start(1000); // 1s chunks keep the uploads small
      recRef.current = rec;

      // sample the shared video element -> JPEG -> ingest
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
        api(`/jobs/${jobIdRef.current}/ingest`, {
          body: { seq, timestamp: seq / SAMPLE_FPS, image },
        }).catch(() => {});
      }, 1000 / SAMPLE_FPS);

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
    if (ivRef.current) clearInterval(ivRef.current);
    ivRef.current = null;
    if (recRef.current && recRef.current.state !== "inactive") {
      recRef.current.stop();
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
        <span className="normal-case text-mut">— pixels are sampled in your browser and pushed to the server</span>
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
              Capturing at {SAMPLE_FPS}fps. Highlight clips are cut from the recording when you stop.
              Use the browser's "Stop sharing" control to end capture early.
            </p>
          )}
        </div>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
    </div>
  );
}
