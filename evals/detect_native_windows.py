#!/usr/bin/env python3
"""Produce a NATIVE-resolution detection slice over bounded windows of a remote source.

ADAAAA-7801. `evals/detect_slice_from_windows.py` decodes windows from a clip
that is already on disk. The american-football native slice cannot work that way:
the rights-cleared original is a 21.8 GB MPEG-TS, and the committed 854x480 file
is archive.org's h.264 derivative of it (0.44x downscale). Downloading 21.8 GB to
answer one cap question is not a bounded job.

Internet Archive serves byte ranges (`Range: bytes=a-b` -> 206), so a window can
be cut out of the original without fetching the original. This producer does that
in two stages so each stage runs where its dependencies exist:

    # stage 1 - network + ffmpeg (no torch, no GPU)
    python3 evals/detect_native_windows.py fetch \
        --source-url https://archive.org/download/<item>/<file>.ts \
        --source-bytes 21812283016 --source-duration 8391.18 \
        --window E01:1599:1620 --window E04:3741:3762 --window E06:5395:5416 \
        --width 1920 --height 1080 --fps 1 --pre-roll-s 25 \
        --fetch-dir out/af7801-fetch

    # stage 2 - the deployed detector (torch + the deploy image), CPU or GPU
    python3 evals/detect_native_windows.py detect \
        --fetch-dir out/af7801-fetch --profile "american football" \
        --fps 1 --max-frames 63 --budget-gpu-minutes 2 \
        --out out/af_detect_slice_native.json

Why two stages: the perceive deploy image carries the deployed weights and torch
but no ffmpeg, and the host carries ffmpeg but not the perceive Python env. The
frame handoff is raw RGB (`<window>/frames.rgb`) at an exact width x height, so
stage 2 reads the decoder's bytes with no re-encode and no image library.

Governance is the same as the 480p producer: `--max-frames` and
`--budget-gpu-minutes` are hard stops checked BEFORE the first frame of each
window and between frames; a breach exits non-zero with no slice written, so an
over-budget run cannot silently pass as a measurement.

Provenance: stage 1 records the exact byte ranges fetched and the sha256 of the
fetched bytes; stage 2 records the weights identity via the same
`detectorModel` block the 480p producer writes (ADAAAA-7801 AC4), plus the
`detector` device label. Nothing here touches the ADAAAA-7788 certified slice.
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
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

from detect_slice_from_windows import build_slice_doc  # noqa: E402

DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024


def parse_window(spec: str) -> dict:
    """`ID:start:end` (seconds, float) -> a window dict."""
    parts = spec.split(":")
    if len(parts) != 3:
        raise SystemExit(f"bad --window {spec!r}: expected ID:start:end")
    wid, start, end = parts
    t_start, t_end = float(start), float(end)
    if t_end <= t_start:
        raise SystemExit(f"bad --window {spec!r}: end must be after start")
    return {"id": wid, "t_start": t_start, "t_end": t_end}


def byte_offset_for(t_s: float, source_bytes: int, source_duration_s: float) -> int:
    """Proportional byte offset for an instant in a constant-bitrate container.

    The archive.org original is CBR-ish MPEG-TS (20.8 Mbit/s over 8391 s), so a
    proportional offset lands within about a second - measured on this item at
    t=1599 s: predicted 4,156,577,349, container start_time 1598.19 s. The caller
    still pre-rolls, because the offset is an estimate, not a keyframe index.
    """
    if source_duration_s <= 0 or source_bytes <= 0:
        raise SystemExit("source byte length and duration are required for offset math")
    frac = max(0.0, min(1.0, t_s / source_duration_s))
    return int(frac * source_bytes)


def plan_windows(windows: list[dict], fps: float) -> int:
    """Total frames the request implies, before anything is fetched."""
    return sum(max(0, int(round((w["t_end"] - w["t_start"]) * fps))) for w in windows)


def fetch_range(url: str, start: int, end: int, dest: str, chunk: int = DEFAULT_CHUNK_BYTES) -> dict:
    """Stream `bytes=start-end` into `dest`. Returns byte count + sha256.

    A server that ignores Range answers 200 with the WHOLE body - for this item
    that is 21.8 GB. The response header is checked for `206` and a matching
    `Content-Range` before any of it is written, so a Range-refusing mirror fails
    the fetch instead of quietly pulling the whole file.

    archive.org answers this item with a `302` to a data node (`dn710106.ca.
    archive.org`) and only the node honours `Range`, so redirects are followed
    and the guard reads the FINAL response: without `-L` the producer saw `302`,
    wrote 0 bytes and reported "refused a byte range", which blamed the source
    for a redirect it simply had not followed.
    """
    expected = end - start + 1
    hdr = dest + ".headers"
    cmd = ["curl", "-sS", "-f", "-L", "--max-redirs", "5", "--retry", "3", "--retry-delay", "2",
           "-H", f"Range: bytes={start}-{end}", "-D", hdr, url]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    h = hashlib.sha256()
    written = 0
    try:
        with open(dest, "wb") as fh:
            for blk in iter(lambda: proc.stdout.read(chunk), b""):
                if written == 0:
                    status, content_range = _range_headers(hdr)
                    if status != "206" or content_range is None:
                        proc.kill()
                        raise SystemExit(
                            f"source refused a byte range (status {status}, "
                            f"content-range {content_range!r}) - refusing to fetch the whole file")
                    got_start = str(content_range).split()[1].split("-")[0]
                    if got_start != str(start):
                        proc.kill()
                        raise SystemExit(
                            f"source answered a different range (asked {start}-{end}, "
                            f"got {content_range}) - the window would measure the wrong minute")
                fh.write(blk)
                h.update(blk)
                written += len(blk)
                if written > expected:
                    proc.kill()
                    raise SystemExit(f"range fetch exceeded the requested {expected} bytes")
    finally:
        proc.stdout.close()
        rc = proc.wait()
        if os.path.exists(hdr):
            os.remove(hdr)
    if rc != 0:
        raise SystemExit(f"range fetch failed (curl exit {rc}) for bytes {start}-{end}")
    if written != expected:
        raise SystemExit(f"range fetch short: got {written} of {expected} bytes")
    return {"bytes": written, "sha256": h.hexdigest()}


def _range_headers(path: str) -> tuple[str | None, str | None]:
    """Read the last response's status + Content-Range out of a curl -D dump."""
    status = None
    content_range = None
    try:
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("HTTP/"):
                    status = line.split()[1] if len(line.split()) > 1 else None
                elif line.lower().startswith("content-range:"):
                    content_range = line.split(":", 1)[1].strip()
    except FileNotFoundError:
        return None, None
    return status, content_range


def decode_window(chunk_path: str, offset_s: float, dur_s: float, width: int, height: int,
                  fps: float, dest: str, max_frames: int = 0) -> int:
    """Decode `dur_s` of `chunk_path` starting `offset_s` in, at width x height.

    One ffmpeg pass per window, rawvideo rgb24 into `dest`. Returns frame count.

    `max_frames` caps the output to the window's planned sample count. Without it
    the `fps` filter emits a frame at BOTH endpoints (a 21 s window at 1 fps gave
    22-23 frames, not 21), so a run could overrun the approved frame envelope
    purely from sampling and stop after paying for the fetch.
    """
    cmd = [
        "ffmpeg", "-v", "error", "-nostdin",
        "-ss", f"{offset_s:.3f}",
        "-t", f"{dur_s:.3f}",
        "-i", chunk_path,
        "-vf", f"fps={fps},scale={width}:{height}",
        "-pix_fmt", "rgb24",
        "-f", "rawvideo",
    ]
    if max_frames:
        cmd += ["-frames:v", str(max_frames)]
    cmd += [dest]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg decode failed: {proc.stderr.decode('utf-8', 'replace')[-800:]}")
    frame_bytes = width * height * 3
    size = os.path.getsize(dest)
    frames = size // frame_bytes
    if size % frame_bytes:
        raise SystemExit(f"decoded bytes {size} are not a whole number of {width}x{height} frames")
    return frames


def read_raw_frames(path: str, width: int, height: int):
    """Yield HxWx3 uint8 frames from a rawvideo file."""
    frame_bytes = width * height * 3
    with open(path, "rb") as fh:
        while True:
            raw = fh.read(frame_bytes)
            if len(raw) < frame_bytes:
                return
            yield np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3)


def cmd_fetch(args) -> int:
    windows = [parse_window(w) for w in args.window]
    planned = plan_windows(windows, args.fps)
    print(f"plan: {len(windows)} windows, {planned} frames @ {args.fps} fps")
    os.makedirs(args.fetch_dir, exist_ok=True)
    index = {"source": {"url": args.source_url, "bytes": args.source_bytes,
                        "duration_s": args.source_duration, "sha256": args.source_sha256},
             "fps": args.fps, "width": args.width, "height": args.height,
             "preRollS": args.pre_roll_s, "windows": []}
    for w in windows:
        t_fetch = max(0.0, w["t_start"] - args.pre_roll_s)
        start = byte_offset_for(t_fetch, args.source_bytes, args.source_duration)
        end = byte_offset_for(w["t_end"] + args.pre_roll_s, args.source_bytes, args.source_duration)
        chunk = os.path.join(args.fetch_dir, f"{w['id']}.ts")
        got = fetch_range(args.source_url, start, end, chunk)
        frames_path = os.path.join(args.fetch_dir, f"{w['id']}.rgb")
        want = int(round((w["t_end"] - w["t_start"]) * args.fps))
        n = decode_window(chunk, w["t_start"] - t_fetch, w["t_end"] - w["t_start"],
                          args.width, args.height, args.fps, frames_path,
                          max_frames=want)
        os.remove(chunk)
        index["windows"].append({
            **w,
            "fetchedByteStart": start,
            "fetchedByteEnd": end,
            "fetchedBytes": got["bytes"],
            "fetchedSha256": got["sha256"],
            "frames": n,
            "framesPath": os.path.relpath(frames_path, args.fetch_dir),
        })
        print(f"  {w['id']:<4} bytes {start}-{end} ({got['bytes'] / 1e6:.1f} MB) "
              f"-> {n} frames")
    with open(os.path.join(args.fetch_dir, "fetch-index.json"), "w") as fh:
        json.dump(index, fh, indent=1)
    total = sum(w["frames"] for w in index["windows"])
    print(f"fetched {total} frames -> {args.fetch_dir}")
    if planned and total < planned:
        print(f"WARNING: decoded {total} of {planned} planned frames "
              "(range start may not have landed before a keyframe)", file=sys.stderr)
    return 0


def cmd_detect(args) -> int:
    index = json.load(open(os.path.join(args.fetch_dir, "fetch-index.json")))
    windows = index["windows"]
    planned = sum(w["frames"] for w in windows)
    print(f"plan: {len(windows)} windows, {planned} frames @ {index['fps']} fps "
          f"(envelope {args.max_frames} frames / {args.budget_gpu_minutes} min)")
    if planned > args.max_frames:
        raise SystemExit(
            f"planned {planned} frames exceeds the approved envelope {args.max_frames} - "
            "stop and return a revised proposal")

    if args.vocabulary:
        # The deploy image ships the detector but NOT the repo's
        # `app.game_profile` module, so a run inside `highlights-perceive` cannot
        # import the profile. The closed vocabulary is what the slice actually
        # needs; it is passed explicitly (from the image's own game-hint map) and
        # `profileKey` records which roster it belongs to.
        vocab = [v.strip() for v in args.vocabulary.split(",") if v.strip()]
        profile_key = args.profile or args.type_key or ""
        if not vocab:
            raise SystemExit("--vocabulary was empty")
    else:
        if not args.profile:
            raise SystemExit("the detect stage needs either --profile or --vocabulary")
        from app.game_profile import load_game_profile

        profile = load_game_profile(args.profile)
        vocab = list(profile.vocabulary)
        profile_key = profile.key
    if not vocab:
        raise SystemExit(f"profile {profile_key!r} declares no detection vocabulary")

    from app.florence import FlorenceDetector

    det = FlorenceDetector(model_name=args.model) if args.model else FlorenceDetector()
    det.load()
    print(f"detector: {det.device_label} vocab={vocab}")

    out_windows = []
    total_frames = 0
    total_ms = 0.0
    started = time.time()
    for w in windows:
        frames = []
        for i, img in enumerate(read_raw_frames(os.path.join(args.fetch_dir, w["framesPath"]),
                                                index["width"], index["height"])):
            if total_frames >= args.max_frames:
                raise SystemExit(f"frame envelope {args.max_frames} reached - stopping (no slice written)")
            if (time.time() - started) / 60.0 > args.budget_gpu_minutes:
                raise SystemExit(
                    f"minute envelope {args.budget_gpu_minutes} exceeded at frame {total_frames} "
                    "- stopping (no slice written)")
            t0 = time.time()
            objects = det.detect(img, vocabulary=vocab, roi_pass=False)
            ms = (time.time() - t0) * 1000.0
            total_ms += ms
            total_frames += 1
            frames.append({
                "t": round(w["t_start"] + i / index["fps"], 3),
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
            "t_start": w["t_start"],
            "t_end": w["t_end"],
            "frames": frames,
            "objectsPerFrame": {
                "max": max(counts) if counts else 0,
                "mean": round(sum(counts) / len(counts), 2) if counts else 0.0,
            },
            "source": {k: w[k] for k in ("fetchedByteStart", "fetchedByteEnd",
                                         "fetchedBytes", "fetchedSha256") if k in w},
        })
        print(f"  {w['id']:<4} {len(frames):>3} frames  objects/frame max={out_windows[-1]['objectsPerFrame']['max']}")

    wall_s = time.time() - started
    try:
        detector_model = det.weights_identity()
    except OSError as exc:
        print(f"WARNING: weight digest failed ({exc}); recording identity without hashes",
              file=sys.stderr)
        detector_model = det.weights_identity(digest=False)

    src = index["source"]
    slice_doc = build_slice_doc(
        profile_key=profile_key,
        type_key=args.type_key or profile_key,
        vocabulary=vocab,
        fps=index["fps"],
        clip_name=os.path.basename(src["url"]),
        clip_sha256=src.get("sha256") or "unverified-remote-range-source",
        clip_bytes=src["bytes"],
        label_manifest=os.path.join(args.fetch_dir, "fetch-index.json"),
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
    # ADAAAA-7801: the slice says WHERE the frames came from, because "native
    # decode" is only checkable if the byte ranges are on the artifact.
    slice_doc["source"] = {
        "url": src["url"],
        "bytes": src["bytes"],
        "duration_s": src["duration_s"],
        "fetch": "archive.org HTTP Range (bytes=a-b); proportional offset + pre-roll",
        "width": index["width"],
        "height": index["height"],
        "preRollS": index["preRollS"],
        "sha256": src.get("sha256"),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(slice_doc, fh, indent=1)
    print(f"wrote {args.out}: {total_frames} frames, "
          f"mean {slice_doc['latency']['meanMsPerFrame']} ms/frame, "
          f"{slice_doc['latency']['wallSeconds']} s wall, "
          f"weights {detector_model.get('source')}")
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="fetch bounded byte ranges and decode raw frames")
    f.add_argument("--source-url", required=True)
    f.add_argument("--source-bytes", type=int, required=True)
    f.add_argument("--source-duration", type=float, required=True)
    f.add_argument("--source-sha256", default=None)
    f.add_argument("--window", action="append", required=True, help="ID:start:end (seconds)")
    f.add_argument("--width", type=int, required=True)
    f.add_argument("--height", type=int, required=True)
    f.add_argument("--fps", type=float, default=1.0)
    f.add_argument("--pre-roll-s", type=float, default=25.0,
                   help="bytes fetched before the window so ffmpeg lands on a keyframe")
    f.add_argument("--fetch-dir", required=True)
    f.set_defaults(func=cmd_fetch)

    d = sub.add_parser("detect", help="run the deployed detector over the fetched frames")
    d.add_argument("--fetch-dir", required=True)
    d.add_argument("--profile", default=None,
                   help="game profile whose roster defines the vocabulary (needs app.game_profile)")
    d.add_argument("--vocabulary", default=None,
                   help="comma-separated closed vocabulary; use inside the deploy image, "
                        "which ships the detector but not app.game_profile")
    d.add_argument("--type-key", default=None)
    d.add_argument("--model", default=None, help="override FLORENCE_MODEL")
    d.add_argument("--max-frames", type=int, required=True, help="approved frame envelope")
    d.add_argument("--budget-gpu-minutes", type=float, required=True, help="approved wall-clock envelope")
    d.add_argument("--out", required=True)
    d.set_defaults(func=cmd_detect)
    return ap


def main() -> int:
    args = build_arg_parser().parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
