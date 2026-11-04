// ADAAAA-7937 — the numeric contract behind the `audio_level` sound-levels
// graph (spec: /ADAAAA/issues/ADAAAA-7932#document-spec §4).
//
// The graph component lives in the webapp panel, but the three rules an
// operator actually reads off it — the window-relative Y domain, the hover
// readout text, and the arrow-key stepping — are pure functions here so they
// are unit-testable in the node test env (this package has no jsdom) and the
// panel only has to wire them to events.

/** 2-dp formatting used by every axis endpoint, reference label and readout. */
export function audioDp2(v: number): string {
  return v.toFixed(2);
}

/**
 * Window-relative Y domain for the drawn energy samples (AC2):
 *
 *   `[min(0, minE), maxE]`  — peak-anchored, floored at zero
 *   `[0, max(1e-3, peak)]`  — flat input, so the axis never collapses
 *
 * Empty input returns the flat-domain floor pair so callers can render an axis
 * without a division by zero.
 */
export function audioLevelDomain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1e-3];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const flat = hi - lo < 1e-9;
  const yLo = Math.min(0, lo);
  const yHi = flat ? Math.max(1e-3, hi) : hi;
  // A peak-anchored domain can never be inverted; guard the degenerate case
  // where every sample is zero or negative.
  return yHi - yLo < 1e-9 ? [yLo, yLo + 1e-3] : [yLo, yHi];
}

/**
 * The hover / keyboard readout (AC4): `T+<ts>s · energy <v> · baseline <v>` for
 * the window-series axis, `sample <i>/<n> · energy <v>` for a sample curve with
 * no timestamps. Values are 2-dp; the baseline segment appears only when the
 * point actually carries one.
 */
export function audioLevelReadout({
  index,
  count,
  t,
  energy,
  baseline,
}: {
  index: number;
  count: number;
  /** Stream time of the point, when the axis is time-based. */
  t?: number;
  energy: number;
  baseline?: number;
}): string {
  const where = t !== undefined ? `T+${audioDp2(t)}s` : `sample ${index + 1}/${count}`;
  const base = baseline !== undefined ? ` · baseline ${audioDp2(baseline)}` : "";
  return `${where} · energy ${audioDp2(energy)}${base}`;
}

/**
 * Left/Right arrow stepping of the cross line (AC7). An inactive cross enters
 * at the active edge (Right → first sample, Left → last), then clamps at both
 * ends so the readout never runs off the series.
 */
export function audioLevelCrossStep(current: number | null, dir: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  if (current === null) return dir === 1 ? 0 : count - 1;
  const next = current + dir;
  return next < 0 || next > count - 1 ? current : next;
}

/**
 * Index of the drawn point nearest a cursor X on the (possibly non-uniform)
 * time axis. Used to snap the hover cross to a real sample.
 */
export function nearestAudioLevelIndex(xs: number[], cursorX: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - cursorX);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
