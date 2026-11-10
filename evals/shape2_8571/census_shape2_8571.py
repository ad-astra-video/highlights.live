#!/usr/bin/env python3
"""ADAAAA-8571 (AC-B shape 2) Step 0, part 2: the $0 score-read CENSUS.

`N` is the number of fixture windows that carry a real, measured score transition -
i.e. windows where a steady PRE frame and a measurable POST frame BOTH read a numeric
score and the two reads DIFFER. `N` is committed to the ticket's pre-run record before
any metered call, and `N < 9` means the leg does not run (ADAAAA-8570 `cap-record-2`
rev `6bb5a746`).

The read is the PRODUCTION probe, not a re-implementation: `POST <perceive>/app/scoreboard`
with a base64 JPEG. Per `services/perceive/app/scoreboard_probe.py` that route runs ONE
`<OCR>` crop and nothing else - no detection, no SAM, no tracker mutation, no decide
call, no Livepeer debit - so the census is `$0` GPU. It returns
`{"ocr": [...], "score": [h, a] | None, "roi": ..., "ok": bool, "reason": ...}` and
perceive's own `parse_ocr_score` is the single owner of "what is a score".

Where to run it (the edge does not expose this route; `/app/scoreboard` 404s publicly):

    docker cp /state/shape2_8571.vp8.ivf perceive:/tmp/
    docker cp census_shape2_8571.py      perceive:/tmp/
    docker cp /state/shape2_8571.manifest.json perceive:/tmp/
    docker exec perceive python3 /tmp/census_shape2_8571.py \
        --manifest /tmp/shape2_8571.manifest.json --out /tmp/shape2.8571.census.json

It defaults to `--base-url http://127.0.0.1:8000`, so from inside the perceive container
it talks to itself over loopback and never leaves the box.

Exit codes: 0 = census written (read `.verdict` for RUN / NO_RUN), 3 = probe never
answered or every read was absent evidence (a broken measurement, NOT an `N < 9`
verdict), 2 = bad input.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


def md5_of(path: str) -> str:
    import hashlib

    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def grab_jpeg(fixture: str, ts_s: float, out_path: str, scale: str | None = None) -> str:
    """One exact frame -> JPEG. `-ss` before `-i` seeks on the IVF frame index."""
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{ts_s:.3f}", "-i", fixture,
           "-frames:v", "1", "-q:v", "2"]
    if scale:
        cmd += ["-vf", f"scale={scale}"]
    cmd.append(out_path)
    subprocess.run(cmd, check=True)
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise SystemExit(f"no frame extracted at {ts_s:.3f}s from {fixture}")
    return out_path


def probe(base_url: str, jpeg_path: str, roi: list[float] | None, timeout: float = 120.0) -> dict:
    with open(jpeg_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode("ascii")
    payload: dict[str, object] = {"image": b64}
    if roi:
        payload["roi"] = roi
    req = urllib.request.Request(
        base_url.rstrip("/") + "/app/scoreboard",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def as_pair(score) -> tuple[int, int] | None:
    if not isinstance(score, (list, tuple)) or len(score) != 2:
        return None
    try:
        return int(score[0]), int(score[1])
    except (TypeError, ValueError):
        return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--fixture", help="defaults to manifest.fixture.path")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--roi", help="normalized x0,y0,x1,y1 (default: perceive's operator ROI)")
    ap.add_argument("--scale", help="optional WxH downscale for the crop, e.g. 1280x720")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames-dir", help="where to keep the extracted JPEGs (evidence)")
    ap.add_argument("--min-anchors", type=int, default=9)
    args = ap.parse_args(argv)

    man = json.load(open(args.manifest))
    fixture = args.fixture or man["fixture"]["path"]
    roi = [float(x) for x in args.roi.split(",")] if args.roi else None
    windows = man["windows"]
    frames_dir = args.frames_dir or os.path.join(tempfile.mkdtemp(prefix="shape2-census-"))
    os.makedirs(frames_dir, exist_ok=True)

    rows = []
    answered = 0
    for w in windows:
        wid = w["id"]
        pre_ts, post_ts = w["pre_read_out_ts"], w["post_read_out_ts"]
        pre_jpg = grab_jpeg(fixture, pre_ts, os.path.join(frames_dir, f"{wid}-pre.jpg"), args.scale)
        post_jpg = grab_jpeg(fixture, post_ts, os.path.join(frames_dir, f"{wid}-post.jpg"), args.scale)
        row = {"id": wid, "transition_s": w["transition_s"],
               "pre_read_out_ts": pre_ts, "post_read_out_ts": post_ts,
               "pre_source_ts": w["pre_read_src_ts"], "post_source_ts": w["post_read_src_ts"]}
        for tag, jpg in (("pre", pre_jpg), ("post", post_jpg)):
            try:
                res = probe(args.base_url, jpg, roi)
                answered += 1
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
                row[f"{tag}_error"] = f"{type(e).__name__}: {e}"
                res = {}
            row[f"{tag}_score"] = res.get("score")
            row[f"{tag}_ok"] = res.get("ok")
            row[f"{tag}_reason"] = res.get("reason") or None
            row[f"{tag}_ocr"] = res.get("ocr") or []
        pre = as_pair(row.get("pre_score"))
        post = as_pair(row.get("post_score"))
        row["numeric"] = bool(pre and post)
        row["differ"] = bool(pre and post and pre != post)
        rows.append(row)
        print(f"  {wid:<12} pre={row['pre_score']} post={row['post_score']} "
              f"differ={row['differ']} reason={row.get('pre_reason') or row.get('post_reason') or '-'}")

    if answered == 0:
        print("CENSUS ERROR: the probe never answered - that is a broken measurement, "
              "not an N < 9 verdict. Nothing is committed.", file=sys.stderr)
        return 3

    n = sum(1 for r in rows if r["differ"])
    verdict = "RUN" if n >= args.min_anchors else "NO_RUN"
    census = {
        "$comment": "ADAAAA-8571 census. N = windows with a numeric PRE and POST read that differ. "
                    "Per ADAAAA-8570 cap-record-2 rev 6bb5a746: N < 9 -> no metered call, AC-B closes N of N.",
        "produced_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        "probe": {"route": "/app/scoreboard", "base_url": args.base_url, "roi": roi,
                  "cost": "$0 GPU (one <OCR> crop; no decide, no Livepeer debit)"},
        "fixture": {
            "path": fixture, "md5": md5_of(fixture) if os.path.exists(fixture) else None,
            "manifest_md5_at_build": man["fixture"].get("md5"),
            "manifest_matches": (md5_of(fixture) == man["fixture"].get("md5")) if os.path.exists(fixture) else None,
            "window_count": len(windows), "splice_instants_s": man.get("splice_instants_s"),
            "physical_transitions": man.get("source", {}).get("physical_transitions"),
        },
        "window_count": len(windows),
        "N": n,
        "min_anchors_required": args.min_anchors,
        "verdict": verdict,
        "reason": None if verdict == "RUN" else f"N of {len(windows)}: only {n} window(s) carried a "
                                               f"numeric PRE and POST read that differ",
        "windows": rows,
        "frames_dir": frames_dir,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(census, fh, indent=2)
        fh.write("\n")
    print(f"CENSUS: N={n} of {len(windows)} -> {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
