import { useEffect, useMemo, useRef, useState } from "react";
import { getToken, api } from "../lib/api";

interface ObsTrack {
  trackId: string;
  slot: number;
  bbox: number[]; // [x1,y1,x2,y2] normalized 0..1
  kind: string;
  lostFrames: number;
}
interface Observation {
  seq: number;
  timestamp: number;
  tracks: ObsTrack[];
}
interface FrameMeta {
  seq: number;
  uri: string;
  timestamp: number | null;
}

const FRAME_W = 320;
const FRAME_H = 180;
const MAX_THUMBS = 60;
const PALETTE = ["#22d3ee", "#f472b6", "#a3e635", "#fbbf24", "#a78bfa", "#fb7185"];

function authFetch(url: string): Promise<string> {
  const t = getToken();
  return fetch(url, { headers: t ? { authorization: `Bearer ${t}` } : {} })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then((b) => URL.createObjectURL(b));
}

// Frame debugger: a filmstrip of the frames perceive actually saw, with the
// Florence/SAM detection boxes overlaid on the selected frame.
export function FrameDebugger({ jobId }: { jobId: string }) {
  const [frames, setFrames] = useState<FrameMeta[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [obsBySeq, setObsBySeq] = useState<Record<number, ObsTrack[]>>({});
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [f, o] = await Promise.all([
          api<{ frames: FrameMeta[] }>(`/jobs/${jobId}/frames`),
          api<{ observations: Observation[] }>(`/jobs/${jobId}/observations`),
        ]);
        if (cancelled) return;
        const list = f.frames.slice(-MAX_THUMBS);
        setFrames(list);
        const map: Record<number, ObsTrack[]> = {};
        for (const ob of o.observations) map[ob.seq] = ob.tracks;
        setObsBySeq(map);
        if (list.length) setSel(list[0].seq);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message || e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Lazy-load thumbnails for the filmstrip (as blob URLs, since <img> can't send the auth header).
  useEffect(() => {
    for (const fr of frames) {
      if (thumbs[fr.seq] !== undefined) continue;
      authFetch(fr.uri).then((u) => setThumbs((prev) => (prev[fr.seq] ? prev : { ...prev, [fr.seq]: u }))).catch(() => {});
    }
  }, [frames]);

  // Draw selected frame + boxes on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sel === null) return;
    const url = thumbs[sel];
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, FRAME_W, FRAME_H);
      const tracks = obsBySeq[sel] ?? [];
      tracks.forEach((t, i) => {
        const [x1, y1, x2, y2] = t.bbox;
        const color = PALETTE[t.slot % PALETTE.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x1 * FRAME_W, y1 * FRAME_H, (x2 - x1) * FRAME_W, (y2 - y1) * FRAME_H);
        ctx.fillStyle = color;
        ctx.font = "10px monospace";
        ctx.fillText(`${t.kind}#${t.slot}`, x1 * FRAME_W, Math.max(10, y1 * FRAME_H - 4));
      });
    };
    img.src = url;
  }, [sel, thumbs, obsBySeq]);

  const selObs = useMemo(() => (sel === null ? undefined : obsBySeq[sel]), [sel, obsBySeq]);

  if (err) return <div className="mt-6 rounded-lg border border-red/40 bg-red/10 p-3 text-sm text-red">Frame debugger: {err}</div>;
  if (frames.length === 0) return <div className="mt-6 text-sm text-mut">No frames saved for this job.</div>;

  return (
    <div className="mt-6 rounded-2xl border border-mut/30 bg-black/40 p-4">
      <div className="mb-2 text-sm font-bold uppercase tracking-wide text-mut">
        Frame debugger — {frames.length} frame(s)
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="relative shrink-0">
          <canvas ref={canvasRef} width={FRAME_W} height={FRAME_H} className="rounded-lg bg-black" />
          {selObs && (
            <div className="mt-1 text-[11px] text-mut">
              seq {sel} — {selObs.length} track(s) detected
            </div>
          )}
        </div>
        <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto">
          {frames.map((fr) => (
            <button
              key={fr.seq}
              title={`T+${fr.timestamp ?? "?"}s`}
              onClick={() => setSel(fr.seq)}
              data-active={sel === fr.seq}
              className="overflow-hidden rounded border-2 border-transparent data-[active=true]:border-neon"
            >
              {thumbs[fr.seq] ? (
                <img src={thumbs[fr.seq]} width={64} height={36} alt={`frame ${fr.seq}`} className="block object-cover" />
              ) : (
                <div className="flex h-9 w-16 items-center justify-center bg-mut/20 text-[10px] text-mut">…</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
