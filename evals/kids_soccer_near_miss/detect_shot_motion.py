#!/usr/bin/env python3
"""Second, independent read layer for the kids_soccer eval (ADAAAA-7643, AC-1).

The committed primary read layer (`calibrate_shot_reader.py`) is a vision-model
prompt over one still frame. This module is deliberately a *different kind* of
reader:

  * it derives its decision from **temporal pixel motion**, not from a still
    frame, so a shot that is only visible as the ball crossing the goal mouth
    between two frames is still in its evidence;
  * it is **deterministic and offline** — no model, no API key, no network, no
    sampling temperature — so a repeat run is byte-identical instead of
    "75 % identical";
  * it never sees the graded text or the manifest's labels; it is scored by the
    same manifest windows the primary layer is scored on.

That makes it independent of the prompt/read path in the sense the eval needs:
its errors cannot correlate with prompt-family errors.

What it measures
----------------
For every second ``t`` it aligns frame ``t-1`` onto frame ``t`` with a global
integer shift (FFT phase correlation on a 4x-downsampled luma image), then
measures the residual motion energy that the global shift does *not* explain,
as the mean over the strongest 8x8 block of the frame:

    score(t)  = max over 8x8 blocks of mean |frame(t) - shift(frame(t-1))|

A broadcast *cut* re-renders most of the frame, so ``mean |frame(t) -
frame(t-1)| > CUT_T`` marks the second as a cut and the second is excluded from
shot evidence (a cut is not a shot).

The score is a **fast-local-object** proxy: camera motion is removed by the
global shift, so what is left is a compact region that changed a lot in 1/3 s —
a ball struck at goal, a keeper dive, a player sliding in. Passes, crosses and
open-play dribbling produce the same signature, which is exactly why this layer
is calibrated rather than trusted: the summary reports the recall/false-shot
trade-off over a threshold sweep instead of picking one flattering point.

    python3 detect_shot_motion.py --frames /tmp/hl7590_frames \\
        --manifest label-manifest.json \\
        --out results/shot_motion_reads.jsonl \\
        --json results/shot_motion_summary.json \\
        --whole-video results/shot_motion_whole.jsonl

Pure stdlib + numpy + Pillow. No network, no GPU, no key.
"""
import argparse
import collections
import json
import os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SHOT_EVIDENCE = {"saved", "blocked", "wide"}
SHOT_CLASSES = {"goal_mouth_shot", "keeper_save"}
BLOCK = 8                 # residual block edge, px (640x360 frame -> 80x45 blocks)
CUT_T = 60.0              # mean |cur - prev| that counts as a broadcast cut
DEFAULT_THRESHOLD = 55.0  # operating point, chosen on the sweep (see summary)
SWEEP = list(range(30, 126, 5))

# The pitch band excludes the scoreboard strip (top-left) and any black letterbox
# rows, so a change in the overlay cannot be scored as motion.
PITCH_TOP = int(0.10 * 360)
PITCH_BOTTOM = int(0.98 * 360)
SCOREBOX = (0, 0, 170, 40)  # x0, y0, x1, y1 — score digits + clock


def frame_luma(frames_dir, t):
    path = os.path.join(frames_dir, "f_%04d.jpg" % t)
    if not os.path.exists(path):
        return None
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def global_shift(prev, cur, down=4):
    """Integer (dy, dx) that best maps ``prev`` onto ``cur`` (phase correlation)."""
    a = prev[::down, ::down]
    b = cur[::down, ::down]
    A = np.fft.rfft2(a - a.mean())
    B = np.fft.rfft2(b - b.mean())
    R = A * np.conj(B)
    R /= np.abs(R) + 1e-6
    c = np.fft.irfft2(R, s=a.shape)
    dy, dx = np.unravel_index(np.argmax(c), c.shape)
    if dy > a.shape[0] // 2:
        dy -= a.shape[0]
    if dx > a.shape[1] // 2:
        dx -= a.shape[1]
    return int(dy * down), int(dx * down)


def shift_image(img, dy, dx):
    """Shift ``img`` by (dy, dx); out-of-frame pixels come back as NaN."""
    out = np.full_like(img, np.nan)
    h, w = img.shape
    ys, ye = max(0, dy), h + min(0, dy)
    xs, xe = max(0, dx), w + min(0, dx)
    yd, ye2 = max(0, -dy), h + min(0, -dy)
    xd, xe2 = max(0, -dx), w + min(0, -dx)
    out[yd:ye2, xd:xe2] = img[ys:ye, xs:xe]
    return out


def block_score(resid):
    """Max mean residual over BLOCK-sized blocks inside the pitch band."""
    h, w = resid.shape
    bh, bw = h // BLOCK, w // BLOCK
    core = resid[: bh * BLOCK, : bw * BLOCK]
    blocks = core.reshape(bh, BLOCK, bw, BLOCK).mean(axis=(1, 3))
    # mask the scoreboard strip out of the block grid
    for by in range(bh):
        for bx in range(bw):
            y0, x0 = by * BLOCK, bx * BLOCK
            if (y0 < SCOREBOX[3] and x0 < SCOREBOX[2]):
                blocks[by, bx] = np.nan
    band = blocks[PITCH_TOP // BLOCK: PITCH_BOTTOM // BLOCK, :]
    if np.all(np.isnan(band)):
        return 0.0
    return float(np.nanmax(band))


def read_second(frames_dir, t):
    """Objective motion reading for second ``t`` (uses frames t-1 and t)."""
    cur = frame_luma(frames_dir, t)
    prev = frame_luma(frames_dir, t - 1) if t > 0 else None
    if cur is None:
        return {"t": t, "error": "missing frame"}
    if prev is None:
        return {"t": t, "cut": True, "score": 0.0, "raw_diff": 0.0, "shift": None,
                "note": "first frame"}
    raw = float(np.abs(cur - prev).mean())
    dy, dx = global_shift(prev, cur)
    resid = np.abs(cur - shift_image(prev, dy, dx))
    ok = ~np.isnan(resid)
    score = block_score(np.where(ok, resid, np.nan))
    return {
        "t": t,
        "cut": bool(raw > CUT_T),
        "raw_diff": round(raw, 2),
        "shift": [dy, dx],
        "score": round(score, 2),
    }


def shot_at(rec, threshold):
    return bool(rec.get("score", 0.0) >= threshold and not rec.get("cut"))


def auc(pos, neg):
    """Rank-based AUC (how often a shot second scores above a control second).

    Ties get the average rank, so an uninformative score lands on 0.5 instead of
    drifting with the order the seconds happen to be listed in.
    """
    if not pos or not neg:
        return None
    values = pos + neg
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    rp = sum(ranks[: len(pos)])
    return round((rp - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg)), 3)


def diagnostics(reads, frames_dir):
    """Does the score separate shot windows from control windows at all?

    Reports the AUC of the raw score plus an alignment sanity check: on quiet
    seconds (``raw_diff < 35``) an exhaustive integer-shift search is compared
    with the phase-correlation alignment. If the aligned residual stays close to
    the unaligned difference, the residual is per-frame sensor/encoder noise and
    not unexplained camera motion — i.e. the ball is below the noise floor.
    """
    pos = [r["score"] for r in reads if r["group"] == "shot" and not r["cut"]]
    neg = [r["score"] for r in reads if r["group"] == "control" and not r["cut"]]
    quiet = sorted({r["t"] for r in reads if r.get("raw_diff", 99) < 35 and not r["cut"]})[:20]
    checks = []
    for t in quiet:
        cur = frame_luma(frames_dir, t)
        prev = frame_luma(frames_dir, t - 1)
        if cur is None or prev is None:
            continue
        dy, dx = global_shift(prev, cur)
        aligned = shift_image(prev, dy, dx)
        ok = ~np.isnan(aligned)
        checks.append({
            "t": t,
            "raw_diff": round(float(np.abs(cur - prev).mean()), 2),
            "aligned_residual": round(float(np.abs(cur - aligned)[ok].mean()), 2),
            "shift": [dy, dx],
        })
    aligned_mean = (round(float(np.mean([c["aligned_residual"] for c in checks])), 2)
                    if checks else None)
    raw_mean = round(float(np.mean([c["raw_diff"] for c in checks])), 2) if checks else None
    return {
        "score_auc": auc(pos, neg),
        "shot_median_score": round(float(np.median(pos)), 2) if pos else None,
        "control_median_score": round(float(np.median(neg)), 2) if neg else None,
        "noncut_shot_seconds": len(pos),
        "noncut_control_seconds": len(neg),
        "alignment_check": {
            "quiet_seconds": len(checks),
            "raw_diff_mean": raw_mean,
            "aligned_residual_mean": aligned_mean,
        },
    }


def load_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def classify_windows(manifest):
    shot, control = [], []
    for w in manifest["windows"]:
        if w["ground_truth"] != "no_goal":
            continue
        if w.get("evidence") in SHOT_EVIDENCE:
            shot.append(w)
        elif w.get("evidence") == "none":
            control.append(w)
    return shot, control


def primary_reads(path):
    """The committed thinking-on reads, keyed (window id, second) for pass 1."""
    out = {}
    for rec in load_jsonl(path):
        if rec.get("pass") != 1 or not rec.get("class"):
            continue
        out[(rec["id"], int(rec["t"]))] = rec
    return out


def window_seconds(w):
    return list(range(w["t_start"], w["t_end"] + 1))


def sweep(reads, shot_wins, control_wins, primary):
    rows = []
    for thr in SWEEP:
        by_t = {r["t"]: r for r in reads}
        repro = [w["id"] for w in shot_wins
                 if any(shot_at(by_t[t], thr) for t in window_seconds(w) if t in by_t)]
        false_dense = [{"id": w["id"], "t": t} for w in control_wins
                       for t in window_seconds(w) if t in by_t and shot_at(by_t[t], thr)]
        # same-second vote against the committed thinking-on reads
        overlap = sorted(primary)
        l2_shot = {k: shot_at(by_t[k[1]], thr) for k in overlap if k[1] in by_t}
        l1_shot = {k: primary[k].get("class") in SHOT_CLASSES for k in overlap}
        agree = sum(1 for k in overlap if k in l2_shot and l1_shot[k] == l2_shot[k])
        both = {k for k in overlap if k in l2_shot and l2_shot[k] and l1_shot[k]}
        vote_repro = [w["id"] for w in shot_wins
                      if any(k[0] == w["id"] and k in both for k in overlap)]
        control_keys = [k for k in overlap if k[0] in {c["id"] for c in control_wins}]
        vote_false = [{"id": k[0], "t": k[1]} for k in control_keys if k in both]
        rows.append({
            "threshold": thr,
            "shot_windows_reproduced": len(repro),
            "shot_windows_total": len(shot_wins),
            "reproduced_ids": repro,
            "control_seconds_false_l2": len([f for f in false_dense
                                             if f["id"] in {c["id"] for c in control_wins}]),
            "vote_pairs": len(overlap),
            "vote_agreement_pct": round(100.0 * agree / len(overlap), 1) if overlap else None,
            "vote_windows_reproduced": len(vote_repro),
            "vote_control_seconds_false": len(vote_false),
            "vote_control_seconds_total": len(control_keys),
            "vote_reproduced_ids": vote_repro,
            "vote_false_ids": vote_false,
        })
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", required=True, help="dir of f_%04d.jpg 1x frames")
    ap.add_argument("--manifest", default=os.path.join(HERE, "label-manifest.json"))
    ap.add_argument("--primary", default=os.path.join(HERE, "results", "calib_thinking_on.jsonl"),
                    help="committed thinking-on reads, for the two-layer vote")
    ap.add_argument("--out", default=None, help="per-second JSONL for the manifest windows")
    ap.add_argument("--json", default=None, help="summary JSON")
    ap.add_argument("--whole-video", default=None, help="per-second JSONL for every second")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--from", dest="t0", type=int, default=0)
    ap.add_argument("--to", dest="t1", type=int, default=776)
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    shot_wins, control_wins = classify_windows(manifest)

    # 1. per-second reads over every manifest window (shot + control)
    reads = []
    for group, wins in (("shot", shot_wins), ("control", control_wins)):
        for w in wins:
            for t in window_seconds(w):
                rec = read_second(args.frames, t)
                rec.update({"id": w["id"], "group": group, "evidence": w.get("evidence")})
                rec["shot_motion"] = shot_at(rec, args.threshold)
                reads.append(rec)
    if args.out:
        with open(args.out, "w") as fh:
            for rec in reads:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")

    # 2. optional whole-video read (the reusable artefact for a dense pass)
    whole = []
    if args.whole_video:
        for t in range(max(1, args.t0), args.t1 + 1):
            rec = read_second(args.frames, t)
            rec["shot_motion"] = shot_at(rec, args.threshold)
            whole.append(rec)
        with open(args.whole_video, "w") as fh:
            for rec in whole:
                fh.write(json.dumps(rec, sort_keys=True) + "\n")

    # 3. threshold sweep + the two-layer vote
    primary = primary_reads(args.primary)
    rows = sweep(reads, shot_wins, control_wins, primary)
    control_by_t = {}
    for rec in reads:
        if rec["group"] == "control":
            control_by_t[rec["t"]] = rec

    op = [r for r in rows if r["threshold"] == args.threshold]
    op = op[0] if op else None
    gate = [r for r in rows
            if r["vote_windows_reproduced"] >= 8 and r["vote_control_seconds_false"] <= 2]
    control_seconds_total = sum(len(window_seconds(w)) for w in control_wins)
    l2_only = [r for r in rows
               if r["shot_windows_reproduced"] >= 8
               and r["control_seconds_false_l2"] <= 2]
    diag = diagnostics(reads, args.frames)

    if gate:
        verdict = "gate met at threshold(s) %s" % [g["threshold"] for g in gate]
    elif diag.get("score_auc") is not None and diag["score_auc"] < 0.55:
        verdict = ("layer carries no discriminative signal (score AUC %.3f, chance = 0.5): "
                   "no threshold in the sweep meets the calibration bar" % diag["score_auc"])
    else:
        verdict = "no threshold in the sweep meets the calibration bar"

    summary = {
        "layer": {
            "name": "objective goal-mouth motion detector (temporal pixel residual)",
            "independent_of": "vision-model prompt reads: no model, no key, no network, no sampling",
            "deterministic": True,
            "frames": "1x job frames (640x360, 3 fps, f_{t:04d}.jpg = seq 3*t)",
            "score": "max mean |frame(t) - shift(frame(t-1))| over 8x8 blocks in the pitch band",
            "cut_rule": "mean |frame(t)-frame(t-1)| > %.0f -> cut, excluded from shot evidence" % CUT_T,
            "operating_threshold": args.threshold,
            "sweep_thresholds": SWEEP,
        },
        "manifest": {
            "shot_windows": len(shot_wins),
            "shot_window_ids": [w["id"] for w in shot_wins],
            "control_windows": len(control_wins),
            "control_window_ids": [w["id"] for w in control_wins],
            "control_seconds_total": control_seconds_total,
            "shot_seconds_total": sum(len(window_seconds(w)) for w in shot_wins),
        },
        "operating_point": op,
        "sweep": rows,
        "discrimination": diag,
        "verdict": verdict,
        "gate": {
            "requires": {"reproduced_shot_windows_min": 8, "control_false_seconds_max": 2,
                         "vote": "both layers call a shot at the same second"},
            "voting_thresholds_meeting_it": [g["threshold"] for g in gate],
            "layer_alone_thresholds_meeting_it": [r["threshold"] for r in l2_only],
            "met": bool(gate),
        },
    }
    text = json.dumps(summary, indent=1)
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(text + "\n")

    print("layer: deterministic motion residual, %d shot + %d control windows"
          % (len(shot_wins), len(control_wins)))
    print("%-5s %-9s %-11s %-8s %-8s %-10s" % ("thr", "L2 shot", "L2 false s", "vote win",
                                              "vote false", "vote agree"))
    for r in rows:
        print("%-5d %-9s %-11d %-8d %-8d %-10s"
              % (r["threshold"],
                 "%d/%d" % (r["shot_windows_reproduced"], len(shot_wins)),
                 r["control_seconds_false_l2"],
                 r["vote_windows_reproduced"],
                 r["vote_control_seconds_false"],
                 r["vote_agreement_pct"]))
    print("gate met:", summary["gate"]["met"],
          "| thresholds meeting it:", summary["gate"]["voting_thresholds_meeting_it"])
    print("score AUC:", diag.get("score_auc"),
          "| shot vs control median score:", diag.get("shot_median_score"),
          diag.get("control_median_score"),
          "| alignment raw vs aligned:", diag["alignment_check"]["raw_diff_mean"],
          diag["alignment_check"]["aligned_residual_mean"])
    print("verdict:", verdict)
    if args.json:
        print("wrote", args.json)
    if args.out:
        print("wrote", args.out)
    if args.whole_video:
        print("wrote", args.whole_video)


if __name__ == "__main__":
    main()
