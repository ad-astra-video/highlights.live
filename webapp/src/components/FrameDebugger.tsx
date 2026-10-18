import { useEffect, useMemo, useRef, useState } from "react";
import { getToken, api } from "../lib/api";
import { resolveTrackLabel, orderGallerySeqs, placeLabel, isTrackOnScreen } from "../lib/frameDebugger";

interface ObsTrack {
  trackId: string;
  slot: number;
  bbox: number[]; // [x1,y1,x2,y2] normalized 0..1
  kind: string;
  // ADAAAA-5056: in-roster detector label on the tracked box. Prefer it over
  // `kind` for display so the user sees "player 0" / "soccer ball 0", not
  // "unknown 0".
  label?: string;
  lostFrames: number;
  // INC-6 / ADAAAA-4330: on-demand find-and-track surfacing.
  selected?: boolean;
  accuracy?: number;
  ontoFrames?: number;
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
// The inline canvas is rendered at 2x internally so box strokes + text stay
// crisp when the 320x180 frame is shown at device-pixel density.
const INLINE_SCALE = 2;
const INLINE_FONT = 12; // CSS px; legible on the 320x180 inline frame
const ENLARGE_W = 960;
const ENLARGE_H = 540;
const ENLARGE_FONT = 24;
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

// Draw a text label with a dark pill behind it so it stays legible over any
// frame content. The label is clamped inside the canvas so it never renders
// off-canvas (clipped) at small sizes, and it flips inside the box when there
// is no room above the box top.
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  bx1: number,
  by1: number,
  color: string,
  fontPx: number,
  w: number,
  h: number
) {
  ctx.font = `${fontPx}px monospace`;
  const tw = ctx.measureText(text).width;
  const pad = Math.max(2, fontPx * 0.35);
  const { lx, ly } = placeLabel(tw, bx1, by1, w, h, fontPx);
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(lx - pad, ly - fontPx - pad * 0.5, tw + pad * 2, fontPx + pad * 1.5);
  ctx.fillStyle = color;
  ctx.fillText(text, lx, ly);
}

// Shared renderer: draws the frame and every detection box + legible label in
// the given coordinate space. Used by BOTH the inline canvas and the enlarged
// lightbox so boxes/labels/palette/selection highlight render identically.
// `pixelRatio` scales the backing store for crispness while drawing in
// `w x h` CSS coordinates.
function drawFrameWithBoxes(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  tracks: ObsTrack[],
  w: number,
  h: number,
  fontPx: number,
  pixelRatio: number
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  tracks.forEach((t) => {
    // ADAAAA-6966/6967: don't stroke the stale last-known box once the object is
    // no longer on this frame (lostFrames > 0 or onScreen === false).
    if (!isTrackOnScreen(t)) return;
    const [x1, y1, x2, y2] = t.bbox;
    const selected = !!t.selected;
    const color = selected ? "#fbbf24" : PALETTE[t.slot % PALETTE.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
    const acc = t.accuracy !== undefined && t.accuracy !== null ? ` ${Math.round(t.accuracy * 100)}%` : "";
    // ADAAAA-5056: prefer the in-roster detector label over the coarse kind.
    const shown = resolveTrackLabel(t);
    const text = `${shown}#${t.slot}${selected ? " ●" : ""}${acc}`;
    drawLabel(ctx, text, x1 * w, y1 * h, color, fontPx, w, h);
  });
}

// Frame debugger: a filmstrip of the frames perceive actually saw, with the
// Florence/SAM detection boxes overlaid on the selected frame. Clicking any
// thumbnail (or the main frame, outside a box) opens a full-resolution enlarged
// lightbox; a "Select" mode lets the user pick >=2 frames and enlarge them as a
// gallery with prev/next. Clicking a detection box issues find-and-track.
export function FrameDebugger({ jobId }: { jobId: string }) {
  const [frames, setFrames] = useState<FrameMeta[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [obsBySeq, setObsBySeq] = useState<Record<number, ObsTrack[]>>({});
  const [sel, setSel] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [following, setFollowing] = useState<{ label: string; slot: number; ts: string } | null>(null);
  // Enlarge lightbox: the ordered set of frames currently shown enlarged, and
  // the index into that set. A single-select opens a one-entry gallery; a
  // multi-select opens a prev/next gallery across the chosen frames.
  const [gallery, setGallery] = useState<number[] | null>(null);
  const [galIndex, setGalIndex] = useState(0);
  // Multi-select mode: discoverable "Select" toggle + per-thumb checkboxes.
  const [selectMode, setSelectMode] = useState(false);
  const [multiSeqs, setMultiSeqs] = useState<number[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enlRef = useRef<HTMLCanvasElement>(null);
  const createdUrls = useRef<Set<string>>(new Set());
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      createdUrls.current.forEach((u) => URL.revokeObjectURL(u));
      createdUrls.current = new Set();
    };
  }, []);

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
      authFetch(fr.uri)
        .then((u) => {
          createdUrls.current.add(u);
          if (!aliveRef.current) return;
          setThumbs((prev) => (prev[fr.seq] ? prev : { ...prev, [fr.seq]: u }));
        })
        .catch(() => {});
    }
  }, [frames]);

  // Draw the selected frame + boxes on the inline canvas (2x crisp backing store).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sel === null) return;
    const url = thumbs[sel];
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (canvasRef.current !== canvas) return;
      drawFrameWithBoxes(canvas, img, obsBySeq[sel] ?? [], FRAME_W, FRAME_H, INLINE_FONT, INLINE_SCALE);
    };
    img.src = url;
  }, [sel, thumbs, obsBySeq]);

  // Draw the enlarged frame + boxes in the lightbox.
  useEffect(() => {
    const canvas = enlRef.current;
    if (!canvas || gallery === null) return;
    const seq = gallery[galIndex];
    const url = thumbs[seq];
    if (!url) return;
    const img = new Image();
    img.onload = () => {
      if (enlRef.current !== canvas) return;
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      drawFrameWithBoxes(canvas, img, obsBySeq[seq] ?? [], ENLARGE_W, ENLARGE_H, ENLARGE_FONT, dpr);
    };
    img.src = url;
  }, [gallery, galIndex, thumbs, obsBySeq]);

  // INC-6 / ADAAAA-4330: click a detection box to issue an on-demand find-and-
  // track intent. Works on BOTH the inline canvas and the enlarged lightbox.
  // Returns true when a box was hit (so the caller can branch: box-hit →
  // follow-track, empty frame → enlarge).
  async function followTrackFrom(canvas: HTMLCanvasElement, seq: number, e: React.MouseEvent<HTMLCanvasElement>): Promise<boolean> {
    if (!canvas || seq === null) return false;
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    const tracks = obsBySeq[seq] ?? [];
    const hit = tracks.find((t) => {
      const [x1, y1, x2, y2] = t.bbox;
      return nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2;
    });
    if (!hit) return false;
    try {
      const res = await api<{ ok: boolean; control?: { type: string; args: any } }>(`/jobs/${jobId}/control`, {
        body: { type: "track", args: { bbox: hit.bbox, label: hit.label?.trim() || hit.kind, slot: hit.slot } },
      });
      setFollowing({ label: `${(hit.label?.trim() || hit.kind) || "detection"}#${hit.slot}`, slot: hit.slot, ts: new Date().toISOString() });
      setErr(null);
    } catch (e2: any) {
      setErr(`find-and-track: ${String(e2?.message || e2)}`);
    }
    return true;
  }

  async function onInlineCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (sel === null) return;
    const hit = await followTrackFrom(canvasRef.current!, sel, e);
    // A1: clicking the main frame (empty area, not a box) enlarges it.
    if (!hit && !selectMode) openSingle(sel);
  }

  function openSingle(seq: number) {
    setSel(seq);
    setGallery([seq]);
    setGalIndex(0);
  }

  function openMulti() {
    // Order the gallery by filmstrip order (frame seq) for predictable prev/next.
    const ordered = orderGallerySeqs(frames.map((f) => f.seq), multiSeqs);
    if (ordered.length === 0) return;
    setGallery(ordered);
    setGalIndex(0);
    setSelectMode(false);
    setMultiSeqs([]);
  }

  function shiftGallery(dir: number) {
    if (!gallery || gallery.length <= 1) return;
    const next = (galIndex + dir + gallery.length) % gallery.length;
    setGalIndex(next);
  }

  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setMultiSeqs([]);
  }

  function toggleMulti(seq: number) {
    setMultiSeqs((prev) => (prev.includes(seq) ? prev.filter((s) => s !== seq) : [...prev, seq]));
  }

  const selObs = useMemo(() => (sel === null ? undefined : obsBySeq[sel]), [sel, obsBySeq]);
  const selectedTrack = useMemo(() => (selObs ?? []).find((t) => t.selected) ?? null, [selObs]);
  const galSeq = gallery === null ? null : gallery[galIndex];

  if (err) return <div className="mt-6 rounded-lg border border-red/40 bg-red/10 p-3 text-sm text-red">Frame debugger: {err}</div>;
  if (frames.length === 0) return <div className="mt-6 text-sm text-mut">No frames saved for this job.</div>;

  return (
    <div className="mt-6 rounded-2xl border border-mut/30 bg-black/40 p-4">
      <div className="mb-2 flex items-center gap-3">
        <div className="text-sm font-bold uppercase tracking-wide text-mut">
          Frame debugger — {frames.length} frame(s)
        </div>
        <button
          type="button"
          data-select-mode={selectMode ? "true" : undefined}
          onClick={toggleSelectMode}
          className="ml-auto rounded border border-mut/40 px-2 py-1 text-[11px] text-mut hover:border-neon hover:text-neon"
        >
          {selectMode ? "Cancel select" : "Select"}
        </button>
        {selectMode && (
          <button
            type="button"
            data-enlarge-multi={multiSeqs.length >= 2 ? "true" : undefined}
            disabled={multiSeqs.length < 2}
            onClick={openMulti}
            className="rounded border border-neon/60 px-2 py-1 text-[11px] text-neon disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enlarge ({multiSeqs.length})
          </button>
        )}
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="relative shrink-0">
          <canvas
            ref={canvasRef}
            width={FRAME_W * INLINE_SCALE}
            height={FRAME_H * INLINE_SCALE}
            style={{ width: FRAME_W, height: FRAME_H }}
            onClick={onInlineCanvasClick}
            className="cursor-crosshair rounded-lg bg-black"
          />
          {selObs && (
            <div className="mt-1 text-[11px] text-mut">seq {sel} — {selObs.length} track(s) detected</div>
          )}
          {selectedTrack ? (
            <div className="mt-1 rounded bg-yellow/20 px-2 py-1 text-[11px] text-yellow">
              ● following {(selectedTrack.label?.trim() || selectedTrack.kind) || "detection"}#{selectedTrack.slot}
              {selectedTrack.accuracy !== undefined && selectedTrack.accuracy !== null
                ? ` — ${Math.round(selectedTrack.accuracy * 100)}% on screen (${selectedTrack.ontoFrames ?? 0} frames)`
                : ""}
            </div>
          ) : (
            <div className="mt-1 text-[10px] text-mut">click a box to follow that object</div>
          )}
          <div className="mt-1">
            <button
              type="button"
              data-enlarge-single="true"
              onClick={() => sel !== null && openSingle(sel)}
              className="rounded border border-mut/40 px-2 py-1 text-[11px] text-mut hover:border-neon hover:text-neon"
            >
              ⤢ Enlarge
            </button>
          </div>
        </div>
        <div className="flex max-h-44 flex-wrap gap-1 overflow-y-auto">
          {frames.map((fr) => (
            <button
              key={fr.seq}
              title={`T+${fr.timestamp ?? "?"}s`}
              onClick={() => (selectMode ? toggleMulti(fr.seq) : openSingle(fr.seq))}
              data-active={selectMode ? multiSeqs.includes(fr.seq) : sel === fr.seq}
              data-selected-multi={selectMode && multiSeqs.includes(fr.seq) ? "true" : undefined}
              className="relative overflow-hidden rounded border-2 border-transparent data-[active=true]:border-neon"
            >
              {thumbs[fr.seq] ? (
                <>
                  <img src={thumbs[fr.seq]} width={64} height={36} alt={`frame ${fr.seq}`} className="block object-cover" />
                  {selectMode && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-neon">
                      {multiSeqs.includes(fr.seq) ? "✓" : ""}
                    </span>
                  )}
                </>
              ) : (
                <div className="flex h-9 w-16 items-center justify-center bg-mut/20 text-[10px] text-mut">…</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {gallery !== null && galSeq !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setGallery(null);
          }}
        >
          <div className="relative max-h-full max-w-full overflow-auto rounded-lg bg-black/90 p-3">
            <div className="mb-2 flex items-center gap-3 text-sm text-mut">
              <span>
                seq {galSeq} — {(obsBySeq[galSeq] ?? []).length} track(s) {gallery.length > 1 ? `(${galIndex + 1}/${gallery.length})` : ""}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {gallery.length > 1 && (
                  <>
                    <button type="button" data-gallery-prev="true" onClick={() => shiftGallery(-1)} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-neon">‹ prev</button>
                    <button type="button" data-gallery-next="true" onClick={() => shiftGallery(1)} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-neon">next ›</button>
                  </>
                )}
                <button type="button" data-gallery-close="true" onClick={() => setGallery(null)} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-red">✕ close</button>
              </div>
            </div>
            <canvas
              ref={enlRef}
              width={ENLARGE_W * 2}
              height={ENLARGE_H * 2}
              style={{ width: ENLARGE_W, height: ENLARGE_H }}
              onClick={(e) => followTrackFrom(enlRef.current!, galSeq!, e)}
              className="cursor-crosshair rounded bg-black"
            />
            <div className="mt-1 text-[11px] text-mut">click a box in the enlarged view to follow that object</div>
          </div>
        </div>
      )}
    </div>
  );
}
