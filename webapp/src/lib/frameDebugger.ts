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
