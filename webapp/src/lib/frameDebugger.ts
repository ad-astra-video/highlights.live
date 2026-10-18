// Pure helpers for the FrameDebugger enlarge / multi-select / legible-label
// behavior (ADAAAA-6943/6946). Kept DOM-free so they unit-test in the node
// environment with the repo's existing vitest helper-test pattern.

export interface LabeledTrack {
  label?: string;
  kind: string;
}

// ADAAAA-5056: prefer the in-roster detector label over the coarse `kind` so
// the surfaced box reads "player 0" / "soccer ball 0", never "unknown 0".
// Falls back to "detection" only when neither a label nor a kind is present.
export function resolveTrackLabel(t: LabeledTrack): string {
  return (t.label?.trim() || t.kind) || "detection";
}

// Multi-select enlarge: order the selected frames by filmstrip order so the
// gallery's prev/next is predictable, dropping seqs not in the filmstrip.
// A single-select is a one-entry gallery; a multi-select is the ordered set.
export function orderGallerySeqs(frameSeqs: number[], selectedSeqs: number[]): number[] {
  const sel = new Set(selectedSeqs);
  return frameSeqs.filter((s) => sel.has(s));
}

export interface LabelPlacement {
  lx: number;
  ly: number;
}

// Collect every frame seq in the sections' filmstrip order (each section is
// already time-ordered). Used to order the multi-select enlarge gallery across
// the per-job detail surface, mirroring the FrameDebugger filmstrip ordering.
export function collectFrameSeqs(sections: { frames: { seq: number }[] }[]): number[] {
  return sections.flatMap((s) => s.frames.map((f) => f.seq));
}

// Minimal structural shape for rendering a detection box + label. Both the
// FrameDebugger observation tracks and the per-job detail `TrackObservation`
// satisfy it, so the SAME renderer drives both the inline canvas and the
// enlarged lightbox (A4: identical bbox mapping, palette, selection highlight).
export interface DrawTrack {
  bbox: number[];
  slot: number;
  kind: string;
  label?: string;
  selected?: boolean;
  accuracy?: number;
}

export const PALETTE = ["#22d3ee", "#f472b6", "#a3e635", "#fbbf24", "#a78bfa", "#fb7185", "#38bdf8", "#fb923c"];

// Draw a text label with a dark pill behind it so it stays legible over any
// frame content. Clamped inside the canvas (never clipped / off-canvas at small
// sizes) and flipped inside the box when there is no room above the box top.
export function drawLabel(
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

// Shared renderer: draw the frame and every detection box + legible label in
// the given `w x h` CSS coordinate space. `pixelRatio` scales the backing store
// so box strokes + text stay crisp on high-density displays. Used by BOTH the
// inline canvas and the enlarged lightbox so they render identically.
//
// `withLabels` defaults to true so the enlarged lightbox still draws the full
// legible label (ADAAAA-6943/6946). The inline thumbnail passes false: the
// board prefers small thumbnails with boxes only, labels on the enlarged frame
// (see ADAAAA-6946 board feedback "only show the labels on the enlarged frame").
export function drawFrameWithBoxes(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  tracks: DrawTrack[],
  w: number,
  h: number,
  fontPx: number,
  pixelRatio: number,
  withLabels = true
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  tracks.forEach((t) => {
    const [x1, y1, x2, y2] = t.bbox;
    const selected = !!t.selected;
    const color = selected ? "#fbbf24" : PALETTE[t.slot % PALETTE.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h);
    if (!withLabels) return;
    const acc = t.accuracy !== undefined && t.accuracy !== null ? ` ${Math.round(t.accuracy * 100)}%` : "";
    // ADAAAA-5056: prefer the in-roster detector label over the coarse kind.
    const shown = resolveTrackLabel(t);
    const text = `${shown}#${t.slot}${selected ? " ●" : ""}${acc}`;
    drawLabel(ctx, text, x1 * w, y1 * h, color, fontPx, w, h);
  });
}

// Clamp a detection-box text label inside the canvas so it never renders
// off-canvas (clipped) at small sizes; flip it inside the box when there is no
// room above the box's top edge. `textWidth` is the measured label width.
export function placeLabel(
  textWidth: number,
  bx1: number,
  by1: number,
  w: number,
  h: number,
  fontPx: number
): LabelPlacement {
  const pad = Math.max(2, fontPx * 0.35);
  let lx = Math.min(Math.max(2, bx1 + 2), w - textWidth - pad * 2);
  if (lx < 2) lx = 2;
  let ly = by1 - pad - 2;
  if (ly < fontPx + pad) ly = by1 + fontPx + pad; // flip inside the box
  if (ly > h - pad) ly = Math.max(fontPx, h - pad);
  return { lx, ly };
}
