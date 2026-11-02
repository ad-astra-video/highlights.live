#!/usr/bin/env python3
"""Produce the frame-level detection slice for a type's committed eval windows.

ADAAAA-7788. The american-football measurement pass (ADAAAA-7767) produced no
frame-level detection slice, so the type had no track steps and therefore no
`motion_fire` number. This script produces exactly that slice - and nothing
wider: it decodes ONLY the windows in the label manifest, at a fixed frame
cadence, and runs the deployed detector over them.

    python3 evals/detect_slice_from_windows.py \
        --labels evals/american_football_val/label-manifest.json \
        --clip-root /home/brad/af-7788/clips \
        --profile "american football" --fps 1 \
        --max-frames 569 --budget-gpu-minutes 35 \
        --out out/af_detect_slice.json

Governance (the ADAAAA-7788 cost gate): the run is bounded BEFORE it starts.
`--max-frames` is the approved frame envelope and `--budget-gpu-minutes` is the
approved wall-clock envelope. Either one tripping stops the job with a non-zero
exit and no partial slice written, so an over-budget run cannot silently pass as
a measurement. The slice records the measured per-frame inference latency, which
is the number the cost proposal estimated; it is evidence, not an input.

No whole-game pass: a window not present in the manifest is never decoded.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "services", "perceive"))

import numpy as np  # noqa: E402


def load_profile(name):
    from app.game_profile import load_game_profile

    return load_game_profile(name)


def sha256_file(path, chunk=1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for blk in iter(lambda: fh.read(chunk), b""):
            h.update(blk)
    return h.hexdigest()


def decode_window(path, start_s, dur_s, width, height, fps):
    """Yield (t_abs, HxWx3 uint8) for each sampled frame in the window.

    A single ffmpeg decode per window at the manifest cadence: `fps` filter
    resamples to the analysis rate, so frame i is at start_s + i/fps.
    """
    cmd = [
        "ffmpeg", "-v", "error",
        "-ss", f"{start_s:.3f}",
        "-t", f"{dur_s:.3f}",
        "-i", path,
        "-vf", f"fps={fps},scale={width}:{height}",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
        "-",
    ]
    frame_bytes = width * height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pending = bytearray()
    idx = 0
    try:
        while True:
            chunk = proc.stdout.read(frame_bytes * 8)
            if not chunk:
                break
            pending.extend(chunk)
            while len(pending) >= frame_bytes:
                raw = bytes(pending[:frame_bytes])
                del pending[:frame_bytes]
                img = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)
                yield (start_s + idx / fps, img)
                idx += 1
    finally:
        proc.stdout.close()
        proc.wait()


def build_slice_doc(
    *,
    profile_key,
    type_key=None,
    vocabulary,
    fps,
    clip_name,
    clip_sha256,
    clip_bytes,
    label_manifest,
    frames,
    latency,
    detector_label,
    detector_model,
    envelope,
    windows,
):
    """Assemble the slice document.

    Kept separate from `main()` so the artifact shape (and, ADAAAA-7801, the
    weights identity it carries) is testable on a CPU host without ffmpeg, torch
    or a GPU.
    """
    return {
        "type": type_key or profile_key,
        "profile": profile_key,
        "vocabulary": list(vocabulary),
        "fps": fps,
        "clip": {"name": clip_name, "sha256": clip_sha256, "bytes": clip_bytes},
        "labelManifest": label_manifest,
        "frames": frames,
        "latency": latency,
        "detector": detector_label,
        # ADAAAA-7801: `detector` is a device label, not a model. The weights
        # identity is recorded here so a committed slice can be checked on a CPU
        # host (per-file sha256 for a local model dir, hub commit for a hub id).
        "detectorModel": detector_model,
        "envelope": envelope,
        "windows": windows,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True, help="label manifest with the windows to score")
    ap.add_argument("--clip-root", required=True, help="dir holding the manifest's clip file")
    ap.add_argument("--profile", required=True, help="game profile key (e.g. 'american football')")
    ap.add_argument("--fps", type=float, default=1.0, help="analysis cadence (deployed VOD cap is 1 fps)")
    ap.add_argument("--max-frames", type=int, required=True, help="approved frame envelope (hard stop)")
    ap.add_argument("--budget-gpu-minutes", type=float, required=True, help="approved wall-clock envelope (hard stop)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default=None, help="override FLORENCE_MODEL")
    ap.add_argument("--only-window", default=None, help="debug: single window id")
    args = ap.parse_args()

    manifest = json.load(open(args.labels))
    video = manifest["video"]
    clip_name = video["path"]
    clip_path = os.path.join(args.clip_root, clip_name)
    if not os.path.exists(clip_path):
        raise SystemExit(f"clip not found: {clip_path}")

    digest = sha256_file(clip_path)
    if video.get("sha256") and digest != video["sha256"]:
        raise SystemExit(
            f"clip sha256 mismatch: {digest} != pinned {video['sha256']} - refusing to measure"
        )

    profile = load_profile(args.profile)
    vocab = list(profile.vocabulary)
    if not vocab:
        raise SystemExit(f"profile {profile.key!r} declares no detection vocabulary")

    windows = manifest["windows"]
    if args.only_window:
        windows = [w for w in windows if w["id"] == args.only_window]
        if not windows:
            raise SystemExit(f"no such window: {args.only_window}")

    planned = sum(int(round((w["t_end"] - w["t_start"]) * args.fps)) for w in windows)
    print(f"plan: {len(windows)} windows, {planned} frames @ {args.fps} fps "
          f"(envelope {args.max_frames} frames / {args.budget_gpu_minutes} GPU-min)")
    if planned > args.max_frames:
        raise SystemExit(
            f"planned {planned} frames exceeds the approved envelope {args.max_frames} - "
            "stop and return a revised proposal"
        )

    from app.florence import FlorenceDetector

    det = FlorenceDetector(model_name=args.model) if args.model else FlorenceDetector()
    det.load()
    print(f"detector: {det.device_label} vocab={vocab}")

    out_windows = []
    total_frames = 0
    total_ms = 0.0
    started = time.time()
    for w in windows:
        w_start = float(w["t_start"])
        w_end = float(w["t_end"])
        frames = []
        for t_abs, img in decode_window(clip_path, w_start, w_end - w_start,
                                        int(video["width"]), int(video["height"]), args.fps):
            if total_frames >= args.max_frames:
                raise SystemExit(f"frame envelope {args.max_frames} reached - stopping (no slice written)")
            elapsed_min = (time.time() - started) / 60.0
            if elapsed_min > args.budget_gpu_minutes:
                raise SystemExit(
                    f"GPU-minute envelope {args.budget_gpu_minutes} exceeded at frame {total_frames} "
                    "- stopping (no slice written)"
                )
            t0 = time.time()
            objects = det.detect(img, vocabulary=vocab, roi_pass=False)
            ms = (time.time() - t0) * 1000.0
            total_ms += ms
            total_frames += 1
            frames.append({
                "t": round(t_abs, 3),
                "ms": round(ms, 1),
                "objects": [
                    {
                        "label": str(o.get("label") or ""),
                        "bbox": [round(float(v), 5) for v in o.get("bbox", [])[:4]],
                        "score": round(float(o.get("confidence", o.get("score", 0.0)) or 0.0), 4),
                    }
                    for o in objects
                ],
            })
        counts = [len(f["objects"]) for f in frames]
        out_windows.append({
            "id": w["id"],
            "kind": w.get("kind"),
            "t_start": w_start,
            "t_end": w_end,
            "frames": frames,
            "objectsPerFrame": {"max": max(counts) if counts else 0,
                                "mean": round(sum(counts) / len(counts), 2) if counts else 0.0},
        })
        print(f"  {w['id']:<4} {len(frames):>3} frames  objects/frame max={out_windows[-1]['objectsPerFrame']['max']}")

    wall_s = time.time() - started
    # ADAAAA-7801: recorded AFTER load() so the device label and the resolved
    # source are the ones actually serving the frames. If a weight file cannot be
    # read, keep the identity (source/device/env) and drop only the hashes rather
    # than losing the whole slice after the GPU minutes were spent.
    try:
        detector_model = det.weights_identity()
    except OSError as exc:
        print(f"WARNING: weight digest failed ({exc}); recording identity without hashes",
              file=sys.stderr)
        detector_model = det.weights_identity(digest=False)
    slice_doc = build_slice_doc(
        profile_key=profile.key,
        type_key=manifest.get("sport") or profile.key,
        vocabulary=vocab,
        fps=args.fps,
        clip_name=clip_name,
        clip_sha256=digest,
        clip_bytes=os.path.getsize(clip_path),
        label_manifest=args.labels,
        frames=total_frames,
        latency={
            "totalMs": round(total_ms, 1),
            "meanMsPerFrame": round(total_ms / total_frames, 1) if total_frames else None,
            "framesPerSecond": round(1000.0 * total_frames / total_ms, 3) if total_ms else None,
            "wallSeconds": round(wall_s, 1),
        },
        detector_label=det.device_label,
        detector_model=detector_model,
        envelope={"maxFrames": args.max_frames, "budgetGpuMinutes": args.budget_gpu_minutes},
        windows=out_windows,
    )
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(slice_doc, fh, indent=1)
    print(f"wrote {args.out}: {total_frames} frames, "
          f"mean {slice_doc['latency']['meanMsPerFrame']} ms/frame, "
          f"{slice_doc['latency']['wallSeconds']} s wall, "
          f"weights {detector_model['source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
