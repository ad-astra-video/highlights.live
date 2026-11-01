#!/usr/bin/env python3
"""Dense native crossing-instant strip read (ADAAAA-7693, follow-up to ADAAAA-7687).

Why this exists
---------------
`da2d21a` accepts four shot-window false positives (`178.1, 203.2, 358.8,
401.7`) and eight labelled goals through the *same* confirm-stage anchor: the
deep-dive's own `ballInNet` + `ballTrajectoryCrossedLine` self-read. Every
deterministic rule built from signals the confirm pass already produces tops out
at 81.82 % precision at recall 1.0 (`results/shot_vs_goal_discrimination.json`,
RESULTS.md § "AC-4"), and a single native 1280x720 frame at the instant is a coin
flip (RESULTS.md § "Native single-frame probe"). The one untested lever is a
*dense* native sequence bracketing the crossing instant: 30 frames at 1/30 s
spanning +/-0.5 s around the instant, tiled into ONE contact sheet per candidate.

The sheet is the unit of evidence, so it has to stay inside the measured
sheet-size limit (~0.9 MPix above which the local gemma channel times out). A
6x5 grid of 220x124 cells plus a one-line header lands at ~0.87 MPix.

Subcommands
-----------
`plan`       build the read plan: the 12 `frame_attestation` accepted cards of
             the `da2d21a` eval (8 goals + the 4 shot-window FPs) and the 12
             `evidence:none` manifest windows as controls.
`strip`      cut the fps=30 slice per candidate with host ffmpeg and contact-sheet
             it with PIL (runs on the box host; needs ffmpeg + PIL).
`read`       serial gemma read of each sheet (runs INSIDE the compose network,
             e.g. `docker exec highlights-perceive`; `gemma:8088` is not
             reachable from the host or the agent container).
`summarize`  fold `reads.jsonl` into the 4-FP / 8-goal / 12-control table, the
             repeat-read agreement and the AC bar verdict (offline).

A failed read is recorded as `unmeasured`, never as disagreement. A read that
says the ball crossed is `crossed`; a read that says it did not is `refuted`
only when the model also saw the ball (`BALL=yes`) — a blind "no" is recorded as
`unmeasured_ball` and cannot carry the bar.

Typical run (box host -> perceive container -> agent):

    python3 native_crossing_strip.py plan \
        --discrimination results/shot_vs_goal_discrimination.json \
        --manifest label-manifest.json --out /tmp/xstrip/plan.json
    python3 native_crossing_strip.py strip --video /data/uploads/<id>/kids-soccer.mp4 \
        --plan /tmp/xstrip/plan.json --out /tmp/xstrip/sheets
    docker cp /tmp/xstrip/sheets highlights-perceive:/tmp/xstrip/sheets
    docker exec highlights-perceive python3 /tmp/xstrip/native_crossing_strip.py read \
        --sheets /tmp/xstrip/sheets --manifest /tmp/xstrip/sheets/strip_manifest.json \
        --out /tmp/xstrip/reads.jsonl --repeat 2
    python3 native_crossing_strip.py summarize --reads /tmp/xstrip/reads.jsonl \
        --json results/native_crossing_strip.json
"""
import argparse
import base64
import glob
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.request

DEFAULT_URL = "http://gemma:8088/v1/chat/completions"
DEFAULT_MODEL = "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4"

# Measured channel limit (ADAAAA-7611): sheets above ~0.9 MPix time out.
MAX_SHEET_MPIX = 0.9
CELL_W, CELL_H = 220, 124
COLS, ROWS = 6, 5
MARGIN = 2
HEADER_H = 18

PROMPT = (
    "ONE contact sheet: 30 consecutive video frames of a football match, 1/30 s "
    "apart, numbered left-to-right then top-to-bottom. Tile 16 (red outline) is "
    "the anchor instant. Does the BALL cross the goal line between the posts and "
    "go in the net around the anchor instant? Answer only, one line, no "
    "explanation: CROSS=yes/no; BALL=yes/no; SCENE=crossing/shot_stopped/"
    "wide/open_play/celebration/replay; ANCHOR=<tile number or none>"
)

SCENES = ("crossing", "shot_stopped", "wide", "open_play", "celebration", "replay")


# --------------------------------------------------------------------------- plan
def plan_cmd(args):
    result = build_plan(json.load(open(args.discrimination)),
                        json.load(open(args.manifest)))
    json.dump(result, open(args.out, "w"), indent=1)
    print(json.dumps(result["counts"]))
    for p in result["plan"]:
        print(f"{p['kind']:8s} {p['id']:22s} t={p['instant']:8.2f}")


def build_plan(discrimination, manifest):
    """Read plan: 8 frame_attestation goals + 4 shot-window FPs + 12 controls.

    The card instant is the card's own `t` (the instant the deep dive attested);
    the four FPs are exactly the accepted cards with no `goal_label`. Controls
    are the manifest windows with `evidence == "none"`, anchored at the window
    midpoint because those windows carry no `instant` key.
    """
    cards = discrimination["cards"]
    attested = [c for c in cards if c.get("corroborationSource") == "frame_attestation"]
    goals = [c for c in attested if c.get("goal_label")]
    fps = [c for c in attested if not c.get("goal_label")]

    goal_windows = [(w["t_start"], w["t_end"]) for w in manifest["windows"]
                    if w.get("ground_truth") == "goal"]

    def overlaps_goal(a, b):
        return any(a < b2 and b > a2 for a2, b2 in goal_windows)

    plan = []
    for c in goals:
        plan.append({"id": f"fa_goal_{c['t']:07.1f}", "kind": "goal",
                     "instant": round(float(c["t"]), 2),
                     "card_t": float(c["t"]), "goal_label": c.get("goal_label"),
                     "source": "frame_attestation"})
    for c in fps:
        plan.append({"id": f"fa_shotfp_{c['t']:07.1f}", "kind": "shot_fp",
                     "instant": round(float(c["t"]), 2),
                     "card_t": float(c["t"]), "goal_label": None,
                     "source": "frame_attestation"})
    for w in manifest["windows"]:
        if w.get("evidence") != "none":
            continue
        mid = (float(w["t_start"]) + float(w["t_end"])) / 2.0
        plan.append({"id": w["id"], "kind": "control", "instant": round(mid, 2),
                     "window": [w["t_start"], w["t_end"]],
                     "overlaps_goal_window": overlaps_goal(w["t_start"], w["t_end"]),
                     "instant_in_goal_window": overlaps_goal(mid, mid + 0.001),
                     "source": "manifest_evidence_none"})
    counts = {"goal": len(goals), "shot_fp": len(fps),
              "control": sum(1 for p in plan if p["kind"] == "control")}
    return {"plan": plan, "counts": counts,
            "commit": discrimination.get("commit"),
            "job_id": discrimination.get("job_id")}


# -------------------------------------------------------------------------- strip
def session_frames(t0, span, fps):
    """Times of the frames ffmpeg emits for `-ss t0 -t span -vf fps=fps`.

    Frame k (0-based) is decoded at t0 + k/fps, so a span of 1.0 s at 30 fps
    yields 30 frames and the anchor instant is index `span*fps/2` (index 15,
    i.e. tile 16 on the sheet).
    """
    n = int(round(span * fps))
    return [round(t0 + k / float(fps), 4) for k in range(n)]


def sheet_geometry(cols=COLS, rows=ROWS, cell=(CELL_W, CELL_H)):
    w = cols * (cell[0] + MARGIN) + MARGIN
    h = rows * (cell[1] + MARGIN) + MARGIN + HEADER_H
    return w, h


def tile_box(index, cols=COLS, cell=(CELL_W, CELL_H)):
    """Pixel box (x0, y0, x1, y1) of tile `index` (0-based, row-major)."""
    row, col = divmod(index, cols)
    x0 = MARGIN + col * (cell[0] + MARGIN)
    y0 = MARGIN + HEADER_H + row * (cell[1] + MARGIN)
    return x0, y0, x0 + cell[0], y0 + cell[1]


def anchor_index_for(offsets):
    """Index of the tile nearest the anchor instant (offset 0)."""
    return min(range(len(offsets)), key=lambda i: abs(float(offsets[i])))


def compose_sheet(frame_paths, *, anchor_index, header, cols=COLS, rows=ROWS,
                  cell=(CELL_W, CELL_H), limit_mpix=MAX_SHEET_MPIX):
    """Tile the frames into one numbered contact sheet with the anchor outlined.

    Frames are drawn row-major; a 1-based tile number is burned into each cell so
    the model can name the anchor tile, and the anchor cell gets a red outline.
    Raises ValueError when the sheet would exceed the measured channel limit.
    """
    from PIL import Image, ImageDraw  # imported lazily: `plan`/`summarize` are offline

    w, h = sheet_geometry(cols, rows, cell)
    mpix = w * h / 1e6
    if mpix > limit_mpix:
        raise ValueError(f"sheet {w}x{h} = {mpix:.3f} MPix exceeds {limit_mpix} MPix")
    sheet = Image.new("RGB", (w, h), (0, 0, 0))
    draw = ImageDraw.Draw(sheet)
    draw.text((MARGIN + 2, 4), header, fill=(255, 255, 255))
    for i, path in enumerate(frame_paths[:cols * rows]):
        img = Image.open(path).convert("RGB")
        if img.size != tuple(cell):
            img = img.resize(tuple(cell))
        x0, y0, _, _ = tile_box(i, cols, cell)
        sheet.paste(img, (x0, y0))
        label = str(i + 1)
        draw.rectangle([x0, y0, x0 + 8 + 6 * len(label), y0 + 11], fill=(0, 0, 0))
        draw.text((x0 + 2, y0 + 1), label, fill=(255, 255, 0))
        if i == anchor_index:
            draw.rectangle([x0, y0, x0 + cell[0] - 1, y0 + cell[1] - 1],
                           outline=(255, 0, 0), width=2)
    return sheet, {"width": w, "height": h, "megapixels": round(mpix, 4),
                   "cols": cols, "rows": rows, "cell": list(cell),
                   "anchor_index": anchor_index, "anchor_tile": anchor_index + 1}


def cut_slice(video, t0, span, fps, outdir, *, cell=(CELL_W, CELL_H), ffmpeg="ffmpeg"):
    """Decode one fps=fps slice straight from the source and write JPEG frames."""
    os.makedirs(outdir, exist_ok=True)
    for old in glob.glob(os.path.join(outdir, "f_*.jpg")):
        os.remove(old)
    cmd = [
        ffmpeg, "-nostdin", "-v", "error",
        "-ss", f"{max(0.0, t0):.3f}", "-i", video, "-t", f"{span:.3f}",
        "-vf", f"fps={fps},scale={cell[0]}:{cell[1]}:flags=lanczos",
        "-q:v", "3", "-start_number", "1",
        os.path.join(outdir, "f_%03d.jpg"),
    ]
    import subprocess
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    return sorted(glob.glob(os.path.join(outdir, "f_*.jpg")))


def cut_frame(video, t, cell, outpath, *, ffmpeg="ffmpeg"):
    """Decode ONE native frame at instant `t`, scaled to `cell`."""
    import subprocess
    cmd = [ffmpeg, "-nostdin", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", video,
           "-frames:v", "1",
           "-vf", f"scale={cell[0]}:{cell[1]}:flags=lanczos", "-q:v", "3", outpath]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    return outpath


def strip(args):
    plan = json.load(open(args.plan))["plan"]
    os.makedirs(args.out, exist_ok=True)
    fps, span = args.fps, args.span
    cell = (args.cell_w, args.cell_h)
    offsets = [float(x) for x in args.offsets.split(",")] if args.offsets else None
    if offsets:
        anchor = anchor_index_for(offsets)
        per_candidate = len(offsets)
    else:
        anchor = int(round(span * fps / 2))
        per_candidate = int(round(span * fps))
    if per_candidate > args.cols * args.rows:
        raise SystemExit(f"{per_candidate} frames exceed the {args.cols}x{args.rows} grid")
    entries = []
    for p in plan:
        cid = p["id"]
        instant = float(p["instant"])
        fdir = os.path.join(args.out, "frames", cid)
        os.makedirs(fdir, exist_ok=True)
        if offsets:
            frames = []
            for i, off in enumerate(offsets):
                path = cut_frame(args.video, instant + off, cell,
                                 os.path.join(fdir, f"f_{i + 1:03d}.jpg"), ffmpeg=args.ffmpeg)
                frames.append(path)
            header = (f"{len(offsets)} native frames at offsets "
                      f"{', '.join(f'{o:+.3f}' for o in offsets)} s from the anchor; "
                      f"anchor = red tile {anchor + 1}")
            frames_expected = len(offsets)
        else:
            t0 = instant - span / 2.0
            frames = cut_slice(args.video, t0, span, fps, fdir, cell=cell,
                               ffmpeg=args.ffmpeg)
            header = (f"{per_candidate} frames, 1/{fps} s apart; anchor = red tile "
                      f"{anchor + 1}; t0={t0:.2f}s")
            frames_expected = per_candidate
        sheet, meta = compose_sheet(frames, anchor_index=anchor, header=header,
                                   cols=args.cols, rows=args.rows, cell=cell)
        path = os.path.join(args.out, f"{cid}.jpg")
        sheet.save(path, quality=88, optimize=True)
        blob = open(path, "rb").read()
        entries.append({"id": cid, "kind": p["kind"], "instant": p["instant"],
                        "t0": round(instant - span / 2.0, 3), "frames": len(frames),
                        "short_frames": len(frames) != frames_expected,
                        "offsets": offsets,
                        "sheet": os.path.basename(path), "bytes": len(blob),
                        "sha256": hashlib.sha256(blob).hexdigest(),
                        **{k: meta[k] for k in ("width", "height", "megapixels",
                                                "cell", "anchor_tile")}})
        print(f"{cid:22s} {p['kind']:8s} t={p['instant']:8.2f} frames={len(frames):2d} "
              f"{meta['width']}x{meta['height']} {meta['megapixels']:.3f}MPix "
              f"{len(blob) // 1024}KB")
    manifest = {"video": args.video, "fps": fps, "span": span,
                "offsets": offsets, "cols": args.cols, "rows": args.rows,
                "cell": list(cell), "sheets": entries, "count": len(entries)}
    json.dump(manifest, open(os.path.join(args.out, "strip_manifest.json"), "w"), indent=1)
    print(f"wrote {len(entries)} sheets -> {args.out}")


# --------------------------------------------------------------------------- read
def parse_reply(text):
    out = {}
    for key in ("CROSS", "BALL", "SCENE", "ANCHOR"):
        m = re.search(rf"{key}\s*[=:]\s*([A-Za-z0-9_]+)", text or "")
        out[key.lower()] = m.group(1).lower() if m else None
    return out


def verdict_of(parsed, err=None):
    """`crossed` / `refuted` / `unmeasured_ball` / `unmeasured`.

    A blind "no" cannot refute: the read has to have found the ball in the
    sequence, otherwise it is the crop/resolution failure mode already recorded
    in RESULTS.md and must not be counted as evidence against a card.
    """
    if err or not parsed:
        return "unmeasured"
    cross = parsed.get("cross")
    if cross == "yes":
        return "crossed"
    if cross == "no":
        if parsed.get("ball") == "yes":
            return "refuted"
        if parsed.get("ball") == "no":
            return "unmeasured_ball"   # model looked, ball not visible in the strip
        return "unmeasured"            # no BALL field at all -> no refutation claim
    return "unmeasured"


def gemma_read(path, url, model, prompt, timeout, retries=2):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    body = {"model": model, "temperature": 0, "max_tokens": 48,
            "chat_template_kwargs": {"enable_thinking": False},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {
                    "url": "data:image/jpeg;base64," + b64}}]}]}
    data = json.dumps(body).encode()
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                d = json.load(r)
            return (d["choices"][0]["message"].get("content") or "").strip(), None
        except Exception as exc:                     # serial retry with backoff
            last = f"{type(exc).__name__}: {exc}"[:120]
            if attempt < retries:
                time.sleep(2.0 * (attempt + 1))
    return "", last


def read(args):
    manifest = json.load(open(args.manifest))
    sheets = {s["id"]: s for s in manifest["sheets"]}
    prompt = args.prompt or PROMPT
    done = set()
    if args.resume and os.path.exists(args.out):
        for line in open(args.out):
            try:
                r = json.loads(line)
            except Exception:
                continue
            done.add((r["id"], r["read_index"]))
    rows = []
    for repeat in range(args.repeat):
        for cid, s in sheets.items():
            if (cid, repeat) in done:
                continue
            path = os.path.join(args.sheets, s["sheet"])
            started = time.time()
            raw, err = gemma_read(path, args.url, args.model, prompt, args.timeout)
            parsed = parse_reply(raw)
            row = {"id": cid, "kind": s["kind"], "instant": s["instant"],
                   "read_index": repeat, "raw": raw, "parsed": parsed,
                   "verdict": verdict_of(parsed, err), "err": err,
                   "elapsed_s": round(time.time() - started, 2)}
            rows.append(row)
            with open(args.out, "a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(f"r{repeat} {cid:22s} {row['verdict']:15s} "
                  f"{row['elapsed_s']:5.1f}s {raw[:70]!r}")
    print(f"appended {len(rows)} reads -> {args.out}")


# ---------------------------------------------------------------------- summarize
def summarize(args):
    rows = [json.loads(line) for line in open(args.reads) if line.strip()]
    by_id = {}
    for r in rows:
        by_id.setdefault(r["id"], {})[r["read_index"]] = r
    repeats = sorted({r["read_index"] for r in rows})
    n_repeats = max(repeats) + 1 if repeats else 0

    def first_pass(rid):
        """Primary verdict for a candidate = read 0, else the first read present."""
        return by_id[rid].get(0) or by_id[rid][min(by_id[rid])]

    table = []
    for rid, reads in by_id.items():
        ref = first_pass(rid)
        verdicts = [reads[k]["verdict"] if k in reads else "missing" for k in range(n_repeats)]
        consistent = len(set(v for v in verdicts if v != "missing")) == 1 and \
            all(v != "missing" for v in verdicts)
        table.append({"id": rid, "kind": ref["kind"], "instant": ref["instant"],
                      "verdicts": verdicts, "verdict": ref["verdict"],
                      "consistent": consistent,
                      "scenes": [reads[k]["parsed"].get("scene") if k in reads else None
                                 for k in range(n_repeats)],
                      "elapsed_s": [reads[k]["elapsed_s"] if k in reads else None
                                    for k in range(n_repeats)]})
    table.sort(key=lambda r: (r["kind"], float(r["instant"])))

    def ids(kind):
        return [r for r in table if r["kind"] == kind]

    goals, fps, controls = ids("goal"), ids("shot_fp"), ids("control")

    def count(rs, verdict):
        return [r["id"] for r in rs if r["verdict"] == verdict]

    def ball_yes(rs):
        """Cards whose primary read reported it could even see the ball."""
        return [r["id"] for r in rs
                if (first_pass(r["id"])["parsed"] or {}).get("ball") == "yes"]

    def reproduced(rs, verdict):
        return [r["id"] for r in rs if r["consistent"] and r["verdict"] == verdict]

    summary = {
        "model": args.model, "prompt": PROMPT, "repeats": n_repeats,
        "candidates": len(table),
        "goals": {"n": len(goals), "ball_yes": ball_yes(goals), "refuted": count(goals, "refuted"),
                  "crossed": count(goals, "crossed"),
                  "unmeasured": count(goals, "unmeasured"),
                  "unmeasured_ball": count(goals, "unmeasured_ball"),
                  "refuted_on_every_read": reproduced(goals, "refuted")},
        "shot_fps": {"n": len(fps), "ball_yes": ball_yes(fps), "refuted": count(fps, "refuted"),
                     "crossed": count(fps, "crossed"),
                     "unmeasured": count(fps, "unmeasured"),
                     "unmeasured_ball": count(fps, "unmeasured_ball"),
                     "refuted_on_every_read": reproduced(fps, "refuted")},
        "controls": {"n": len(controls), "ball_yes": ball_yes(controls), "crossed": count(controls, "crossed"),
                     "refuted": count(controls, "refuted"),
                     "unmeasured": count(controls, "unmeasured"),
                     "unmeasured_ball": count(controls, "unmeasured_ball")},
        "reproducible_candidates": sum(1 for r in table if r["consistent"]),
        "mean_read_s": round(sum(r["elapsed_s"] for r in rows if r["elapsed_s"]) /
                             max(1, sum(1 for r in rows if r["elapsed_s"])), 2),
        "table": table,
    }
    # AC bar: >= 4/4 shot-window FPs refuted AND 0/8 goals refuted, on a
    # reproducible repeat read.
    fp_ok = summary["shot_fps"]["n"] == 4 and \
        len(summary["shot_fps"]["refuted_on_every_read"]) == 4
    goal_ok = len(summary["goals"]["refuted_on_every_read"]) == 0 and \
        len(summary["goals"]["refuted"]) == 0
    goals_crossed = len(summary["goals"]["crossed"]) == summary["goals"]["n"] == 8
    summary["bar"] = {"fp_all_refuted_reproducible": fp_ok,
                      "no_goal_refuted": goal_ok,
                      "goals_all_crossed": goals_crossed,
                      "met": fp_ok and goal_ok,
                      "promotion_ready": fp_ok and goal_ok and goals_crossed}
    if args.json:
        json.dump(summary, open(args.json, "w"), indent=1)
    print(json.dumps({k: v for k, v in summary.items() if k != "table"}, indent=1))
    for r in table:
        print(f"{r['kind']:8s} {r['id']:22s} t={float(r['instant']):8.2f} "
              f"{'/'.join(r['verdicts'])} {'consistent' if r['consistent'] else 'SPLIT'}")
    return summary


# --------------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan", help="build the read plan from the eval artifacts")
    p.add_argument("--discrimination", default="results/shot_vs_goal_discrimination.json")
    p.add_argument("--manifest", default="label-manifest.json")
    p.add_argument("--out", required=True)
    p.set_defaults(func=plan_cmd)

    s = sub.add_parser("strip", help="cut fps slices and build one sheet per candidate")
    s.add_argument("--video", required=True)
    s.add_argument("--plan", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--fps", type=int, default=30)
    s.add_argument("--span", type=float, default=1.0)
    s.add_argument("--offsets", default=None,
                   help="comma-separated per-frame offsets in seconds from the "
                        "anchor instant; overrides --fps/--span (resolution variants)")
    s.add_argument("--cols", type=int, default=COLS)
    s.add_argument("--rows", type=int, default=ROWS)
    s.add_argument("--cell-w", type=int, default=CELL_W)
    s.add_argument("--cell-h", type=int, default=CELL_H)
    s.add_argument("--ffmpeg", default="ffmpeg")
    s.set_defaults(func=strip)

    r = sub.add_parser("read", help="serial gemma read of the sheets")
    r.add_argument("--sheets", required=True)
    r.add_argument("--manifest", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--repeat", type=int, default=1)
    r.add_argument("--model", default=DEFAULT_MODEL)
    r.add_argument("--url", default=DEFAULT_URL)
    r.add_argument("--prompt", default=None)
    r.add_argument("--timeout", type=float, default=180.0)
    r.add_argument("--resume", action="store_true")
    r.set_defaults(func=read)

    m = sub.add_parser("summarize", help="fold reads.jsonl into the read table")
    m.add_argument("--reads", required=True)
    m.add_argument("--json", default=None)
    m.add_argument("--model", default=DEFAULT_MODEL)
    m.set_defaults(func=summarize)

    args = ap.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
