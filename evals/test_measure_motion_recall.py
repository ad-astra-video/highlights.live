"""Accounting tests for the motion-trigger measurement harness (ADAAAA-7788).

These are HARNESS ACCOUNTING tests on synthetic detections. They are not a
football number, they are not a fixture-backend result, and nothing here may be
reported as the type's measured motion operating point (the issue's AC7).

What they pin, end to end through the CLI:

  - a static scene produces no fires, so recall 0 / candidate FP rate 0 and all
    non-event windows clean,
  - a >= MOTION_MIN_STEP single-step displacement at each verified onset
    produces recall 1.0 with no false candidates,
  - the roster cap is never exceeded on a 22-object frame, and the detections the
    cap cannot keep are counted rather than silently dropped,
  - a slice missing a manifest window is refused instead of scored as a partial
    measurement.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "measure_motion_recall.py")
PROFILE = "american football"


def _manifest(windows, clip_s=60.0):
    return {
        "sport": "american football",
        "video": {"path": "synthetic.mp4", "duration_s": clip_s, "sha256": None},
        "windows": windows,
    }


def _frames(t_start, t_end, boxes_at):
    """One frame per second; `boxes_at(t)` returns the frame's object list."""
    frames = []
    t = t_start
    while t < t_end:
        frames.append({
            "t": float(t),
            "objects": [
                {"label": "player", "bbox": list(b), "score": 0.9}
                for b in boxes_at(t)
            ],
        })
        t += 1
    return frames


def _slice(windows):
    return {
        "fps": 1.0,
        "frames": sum(len(w["frames"]) for w in windows),
        "clip": {"name": "synthetic.mp4", "sha256": None},
        "latency": {"meanMsPerFrame": 1.0},
        "windows": windows,
    }


def _write(tmp_path, manifest, slice_doc):
    mpath = tmp_path / "manifest.json"
    spath = tmp_path / "slice.json"
    out = tmp_path / "out.json"
    mpath.write_text(json.dumps(manifest))
    spath.write_text(json.dumps(slice_doc))
    return str(mpath), str(spath), str(out)


def _run(mpath, spath, out, *extra):
    cmd = [sys.executable, SCRIPT, "--slice", spath, "--labels", mpath,
           "--profile", PROFILE, "--json", out, *extra]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    return proc, (json.loads(open(out).read()) if os.path.exists(out) else None)


def _windows(static=True):
    boxes = [(0.10, 0.20, 0.20, 0.40)]

    def still(_t):
        return boxes

    def jump_at(onset):
        # The object stays put, then moves a full box-width in one step.
        def _b(t):
            return [(0.10 + (0.30 if t >= onset else 0.0), 0.20, 0.20, 0.40)]
        return _b

    e01 = {"id": "E01", "kind": "scoring", "instant_s": 12, "t_start": 10, "t_end": 16}
    e02 = {"id": "E02", "kind": "scoring", "instant_s": 22, "t_start": 20, "t_end": 26}
    n01 = {"id": "N01", "kind": "non_event", "t_start": 30, "t_end": 36}
    frames = {
        "E01": dict(e01, frames=_frames(10, 16, still if static else jump_at(12))),
        "E02": dict(e02, frames=_frames(20, 26, still if static else jump_at(22))),
        "N01": dict(n01, frames=_frames(30, 36, still)),
    }
    manifest = _manifest([e01, e02, n01])
    slice_doc = _slice([frames["E01"], frames["E02"], frames["N01"]])
    return manifest, slice_doc


def test_static_scene_has_no_fires(tmp_path):
    manifest, slice_doc = _windows(static=True)
    mpath, spath, out = _write(tmp_path, manifest, slice_doc)
    proc, doc = _run(mpath, spath, out)
    assert proc.returncode == 0, proc.stderr
    assert doc["main"]["candidates"] == 0
    assert doc["main"]["recall"] == 0.0
    assert doc["main"]["fp_rate"] == 0.0
    assert doc["negatives"]["fp_windows"] == 0


def test_motion_step_at_each_onset_recalls_both(tmp_path):
    manifest, slice_doc = _windows(static=False)
    mpath, spath, out = _write(tmp_path, manifest, slice_doc)
    proc, doc = _run(mpath, spath, out)
    assert proc.returncode == 0, proc.stderr
    assert doc["main"]["events"] == 2
    assert doc["main"]["recalled"] == 2
    assert doc["main"]["recall"] == 1.0
    # `motion_fire` reads the MAX step over the track's recent history, so the
    # rule keeps firing after one genuine step until that step ages out. The
    # harness must report that as the deployed rule does, not debounce it away:
    # per-frame candidates exceed the two real steps, and the sticky tail frames
    # fall outside the -3/+2 s match window (one per window here).
    assert doc["main"]["candidates"] > 2
    assert doc["main"]["fp"] == 2
    # Collapsing each contiguous firing run to one episode recovers exactly the
    # two real motion events, with no false candidate.
    assert doc["episodes"]["candidates"] == 2
    assert doc["episodes"]["recall"] == 1.0
    assert doc["episodes"]["fp"] == 0
    assert doc["episodes"]["p50"] == 0.0


def test_cap_counts_unkept_detections_on_a_crowded_frame(tmp_path):
    manifest = _manifest([{"id": "N01", "kind": "non_event", "t_start": 30, "t_end": 34}])
    crowded = [(0.02 * i, 0.20, 0.02 * i + 0.015, 0.40) for i in range(22)]
    window = dict(manifest["windows"][0], frames=_frames(30, 34, lambda _t: crowded))
    proc, doc = _run(*_write(tmp_path, manifest, _slice([window])))
    assert proc.returncode == 0, proc.stderr
    assert doc["capacity"] == 8
    assert doc["roster"]["maxConcurrent"] == 8
    assert doc["roster"]["maxConcurrent"] <= doc["capacity"]
    assert doc["roster"]["objectsPerFrameMax"] == 22
    assert doc["roster"]["unkeptDetections"] > 0


def test_live_mode_uses_the_3_object_cap(tmp_path):
    manifest = _manifest([{"id": "N01", "kind": "non_event", "t_start": 30, "t_end": 34}])
    crowded = [(0.02 * i, 0.20, 0.02 * i + 0.015, 0.40) for i in range(22)]
    window = dict(manifest["windows"][0], frames=_frames(30, 34, lambda _t: crowded))
    mpath, spath, out = _write(tmp_path, manifest, _slice([window]))
    proc, doc = _run(mpath, spath, out, "--mode", "live")
    assert proc.returncode == 0, proc.stderr
    assert doc["capacity"] == 3
    assert doc["roster"]["maxConcurrent"] == 3


def test_incomplete_slice_is_refused(tmp_path):
    manifest, slice_doc = _windows(static=False)
    slice_doc["windows"] = [slice_doc["windows"][0]]  # E02 and N01 never detected
    mpath, spath, out = _write(tmp_path, manifest, slice_doc)
    proc, _doc = _run(mpath, spath, out)
    assert proc.returncode != 0
    assert "missing manifest windows" in proc.stderr
    assert not os.path.exists(out)
