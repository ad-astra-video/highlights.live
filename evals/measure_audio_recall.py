#!/usr/bin/env python3
"""Real-audio measurement for the audio trigger paths (ADAAAA-4970 / ADAAAA-7674 /
ADAAAA-7682).

Quantifies audio-gate fidelity per trigger class under continuous crowd noise on
real clips. Pure DSP — ffmpeg only to decode the audio track; no gemma, no billed
GPU path.

Two modes:

1. **Per-class mode (ADAAAA-7674 AC1/AC2, ADAAAA-7682 AC1/AC3)** — score every
   class in the label manifest and print the fidelity table:

       python3 evals/measure_audio_recall.py \
           --labels evals/audio-labels.json --clip-root /data

   Each class reports recall, trigger-window false-positive rate, and
   onset->fire p50/p95. A class whose manifest entry has ``clip: null`` is
   printed as ``N/A`` with its recorded gap reason — a gap is not a pass.

   Per-class manifest fields (ADAAAA-7682):

   - ``gate``: ``"stageA"`` (broadband noise-change, default) or ``"whistle"``
     (the band-limited 2.4-3.4 kHz tonal path in ``audio_gate.py``).
   - ``sr``: decode rate override. A narrowband 3.4 kHz band must be scored at
     the production 16 kHz, not the manifest-wide 8 kHz (Nyquist 4000 Hz).
   - ``negatives``: non-whistle windows ``[{clip, start, end}, ...]`` run through
     a FRESH gate each, for the false-positive rate the ship gate bounds.

   Real decoded PCM is fed to the gate, never a synthesized constant-RMS frame:
   Stage-A reads frame RMS so the value is identical, while the whistle path
   needs the spectrum.

2. **Before/after mode (ADAAAA-4970)** — compare the legacy INC-2 operating
   point with the current defaults on one clip/goal list:

       python3 evals/measure_audio_recall.py \
           --clip /data/real_goal_3080.mp4 \
           --goals 0,2,11,... [--frame-s 0.1] [--sr 8000]

``--goals`` are the video-rail accepted GOAL timestamps (seconds) for the clip;
recall = fraction with a gate candidate within [ts-pre, ts+post].

Needs numpy + the gate module (run where perceive deps exist, e.g. the box
perceive venv/container or the box host).
"""
import argparse
import json
import os
import subprocess
import sys

import numpy as np


def load_gate():
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "services", "perceive", "app", "audio_gate.py")
    spec = importlib.util.spec_from_file_location("audio_gate", os.path.normpath(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["audio_gate"] = mod
    spec.loader.exec_module(mod)
    return mod


def load_profile(name="soccer"):
    """Load the type's GAME PROFILE (ADAAAA-7754).

    `game_profile.py` is import-free at module scope on purpose, so the harness
    can load it standalone exactly like it loads `audio_gate`.
    """
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "services", "perceive", "app", "game_profile.py")
    spec = importlib.util.spec_from_file_location("game_profile", os.path.normpath(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["game_profile"] = mod
    spec.loader.exec_module(mod)
    return mod.load_game_profile(name)


def profile_gate_config(profile, frame_s: float):
    """A GateConfig at the profile's per-type audio operating point.

    No soccer threshold is hard-coded here: the defaults come from the profile,
    so a type's measured burst/swell/cooldown/latency set is what the harness
    scores.
    """
    gate_mod = load_gate()
    return gate_mod.GateConfig(frame_s=frame_s, **profile.audio_thresholds.as_gate_kwargs())


def run_gate_stream(path, sr, frame_s, gate, start_s=0.0, dur_s=None):
    """Feed real decoded PCM frames (mono s16le, ``sr``) into ``gate``.

    Stage-A reads frame RMS, which a real PCM chunk reproduces exactly (the old
    synthetic ``np.full(800, rms)`` feed was the same number). The band-limited
    whistle path needs the spectrum, so the eval must feed real samples instead
    of a constant array — otherwise the 2.4-3.4 kHz band of the decoded audio is
    never measured (ADAAAA-7682 AC1).

    ``start_s``/``dur_s`` decode only a window (the negative windows), so the
    gate is fresh at the window start and cannot inherit prior state.
    """
    n = max(1, int(sr * frame_s))
    cmd = ["ffmpeg", "-v", "error"]
    if start_s > 0:
        cmd += ["-ss", f"{start_s:.3f}"]
    cmd += ["-i", path]
    if dur_s is not None:
        cmd += ["-t", f"{dur_s:.3f}"]
    cmd += ["-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    fires, lats, kinds = [], [], []
    frame_bytes = n * 2
    # ``ts`` is ``i * frame_s`` (exact index arithmetic), NOT an accumulated
    # float: the gate's rolling baseline window is cut at ``ts - lookback_s``,
    # so a 1e-13 drift over a long clip can push a frame in or out of the
    # percentile window and flip a marginal fire. With accumulation the same
    # clip scored 0.78 (25/32) against the whole-file feed's 0.88 (28/32).
    frame_index = 0
    # A pipe read can return fewer bytes than requested even mid-stream, so
    # accumulate until a whole frame is buffered.
    pending = bytearray()
    while True:
        chunk = proc.stdout.read(65536)
        if not chunk:
            break
        pending.extend(chunk)
        while len(pending) >= frame_bytes:
            frame = bytes(pending[:frame_bytes])
            del pending[:frame_bytes]
            x = np.frombuffer(frame, dtype="<i2").astype(np.float32)
            sig = gate.update(x, frame_index * frame_s)
            if sig is not None:
                fires.append(sig.ts)
                lats.append(sig.onset_latency_s)
                kinds.append(sig.threshold_id or sig.kind)
            frame_index += 1
    proc.stdout.close()
    proc.wait()
    return fires, lats, kinds


def build_gate(mod, gate_name, frame_s, sr, **overrides):
    """Build a gate for the class' path, ignoring overrides it does not own.

    ``--gate-opt`` is a global flag, so a whistle-only field would otherwise
    crash the ``stageA`` classes in the same run.
    """
    from dataclasses import fields

    if gate_name == "whistle":
        cfg_cls = mod.WhistleConfig
        opts = {"frame_s": frame_s, "sample_rate": sr}
        gate_cls = mod.BandLimitedWhistleGate
    else:
        cfg_cls = mod.GateConfig
        opts = {"frame_s": frame_s}
        gate_cls = mod.AudioEnergyGate
    valid = {f.name for f in fields(cfg_cls)}
    opts.update({k: v for k, v in overrides.items() if k in valid})
    return gate_cls(cfg_cls(**opts))



def pc(lats, p):
    if not lats:
        return 0.0
    s = sorted(lats)
    return s[min(len(s) - 1, int(p * len(s)))]


def measure_fires(fires, lats, kinds, onsets, pre, post, known=()):
    """Score one stream's fires against its onsets.

    ``known`` are independently verified onsets that are NOT part of the recall
    denominator (found after the corpus was labelled). A fire matching one is a
    true positive for FP accounting but does not inflate recall — otherwise a
    detector could be credited for finding the very points added to the corpus
    from its own output.
    """
    onsets = sorted(set(onsets))
    known = sorted(set(known))

    def _near(t):
        return any(f >= t - pre and f <= t + post for f in fires)

    rec = sum(1 for t in onsets if _near(t))
    fp = sum(1 for f in fires
             if not any(t - pre <= f <= t + post for t in onsets)
             and not any(t - pre <= f <= t + post for t in known))
    return {
        "candidates": len(fires),
        "events": len(onsets),
        "recalled": rec,
        "recall": rec / len(onsets) if onsets else 0.0,
        "fp": fp,
        "fp_rate": fp / len(fires) if fires else 0.0,
        "p50": pc(lats, 0.5),
        "p95": pc(lats, 0.95),
        "max_lat": max(lats) if lats else 0.0,
        "threshold_ids": sorted(set(kinds)),
    }


def measure_negatives(mod, args, manifest, cls, sr, frame_s, gate_name, overrides=None):
    """Score the class' non-whistle negative windows for false triggers.

    Each window is decoded on its own and run through a fresh gate, so a fire in
    it is a true false positive rather than one inherited from neighbouring
    audio. ``fp_windows`` (windows with >= 1 fire) is the rate the ship gate
    bounds; ``windows`` is the denominator.
    """
    overrides = overrides or {}
    windows = cls.get("negatives") or []
    if not windows:
        return None
    fired = 0
    candidates = 0
    details = []
    for w in windows:
        path = w["clip"]
        if args.clip_root:
            path = os.path.join(args.clip_root, w["clip"])
        if not os.path.exists(path):
            details.append({"clip": w["clip"], "start": w["start"], "error": "clip not found"})
            continue
        dur = float(w["end"]) - float(w["start"])
        gate = build_gate(mod, gate_name, frame_s, sr, **overrides)
        fires, _lats, _kinds = run_gate_stream(path, sr, frame_s, gate,
                                               start_s=float(w["start"]), dur_s=dur)
        if fires:
            fired += 1
            candidates += len(fires)
        details.append({"clip": w["clip"], "start": w["start"], "end": w["end"],
                        "fires": [round(f + float(w["start"]), 2) for f in fires]})
    return {
        "windows": len(windows),
        "fp_windows": fired,
        "fp_window_rate": fired / len(windows) if windows else 0.0,
        "candidates": candidates,
        "details": details,
    }


DEFAULT_MATCH_PRE_S = 3.0
DEFAULT_MATCH_POST_S = 2.0


def resolve_match_windows(match_pre, match_post, manifest):
    """Resolve the onset scoring windows: explicit CLI value > manifest > default.

    ADAAAA-7772: the manifest's ``matchPre``/``matchPost`` used to win
    unconditionally (``manifest.get("matchPre", args.match_pre)``), so passing
    ``--match-pre`` while the manifest carried the key was silently inert. A
    reviewer re-scoring label-tolerance sensitivity that way got the baseline
    back for every tolerance and would read the sweep as unsupported. An explicit
    flag now overrides the manifest; a manifest value still wins over the default.
    """
    pre = DEFAULT_MATCH_PRE_S if match_pre is None else match_pre
    post = DEFAULT_MATCH_POST_S if match_post is None else match_post
    if match_pre is None:
        pre = manifest.get("matchPre", pre)
    if match_post is None:
        post = manifest.get("matchPost", post)
    return pre, post


def per_class(args):
    """Score every class in the manifest; return the table rows.

    A class may name one clip (``clip`` + ``onsets``) or several
    (``clips: [{clip, onsets}, ...]``, ADAAAA-7682) — the whistle class spans
    the clips its verified onsets actually live in. Fires are collected per clip
    with a fresh gate (each clip is a separate stream) and then scored jointly
    against the union of its onsets.
    """
    manifest = json.load(open(args.labels))
    mod = load_gate()
    frame_s = manifest.get("frameS", args.frame_s)
    # ADAAAA-7772: an explicit --match-pre/--match-post must not be shadowed by the
    # manifest; the override is stated on stderr so a transcript shows what scored.
    pre, post = resolve_match_windows(args.match_pre, args.match_post, manifest)
    if args.match_pre is not None and "matchPre" in manifest and manifest["matchPre"] != pre:
        print(f"note: --match-pre {pre} overrides the manifest's matchPre "
              f"{manifest['matchPre']}", file=sys.stderr)
    if args.match_post is not None and "matchPost" in manifest and manifest["matchPost"] != post:
        print(f"note: --match-post {post} overrides the manifest's matchPost "
              f"{manifest['matchPost']}", file=sys.stderr)
    rows = []
    for cls in manifest["classes"]:
        row = {"id": cls["id"], "clip": cls.get("clip"), "measured": bool(cls.get("measured"))}
        segments = cls.get("clips") or (
            [{"clip": cls["clip"], "onsets": cls.get("onsets", [])}] if cls.get("clip") else []
        )
        if not segments:
            row.update(measured=False, gap_reason=cls.get("gapReason", ""))
            rows.append(row)
            continue
        # ADAAAA-7682 AC1: the class may override the manifest-wide decode rate.
        # A 3.4 kHz band scored on 8 kHz-decoded audio (Nyquist 4000 Hz) is not
        # the signal production PCM carries, so the whistle class decodes at the
        # production rate instead.
        sr = int(cls.get("sr") or manifest.get("sr") or args.sr)
        gate_name = cls.get("gate", "stageA")
        fires, lats, kinds = [], [], []
        recalled = 0
        fp = 0
        events = 0
        seg_rows = []
        missing = []
        for seg in segments:
            path = seg["clip"]
            if args.clip_root:
                path = os.path.join(args.clip_root, seg["clip"])
            if not os.path.exists(path):
                missing.append(path)
                continue
            gate = build_gate(mod, gate_name, frame_s, sr, **args.gate_opts)
            sfires, slats, skinds = run_gate_stream(path, sr, frame_s, gate)
            # Score THIS clip on its own. Pooling fires across clips lets a fire
            # in clip A "match" an onset at the same second in clip B, which
            # inflated whistle recall from 0.70 to a false 1.00.
            segm = measure_fires(sfires, slats, skinds, seg["onsets"], pre, post,
                                 known=seg.get("detectedOnsets", ()))
            recalled += segm["recalled"]
            fp += segm["fp"]
            events += segm["events"]
            seg_rows.append({"clip": seg["clip"], "onsets": seg["onsets"],
                             "detectedOnsets": seg.get("detectedOnsets", []),
                             "fires": [round(f, 2) for f in sfires],
                             "recalled": segm["recalled"], "fp": segm["fp"],
                             "thresholdIds": sorted(set(skinds))})
            fires.extend(sfires)
            lats.extend(slats)
            kinds.extend(skinds)
        if missing:
            row.update(measured=False, gap_reason=f"clip(s) not found: {missing}")
            rows.append(row)
            continue
        row.update(candidates=len(fires), events=events, recalled=recalled,
                   recall=recalled / events if events else 0.0,
                   fp=fp, fp_rate=fp / len(fires) if fires else 0.0,
                   p50=pc(lats, 0.5), p95=pc(lats, 0.95),
                   max_lat=max(lats) if lats else 0.0,
                   threshold_ids=sorted(set(kinds)),
                   measured=True, sr=sr, gate=gate_name, segments=seg_rows)
        if cls.get("negatives"):
            row["negatives"] = measure_negatives(mod, args, manifest, cls, sr, frame_s,
                                                 gate_name, overrides=args.gate_opts)
        if args.compare_lookback is not None and gate_name == "stageA":
            bfires, blats, bkinds = [], [], []
            brec, bfp = 0, 0
            for seg in segments:
                p = os.path.join(args.clip_root, seg["clip"]) if args.clip_root else seg["clip"]
                base = build_gate(mod, "stageA", frame_s, sr, lookback_s=args.compare_lookback)
                f, l, k = run_gate_stream(p, sr, frame_s, base)
                bfires.extend(f)
                blats.extend(l)
                bkinds.extend(k)
                segm = measure_fires(f, l, k, seg["onsets"], pre, post)
                brec += segm["recalled"]
                bfp += segm["fp"]
            row["baseline"] = {
                "candidates": len(bfires),
                "events": sum(len(s["onsets"]) for s in segments),
                "recalled": brec,
                "recall": brec / sum(len(s["onsets"]) for s in segments),
                "fp": bfp,
                "fp_rate": bfp / len(bfires) if bfires else 0.0,
                "p50": pc(blats, 0.5),
                "p95": pc(blats, 0.95),
            }
        rows.append(row)
    return rows


def print_table(rows, compare):
    print("| class | clip | sr | events | candidates | recall | FP windows | FP rate | onset->fire p50 | p95 |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        if not r.get("measured"):
            print(f"| {r['id']} | N/A | N/A | N/A | N/A | **N/A** | N/A | N/A | N/A | N/A |")
            continue
        print(f"| {r['id']} | `{r['clip']}` | {r.get('sr', '')} | {r['events']} | {r['candidates']} | "
              f"{r['recall']:.2f} ({r['recalled']}/{r['events']}) | {r['fp']} | {r['fp_rate']:.2f} | "
              f"{r['p50']:.2f} s | {r['p95']:.2f} s |")
        neg = r.get("negatives")
        if neg:
            print(f"| _{r['id']} negatives_ | {neg['windows']} windows | {r.get('sr', '')} | — | "
                  f"{neg['candidates']} fires | — | {neg['fp_windows']} | {neg['fp_window_rate']:.2f} | — | — |")
    if compare:
        print("\n| class | lookback | recall | FP rate | candidates | p50 | p95 |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for r in rows:
            if not r.get("measured") or "baseline" not in r:
                continue
            b, c = r["baseline"], r
            print(f"| {r['id']} | {compare:.1f} s -> current | "
                  f"{b['recall']:.2f} -> {c['recall']:.2f} | {b['fp_rate']:.2f} -> {c['fp_rate']:.2f} | "
                  f"{b['candidates']} -> {c['candidates']} | {b['p50']:.2f} -> {c['p50']:.2f} | "
                  f"{b['p95']:.2f} -> {c['p95']:.2f} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", help="clip path (before/after mode)")
    ap.add_argument("--goals", help="comma-separated goal timestamps (s) (before/after mode)")
    ap.add_argument("--labels", help="label manifest path (per-class mode)")
    ap.add_argument("--clip-root", help="directory the manifest clip names resolve against (e.g. /data)")
    ap.add_argument("--class", dest="classes", action="append",
                    help="only score these class ids (repeatable; default: all)")
    ap.add_argument("--frame-s", type=float, default=0.1)
    ap.add_argument("--sr", type=int, default=8000)
    ap.add_argument("--match-pre", type=float, default=None,
                    help="pre-window (s) around a labelled onset; default 3.0, or the "
                         "manifest's matchPre when the manifest carries one. An "
                         "explicit value overrides the manifest (ADAAAA-7772)")
    ap.add_argument("--match-post", type=float, default=None,
                    help="post-window (s) after a labelled onset; default 2.0, or the "
                         "manifest's matchPost when the manifest carries one")
    ap.add_argument("--compare-lookback", type=float, default=None,
                    help="also score the class at this lookback_s to show the tuning delta")
    ap.add_argument("--gate-opt", dest="gate_opts", action="append", default=[],
                    metavar="KEY=VALUE",
                    help="override a gate config field (repeatable), e.g. "
                         "--gate-opt whistle_ratio=4 --gate-opt sustain_frames=2")
    ap.add_argument("--volume-clip", default=None,
                    help="stream one clip through a gate and report candidates/min "
                         "(ADAAAA-7682 AC3 cross-clip trigger-volume budget)")
    ap.add_argument("--volume-gate", default="whistle", choices=["whistle", "stageA"],
                    help="which path to stream for --volume-clip (default whistle)")
    ap.add_argument("--json", help="write the machine-readable result to this path")
    ap.add_argument("--profile", default="soccer",
                    help="game profile whose audioThresholds the NEW run scores (ADAAAA-7754)")
    ap.add_argument("--only", choices=["old", "new"], default=None)
    a = ap.parse_args()
    opts = {}
    for item in a.gate_opts:
        key, _, raw = item.partition("=")
        if not key or not raw:
            ap.error(f"--gate-opt needs KEY=VALUE, got {item!r}")
        try:
            opts[key] = int(raw)
        except ValueError:
            try:
                opts[key] = float(raw)
            except ValueError:
                opts[key] = {"true": True, "false": False}.get(raw.lower(), raw)
    a.gate_opts = opts

    if a.volume_clip:
        path = a.volume_clip
        if a.clip_root:
            path = os.path.join(a.clip_root, a.volume_clip)
        if not os.path.exists(path):
            ap.error(f"--volume-clip not found: {path}")
        mod = load_gate()
        sr = 16000 if a.volume_gate == "whistle" else a.sr
        gate = build_gate(mod, a.volume_gate, a.frame_s, sr, **a.gate_opts)
        fires, _lats, kinds = run_gate_stream(path, sr, a.frame_s, gate)
        seconds = int(round(float(
            subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", path],
                           check=True, capture_output=True, text=True).stdout.strip() or 0)))
        minutes = seconds / 60.0
        print(f"{a.volume_gate} on {a.volume_clip}: {seconds} s, "
              f"{len(fires)} candidates = {len(fires) / minutes:.1f}/min")
        print("fires:", [round(f, 2) for f in fires])
        print("thresholdIds:", sorted(set(kinds)))
        if a.json:
            json.dump({"clip": a.volume_clip, "gate": a.volume_gate, "seconds": seconds,
                       "candidates": len(fires), "perMinute": round(len(fires) / minutes, 1),
                       "fires": [round(f, 2) for f in fires]}, open(a.json, "w"), indent=2)
        return

    if a.labels:
        rows = per_class(a)
        if a.classes:
            rows = [r for r in rows if r["id"] in a.classes]
        print_table(rows, a.compare_lookback)
        for r in rows:
            if not r.get("measured"):
                print(f"\nN/A — {r['id']}: {r.get('gap_reason', 'no footage')}")
        if a.json:
            json.dump({"classes": rows, "frameS": a.frame_s}, open(a.json, "w"), indent=2)
        return

    if not (a.clip and a.goals):
        ap.error("either --labels or both --clip and --goals are required")
    goals = [float(x) for x in a.goals.split(",") if x.strip() != ""]
    mod = load_gate()
    gate_cls, GateConfig = mod.AudioEnergyGate, mod.GateConfig
    # before/after mode has no manifest to inherit a window from.
    match_pre, match_post = resolve_match_windows(a.match_pre, a.match_post, {})

    profile = load_profile(a.profile)
    old = GateConfig(frame_s=a.frame_s, burst_ratio=3.0, burst_min_frames=10,
                     swell_ratio=1.5, swell_seconds=3.0, cooldown_s=5.0)
    # ADAAAA-7754: the NEW operating point is the profile's per-type thresholds
    # (the soccer default reproduces the shipped defaults exactly).
    new = profile_gate_config(profile, a.frame_s)

    def show(label, cfg):
        fires, lats, kinds = run_gate_stream(a.clip, a.sr, a.frame_s, gate_cls(cfg))
        m = measure_fires(fires, lats, kinds, goals, match_pre, match_post)
        print(f"{label}: candidates={m['candidates']} goals={m['events']} "
              f"recalled={m['recalled']} recall={m['recall']:.2f} "
              f"fp={m['fp']} fp_rate={m['fp_rate']:.2f} p50={m['p50']:.2f}s p95={m['p95']:.2f}s "
              f"max_lat={m['max_lat']:.2f}s threshold={m['threshold_ids']}")

    if a.only in (None, "old"):
        show("OLD (INC-2 budget)", old)
    if a.only in (None, "new"):
        show("NEW (current)", new)


if __name__ == "__main__":
    main()
