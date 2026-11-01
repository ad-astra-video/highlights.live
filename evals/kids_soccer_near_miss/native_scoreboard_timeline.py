#!/usr/bin/env python3
"""Native-resolution scoreboard timeline (ADAAAA-7611, AC-2).

Why a second scoreboard pass: the 1x detector (`detect_scoreboard_changes.py`)
diffs the score-digit box on the pipeline's 640x360 cache. That cache renders the
digits at ~42x17 px and the digit box sits on a **semi-transparent** red bar, so
the background scene shows through and a mean-luma difference fires on scene
changes, not only on score changes. Its candidate list is therefore a list of
"inspect these seconds", which is why 16 of its candidates stayed unconfirmed.

The upload itself is 1280x720, so the digits are 84x34 there. This module reads
the source video directly (ffmpeg pipe, no frame cache) and builds a per-second
*score state* timeline instead of a diff list:

  * ``present``    — the red score bar is on screen (mean R-G over the bar box),
  * ``glyphs``     — a 21x9 mask of the white digit pixels inside the bar,
  * ``state``      — a cluster id for that mask across the whole video,
  * ``state_dist`` — distance from the previous second's mask,
  * ``raw_diff``   — whole-frame mean |cur - prev|, i.e. the broadcast-cut signal.

A real goal moves the digits **inside one continuous passage**; a cut re-renders
the overlay and changes the mask without a goal. So the classifier this feeds is:

  * ``noise``          — the mask barely moves (the 1x candidate was encoder noise),
  * ``cut_artifact``   — the mask moves at the same second as a cut,
  * ``score_change``   — the mask moves with no cut: a genuine scoreboard update.

That turns AC-2's 16 unconfirmed candidates into an objective verdict each,
without a vision model in the loop and without decide's text.

Usage
-----
  python3 native_scoreboard_timeline.py --video /path/kids-soccer.mp4 \\
      --out results/native_scoreboard_timeline.jsonl \\
      --json results/native_scoreboard_timeline.json

Pure stdlib + numpy + ffmpeg. No model, no key, no network.
"""
import argparse
import json
import subprocess

import numpy as np

# Boxes are for 1280x720. They are exactly 2x the 1x detector's boxes
# (BAR 89,14,165,31 / DIGITS 112,14,154,31 at 640x360), so the same overlay
# region is measured at the source's resolution.
BAR_BOX = (178, 28, 330, 62)
DIGIT_BOX = (224, 28, 308, 64)
PRESENT_T = 40.0     # mean R-G over the bar that counts as "score bar on screen"
GLYPH_T = 150        # min(R,G,B) above this is a white digit pixel
STATE_DIST_T = 0.06  # mask distance that counts as a different score state
FLAT_T = 0.02        # mask distance below this is noise, not a score change
CUT_T = 60.0         # whole-frame mean |cur-prev| that counts as a broadcast cut


def probe(video):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", video],
        capture_output=True, text=True, check=True)
    s = json.loads(out.stdout)["streams"][0]
    return int(s["width"]), int(s["height"]), s["avg_frame_rate"]


def stream_rgb(video, fps):
    w, h, _ = probe(video)
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", video,
           "-vf", "fps=%s" % fps, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    nbytes = w * h * 3
    i = 0
    try:
        while True:
            buf = p.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            yield i, np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3).astype(np.int16)
            i += 1
    finally:
        p.stdout.close()
        p.wait()


def presence(rgb):
    bar = rgb[BAR_BOX[1]:BAR_BOX[3], BAR_BOX[0]:BAR_BOX[2]]
    return float((bar[:, :, 0] - bar[:, :, 1]).mean())


def glyph_mask(rgb):
    """21x9 mask of the white digit pixels inside the score bar."""
    d = rgb[DIGIT_BOX[1]:DIGIT_BOX[3], DIGIT_BOX[0]:DIGIT_BOX[2]]
    white = (d.min(axis=2) > GLYPH_T).astype(np.float32)
    h, w = white.shape
    return white.reshape(9, h // 9, 21, w // 21).mean(axis=(1, 3))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True)
    ap.add_argument("--fps", type=float, default=1.0)
    ap.add_argument("--out", default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--from", dest="t0", type=int, default=0)
    ap.add_argument("--to", dest="t1", type=int, default=None)
    args = ap.parse_args()

    w, h, rate = probe(args.video)
    print("source: %dx%d %s fps, sampling %g fps" % (w, h, rate, args.fps))

    rows = []
    centres = []
    prev_mask = None
    prev_gray = None
    prev_present = False
    for i, rgb in stream_rgb(args.video, args.fps):
        t = int(round(i / args.fps))
        if t < args.t0 or (args.t1 is not None and t > args.t1):
            break
        p = presence(rgb)
        present = p >= PRESENT_T
        gray = rgb.mean(axis=2)
        raw = float(np.abs(gray - prev_gray).mean()) if prev_gray is not None else 0.0
        rec = {"t": t, "present": present, "presence": round(p, 1),
               "raw_diff": round(raw, 2), "cut": bool(raw > CUT_T)}
        if present:
            m = glyph_mask(rgb)
            if prev_mask is not None and prev_present:
                dist = float(np.abs(m - prev_mask).mean())
                rec["state_dist"] = round(dist, 4)
                best, bd = None, 1e9
                for cid, (c, n) in enumerate(centres):
                    d = float(np.abs(m - c).mean())
                    if d < bd:
                        best, bd = cid, d
                if best is not None and bd < STATE_DIST_T:
                    c, n = centres[best]
                    centres[best] = (c + (m - c) / (n + 1), n + 1)
                    rec["state"] = best
                else:
                    centres.append((m, 1))
                    rec["state"] = len(centres) - 1
            else:
                rec["state_dist"] = None
                rec["state"] = None
            prev_mask = m
            prev_present = True
        else:
            rec["state_dist"] = None
            rec["state"] = None
            prev_mask = None
            prev_present = False
        prev_gray = gray
        rows.append(rec)
        if len(rows) % 100 == 0:
            print("  ... %d seconds" % len(rows), flush=True)

    changes = [r for r in rows if r.get("state_dist") is not None
               and r["state_dist"] >= FLAT_T]
    for r in changes:
        r["verdict"] = "cut_artifact" if r["cut"] else "score_change"
    counts = {
        "seconds": len(rows),
        "present_seconds": sum(1 for r in rows if r["present"]),
        "cut_seconds": sum(1 for r in rows if r["cut"]),
        "mask_changes": len(changes),
        "score_changes": sum(1 for r in changes if r["verdict"] == "score_change"),
        "cut_artifacts": sum(1 for r in changes if r["verdict"] == "cut_artifact"),
        "distinct_states": len(centres),
    }
    summary = {
        "layer": {"name": "native-resolution scoreboard state timeline", "deterministic": True,
                  "source": "%dx%d %s fps, sampled %g fps" % (w, h, rate, args.fps),
                  "bar_box": BAR_BOX, "digit_box": DIGIT_BOX,
                  "rules": {"present_mean_r_minus_g": PRESENT_T, "glyph_min_rgb": GLYPH_T,
                            "state_dist": STATE_DIST_T, "flat": FLAT_T, "cut": CUT_T}},
        "counts": counts,
        "score_changes": [{"t": r["t"], "state_dist": r["state_dist"],
                           "raw_diff": r["raw_diff"], "from": None, "to": r["state"]}
                          for r in changes if r["verdict"] == "score_change"],
        "cut_artifacts": [{"t": r["t"], "state_dist": r["state_dist"], "raw_diff": r["raw_diff"]}
                          for r in changes if r["verdict"] == "cut_artifact"],
    }
    if args.out:
        with open(args.out, "w") as fh:
            for r in rows:
                fh.write(json.dumps(r, sort_keys=True) + "\n")
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(counts, indent=1))
    print("score changes (no cut):", [c["t"] for c in summary["score_changes"]])
    if args.out:
        print("wrote", args.out)
    if args.json:
        print("wrote", args.json)


if __name__ == "__main__":
    main()
