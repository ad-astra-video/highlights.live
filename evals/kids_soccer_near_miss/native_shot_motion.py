#!/usr/bin/env python3
"""Native-resolution motion reader for the kids_soccer eval (ADAAAA-7611, AC-1).

The committed second layer (`detect_shot_motion.py`) reads the pipeline's
*stored* frames: 640x360 at 3 fps. On that cache the ball is ~10 px wide and the
per-pair difference is encoder/texture noise (measured: static-second mean |d|
26.7 luma, global alignment recovers 1.5 of it), which is why every threshold in
its sweep landed at AUC 0.481 — chance.

The eval's source of truth is not that cache: the job detail records
``sourceUrl`` (``/data/uploads/<id>/kids-soccer.mp4``) and the upload is
**1280x720 at 60 fps**. Four times the ball area and twenty times the temporal
samples. This module re-runs the same motion statistic directly on the source
video, so the question "can a deterministic layer see a shot" is answered on the
footage rather than on a downscale of it.

It streams decoded grey frames straight out of ffmpeg (no frame dir, no JPEG
round-trip, nothing written to disk), samples at ``--fps`` (default 12), and for
every sampled pair computes the same statistic as the 1x layer:

    score = max over BLOCKxBLOCK blocks of mean |cur - shift(prev)|

with ``shift`` from FFT phase correlation, so global camera motion is removed
and a broadcast cut is flagged by its raw difference instead of being scored as
motion.

Scoring is per *second* on the manifest's 1 s grid: a second's score is the max
over the sampled pairs that fall inside it, which is the same granularity the
labelled windows use.

Usage
-----
  # per-second reads for every no-goal window in the manifest
  python3 native_shot_motion.py --video /path/kids-soccer.mp4 --manifest label-manifest.json \\
      --out results/native_shot_motion_windows.jsonl --json results/native_shot_motion_summary.json

  # one arbitrary range
  python3 native_shot_motion.py --video /path/kids-soccer.mp4 --from 126 --to 133

  # resolution ablation (decode the source, sample it down to the old cache)
  python3 native_shot_motion.py --video ... --scale 640x360 --calibrate

Pure stdlib + numpy + ffmpeg. No model, no key, no network.
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from detect_shot_motion import auc, global_shift, shift_image, SHOT_EVIDENCE  # noqa: E402

BLOCK = 8
DEFAULT_CUT_T = 60.0
SWEEP = [x / 2.0 for x in range(40, 241, 5)]   # 20 .. 120


def probe(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", video],
        capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)["streams"][0]
    return int(s["width"]), int(s["height"]), s["avg_frame_rate"]


def stream_luma(video, start_s, dur_s, fps, scale=None):
    """Yield ``(t_abs, luma float32 HxW)`` for a decoded slice of ``video``."""
    w, h, _ = probe(video)
    vf = "fps=%s" % fps
    if scale and scale.lower() != "native":
        vf += ",scale=%s" % scale
    vf += ",format=gray"
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-ss", "%.3f" % start_s, "-i", video,
           "-t", "%.3f" % dur_s, "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    if scale and scale.lower() != "native":
        sc = scale.lower().split("x")
        w, h = int(sc[0]), int(sc[1])
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    nbytes = w * h
    i = 0
    try:
        while True:
            buf = p.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            yield start_s + i / float(fps), np.frombuffer(buf, dtype=np.uint8).reshape(h, w).astype(np.float32)
            i += 1
    finally:
        p.stdout.close()
        p.wait()


def block_score(resid):
    """Max mean residual over BLOCK blocks, scoreboard strip masked out."""
    h, w = resid.shape
    bh, bw = h // BLOCK, w // BLOCK
    core = resid[: bh * BLOCK, : bw * BLOCK]
    blocks = core.reshape(bh, BLOCK, bw, BLOCK).mean(axis=(1, 3))
    sb = (0, 0, int(0.266 * w), int(0.111 * h))   # score digits + clock, scaled
    blocks[: max(1, sb[3] // BLOCK), : max(1, sb[2] // BLOCK)] = np.nan
    band = blocks[int(0.10 * bh): int(0.98 * bh), :]
    if band.size == 0 or np.all(np.isnan(band)):
        return 0.0, 0, 0
    f = np.nanmean(band)
    return float(np.nanmax(band)), int(np.nansum(band > 3 * f)), int(np.nansum(band > 15.0))


def read_range(video, t0, t1, fps, cut_t, scale):
    """Per-second readings for ``[t0, t1]`` inclusive (1 s grid)."""
    dur = (t1 - t0) + 1
    per_sec = {}
    prev = None
    prev_t = None
    for t_abs, cur in stream_luma(video, t0, dur, fps, scale):
        sec = int(t_abs)
        rec = per_sec.setdefault(sec, {"t": sec, "score": 0.0, "raw_max": 0.0,
                                       "hot_blocks": 0, "very_hot": 0, "pairs": 0,
                                       "cut": False})
        if prev is not None:
            raw = float(np.abs(cur - prev).mean())
            dy, dx = global_shift(prev, cur)
            resid = np.abs(cur - shift_image(prev, dy, dx))
            ok = ~np.isnan(resid)
            sc, hot, very = block_score(np.where(ok, resid, np.nan))
            rec["pairs"] += 1
            rec["raw_max"] = max(rec["raw_max"], round(raw, 2))
            rec["score"] = max(rec["score"], round(sc, 2))
            rec["hot_blocks"] = max(rec["hot_blocks"], hot)
            rec["very_hot"] = max(rec["very_hot"], very)
            rec["shift"] = [dy, dx]
            if raw > cut_t:
                rec["cut"] = True
        prev, prev_t = cur, t_abs
    return [per_sec[k] for k in sorted(per_sec)]


def shot_at(rec, threshold):
    return bool(rec.get("score", 0.0) >= threshold and not rec.get("cut"))


def windows_of(manifest, which):
    shot, control = [], []
    for w in manifest["windows"]:
        if w["ground_truth"] != "no_goal":
            continue
        if w.get("evidence") in SHOT_EVIDENCE:
            shot.append(w)
        elif w.get("evidence") == "none":
            control.append(w)
    return shot, control


def sweep(reads, shot_wins, control_wins):
    rows = []
    by_t = {r["t"]: r for r in reads}
    for thr in SWEEP:
        repro = [w["id"] for w in shot_wins
                 if any(shot_at(by_t[t], thr) for t in range(w["t_start"], w["t_end"] + 1) if t in by_t)]
        false = [{"id": w["id"], "t": t} for w in control_wins
                 for t in range(w["t_start"], w["t_end"] + 1) if t in by_t and shot_at(by_t[t], thr)]
        rows.append({"threshold": thr, "shot_windows_reproduced": len(repro),
                     "reproduced_ids": repro, "control_seconds_false": len(false),
                     "false_ids": false})
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--manifest", default=os.path.join(HERE, "label-manifest.json"))
    ap.add_argument("--from", dest="t0", type=int, default=None)
    ap.add_argument("--to", dest="t1", type=int, default=None)
    ap.add_argument("--fps", type=float, default=12.0)
    ap.add_argument("--scale", default="native", help="'native' or WxH to decode into")
    ap.add_argument("--cut-t", type=float, default=DEFAULT_CUT_T)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    w, h, rate = probe(args.video)
    print("source: %s  %dx%d  %s fps" % (os.path.basename(args.video), w, h, rate))

    if args.t0 is not None and args.t1 is not None:
        reads = read_range(args.video, args.t0, args.t1, args.fps, args.cut_t, args.scale)
        for r in reads:
            print("  t=%4d score=%7.2f raw=%6.2f hot=%3d very=%3d cut=%s"
                  % (r["t"], r["score"], r["raw_max"], r["hot_blocks"], r["very_hot"], r["cut"]))
        if args.out:
            with open(args.out, "w") as fh:
                for r in reads:
                    fh.write(json.dumps(r, sort_keys=True) + "\n")
            print("wrote", args.out)
        return

    manifest = json.load(open(args.manifest))
    shot_wins, control_wins = windows_of(manifest, None)
    reads = []
    for group, wins in (("shot", shot_wins), ("control", control_wins)):
        for win in wins:
            for r in read_range(args.video, win["t_start"], win["t_end"], args.fps,
                                args.cut_t, args.scale):
                r.update({"id": win["id"], "group": group, "evidence": win.get("evidence")})
                reads.append(r)
            print("  %-12s %s %4d-%4d done" % (win["id"], group, win["t_start"], win["t_end"]))

    rows = sweep(reads, shot_wins, control_wins)
    by_t = {r["t"]: r for r in reads}
    pos = [r["score"] for r in reads if r["group"] == "shot" and not r["cut"]]
    neg = [r["score"] for r in reads if r["group"] == "control" and not r["cut"]]
    quiet = [r["raw_max"] for r in reads if not r["cut"]]
    summary = {
        "layer": {"name": "native-resolution motion residual", "deterministic": True,
                  "source": "%dx%d %s fps, sampled at %g fps, scale=%s"
                            % (w, h, rate, args.fps, args.scale),
                  "score": "max mean |cur - shift(prev)| over %dpx blocks, pitch band" % BLOCK,
                  "cut_rule": "mean |cur-prev| > %.0f -> cut, not shot evidence" % args.cut_t,
                  "sweep_thresholds": SWEEP},
        "windows": {"shot": len(shot_wins), "control": len(control_wins),
                    "shot_ids": [x["id"] for x in shot_wins],
                    "control_ids": [x["id"] for x in control_wins]},
        "discrimination": {
            "score_auc": auc(pos, neg),
            "shot_median_score": round(float(np.median(pos)), 2) if pos else None,
            "control_median_score": round(float(np.median(neg)), 2) if neg else None,
            "noncut_shot_seconds": len(pos), "noncut_control_seconds": len(neg),
            "raw_diff_percentiles": {p: round(float(np.percentile(quiet, p)), 2)
                                     for p in (50, 90, 99, 100)} if quiet else None,
        },
        "sweep": rows,
        "gate": {"requires": {"reproduced_shot_windows_min": 8, "control_false_seconds_max": 2},
                 "thresholds_meeting_it": [r["threshold"] for r in rows
                                           if r["shot_windows_reproduced"] >= 8
                                           and r["control_seconds_false"] <= 2],
                 },
    }
    summary["gate"]["met"] = bool(summary["gate"]["thresholds_meeting_it"])
    text = json.dumps(summary, indent=1)
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(text + "\n")
    if args.out:
        with open(args.out, "w") as fh:
            for r in reads:
                fh.write(json.dumps(r, sort_keys=True) + "\n")

    print("\n%-6s %-10s %-12s" % ("thr", "shot wins", "control false s"))
    for r in rows:
        mark = "  <= BAR" if r["threshold"] in summary["gate"]["thresholds_meeting_it"] else ""
        print("%-6.1f %-10s %-12d%s" % (r["threshold"],
                                        "%d/%d" % (r["shot_windows_reproduced"], len(shot_wins)),
                                        r["control_seconds_false"], mark))
    d = summary["discrimination"]
    print("\nscore AUC: %s (chance 0.5)" % d["score_auc"])
    print("shot median %s vs control median %s"
          % (d["shot_median_score"], d["control_median_score"]))
    print("raw-diff percentiles: %s" % d["raw_diff_percentiles"])
    print("gate met:", summary["gate"]["met"],
          "| thresholds:", summary["gate"]["thresholds_meeting_it"])
    if args.json:
        print("wrote", args.json)
    if args.out:
        print("wrote", args.out)


if __name__ == "__main__":
    main()
