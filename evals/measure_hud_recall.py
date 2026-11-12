#!/usr/bin/env python3
"""Operating-point measurement for the esports (SuperTuxKart) HUD event trigger
(ADAAAA-8744 WP3, plan ADAAAA-7812 §2/§5).

What this measures
------------------
A bounded CPU grid over the `hud-event` reader's two operating-point knobs —
band change sensitivity × minimum dwell — on the 1351 s labelled window of
`evals/supertuxkart_val/label-manifest.json`. Every cell is a real run of
`services/perceive/app/hud_reader.py` over real decoded frames of the labelled
clip, scored by WP2's oracle (`evals/hud_oracle.py`) against the frozen human
labels. Nothing here is a fixture number: the frames come from the clip whose
sha256 the manifest pins, and the reader is the shipped Stage-A module, armed
explicitly (`enabled=True`) for the measurement only.

The grid is the plan §5 acceptance table, cell by cell, no aggregation that can
hide a failing cell:

- A1 recall on the 15 verified objective events, default -3/+2 s window  >= 0.80 (12/15)
- A2 in-window candidate FP rate on the labelled window                 <= 0.10
- A3 non-event windows silent                                           >= 11 of 13
- A4 trigger volume in-window                                           <= 1.5 candidates/min (<= 34)

A6 is enforced structurally: the manifest sha256 is checked before and after
every cell and the clip sha256 before and after the whole pass; a mismatch
voids the run and no number is printed (exit 3).

Usage::

    python3 evals/measure_hud_recall.py \
        --clip /path/to/sh_onfoss_20230923_tournament.mp4 \
        --out-dir evals/supertuxkart_val/run \
        [--sensitivities 0.03,0.05,0.08,0.12] [--dwells 2,3,4] \
        [--match-pre -3] [--match-post 2] [--diagnose]

Artifacts (all under ``--out-dir``):

- ``cell_s<S>_d<D>.json`` — the candidate export for that cell, in the exact
  schema `evals/hud_oracle.py` accepts, so QA can re-score any cell on its own
  box with ``python3 evals/hud_oracle.py --candidates <file>``.
- ``hud_grid.json`` — every cell's full oracle result plus the harness limits.
- ``hud_grid.md`` — the human-readable table pasted into the issue.

Exit codes: ``0`` grid completed and at least one cell clears A1-A4 (continue),
``1`` grid completed and no cell clears A1-A4 (the pre-authorised park),
``3`` manifest/clip hash voided the run.

Needs numpy + ffmpeg (frame decode only). No GPU, no network, no model call.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import types

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

DEFAULT_MANIFEST = os.path.join(HERE, "supertuxkart_val", "label-manifest.json")
DEFAULT_OUT_DIR = os.path.join(HERE, "supertuxkart_val", "run")

#: the reader's module is loaded under a synthetic package so its relative
#: ``from .game_profile import ...`` resolves without importing ``app/__init__``
#: (which pulls fastapi/PIL). This is the same standalone-loading trick
#: ``evals/measure_audio_recall.py`` uses for ``audio_gate`` / ``game_profile``.
READER_PKG = "_hud_measure"

#: HUD band rects in NATIVE 426x240 pixels, copied verbatim from the manifest's
#: ``video.frame_source`` (the bands the labels were read from: race clock, centre
#: event banner, grand-prix panel). They are measurement geometry for THIS clip,
#: not a shipped default — the `supertuxkart` profile still declares no hudModel.
STK_BANDS = (
    ("race-clock", (364, 30, 426, 56), "clock"),
    ("centre-banner", (120, 60, 320, 110), "banner"),
    ("grand-prix-panel", (60, 50, 170, 180), "counter"),
)

#: plan §5 bars. A1/A2/A3/A4 are graded per cell; nothing is averaged.
BAR_RECALL = 0.80
BAR_FP_RATE = 0.10
BAR_SILENT_WINDOWS = 11  # of 13
BAR_CANDIDATES_PER_MIN = 1.5  # <= 34 over the 1351 s window

#: the grid is centred on the per-band change-score calibration this harness prints
#: under ``--diagnose`` for this clip: at-rest frame-to-frame p50 is 0.067-0.105 and
#: p95 0.174-0.238, while frames within +/-1 s of a label run 0.14-0.34 (peak 0.34).
#: So the spread spans "below the resting noise floor" (0.08) to "above its p95"
#: (0.25), which is the only range where a separating cell could exist.
DEFAULT_SENSITIVITIES = (0.08, 0.12, 0.18, 0.25)
DEFAULT_DWELLS = (2, 3, 4)


class Voided(RuntimeError):
    """The manifest or the clip is not the pinned artifact; no number may print."""


# --- module loading ------------------------------------------------------------------------

def load_reader_module():
    """Load `services/perceive/app/hud_reader.py` as a standalone package module."""
    app_dir = os.path.join(REPO, "services", "perceive", "app")
    path = os.path.join(app_dir, "hud_reader.py")
    pkg = types.ModuleType(READER_PKG)
    pkg.__path__ = [app_dir]  # type: ignore[attr-defined]
    sys.modules[READER_PKG] = pkg
    spec = importlib.util.spec_from_file_location(f"{READER_PKG}.hud_reader", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def load_oracle_module():
    """Load `evals/hud_oracle.py` (pure stdlib) by path."""
    path = os.path.join(HERE, "hud_oracle.py")
    spec = importlib.util.spec_from_file_location("hud_oracle", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["hud_oracle"] = mod
    spec.loader.exec_module(mod)
    return mod


# --- artifacts -----------------------------------------------------------------------------

def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_manifest(manifest_path: str, oracle) -> str:
    sha = sha256_file(manifest_path)
    if sha != oracle.MANIFEST_SHA256:
        raise Voided(
            f"manifest sha256 {sha} != pinned {oracle.MANIFEST_SHA256} — run voided, no numbers"
        )
    return sha


def check_clip(clip_path: str, manifest: dict) -> str:
    expected = (manifest.get("video") or {}).get("sha256")
    sha = sha256_file(clip_path)
    if expected and sha != expected:
        raise Voided(
            f"clip sha256 {sha} != manifest video.sha256 {expected} — run voided, no numbers"
        )
    return sha


# --- frame decode --------------------------------------------------------------------------

def decode_frames(clip_path: str, start_s: float, end_s: float, width: int, height: int):
    """Decode [start_s, end_s) at 1 fps to a (n, h, w) uint8 grayscale stack.

    Timestamps are ``start_s + i`` — the manifest's own 1 fps label grid, so a
    candidate's ``t`` compares to a label instant without any resampling gamble.
    """
    span = max(1, int(round(end_s - start_s)))
    cmd = [
        "ffmpeg", "-v", "error", "-nostdin",
        "-ss", f"{start_s:.3f}", "-t", f"{span}",
        "-i", clip_path,
        "-vf", "fps=1", "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode('utf-8', 'replace')[:400]}")
    frame_bytes = width * height
    n = len(proc.stdout) // frame_bytes
    if n == 0:
        raise RuntimeError("ffmpeg produced no frames for the labelled window")
    grid = np.frombuffer(proc.stdout[: n * frame_bytes], dtype=np.uint8)
    return grid.reshape(n, height, width), span


# --- one grid cell -------------------------------------------------------------------------

def run_cell(reader_mod, oracle, frames, start_s: int, sensitivity: float, dwell: int,
             out_dir: str, manifest: dict, manifest_path: str, span_s: float,
             match_pre=None, match_post=None, fps: int = 1) -> dict:
    """Run the reader over the labelled window at one (sensitivity, dwell) cell."""
    # Build the model from the profile contract's own dataclasses so the reader sees
    # exactly the objects it is shipped with (no local reimplementation of HudBand).
    game_profile = sys.modules[f"{READER_PKG}.game_profile"]
    band_objs = tuple(
        game_profile.HudBand(name=name, rect=rect, kind=kind) for name, rect, kind in STK_BANDS
    )
    model = game_profile.HudModel(
        bands=band_objs,
        change_sensitivity=sensitivity,
        min_dwell_frames=dwell,
        quiet_frames=2,
        cell=8,
    )
    reader = reader_mod.HudEventReader(model, enabled=True)

    candidates: list[dict] = []
    frame_times: list[float] = []
    state_after: dict = {}
    wall_ms: list[float] = []
    import time as _time
    for i in range(frames.shape[0]):
        ts = float(start_s + i * (1.0 / fps))
        t0 = _time.perf_counter()
        fires = reader.observe(frames[i], ts, seq=i)
        wall_ms.append((_time.perf_counter() - t0) * 1000.0)
        frame_times.append(ts)
        for fire in fires:
            candidates.append({
                "t": round(float(fire.timestamp), 3),
                "band": fire.band,
                "kind": fire.kind,
                "score": round(float(fire.score), 5),
                "coincidentBands": list(fire.coincident_bands),
            })
    for band in band_objs:
        st = reader.state_for(band.name)
        state_after[band.name] = {
            "latched": bool(st.latched),
            "lastScore": round(float(st.last_score), 5),
            "baselineNull": st.baseline is None,
        }

    tag = f"s{sensitivity:g}_d{dwell}"
    export = {
        "video": {
            "id": (manifest.get("video") or {}).get("id"),
            "path": (manifest.get("video") or {}).get("path"),
            "duration_s": (manifest.get("video") or {}).get("duration_s"),
        },
        "producer": "hud-event/hud_reader (measure_hud_recall grid cell)",
        "fps": fps,
        "cell": {
            "changeSensitivity": sensitivity,
            "minDwellFrames": dwell,
            "quietFrames": 2,
            "cell": 8,
            "bands": [{"name": n, "rect": list(r), "kind": k} for n, r, k in STK_BANDS],
        },
        "frames_observed": reader.frames_observed,
        "flickers_suppressed": reader.flickers_suppressed,
        "band_state_at_end": state_after,
        "candidates": candidates,
    }
    export_path = os.path.join(out_dir, f"cell_{tag}.json")
    with open(export_path, "w", encoding="utf-8") as fh:
        json.dump(export, fh, indent=1, sort_keys=True)
        fh.write("\n")

    result = oracle.run(
        manifest_path=manifest_path,
        candidates_path=export_path,
        match_pre=match_pre,
        match_post=match_post,
        labelled_window_s=span_s,
    )
    if result["sha_before"] != result["sha_after"]:
        raise Voided("manifest changed during the cell — run voided")

    overall = result["overall"]
    p95 = float(np.percentile(wall_ms, 95)) if wall_ms else 0.0
    # A4 is judged on the volume the trigger emits inside the DECODED window (the plan's
    # 1351 s window), which is the same denominator the audio measurement used. The
    # oracle's own `candidates_per_minute` divides by its narrower label coverage, so the
    # two are reported separately and neither hides a candidate.
    in_decoded = overall["candidates_in_window"] + overall["outside_labelled_window"]
    volume_per_min = in_decoded / (span_s / 60.0) if span_s > 0 else 0.0
    row = {
        "cell": tag,
        "changeSensitivity": sensitivity,
        "minDwellFrames": dwell,
        "frames": int(frames.shape[0]),
        "candidates": overall["candidates"],
        "candidatesInWindow": overall["candidates_in_window"],
        "outsideWindow": overall["outside_labelled_window"],
        "recalled": overall["recalled"],
        "events": overall["events"],
        "recall": round(float(overall["recall"]), 4),
        "fp": overall["fp"],
        "fpRate": round(float(overall["fp_rate"]), 4),
        "silentWindows": int(result["negatives"]["silent_windows"]),
        "nonEventWindows": int(result["negatives"]["windows"]),
        "candidatesPerMinute": round(volume_per_min, 3),
        "candidatesPerMinuteLabelCoverage": round(float(overall["candidates_per_minute"]), 3),
        "candidatesInDecodedWindow": int(in_decoded),
        "frameCostP95Ms": round(p95, 3),
        "flickersSuppressed": int(reader.flickers_suppressed),
        "exportPath": export_path,
        "a1": bool(overall["recall"] >= BAR_RECALL),
        "a2": bool(overall["fp_rate"] <= BAR_FP_RATE),
        "a3": bool(result["negatives"]["silent_windows"] >= BAR_SILENT_WINDOWS),
        "a4": bool(volume_per_min <= BAR_CANDIDATES_PER_MIN),
        "result": result,
    }
    row["clears"] = row["a1"] and row["a2"] and row["a3"] and row["a4"]
    return row


# --- rendering -----------------------------------------------------------------------------

GRID_HEADER = (
    "| cell | sensitivity | dwell | candidates (in-window) | recall | A1 | FP rate | A2 | "
    "silent windows | A3 | candidates/min | A4 | clears |"
)
GRID_SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"


def render_grid(rows: list[dict]) -> str:
    lines = [GRID_HEADER, GRID_SEP]
    for r in rows:
        lines.append(
            f"| `{r['cell']}` | {r['changeSensitivity']:g} | {r['minDwellFrames']} | "
            f"{r['candidatesInWindow']} | {r['recall']:.2f} ({r['recalled']}/{r['events']}) | "
            f"{'pass' if r['a1'] else 'FAIL'} | {r['fpRate']:.4f} | "
            f"{'pass' if r['a2'] else 'FAIL'} | {r['silentWindows']}/{r['nonEventWindows']} | "
            f"{'pass' if r['a3'] else 'FAIL'} | {r['candidatesPerMinute']:.2f} | "
            f"{'pass' if r['a4'] else 'FAIL'} | {'**yes**' if r['clears'] else 'no'} |"
        )
    return "\n".join(lines)


def latch_trace(reader_mod, frames, start_s: int, sensitivity: float, dwell: int,
                oracle, manifest: dict, lookback: int = 3) -> dict:
    """Why a cell misses: per-band latched frames and the armed/latched state at each label.

    The reader emits at most one candidate per band per latch cycle, and a latch is
    released only after ``quiet_frames`` consecutive frames *below* sensitivity
    against the latch-time baseline. This trace reports, for one cell, how many of
    the window's frames each band spent latched and, at every labelled instant,
    what the band's step score was and whether the band was armed. That is the
    difference between "no step exists here" and "a step exists but the band could
    not fire" — two very different findings.
    """
    game_profile = sys.modules[f"{READER_PKG}.game_profile"]
    band_objs = tuple(
        game_profile.HudBand(name=n, rect=r, kind=k) for n, r, k in STK_BANDS
    )
    model = game_profile.HudModel(
        bands=band_objs, change_sensitivity=sensitivity, min_dwell_frames=dwell,
        quiet_frames=2, cell=8,
    )
    reader = reader_mod.HudEventReader(model, enabled=True)
    latched = {b.name: np.zeros(frames.shape[0], dtype=bool) for b in band_objs}
    fires: list[dict] = []
    for i in range(frames.shape[0]):
        ts = float(start_s + i)
        for fire in reader.observe(frames[i], ts, seq=i):
            fires.append({"t": round(float(fire.timestamp), 3), "band": fire.band,
                          "score": round(float(fire.score), 4)})
        for b in band_objs:
            latched[b.name][i] = reader.state_for(b.name).latched

    per_band = [
        {"band": b.name,
         "latchedFrames": int(latched[b.name].sum()),
         "frames": int(frames.shape[0]),
         "firstLatchT": (start_s + int(np.argmax(latched[b.name])))
         if latched[b.name].any() else None}
        for b in band_objs
    ]
    events = oracle.labelled_events(manifest)
    rows = []
    for e in events:
        i = int(round(e["instant"])) - int(start_s)
        i = max(0, min(frames.shape[0] - 1, i))
        j = max(0, i - lookback)
        scores, states = {}, {}
        for b in band_objs:
            prev = reader_mod.band_signature(frames[j], b, 8)
            sc = reader_mod.band_change_score(frames[i], b, prev, 8)
            scores[b.name] = None if sc is None else round(float(sc), 4)
            states[b.name] = "latched" if latched[b.name][i] else "armed"
        rows.append({"event": e["id"], "event_type": e["event_type"],
                     "t": round(float(e["instant"]), 2), "scores": scores, "states": states})
    return {"sensitivity": sensitivity, "dwell": dwell, "fires": fires,
            "perBand": per_band, "events": rows}


def render_latch_trace(trace: dict) -> str:
    lines = [f"cell s{trace['sensitivity']:g}/d{trace['dwell']} — "
             f"{len(trace['fires'])} candidates in the window", ""]
    lines.append("| band | latched frames | window frames | first latch t |")
    lines.append("| --- | --- | --- | --- |")
    for b in trace["perBand"]:
        lines.append(f"| `{b['band']}` | {b['latchedFrames']} | {b['frames']} | "
                     f"{b['firstLatchT']} |")
    bands = list(trace["events"][0]["scores"]) if trace["events"] else []
    lines.append("")
    lines.append("| event | class | t | " + " | ".join(f"`{b}` step" for b in bands)
                 + " | " + " | ".join(f"`{b}` state" for b in bands) + " |")
    lines.append("| --- | --- | --- | " + " | ".join("---" for _ in bands) + " | "
                 + " | ".join("---" for _ in bands) + " |")
    for row in trace["events"]:
        cells = ["" if row["scores"][b] is None else f"{row['scores'][b]:.3f}" for b in bands]
        lines.append(f"| `{row['event']}` | {row['event_type']} | {row['t']} | "
                     + " | ".join(cells) + " | "
                     + " | ".join(row["states"][b] for b in bands) + " |")
    return "\n".join(lines)


def render_diagnose(rows: list[dict]) -> str:
    """Per-band raw change-score read at every labelled instant (grid calibration evidence)."""
    lines = ["| band | window | max score | p50 | p95 | frames |", "| --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        lines.append(
            f"| `{r['band']}` | {r['scope']} | {r['max']:.4f} | {r['p50']:.4f} | "
            f"{r['p95']:.4f} | {r['frames']} |"
        )
    return "\n".join(lines)


def pick_best(rows: list[dict]) -> dict | None:
    """The chosen cell: a clearing cell with the best recall, then the lowest volume.

    A cell that clears A1-A4 is the only kind that can be chosen; if none clears,
    the caller parks with the measured numbers (plan §7.4) and chooses nothing.
    """
    clearing = [r for r in rows if r["clears"]]
    if not clearing:
        return None
    clearing.sort(key=lambda r: (-r["recall"], r["candidatesPerMinute"], -r["changeSensitivity"]))
    return clearing[0]


# --- main ----------------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="HUD operating-point measurement grid (ADAAAA-8744 WP3)")
    ap.add_argument("--clip", required=True, help="path to the labelled clip")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    ap.add_argument("--sensitivities", default=",".join(f"{v:g}" for v in DEFAULT_SENSITIVITIES))
    ap.add_argument("--dwells", default=",".join(str(v) for v in DEFAULT_DWELLS))
    ap.add_argument("--window-start", type=float, default=None,
                    help="decode/scoring window start (default: the manifest's own labelled "
                         "window). The plan's measured window for this clip is 4380-5731 s; "
                         "the labels' own coverage is narrower and is reported separately.")
    ap.add_argument("--window-end", type=float, default=None)
    ap.add_argument("--match-pre", type=float, default=None)
    ap.add_argument("--match-post", type=float, default=None)
    ap.add_argument("--diagnose", action="store_true",
                    help="print the per-band change-score calibration table as well")
    ap.add_argument("--latch-trace", metavar="S:D", default=None,
                    help="trace latches for one cell (default: the best-recall cell when "
                         "nothing clears, else the chosen cell)")
    ap.add_argument("--json", default=None, help="write hud_grid.json here (default: out-dir)")
    args = ap.parse_args(argv)

    sens = [float(x) for x in str(args.sensitivities).split(",") if x.strip()]
    dwells = [int(x) for x in str(args.dwells).split(",") if x.strip()]
    os.makedirs(args.out_dir, exist_ok=True)

    oracle = load_oracle_module()
    reader_mod = load_reader_module()

    # A6: pin the label artifact and the clip BEFORE any frame is decoded.
    sha_before = check_manifest(args.manifest, oracle)
    clip_sha_before = check_clip(args.clip, oracle.load_manifest(args.manifest))
    manifest = oracle.load_manifest(args.manifest)
    label_start, label_end = oracle.labelled_window(manifest)
    win_start = label_start if args.window_start is None else float(args.window_start)
    win_end = label_end if args.window_end is None else float(args.window_end)
    if win_end <= win_start:
        raise SystemExit("window-end must be after window-start")
    video = manifest.get("video") or {}
    width, height = int(video.get("width") or 426), int(video.get("height") or 240)

    frames, span = decode_frames(args.clip, win_start, win_end, width, height)
    print(f"decoded {frames.shape[0]} frames at 1 fps over {span} s "
          f"({win_start:g}-{win_end:g} s) from {video.get('path')} "
          f"(label coverage {label_start:g}-{label_end:g} s)")

    rows: list[dict] = []
    for s in sens:
        for d in dwells:
            row = run_cell(reader_mod, oracle, frames, int(win_start), s, d, args.out_dir,
                           manifest, args.manifest, float(span), args.match_pre,
                           args.match_post)
            rows.append(row)
            print(f"cell s{s:g}/d{d}: candidates={row['candidatesInWindow']} "
                  f"recall={row['recall']:.2f} fpRate={row['fpRate']:.4f} "
                  f"silent={row['silentWindows']}/{row['nonEventWindows']} "
                  f"cpm={row['candidatesPerMinute']:.2f} clears={row['clears']}")

    # A6 again: manifest and clip must be byte-identical at the end.
    sha_after = check_manifest(args.manifest, oracle)
    clip_sha_after = check_clip(args.clip, manifest)
    if (sha_before, clip_sha_before) != (sha_after, clip_sha_after):
        raise Voided("manifest or clip changed during the pass — run voided")

    best = pick_best(rows)
    grid_block = render_grid(rows)
    print()
    print(grid_block)

    diagnose_block = ""
    diag = None
    if args.diagnose:
        diag = diagnose(reader_mod, frames, int(win_start), oracle, manifest)
        diagnose_block = render_diagnose(diag["rows"])
        print()
        print("### band change-score calibration")
        print(diagnose_block)

    detail = ""
    if best is not None:
        detail = oracle.render(best["result"])
        print()
        print(detail)

    trace = None
    trace_block = ""
    trace_target = args.latch_trace
    if trace_target is None:
        pool = [r for r in rows if r["clears"]] or rows
        best_recall = max(pool, key=lambda r: r["recall"])
        trace_target = f"{best_recall['changeSensitivity']:g}:{best_recall['minDwellFrames']}"
    if trace_target:
        try:
            s_str, d_str = str(trace_target).split(":", 1)
            trace = latch_trace(reader_mod, frames, int(win_start), float(s_str), int(d_str),
                                oracle, manifest)
            trace_block = render_latch_trace(trace)
            print()
            print("### latch trace")
            print(trace_block)
        except ValueError:
            print(f"ignoring --latch-trace {trace_target!r}: want S:D", file=sys.stderr)

    payload = {
        "harness": "evals/measure_hud_recall.py",
        "clip": args.clip,
        "clipSha256Before": clip_sha_before,
        "clipSha256After": clip_sha_after,
        "manifest": args.manifest,
        "manifestSha256Before": sha_before,
        "manifestSha256After": sha_after,
        "manifestPinned": oracle.MANIFEST_SHA256,
        "window": [round(win_start, 2), round(win_end, 2)],
        "labelCoverage": [round(label_start, 2), round(label_end, 2)],
        "labelledWindowS": round(span, 2),
        "frames": int(frames.shape[0]),
        "matchWindow": {"pre": rows[0]["result"]["matchPre"],
                        "post": rows[0]["result"]["matchPost"]},
        "bars": {"A1_recall": BAR_RECALL, "A2_fpRate": BAR_FP_RATE,
                 "A3_silentWindows": BAR_SILENT_WINDOWS,
                 "A4_candidatesPerMinute": BAR_CANDIDATES_PER_MIN},
        "grid": [{k: v for k, v in r.items() if k != "result"} for r in rows],
        "chosen": None if best is None else best["cell"],
        "verdict": "continue" if best is not None else "park",
        "diagnose": diag,
        "latchTrace": trace,
    }
    out_json = args.json or os.path.join(args.out_dir, "hud_grid.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
        fh.write("\n")
    md_path = os.path.join(args.out_dir, "hud_grid.md")
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write("# HUD operating-point grid (ADAAAA-8744 WP3)\n\n")
        fh.write(f"- clip sha256: `{clip_sha_before}` (checked before and after)\n")
        fh.write(f"- manifest sha256: `{sha_before}` (pinned `{oracle.MANIFEST_SHA256}`, "
                 f"checked before and after)\n")
        fh.write(f"- measured window: {win_start:g}-{win_end:g} s ({span} s), "
                 f"{frames.shape[0]} frames at 1 fps\n")
        fh.write(f"- label coverage inside it: {label_start:g}-{label_end:g} s\n")
        fh.write(f"- match window: -{rows[0]['result']['matchPre']:g} s / "
                 f"+{rows[0]['result']['matchPost']:g} s (oracle default)\n\n")
        fh.write("## Grid\n\n")
        fh.write(grid_block + "\n\n")
        if diagnose_block:
            fh.write("## Band change-score calibration\n\n" + diagnose_block + "\n\n")
        if trace_block:
            fh.write("## Latch trace\n\n" + trace_block + "\n\n")
        fh.write(f"## Verdict\n\n- chosen cell: "
                 f"{'`' + best['cell'] + '`' if best else 'none (park)'}\n")
        fh.write(f"- verdict: **{payload['verdict']}**\n")
    print()
    print(f"artifacts: {out_json} · {md_path}")
    print(f"verdict: {payload['verdict']}"
          + (f" (chosen {best['cell']})" if best else " (no cell clears A1-A4)"))
    return 0 if best is not None else 1


def diagnose(reader_mod, frames, start_s: int, oracle, manifest: dict) -> dict:
    """Per-band change-score statistics at the labelled instants vs the whole window.

    Calibration evidence for the grid's sensitivity range: it prints what the bands
    actually score when a label says a transition happened, and what they score at
    rest, so the chosen sensitivities are visible as a data-driven range.
    """
    game_profile = sys.modules[f"{READER_PKG}.game_profile"]
    band_objs = tuple(
        game_profile.HudBand(name=n, rect=r, kind=k) for n, r, k in STK_BANDS
    )
    events = oracle.labelled_events(manifest)
    rows = []
    for band in band_objs:
        scores = []
        for i in range(frames.shape[0]):
            # score against the previous frame: the raw step magnitude, no latch.
            prev = frames[i - 1] if i else None
            s = reader_mod.band_change_score(frames[i], band, None if prev is None
                                             else reader_mod.band_signature(prev, band, 8), 8)
            if s is not None:
                scores.append((start_s + i, s))
        if not scores:
            continue
        vals = np.array([s for _, s in scores], dtype=float)
        rows.append({
            "band": band.name,
            "scope": "whole window (frame-to-frame)",
            "max": float(vals.max()),
            "p50": float(np.percentile(vals, 50)),
            "p95": float(np.percentile(vals, 95)),
            "frames": len(vals),
        })
        # scores within +/-1 s of a labelled instant
        near = [s for t, s in scores
                if any(abs(t - e["instant"]) <= 1.0 for e in events)]
        if near:
            near_vals = np.array(near, dtype=float)
            rows.append({
                "band": band.name,
                "scope": "within +/-1 s of a labelled instant",
                "max": float(near_vals.max()),
                "p50": float(np.percentile(near_vals, 50)),
                "p95": float(np.percentile(near_vals, 95)),
                "frames": len(near_vals),
            })
    return {"rows": rows}


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Voided as exc:
        print(f"VOIDED: {exc}", file=sys.stderr)
        sys.exit(3)
