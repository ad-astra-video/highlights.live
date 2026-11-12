#!/usr/bin/env python3
"""Corroboration oracle for the esports (SuperTuxKart) HUD event trigger (ADAAAA-8743, WP2 of
the plan on ADAAAA-7812 §2/§4).

It scores a **candidate export** — a plain JSON file of HUD-transition candidates — against
the frozen human-read label manifest `evals/supertuxkart_val/label-manifest.json`, and
against nothing else. It never imports, instantiates or pokes the trigger reader
(`services/perceive/app/hud_reader.py`), so a reader that produced the labels cannot also
author the judgement of the reader that consumes them.

Three jobs, in this order:

1. **Score.** Same event classes, same `-matchPre/+matchPost` (`-3/+2 s`) matching window and
   the same table columns as `evals/measure_audio_recall.py`, so a HUD cell and an audio cell
   are comparable cell for cell. Recall, in-window candidate FP, FP rate and the candidate
   lag distribution are printed per class; the per-window fire counts of every verified
   non-event window are printed separately (a window that fires is the failure A3 bounds).
2. **Corroborate.** A candidate survives only when a second, *independent* channel agrees:
   a motion peak, an audio burst, or a second HUD band transitioning at the same instant.
   Each rule's precision lift is printed on its own row. There is deliberately no single
   aggregated "corroborated" number that would let one channel's work hide inside another's.
3. **Enforce independence.** The manifest's sha256 is re-checked before *and* after scoring.
   A mismatch voids the run — the oracle prints VOIDED, produces no numbers, and exits 3.
   The pinned digest below is the one QA independently re-derived on ADAAAA-7806.

Candidate export schema (no label fields — see `validate_export`)::

    {
      "video": {"id": "...", "path": "...", "duration_s": 5950.549},
      "producer": "hud-event/hud_reader",          # free text, optional
      "fps": 1,                                    # optional, printed in the `sr` column
      "candidates": [
        {"t": 4547.4,                              # REQUIRED: candidate instant, seconds
         "band": "centre-banner",                  # HUD band the reader fired on
         "score": 0.81,                            # reader's own change score, optional
         "corroboration": {                        # optional; drives the per-rule table
           "motion": 0.62,                         # normalised 0-1 motion-peak agreement
           "audio": 0.71,                          # normalised 0-1 audio-burst agreement
           "bands": [{"band": "laps", "t": 4547.6}]  # OTHER HUD bands, with instants
         }}
      ]
    }

A bare `[...]` list of candidates is also accepted. `PYTHONPATH`/`sys.path` are irrelevant to
the score: stdin, network, environment and the reader are all out of reach. Pure stdlib — it
runs anywhere `python3` exists, including a reviewer's box with no perceive deps.

Usage::

    python3 evals/hud_oracle.py \\
        --candidates /path/to/candidates.json \\
        --manifest evals/supertuxkart_val/label-manifest.json \\
        [--rule motion|audio|second-band|any] [--json out.json]

Exit codes: `0` scored, `2` bad candidate export, `3` manifest voided (hash mismatch).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

# --- the frozen label artifact -------------------------------------------------------------

#: sha256 of the human-read manifest QA independently re-derived on ADAAAA-7806.
MANIFEST_SHA256 = "d19a2240578ba6760d9634cd9932cd48ae49bd245b7085140711c6f1bca73d23"

#: repo-relative path of the only label input this oracle accepts.
MANIFEST_RELPATH = os.path.join("evals", "supertuxkart_val", "label-manifest.json")

#: matching window, identical to `evals/measure_audio_recall.py` (ADAAAA-7772 semantics).
DEFAULT_MATCH_PRE_S = 3.0
DEFAULT_MATCH_POST_S = 2.0

#: event classes the HUD trigger is scored on, in the manifest's own order.
EVENT_CLASSES = ("race_start", "final_lap", "race_finish")

#: corroboration rules. Each reads a channel that is *not* the band the candidate fired on.
CORROBORATION_RULES = ("motion", "audio", "second-band")

#: column header, byte-identical to `evals/measure_audio_recall.py:print_table` so the two
#: harnesses cannot drift apart (a test pins this).
TABLE_HEADER = ("| class | clip | sr | events | candidates | recall | FP windows | FP rate | "
                "onset->fire p50 | p95 |")
TABLE_SEP = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"

CORROBORATION_HEADER = ("| rule | candidates kept | kept TP | kept precision | base precision | "
                        "precision lift | recall kept | recall delta |")
CORROBORATION_SEP = "| --- | --- | --- | --- | --- | --- | --- | --- |"

NON_EVENT_HEADER = "| window | t_start | t_end | fires | in-window seconds |"
NON_EVENT_SEP = "| --- | --- | --- | --- | --- |"

#: fields that only a label artifact carries. A candidate export carrying any of them is not a
#: reader export, it is the labels in disguise, and the oracle refuses it.
LABEL_FIELDS = ("ground_truth", "event_type", "instant", "bracket", "brackets", "labels",
                "label", "window_class", "non_event", "evidence", "t_start", "t_end")

DEFAULT_RULE_CFG = {"motion_min": 0.5, "audio_min": 0.5, "band_window_s": 4.0}


class OracleError(RuntimeError):
    """Base class for every refusal."""


class ManifestVoided(OracleError):
    """The label manifest is not the frozen artifact; no number may be produced."""


class CandidateSchemaError(OracleError):
    """The candidate export is malformed or carries label fields."""


# --- manifest handling ---------------------------------------------------------------------

def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_manifest_path() -> str:
    return os.path.join(repo_root(), MANIFEST_RELPATH)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_manifest(path: str, expected: str = MANIFEST_SHA256) -> str:
    """Return the digest iff it equals the pinned one; otherwise void the run.

    Called before *and* after scoring. A run that scored against a manifest modified between
    the two checks must not report a number, so the caller discards the result on mismatch.
    """
    actual = sha256_file(path)
    if actual != expected:
        raise ManifestVoided(
            f"manifest sha256 {actual} != pinned {expected} ({path}); run VOIDED")
    return actual


def load_manifest(path: str) -> dict:
    verify_manifest(path)
    with open(path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if not isinstance(manifest, dict) or not manifest.get("windows"):
        raise CandidateSchemaError(f"{path} is not a label manifest with `windows`")
    return manifest


def labelled_events(manifest: dict) -> list:
    """The 15 objective events, each with its class, instant and bracket."""
    out = []
    for w in manifest["windows"]:
        if w.get("kind") == "non_event":
            continue
        if w.get("ground_truth") != "objective_event":
            continue
        out.append({"id": w["id"], "event_type": w["event_type"], "race": w.get("race"),
                    "instant": float(w["instant"]),
                    "bracket": [float(x) for x in (w.get("bracket") or [])]})
    return sorted(out, key=lambda e: e["instant"])


def non_event_windows(manifest: dict) -> list:
    out = []
    for w in manifest["windows"]:
        if w.get("kind") != "non_event":
            continue
        out.append({"id": w["id"], "t_start": float(w["t_start"]), "t_end": float(w["t_end"])})
    return sorted(out, key=lambda w: w["t_start"])


def labelled_window(manifest: dict) -> tuple:
    """(start, end) covered by the labels: every event bracket plus every non-event window."""
    starts, ends = [], []
    for e in labelled_events(manifest):
        starts.append(e["instant"])
        ends.append((e["bracket"] or [e["instant"]])[-1])
    for w in non_event_windows(manifest):
        starts.append(w["t_start"])
        ends.append(w["t_end"])
    return min(starts), max(ends)


def resolve_match_windows(match_pre, match_post, manifest: dict) -> tuple:
    """Resolve the scoring window: explicit flag > manifest > default.

    Mirrors `measure_audio_recall.resolve_match_windows` (the ADAAAA-7772 precedence fix) so
    an explicit `--match-pre` cannot be silently shadowed by the manifest.
    """
    pre = DEFAULT_MATCH_PRE_S if match_pre is None else float(match_pre)
    post = DEFAULT_MATCH_POST_S if match_post is None else float(match_post)
    if match_pre is None:
        pre = float(manifest.get("matchPre", pre))
    if match_post is None:
        post = float(manifest.get("matchPost", post))
    return pre, post


# --- candidate export handling -------------------------------------------------------------

def _reject_label_fields(obj: dict, where: str) -> None:
    bad = sorted(set(LABEL_FIELDS) & set(obj))
    if bad:
        raise CandidateSchemaError(
            f"{where} carries label field(s) {bad}; a candidate export must not contain "
            f"labels — the oracle scores a reader export against the frozen manifest, not a "
            f"copy of the labels")


def load_export(path: str) -> dict:
    """Read and validate a candidate export. Raises CandidateSchemaError for anything else."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except OSError as exc:
        raise CandidateSchemaError(f"{path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CandidateSchemaError(f"{path} is not JSON: {exc}") from exc
    if isinstance(raw, list):
        raw = {"candidates": raw}
    if not isinstance(raw, dict) or not isinstance(raw.get("candidates"), list):
        raise CandidateSchemaError(f"{path} must be a list or an object with `candidates`")
    _reject_label_fields(raw, f"{path} (top level)")
    for i, cand in enumerate(raw["candidates"]):
        if not isinstance(cand, dict):
            raise CandidateSchemaError(f"{path}: candidate #{i} is not an object")
        _reject_label_fields(cand, f"{path}: candidate #{i}")
        if "t" not in cand:
            raise CandidateSchemaError(f"{path}: candidate #{i} has no `t` instant")
        try:
            cand["t"] = float(cand["t"])
        except (TypeError, ValueError) as exc:
            raise CandidateSchemaError(f"{path}: candidate #{i} `t` is not numeric: {exc}")
    raw["candidates"].sort(key=lambda c: c["t"])
    return raw


def candidate_band(cand: dict) -> str:
    return str(cand.get("band") or cand.get("channel") or "")


# --- corroboration -------------------------------------------------------------------------

def _num(value):
    """Tolerant numeric read; a `{"value": x}` / `{"score": x}` wrapper is unwrapped."""
    if isinstance(value, dict):
        for key in ("score", "value", "agreement"):
            if key in value:
                return _num(value[key])
        return None
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def rule_agrees(rule: str, cand: dict, cfg: dict | None = None) -> bool:
    """Does the independent channel named by ``rule`` agree with this candidate?

    The candidate's own band is never evidence for itself: `second-band` requires a band
    *other than* the one the reader fired on, and motion/audio are different sensors.
    """
    cfg = dict(DEFAULT_RULE_CFG, **(cfg or {}))
    corr = cand.get("corroboration")
    if not isinstance(corr, dict):
        corr = {}
    if rule == "motion":
        value = _num(cand.get("motion"))
        if value is None:
            value = _num(corr.get("motion"))
        return value is not None and value >= cfg["motion_min"]
    if rule == "audio":
        value = _num(cand.get("audio"))
        if value is None:
            value = _num(corr.get("audio"))
        return value is not None and value >= cfg["audio_min"]
    if rule == "second-band":
        own = candidate_band(cand)
        bands = corr.get("bands")
        if bands is None:
            bands = cand.get("bands")
        if isinstance(bands, str):
            bands = [bands]
        if not isinstance(bands, list):
            return False
        for item in bands:
            if isinstance(item, dict):
                other = str(item.get("band") or item.get("channel") or "")
                other_t = _num(item.get("t"))
                if other_t is not None and abs(other_t - cand["t"]) > cfg["band_window_s"]:
                    continue
            else:
                other = str(item)
            if other and other != own:
                return True
        return False
    raise OracleError(f"unknown corroboration rule {rule!r}")


# --- scoring -------------------------------------------------------------------------------

def pc(values, p):
    """Percentile, identical to `measure_audio_recall.pc`."""
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


def in_window(t: float, instant: float, pre: float, post: float) -> bool:
    return instant - pre <= t <= instant + post


def _first_hit(candidates, instant, pre, post):
    for cand in candidates:
        if in_window(cand["t"], instant, pre, post):
            return cand
    return None


def hits_any_event(t: float, events, pre: float, post: float) -> bool:
    return any(in_window(t, e["instant"], pre, post) for e in events)


def score_class(cls: str, clip: str, candidates, events, non_event_fires, pre, post,
                fps=None) -> dict:
    """One table row: recall/FP for a class, FP counted against all 15 objective events.

    A candidate that matches a *different* class's event is not a false positive here — one
    clip carries all three classes, so class-scoped FP accounting (the audio harness's variant
    for one-class-per-clip manifests) would report the same candidate as TP and FP at once.
    The audio-literal variant is kept in `fp_class_only` for anyone diffing the two harnesses.
    """
    class_events = [e for e in events if e["event_type"] == cls]
    lags = []
    recalled = 0
    for event in class_events:
        cand = _first_hit(candidates, event["instant"], pre, post)
        if cand is not None:
            recalled += 1
            lags.append(round(cand["t"] - event["instant"], 3))
    fp = sum(1 for c in candidates if not hits_any_event(c["t"], events, pre, post))
    fp_class_only = sum(1 for c in candidates
                        if not any(in_window(c["t"], e["instant"], pre, post)
                                   for e in class_events))
    return {
        "id": cls,
        "clip": clip,
        "sr": fps,
        "events": len(class_events),
        "candidates": len(candidates),
        "recalled": recalled,
        "recall": recalled / len(class_events) if class_events else 0.0,
        "fp": fp,
        "fp_rate": fp / len(candidates) if candidates else 0.0,
        "fp_class_only": fp_class_only,
        "fp_rate_class_only": fp_class_only / len(candidates) if candidates else 0.0,
        "p50": pc(lags, 0.5),
        "p95": pc(lags, 0.95),
        "lags": lags,
        "non_event_fires": non_event_fires,
    }


def score_non_event_windows(candidates, windows) -> dict:
    """Per-window fire counts on verified non-event windows (A3)."""
    rows = []
    fired = 0
    fires = 0
    for w in windows:
        inside = [round(c["t"], 2) for c in candidates if w["t_start"] <= c["t"] <= w["t_end"]]
        if inside:
            fired += 1
            fires += len(inside)
        rows.append({"id": w["id"], "t_start": w["t_start"], "t_end": w["t_end"],
                     "seconds": round(w["t_end"] - w["t_start"], 2), "fires": inside})
    return {
        "windows": len(windows),
        "fp_windows": fired,
        "fp_window_rate": fired / len(windows) if windows else 0.0,
        "candidates": fires,
        "silent_windows": len(windows) - fired,
        "per_window": rows,
    }


def score_corroboration(candidates, events, pre, post, cfg=None) -> list:
    """Per-rule precision lift. One row per rule, plus the union row.

    Base precision is measured over every candidate inside the labelled window; the row's
    `kept precision` is measured over the candidates that rule keeps. The lift is the
    difference. A rule that keeps fewer true positives than it keeps false positives shows a
    negative lift — that is the point of reporting per rule instead of one aggregate.
    """
    cfg = dict(DEFAULT_RULE_CFG, **(cfg or {}))
    in_window_cands = [c for c in candidates if hits_any_event(c["t"], events, pre, post)]
    base_kept = len(candidates)
    base_tp = len(in_window_cands)
    base_precision = base_tp / base_kept if base_kept else 0.0
    total_events = len(events)
    base_recall = base_tp / total_events if total_events else 0.0
    rows = []
    for rule in CORROBORATION_RULES:
        kept = [c for c in candidates if rule_agrees(rule, c, cfg)]
        tp = [c for c in kept if hits_any_event(c["t"], events, pre, post)]
        precision = len(tp) / len(kept) if kept else 0.0
        recalled_events = sum(1 for e in events
                              if any(in_window(c["t"], e["instant"], pre, post) for c in kept))
        recall = recalled_events / total_events if total_events else 0.0
        rows.append({
            "rule": rule,
            "candidates_kept": len(kept),
            "kept_tp": len(tp),
            "kept_precision": precision,
            "base_precision": base_precision,
            "precision_lift": precision - base_precision,
            "events_kept": recalled_events,
            "recall_kept": recall,
            "recall_delta": recall - base_recall,
        })
    union = [c for c in candidates
             if any(rule_agrees(r, c, cfg) for r in CORROBORATION_RULES)]
    utp = [c for c in union if hits_any_event(c["t"], events, pre, post)]
    uprecision = len(utp) / len(union) if union else 0.0
    urecalled = sum(1 for e in events
                    if any(in_window(c["t"], e["instant"], pre, post) for c in union))
    rows.append({
        "rule": "any-of-rules",
        "candidates_kept": len(union),
        "kept_tp": len(utp),
        "kept_precision": uprecision,
        "base_precision": base_precision,
        "precision_lift": uprecision - base_precision,
        "events_kept": urecalled,
        "recall_kept": urecalled / total_events if total_events else 0.0,
        "recall_delta": (urecalled / total_events if total_events else 0.0) - base_recall,
    })
    return rows


def score(manifest: dict, export: dict, pre: float, post: float, cfg=None,
          labelled_window_s=None) -> dict:
    """Score an export against a manifest that has already passed the pin check."""
    events = labelled_events(manifest)
    windows = non_event_windows(manifest)
    candidates = export["candidates"]
    clip = (manifest.get("video") or {}).get("path") or "N/A"
    fps = export.get("fps")
    win_start, win_end = labelled_window(manifest)
    span = (win_end - win_start) if labelled_window_s is None else float(labelled_window_s)

    negatives = score_non_event_windows(candidates, windows)
    classes = [score_class(cls, clip, candidates, events, negatives["candidates"], pre, post,
                           fps=fps) for cls in EVENT_CLASSES]
    in_cov = [c for c in candidates if win_start <= c["t"] <= win_end]
    overall_tp = [c for c in in_cov if hits_any_event(c["t"], events, pre, post)]
    overall_fp = len(in_cov) - len(overall_tp)
    recalled = sum(1 for e in events if _first_hit(candidates, e["instant"], pre, post))
    return {
        "manifest_path": None,
        "sha_before": None,
        "sha_after": None,
        "matchPre": pre,
        "matchPost": post,
        "labelled_window_s": round(span, 2),
        "labelled_window": [round(win_start, 2), round(win_end, 2)],
        "classes": classes,
        "negatives": negatives,
        "overall": {
            "candidates": len(candidates),
            "candidates_in_window": len(in_cov),
            "outside_labelled_window": len(candidates) - len(in_cov),
            "events": len(events),
            "recalled": recalled,
            "recall": recalled / len(events) if events else 0.0,
            "tp": len(overall_tp),
            "fp": overall_fp,
            "fp_rate": overall_fp / len(in_cov) if in_cov else 0.0,
            "candidates_per_minute": (len(in_cov) / (span / 60.0)) if span > 0 else 0.0,
        },
        "corroboration": score_corroboration(candidates, events, pre, post, cfg),
        "rule_cfg": dict(DEFAULT_RULE_CFG, **(cfg or {})),
    }


def run(manifest_path: str, candidates_path: str, match_pre=None, match_post=None,
        cfg=None, labelled_window_s=None, rule: str | None = None) -> dict:
    """Verify -> load -> score -> re-verify. Any hash mismatch raises and voids the run."""
    sha_before = verify_manifest(manifest_path)
    manifest = load_manifest(manifest_path)
    export = load_export(candidates_path)
    pre, post = resolve_match_windows(match_pre, match_post, manifest)
    if rule:
        if rule not in CORROBORATION_RULES and rule != "any":
            raise OracleError(f"unknown --rule {rule!r}")
        export = dict(export)
        export["candidates"] = [
            c for c in export["candidates"]
            if (any(rule_agrees(r, c, cfg) for r in CORROBORATION_RULES) if rule == "any"
                else rule_agrees(rule, c, cfg))
        ]
    result = score(manifest, export, pre, post, cfg, labelled_window_s)
    result["manifest_path"] = manifest_path
    result["sha_before"] = sha_before
    result["rule_applied"] = rule
    sha_after = verify_manifest(manifest_path)
    result["sha_after"] = sha_after
    return result


# --- rendering -----------------------------------------------------------------------------

def _fmt_cell(value):
    return "—" if value is None else str(value)


def render(result: dict) -> str:
    """The markdown table block: class table (audio columns), non-event windows, per-rule lift."""
    lines = []
    lines.append(f"manifest: `{result['manifest_path']}`")
    lines.append(f"manifest sha256 (pinned `{MANIFEST_SHA256}`): "
                 f"before `{result['sha_before']}`")
    lines.append(f"match window: -{result['matchPre']:g} s / +{result['matchPost']:g} s · "
                 f"labelled window {result['labelled_window_s']:g} s "
                 f"({result['labelled_window'][0]:g}-{result['labelled_window'][1]:g} s)")
    if result.get("rule_applied"):
        lines.append(f"corroboration rule applied before scoring: `{result['rule_applied']}`")
    lines.append("")
    lines.append(TABLE_HEADER)
    lines.append(TABLE_SEP)
    for row in result["classes"]:
        lines.append(
            f"| {row['id']} | `{row['clip']}` | {_fmt_cell(row['sr'])} | {row['events']} | "
            f"{row['candidates']} | {row['recall']:.2f} ({row['recalled']}/{row['events']}) | "
            f"{row['fp']} | {row['fp_rate']:.2f} | {row['p50']:.2f} s | {row['p95']:.2f} s |")
    neg = result["negatives"]
    lines.append(
        f"| _non_event windows_ | {neg['windows']} windows | "
        f"{_fmt_cell(result['classes'][0]['sr'] if result['classes'] else None)} | — | "
        f"{neg['candidates']} fires | — | {neg['fp_windows']} | "
        f"{neg['fp_window_rate']:.2f} | — | — |")
    o = result["overall"]
    lines.append("")
    lines.append(
        f"overall: candidates={o['candidates']} in-window={o['candidates_in_window']} "
        f"outside={o['outside_labelled_window']} events={o['events']} "
        f"recalled={o['recalled']} recall={o['recall']:.2f} "
        f"fp={o['fp']} fp_rate={o['fp_rate']:.2f} "
        f"candidates/min={o['candidates_per_minute']:.2f} "
        f"silent_windows={neg['silent_windows']}/{neg['windows']}")
    lines.append("")
    lines.append(NON_EVENT_HEADER)
    lines.append(NON_EVENT_SEP)
    for w in neg["per_window"]:
        lines.append(f"| {w['id']} | {w['t_start']:g} | {w['t_end']:g} | "
                     f"{len(w['fires'])} | {w['seconds']:g} |")
    lines.append("")
    lines.append("precision lift per corroboration rule (each rule is a channel the candidate "
                 "did not fire on):")
    lines.append("")
    lines.append(CORROBORATION_HEADER)
    lines.append(CORROBORATION_SEP)
    for r in result["corroboration"]:
        lines.append(
            f"| {r['rule']} | {r['candidates_kept']} | {r['kept_tp']} | "
            f"{r['kept_precision']:.2f} | {r['base_precision']:.2f} | "
            f"{r['precision_lift']:+.2f} | "
            f"{r['recall_kept']:.2f} ({r['events_kept']}/{o['events']}) | "
            f"{r['recall_delta']:+.2f} |")
    lines.append("")
    lines.append(f"manifest sha256 after scoring: `{result['sha_after']}` "
                 f"— unchanged, run valid" if result["sha_after"] == result["sha_before"]
                 else f"manifest sha256 after scoring: `{result['sha_after']}` — CHANGED")
    return "\n".join(lines)


# --- CLI -----------------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Score a HUD candidate export against the frozen SuperTuxKart labels.")
    ap.add_argument("--candidates", required=True,
                    help="candidate-export JSON from the HUD reader")
    ap.add_argument("--manifest", default=default_manifest_path(),
                    help="label manifest (default: the frozen committed one)")
    ap.add_argument("--match-pre", type=float, default=None,
                    help="pre-window seconds (flag > manifest > 3.0, as measure_audio_recall)")
    ap.add_argument("--match-post", type=float, default=None,
                    help="post-window seconds (flag > manifest > 2.0)")
    ap.add_argument("--rule", choices=("motion", "audio", "second-band", "any"), default=None,
                    help="filter candidates through this corroboration rule before scoring")
    ap.add_argument("--motion-min", type=float, default=DEFAULT_RULE_CFG["motion_min"])
    ap.add_argument("--audio-min", type=float, default=DEFAULT_RULE_CFG["audio_min"])
    ap.add_argument("--band-window", type=float, default=DEFAULT_RULE_CFG["band_window_s"],
                    help="seconds within which a second HUD band counts as agreeing")
    ap.add_argument("--labelled-window-s", type=float, default=None,
                    help="override the candidate/minute denominator (default: the manifest's "
                         "labelled span)")
    ap.add_argument("--json", default=None, help="write the machine-readable result here")
    args = ap.parse_args(argv)

    cfg = {"motion_min": args.motion_min, "audio_min": args.audio_min,
           "band_window_s": args.band_window}
    try:
        result = run(args.manifest, args.candidates, args.match_pre, args.match_post, cfg,
                     args.labelled_window_s, args.rule)
    except ManifestVoided as exc:
        print(f"VOIDED: {exc}", file=sys.stderr)
        print("VOIDED: no numbers produced — the labels are not the frozen artifact.",
              file=sys.stderr)
        return 3
    except CandidateSchemaError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 2
    print(render(result))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
            fh.write("\n")
        print(f"\njson: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
