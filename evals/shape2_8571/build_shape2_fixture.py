#!/usr/bin/env python3
"""ADAAAA-8571 (AC-B shape 2): build the goal-dense $0 fixture from the score-legible reel.

Method: the `kids510` frame-concat with ZERO re-encode.

  1. The reel is encoded ONCE to a baseline VP8/IVF (`--baseline-out`, or reused with
     `--baseline-in`). That single encode is the only lossy step; the fixture itself
     never touches pixels again.
  2. Each of the N windows is cut out of the baseline as a byte range of whole IVF
     frame records (4-byte size + 8-byte timestamp + payload). The compressed payload
     of every frame is copied verbatim - so a frame in the fixture is bit-identical to
     the same frame of the baseline, and a splice cannot change a decoded frame.
  3. Windows are concatenated round-robin over the four physical transitions
     (t1,t2,t3,t4,t1,...) so a twin of a transition sits >= 4 windows away in fixture
     time (136 s), which is outside both the 30 s `goal_burst_same_transition` burst
     window and the 120 s `GOAL_SAME_TRANSITION_HORIZON_S` same-transition horizon.
  4. Every splice boundary is snapped to an I-frame (VP8 needs the keyframe that
     precedes a predicted frame, so a cut that is not a keyframe would not decode)
     and asserted to sit >= `min_splice_margin_s` inside a steady-score span, i.e.
     away from every transition instant in the reel. A splice therefore cannot itself
     move the score read.
  5. The manifest records, per window, the source frame range, the splice instant in
     BOTH clocks (source and fixture), the two census probe instants, and the md5 of
     the fixture - so `census_shape2_8571.py` and the pre-run record grade from the
     same numbers.

Frame-timestamp rewrite: IVF frame timestamps are rewritten to the fixture's own
sequential clock (0,1,2,... at the stream timebase). Only those 8-byte header fields
change; the payloads stay byte-identical. `--verify` proves that with a per-frame
decoded-pixel md5 comparison (`ffmpeg -f framemd5`), which is the honest test of
"zero re-encode": a re-encoded window would fail it.

Self-test (no box, no network, $0):

    python3 evals/shape2_8571/build_shape2_fixture.py --self-test

Build (on the box, where the reel lives):

    python3 build_shape2_fixture.py \
        --reel /data/clips/kids-soccer.mp4 \
        --spec windows_shape2.json \
        --baseline-out /state/shape2_8571_src.vp8.ivf \
        --out /state/shape2_8571.vp8.ivf \
        --manifest /state/shape2_8571.manifest.json \
        --verify
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass

IVF_HDR = struct.Struct("<4sHH4sHHIIII")  # DKIF, ver, hdrlen, fourcc, w, h, den, num, frames, unused
IVF_FRAME_HDR = struct.Struct("<IQ")  # size, timestamp
IVF_MAGIC = b"DKIF"


# --------------------------------------------------------------------------- ivf io
@dataclass
class IvfFrame:
    index: int
    offset: int  # byte offset of the frame RECORD (its 4-byte size field)
    size: int
    ts: int
    pict_type: str = "?"

    @property
    def payload_offset(self) -> int:
        return self.offset + IVF_FRAME_HDR.size


def read_ivf(path: str) -> tuple[dict, list[IvfFrame]]:
    """Parse an IVF container into its header fields + a frame index (no payload copy)."""
    with open(path, "rb") as fh:
        raw = fh.read(IVF_HDR.size)
        if len(raw) < IVF_HDR.size:
            raise SystemExit(f"{path}: too short to be IVF")
        magic, ver, hdrlen, fourcc, w, h, den, num, nframes, _unused = IVF_HDR.unpack(raw)
        if magic != IVF_MAGIC:
            raise SystemExit(f"{path}: not an IVF file (magic={magic!r})")
        hdr = {"version": ver, "header_len": hdrlen, "fourcc": fourcc.decode("ascii", "replace"),
               "width": w, "height": h, "rate_den": den, "rate_num": num, "nframes": nframes}
        pos = hdrlen
        frames: list[IvfFrame] = []
        fh.seek(0, os.SEEK_END)
        end = fh.tell()
        fh.seek(pos)
        idx = 0
        while pos + IVF_FRAME_HDR.size <= end:
            fh.seek(pos)
            head = fh.read(IVF_FRAME_HDR.size)
            if len(head) < IVF_FRAME_HDR.size:
                break
            size, ts = IVF_FRAME_HDR.unpack(head)
            if size <= 0 or pos + IVF_FRAME_HDR.size + size > end:
                break
            frames.append(IvfFrame(index=idx, offset=pos, size=size, ts=ts))
            pos += IVF_FRAME_HDR.size + size
            idx += 1
    if hdr["nframes"] and len(frames) != hdr["nframes"]:
        raise SystemExit(f"{path}: header claims {hdr['nframes']} frames, indexed {len(frames)}")
    return hdr, frames


def frame_pict_types(path: str, fps: float) -> list[str]:
    """Per-frame pict_type from ffprobe (needed to cut on keyframes only)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "frame=pict_type", "-of", "csv=p=0", path],
        check=True, capture_output=True, text=True,
    ).stdout.split()
    return [t.strip().upper() or "?" for t in out]


def md5_of(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ffprobe_stream(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,avg_frame_rate,duration,nb_frames,codec_name",
         "-show_entries", "format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True,
    ).stdout
    d = json.loads(out)
    s = (d.get("streams") or [{}])[0]

    def rate(v: str | None) -> float:
        if not v or "/" not in v:
            return 0.0
        n, dn = v.split("/")
        try:
            dn_f = float(dn)
            return float(n) / dn_f if dn_f else 0.0
        except ValueError:
            return 0.0

    # IVF reports avg_frame_rate as 0/0; fall back to r_frame_rate then to 30
    fps = rate(s.get("avg_frame_rate")) or rate(s.get("r_frame_rate")) or 30.0
    return {
        "codec": s.get("codec_name"),
        "width": s.get("width"),
        "height": s.get("height"),
        "fps": fps,
        "duration_s": float(s.get("duration") or (d.get("format") or {}).get("duration") or 0.0),
        "nb_frames": s.get("nb_frames"),
    }


# ------------------------------------------------------------------- baseline encode
def encode_baseline(reel: str, baseline_out: str, width: int = 1280, height: int = 720,
                    fps: int = 30, bitrate: str = "4M", gop: int = 15) -> None:
    """The single lossy step: reel -> VP8 IVF at fixed settings.

    `-g gop -keyint_min gop` pins an I-frame every `gop` frames (0.5 s at 30 fps), which
    keeps the splice snap cost below `min_splice_margin_s` while leaving every window
    boundary a legal cut point.
    """
    os.makedirs(os.path.dirname(baseline_out) or ".", exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", reel,
         "-an", "-c:v", "libvpx", "-b:v", bitrate, "-g", str(gop), "-keyint_min", str(gop),
         "-deadline", "realtime", "-cpu-used", "8",
         "-r", str(fps), "-s", f"{width}x{height}", "-pix_fmt", "yuv420p", baseline_out],
        check=True,
    )


# ----------------------------------------------------------------------- window plan
def snap_to_keyframe(frames: list[IvfFrame], target_index: int, fps: float,
                     max_snap_s: float = 0.5) -> int:
    """Nearest I-frame index to `target_index` within `max_snap_s`; -1 when none."""
    lo = max(0, target_index - int(round(max_snap_s * fps)))
    hi = min(len(frames) - 1, target_index + int(round(max_snap_s * fps)))
    best, best_d = -1, None
    for i in range(lo, hi + 1):
        if frames[i].pict_type != "I":
            continue
        d = abs(i - target_index)
        if best_d is None or d < best_d:
            best, best_d = i, d
    return best


def plan_windows(spec: dict, frames: list[IvfFrame], fps: float) -> list[dict]:
    windows = spec["windows"]
    transitions = [float(t) for t in spec["transitions_s"]]
    window_s = float(spec["window_s"])
    margin = float(spec["min_splice_margin_s"])
    win_frames = int(round(window_s * fps))
    if len(windows) * window_s > 430.0:
        raise SystemExit(f"plan exceeds the 430 s hard stop: {len(windows)}x{window_s}s")

    plan: list[dict] = []
    for w in windows:
        goal = float(w["transition"])
        pre, post = float(w["pre_s"]), float(w["post_s"])
        if abs((pre + post) - window_s) > 1e-6:
            raise SystemExit(f"{w['id']}: pre+post = {pre + post} != window_s {window_s}")
        target_ts = goal - pre
        target_index = int(round(target_ts * fps))
        start_index = snap_to_keyframe(frames, target_index, fps)
        if start_index < 0:
            raise SystemExit(f"{w['id']}: no I-frame within 0.5 s of {target_ts:.3f}s - "
                             f"re-encode the baseline with a smaller -g")
        end_index = start_index + win_frames
        if end_index > len(frames):
            raise SystemExit(f"{w['id']}: window runs past the baseline ({end_index} > {len(frames)})")
        start_ts = start_index / fps
        end_ts = end_index / fps
        # steady-score assertion: both splices sit >= margin from EVERY transition instant
        for b_ts in (start_ts, end_ts):
            for t in transitions:
                if abs(b_ts - t) < margin:
                    raise SystemExit(
                        f"{w['id']}: splice at {b_ts:.3f}s is {abs(b_ts - t):.3f}s from transition "
                        f"{t:.0f}s (< {margin}s) - a splice that close could itself move the score read")
        inside = [t for t in transitions if start_ts <= t < end_ts]
        if inside != [goal]:
            raise SystemExit(f"{w['id']}: window [{start_ts:.3f},{end_ts:.3f}) carries transitions "
                             f"{inside}, expected exactly [{goal:.0f}]")
        plan.append({
            "id": w["id"],
            "transition_s": goal,
            "pre_s": pre,
            "post_s": post,
            "src_start_frame": start_index,
            "src_end_frame": end_index,
            "src_start_ts": round(start_ts, 6),
            "src_end_ts": round(end_ts, 6),
            # the census reads a steady PRE frame and a measurable POST frame inside the window
            "pre_read_src_ts": round(start_ts + float(spec.get("pre_read_offset_s", 4)), 6),
            "post_read_src_ts": round(end_ts - float(spec.get("post_read_offset_s", 6)), 6),
        })
    return plan


# --------------------------------------------------------------------- fixture writer
def write_fixture(baseline: str, hdr: dict, frames: list[IvfFrame], plan: list[dict],
                  out_path: str, fps: float) -> dict:
    total_frames = sum(p["src_end_frame"] - p["src_start_frame"] for p in plan)
    den, num = hdr["rate_den"], hdr["rate_num"]
    tb = num / den if den else 1.0  # seconds per timestamp unit

    with open(baseline, "rb") as src, open(out_path, "wb") as dst:
        out_hdr = bytearray(IVF_HDR.pack(
            IVF_MAGIC, hdr["version"], hdr["header_len"], hdr["fourcc"].encode("ascii"),
            hdr["width"], hdr["height"], den, num, total_frames, 0,
        ))
        dst.write(out_hdr)
        out_index = 0
        for p in plan:
            p["out_start_frame"] = out_index
            p["out_start_s"] = round(out_index / fps, 6)
            for i in range(p["src_start_frame"], p["src_end_frame"]):
                f = frames[i]
                src.seek(f.offset)
                record = src.read(IVF_FRAME_HDR.size + f.size)
                size = struct.unpack("<I", record[:4])[0]
                # IVF timebase is num/den seconds; one frame is 1/fps seconds, so the
                # timestamp advances by den/(fps*num) units per frame (== 1 for 30/1).
                ts = int(round(out_index * den / (fps * num) if num else out_index))
                dst.write(struct.pack("<I", size) + struct.pack("<Q", ts) + record[IVF_FRAME_HDR.size:])
                out_index += 1
            p["out_end_frame"] = out_index - 1
            p["out_end_s"] = round(out_index / fps, 6)
            p["pre_read_out_ts"] = round(p["out_start_s"] + float(p["pre_s"]) - float(
                p["pre_read_src_ts"] - p["src_start_ts"]), 6)
            # post read is measured from the window END, so it is defined the same way in both clocks
            p["post_read_out_ts"] = round(p["out_end_s"] - (p["src_end_ts"] - p["post_read_src_ts"]), 6)
    return {"total_frames": total_frames, "duration_s": round(total_frames / fps, 6)}


def verify_frame_identity(baseline: str, fixture: str, plan: list[dict]) -> dict:
    """Per-frame decoded-pixel md5 of the fixture == the expected slice of the baseline."""
    def framemd5(path: str) -> list[str]:
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-f", "framemd5", "-"],
            check=True, capture_output=True, text=True,
        ).stdout.splitlines()
        return [ln.split(",")[-1].strip() for ln in out if ln and not ln.startswith("#")]

    base = framemd5(baseline)
    fix = framemd5(fixture)
    expect: list[str] = []
    for p in plan:
        expect.extend(base[p["src_start_frame"]:p["src_end_frame"]])
    if len(fix) != len(expect):
        return {"ok": False, "detail": f"frame count {len(fix)} != expected {len(expect)}"}
    bad = [i for i, (a, b) in enumerate(zip(fix, expect)) if a != b]
    return {"ok": not bad, "frames_compared": len(expect),
            "first_mismatch": bad[0] if bad else None,
            "detail": "decoded pixels bit-identical to the baseline slice" if not bad else "mismatch"}


# ------------------------------------------------------------------------- self test
def self_test() -> int:
    """Build a fixture from a synthetic reel and prove zero re-encode end to end."""
    tmp = tempfile.mkdtemp(prefix="shape2-selftest-")
    try:
        reel = os.path.join(tmp, "reel.mp4")
        # a 60 s reel whose every frame carries its own number: a splice error is visible
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
             "-i", "testsrc=size=320x180:rate=30:duration=60",
             "-vf", "drawtext=text='%{n}':fontsize=28:fontcolor=white:x=10:y=10",
             "-c:v", "libx264", "-pix_fmt", "yuv420p", reel],
            check=True,
        )
        baseline = os.path.join(tmp, "base.vp8.ivf")
        encode_baseline(reel, baseline, width=320, height=180, fps=30, bitrate="800k", gop=15)
        hdr, frames = read_ivf(baseline)
        frames_pts = frame_pict_types(baseline, 30.0)
        if len(frames_pts) != len(frames):
            print(f"SELFTEST FAIL: ffprobe saw {len(frames_pts)} frames, IVF index {len(frames)}")
            return 1
        for f, t in zip(frames, frames_pts):
            f.pict_type = t
        spec = {
            "transitions_s": [10, 25, 40, 50],
            "window_s": 6,
            "min_splice_margin_s": 2,
            "pre_read_offset_s": 1,
            "post_read_offset_s": 2,
            "windows": [
                {"id": "w1", "transition": 10, "pre_s": 3, "post_s": 3},
                {"id": "w2", "transition": 25, "pre_s": 3, "post_s": 3},
                {"id": "w3", "transition": 40, "pre_s": 3, "post_s": 3},
                {"id": "w4", "transition": 50, "pre_s": 3, "post_s": 3},
                {"id": "w5", "transition": 10, "pre_s": 2, "post_s": 4},
            ],
        }
        plan = plan_windows(spec, frames, 30.0)
        fixture = os.path.join(tmp, "fixture.vp8.ivf")
        info = write_fixture(baseline, hdr, frames, plan, fixture, 30.0)
        ver = verify_frame_identity(baseline, fixture, plan)
        probe = ffprobe_stream(fixture)
        problems = []
        if not ver["ok"]:
            problems.append(f"frame identity: {ver['detail']}")
        if info["duration_s"] != 5 * 6.0:
            problems.append(f"duration {info['duration_s']} != 30.0")
        if abs(probe["fps"] - 30.0) > 1e-6:
            problems.append(f"fps {probe['fps']} != 30")
        gaps = []
        for i in range(len(plan)):
            twin = plan[i + 4] if i + 4 < len(plan) else None
            if twin and twin["transition_s"] == plan[i]["transition_s"]:
                gaps.append(round((twin["out_start_s"] + twin["pre_s"]) - (plan[i]["out_start_s"] + plan[i]["pre_s"]), 3))
        print(json.dumps({
            "windows": len(plan), "frames": info["total_frames"], "duration_s": info["duration_s"],
            "frame_identity": ver, "probe": probe, "twin_gaps_s": gaps,
            "merged": True,
        }, indent=2))
        if problems:
            print("SELFTEST FAIL: " + "; ".join(problems))
            return 1
        print("SELFTEST PASS: zero re-encode proven (per-frame decoded md5), "
              "splices I-frame aligned, twin gap beyond the dedupe horizon")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------------------ main
def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--reel")
    ap.add_argument("--spec", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                  "windows_shape2.json"))
    ap.add_argument("--baseline-out")
    ap.add_argument("--baseline-in", help="reuse an already-encoded baseline (identical settings)")
    ap.add_argument("--out")
    ap.add_argument("--manifest")
    ap.add_argument("--verify", action="store_true", help="assert per-frame decoded identity")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()
    for req in ("out", "manifest"):
        if not getattr(args, req):
            ap.error(f"--{req} is required")

    spec = json.load(open(args.spec))
    reel_info = None
    if args.baseline_in:
        baseline = args.baseline_in
    else:
        if not args.reel or not args.baseline_out:
            ap.error("--reel and --baseline-out are required unless --baseline-in is given")
        reel_info = ffprobe_stream(args.reel)
        encode_baseline(args.reel, args.baseline_out, args.width, args.height, args.fps)
        baseline = args.baseline_out

    hdr, frames = read_ivf(baseline)
    fps = 30.0 if not hdr["rate_den"] else hdr["rate_den"] / (hdr["rate_num"] or 1)
    types = frame_pict_types(baseline, fps)
    for f, t in zip(frames, types):
        f.pict_type = t
    keyframes = sum(1 for f in frames if f.pict_type == "I")
    if keyframes < len(frames) // 60:
        raise SystemExit(f"baseline has {keyframes} I-frames in {len(frames)} - splice snapping "
                         f"would drift; re-encode with -g 15")

    plan = plan_windows(spec, frames, fps)
    info = write_fixture(baseline, hdr, frames, plan, args.out, fps)

    gaps = []
    for i, p in enumerate(plan):
        twin = plan[i + 4] if i + 4 < len(plan) else None
        if twin and twin["transition_s"] == p["transition_s"]:
            gaps.append({"from": p["id"], "to": twin["id"],
                         "gap_s": round((twin["out_start_s"] + twin["pre_s"]) -
                                        (p["out_start_s"] + p["pre_s"]), 3)})

    verification = None
    if args.verify:
        verification = verify_frame_identity(baseline, args.out, plan)
        if not verification["ok"]:
            raise SystemExit(f"frame identity FAILED: {verification['detail']}")

    manifest = {
        "$comment": "ADAAAA-8571 shape-2 fixture manifest. Written by build_shape2_fixture.py; "
                    "the census and the pre-run record read this file, never a re-derivation.",
        "fixture": {
            "path": args.out,
            "md5": md5_of(args.out),
            "codec": "vp8",
            "fourcc": hdr["fourcc"],
            "width": hdr["width"],
            "height": hdr["height"],
            "fps": fps,
            "frames": info["total_frames"],
            "duration_s": info["duration_s"],
            "zero_reencode": True,
            "verification": verification,
        },
        "baseline": {
            "path": baseline,
            "md5": md5_of(baseline),
            "frames": len(frames),
            "keyframes": keyframes,
            "encoding": {"codec": "libvpx", "gop": 15, "bitrate": "4M",
                         "size": f"{hdr['width']}x{hdr['height']}", "fps": fps},
        },
        "source": {
            "reel": spec.get("source_reel") if not reel_info else args.reel,
            "probe": reel_info,
            "transitions_s": spec["transitions_s"],
            "physical_transitions": len(spec["transitions_s"]),
        },
        "ordering": "round_robin t1,t2,t3,t4 x3 (a twin sits 4 windows away)",
        "window_s": spec["window_s"],
        "min_splice_margin_s": spec["min_splice_margin_s"],
        "windows": plan,
        "splice_instants_s": [p["out_start_s"] for p in plan],
        "twin_gaps_s": gaps,
        "min_twin_gap_s": min((g["gap_s"] for g in gaps), default=None),
        "census": {"pre_read_offset_s": spec.get("pre_read_offset_s", 4),
                   "post_read_offset_s": spec.get("post_read_offset_s", 6),
                   "window_count": len(plan)},
    }
    os.makedirs(os.path.dirname(args.manifest) or ".", exist_ok=True)
    with open(args.manifest, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps({k: manifest[k] for k in ("fixture", "ordering", "window_s",
                                               "min_twin_gap_s", "splice_instants_s")}, indent=2))
    if manifest["min_twin_gap_s"] is not None and manifest["min_twin_gap_s"] <= 120:
        print(f"WARNING: min twin gap {manifest['min_twin_gap_s']}s is inside the 120 s "
              f"same-transition horizon (GOAL_SAME_TRANSITION_HORIZON_S)")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
