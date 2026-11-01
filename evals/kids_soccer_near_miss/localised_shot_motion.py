#!/usr/bin/env python3
"""Localised goal-mouth motion reader (ADAAAA-7611, AC-1) — region-first.

Both prior deterministic layers scored the WHOLE pitch:

- ``detect_shot_motion.py`` on the 640x360 / 3 fps cache → AUC 0.481;
- ``native_shot_motion.py`` on the 1280x720 / 12 fps source → AUC 0.440, and the
  reason recorded in RESULTS.md is that ``max over ~13000 8x8 blocks`` always
  finds *some* moving player, so the statistic saturates (210 of 255 luma) and
  carries no signal about the ball.

The reading the vision layer gave is that localisation must come first: a fixed
crop of a save returned "no shot" while a full-frame read of the same second
returned "ball". This module applies that to the *deterministic* layer instead of
the model:

1. For every labelled GOAL window, build a coarse cell map (``--grid 12x7``) of
   the maximum per-pair motion residual inside the window, at native resolution.
   (Global camera shift is removed by phase correlation, as in the other
   readers; the scoreboard strip is masked.)
2. The **goal-mouth region** is the set of cells that are hot at goals and NOT
   hot on quiet seconds — derived from goal windows only, so it never sees the
   shot-class windows it is then applied to.
3. Score each labelled shot window and each ``evidence:none`` control window as
   ``max residual inside that region`` and report the AUC for shot vs control.

If the region-first statistic separates, a deterministic labeller exists and the
next wake can promote candidate windows on it. If it does not, the pixel path is
exhausted at native resolution AND with a region prior, which is what closes
AC-1's deterministic branch honestly.

No model, no key, no network: numpy + ffmpeg only.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from detect_shot_motion import auc, global_shift, shift_image  # noqa: E402
from native_shot_motion import probe, stream_luma  # noqa: E402

BLOCK = 8


def cell_map(resid, grid):
    """Pool a residual image into a ``grid`` (cols x rows) cell map."""
    h, w = resid.shape
    gx, gy = grid
    bh, bw = h // gy, w // gx
    core = resid[: gy * bh, : gx * bw]
    cells = core.reshape(gy, bh, gx, bw).mean(axis=(1, 3))
    # scoreboard strip (digits + clock) is scene decoration, not pitch motion
    cells[0, : max(1, int(0.30 * gx))] = np.nan
    return cells


def window_map(video, t0, t1, fps, grid, cut_t):
    """Max cell map over the window plus the max cut score seen."""
    prev = None
    best = np.full((grid[1], grid[0]), np.nan, dtype=np.float32)
    cut = 0.0
    for t_abs, cur in stream_luma(video, t0, (t1 - t0) + 1.0, fps):
        if prev is not None:
            raw = cur - prev
            dx, dy = global_shift(prev, cur)
            resid = np.abs(cur - shift_image(prev, dx, dy))
            m = float(np.mean(np.abs(raw)))
            cut = max(cut, m)
            cells = cell_map(resid, grid)
            take = np.fmax(best, cells)
            best = np.where(np.isnan(best), cells, take)
        prev = cur
    return best, cut


def region_max(cells, region):
    vals = [cells[r, c] for (r, c) in region
            if not np.isnan(cells[r, c])]
    return float(max(vals)) if vals else 0.0


def pick_region(goal_maps, quiet_maps, pct=0.75):
    """Cells hot at goals and cool on quiet seconds."""
    if not goal_maps or not quiet_maps:
        return []
    g = np.nanmedian(np.stack(goal_maps), axis=0)
    q = np.nanmedian(np.stack(quiet_maps), axis=0)
    gy, gx = g.shape
    region = []
    for r in range(gy):
        for c in range(gx):
            if np.isnan(g[r, c]) or np.isnan(q[r, c]):
                continue
            if g[r, c] >= np.nanpercentile(g, pct) and g[r, c] > 1.6 * max(q[r, c], 1.0):
                region.append((r, c))
    return region


def windows_from_manifest(manifest, kinds):
    out = []
    for w in manifest["windows"]:
        gt = (w.get("ground_truth") or "").lower()
        ev = (w.get("evidence") or "").lower()
        if "goal" in kinds and gt == "goal":
            out.append((w["id"], float(w["t_start"]), float(w["t_end"]), "goal"))
        elif "shot" in kinds and gt != "goal" and ev not in ("none", "", None):
            out.append((w["id"], float(w["t_start"]), float(w["t_end"]), "shot"))
        elif "control" in kinds and gt != "goal" and ev in ("none", "", None):
            out.append((w["id"], float(w["t_start"]), float(w["t_end"]), "control"))
    return out


def sweep(shots, controls):
    vals = sorted([v for _, v in shots] + [v for _, v in controls])
    if not vals:
        return None, []
    rows = []
    for frac in (0.5, 0.6, 0.7, 0.8, 0.9):
        thr = vals[min(len(vals) - 1, int(frac * len(vals)))]
        tp = sum(1 for _, v in shots if v >= thr)
        fp = sum(1 for _, v in controls if v >= thr)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / len(shots) if shots else 0.0
        rows.append({"thr": round(thr, 2), "recall": round(rec, 3),
                     "fp": fp, "precision": round(prec, 3)})
    return auc([v for _, v in shots], [v for _, v in controls]), rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--fps", type=float, default=12.0)
    ap.add_argument("--grid", default="12x7", help="cols x rows cell map")
    ap.add_argument("--json")
    ap.add_argument("--out")
    args = ap.parse_args(argv)

    gx, gr = (int(x) for x in args.grid.lower().split("x"))
    grid = (gx, gr)
    with open(args.manifest) as fh:
        manifest = json.load(fh)

    goals = windows_from_manifest(manifest, {"goal"})
    shots = windows_from_manifest(manifest, {"shot"})
    controls = windows_from_manifest(manifest, {"control"})

    maps, rows = {}, []
    for wid, t0, t1, kind in goals + shots + controls:
        cells, cut = window_map(args.video, t0, t1, args.fps, grid, 60.0)
        maps[wid] = cells
        rows.append({"id": wid, "kind": kind, "t0": t0, "t1": t1, "cut": round(cut, 1)})

    goal_maps = [maps[w] for w, _, _, k in goals]
    control_maps = [maps[w] for w, _, _, k in controls]
    region = pick_region(goal_maps, control_maps)

    shot_vals, ctrl_vals, goal_vals = [], [], []
    for wid, t0, t1, kind in goals + shots + controls:
        v = region_max(maps[wid], region)
        if kind == "shot":
            shot_vals.append((wid, v))
        elif kind == "control":
            ctrl_vals.append((wid, v))
        else:
            goal_vals.append((wid, v))

    a, sweep_rows = sweep(shot_vals, ctrl_vals)
    summary = {
        "video": os.path.basename(args.video),
        "fps": args.fps,
        "grid": args.grid,
        "region": {"cells": region, "n_cells": len(region),
                   "fraction_of_grid": round(len(region) / float(gx * gr), 3)},
        "auc_shot_vs_control_in_region": None if a is None else round(a, 3),
        "shots": [{"id": w, "score": round(v, 2)} for w, v in shot_vals],
        "controls": [{"id": w, "score": round(v, 2)} for w, v in ctrl_vals],
        "goals": [{"id": w, "score": round(v, 2)} for w, v in goal_vals],
        "threshold_sweep": sweep_rows,
        "verdict": None,
    }
    if a is not None:
        med_s = float(np.median([v for _, v in shot_vals])) if shot_vals else 0.0
        med_c = float(np.median([v for _, v in ctrl_vals])) if ctrl_vals else 0.0
        summary["medians"] = {"shot": round(med_s, 2), "control": round(med_c, 2)}
        best_ok = [r for r in sweep_rows if r["recall"] >= 0.8 and r["fp"] <= 2]
        summary["verdict"] = (
            "region-first statistic separates (bar met: >=8/10 shots, <=2/12 controls)"
            if best_ok else
            "region-first statistic does NOT meet the AC-1 labeller bar")
    print(json.dumps(summary, indent=2))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(summary, fh, indent=2)
            fh.write("\n")
    if args.out:
        with open(args.out, "w") as fh:
            for row in rows:
                wid = row["id"]
                fh.write(json.dumps({**row,
                                     "cells": [[None if np.isnan(v) else round(float(v), 2)
                                                for v in r] for r in maps[wid]]}) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
