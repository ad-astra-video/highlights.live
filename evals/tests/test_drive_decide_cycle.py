"""Tests for `evals/drive_decide_cycle.py` against the POST-ADAAAA-7108
perceive contract (no candidates) — ADAAAA-8122.

The regression these tests lock down: the old harness gated every decide on
`resp["candidate"]`, and since ADAAAA-7108 removed every candidate trigger,
`/analyze` never returns one. The harness therefore emitted ZERO events on the
deployed build at any fps, which read as a model/quality result. A stub perceive
that answers exactly like the deployed build (observation at the top level, no
`candidate` key) must still produce a scored trace.

Pure stdlib + ffmpeg (both on the box and in CI); no GPU, no network.
"""
import json
import os
import subprocess
import sys
import threading
import http.server

import pytest

EVALS = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, EVALS)
import drive_decide_cycle as drive  # noqa: E402


# ------------------------------------------------------------------ units ----
def _windows_manifest(tmp_path):
    m = {
        "video": {"id": "kids-soccer", "path": "/data/clips/kids300.mp4"},
        "windows": [
            {"id": "ks-g-0100", "t_start": 95, "t_end": 105, "instant": 100,
             "ground_truth": "goal", "evidence": "ball_in_net"},
            {"id": "ks-n-0110", "t_start": 106, "t_end": 116,
             "ground_truth": "none", "evidence": "none"},
        ],
    }
    p = tmp_path / "label-manifest.json"
    p.write_text(json.dumps(m))
    return str(p)


def test_windows_manifest_becomes_units(tmp_path):
    units = drive.load_units(_windows_manifest(tmp_path))
    assert [u["id"] for u in units] == ["ks-g-0100", "ks-n-0110"]
    goal, neg = units
    assert goal["groundTruth"]["isHighlight"] is True
    assert goal["groundTruth"]["instant"] == 100.0
    assert goal["start"] == 95.0 and goal["end"] == 105.0
    assert neg["groundTruth"]["isHighlight"] is False
    assert "instant" not in neg["groundTruth"]


def test_clips_manifest_still_loads(tmp_path):
    m = {"sport": "soccer", "acceptance": {"recallVodPct": 90}, "clips": [
        {"id": "soc-goal-01", "mode": "vod", "source": "host:x:/a.mp4",
         "startS": 0.0, "endS": 8.0,
         "groundTruth": {"isHighlight": True, "eventType": "GOAL"}},
    ]}
    p = tmp_path / "clips.json"
    p.write_text(json.dumps(m))
    units = drive.load_units(str(p))
    assert len(units) == 1 and units[0]["mode"] == "vod"
    assert drive.load_units(str(p), mode="live") == []


# ------------------------------------------------------------- sampling ------
def test_cadence_centers_are_label_blind_and_bounded():
    centers = drive.cadence_centers(95.0, 105.0, 5.0)
    assert centers == [95.0, 100.0, 105.0]
    # a window shorter than one cadence still yields one decide at its start
    assert drive.cadence_centers(10.0, 12.0, 5.0) == [10.0]


def test_subsample_even_keeps_oldest_and_newest_under_the_cap():
    items = list(range(12))
    out = drive.subsample_even(items, 4)
    assert len(out) == 4
    assert out[0] == 0 and out[-1] == 11
    # deterministic + no duplicates
    assert out == drive.subsample_even(items, 4)
    assert len(set(out)) == len(out)
    assert drive.subsample_even(items, 0) == items          # no budget = all
    assert drive.subsample_even(items, 99) == items         # under cap = all


def test_window_frames_are_span_limited():
    frames = [{"ts": t, "b64": "x"} for t in (0.0, 1.0, 2.0, 3.0, 4.0)]
    got = drive.window_frames(frames, 2.0, 2.0)
    assert [f["ts"] for f in got] == [1.0, 2.0, 3.0]


# -------------------------------------------------------- observation --------
def test_post_7108_wire_shape_is_read_as_an_observation():
    """The deployed /analyze body IS the observation (no `candidate` key)."""
    body = {"type": "observation", "sessionId": "s", "seq": 3, "timestamp": 100.0,
            "tracks": [{"trackId": "t1", "label": "player", "bbox": [0.1, 0.1, 0.2, 0.2]}],
            "objects": [{"label": "player", "confidence": 0.9, "bbox": [0.1, 0.1, 0.2, 0.2]}],
            "ocr": ["2-1"],
            "evidence": {"ballVelocity": {"speedMps": 6.5},
                         "ballPossession": {"possessingPlayerId": "t1"}}}
    sig = drive.observation_signal(body)
    assert len(sig["tracks"]) == 1 and len(sig["objects"]) == 1
    assert sig["ballVelocity"] == 6.5 and sig["ballPossession"] == "t1"
    assert sig["ocr"] == ["2-1"]
    assert sig["scoreBoardChanged"] is None
    # and the top-level scoreboard corroboration is picked up when it fires
    sig2 = drive.observation_signal({**body, "scoreBoardChanged": True,
                                     "scoreboardDelta": {"home": "2", "away": "1"}})
    assert sig2["scoreBoardChanged"] is True
    assert sig2["scoreboardDelta"] == {"home": "2", "away": "1"}


# ---------------------------------------------------------------- audio ------
def test_crowd_energy_reads_a_burst_from_the_rms_series():
    # quiet baseline 0.02, loud reaction 0.30 at the decide centre
    series = [0.02] * 20 + [0.30] * 10 + [0.02] * 20
    ce, kind, levels = drive.crowd_energy(series, 20.0)
    assert ce > 0.5 and kind == "burst"
    assert levels and all(0.0 <= v <= 1.0 for v in levels)
    # flat audio = no reaction at all (absent evidence stays absent)
    ce_flat, kind_flat, _ = drive.crowd_energy([0.02] * 40, 20.0)
    assert ce_flat == 0.0 and kind_flat == ""
    # no audio track -> no series -> no reaction
    assert drive.crowd_energy([], 10.0) == (0.0, "", [])


def test_fold_window_evidence_caps_and_folds():
    sigs = [
        {"tracks": [{"trackId": str(i), "bbox": [0, 0, 1, 1]} for i in range(5)],
         "objects": [], "ocr": ["1-0", "12:00"], "ballVelocity": 2.0,
         "ballPossession": "a", "goalCrossed": None, "ballOutcome": None,
         "scoreBoardChanged": None, "scoreboardDelta": None},
        {"tracks": [{"trackId": str(i), "bbox": [0, 0, 1, 1]} for i in range(20)],
         "objects": [], "ocr": [], "ballVelocity": 7.5, "ballPossession": "",
         "goalCrossed": True, "ballOutcome": "goal", "scoreBoardChanged": True,
         "scoreboardDelta": {"home": "2", "away": "1"}},
    ]
    ev = drive.fold_window_evidence(sigs, {"crowdEnergy": 0.4}, [0.1, 0.2])
    assert ev["trackCount"] == drive.DECIDE_MAX_TRACK_COUNT      # decide contract cap
    assert len(ev["detections"]) == drive.DECIDE_MAX_DETECTIONS  # decide contract cap
    assert ev["ocrHits"] == 2
    assert ev["maxVelocity"] == 7.5
    assert ev["goalCrossed"] is True and ev["ballOutcome"] == "goal"
    assert ev["scoreBoardChanged"] is True
    assert ev["scoreBoardDelta"] == {"home": "2", "away": "1"}
    assert ev["reaction"] == {"crowdEnergy": 0.4}
    assert ev["audioLevels"] == [0.1, 0.2]


# ----------------------------------------------------- end-to-end stub -------
class _Stub(http.server.BaseHTTPRequestHandler):
    """Deployed-shape perceive (/analyze -> observation, never a candidate) and
    a decide that accepts exactly the frames whose scoreboard changed."""

    analyze_calls = 0
    decide_calls = 0

    def log_message(self, *a):  # keep pytest output clean
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        req = json.loads(self.rfile.read(n).decode() or "{}")
        if self.path.endswith("/analyze"):
            type(self).analyze_calls += 1
            # ADAAAA-7108 shape: the observation IS the body. No `candidate`.
            self._send({"type": "observation", "sessionId": "s",
                        "seq": req.get("seq", 0), "timestamp": req.get("timestamp", 0.0),
                        "tracks": [{"trackId": "t1", "label": "player",
                                    "bbox": [0.4, 0.4, 0.5, 0.5]}],
                        "objects": [], "ocr": ["2-1"],
                        "evidence": {"ballVelocity": {"speedMps": 1.0}}})
            return
        if self.path.endswith("/highlight"):
            type(self).decide_calls += 1
            ev = req.get("evidence") or {}
            accept = bool(ev.get("ocrHits"))
            self._send({"isHighlight": accept, "score": 90.0 if accept else 10.0,
                        "eventType": req.get("eventType"),
                        "outcome": "scoring_play" if accept else "not_highlight",
                        "reason": "stub"})
            return
        self.send_error(404)


@pytest.fixture
def stub_url():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Stub)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _tiny_clip(tmp_path):
    clip = str(tmp_path / "clip.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi",
                    "-i", "testsrc=size=160x120:rate=10:duration=3",
                    "-pix_fmt", "yuv420p", "-y", clip], check=True)
    return clip


def test_drive_emits_decisions_on_the_post_7108_contract(tmp_path, stub_url):
    """The whole seam: a candidate-less perceive must still yield a scored trace."""
    clip = _tiny_clip(tmp_path)
    manifest = {"video": {"path": "clip.mp4"}, "windows": [
        {"id": "w-goal", "t_start": 0.0, "t_end": 3.0, "instant": 1.0,
         "ground_truth": "goal"},
    ]}
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    out = tmp_path / "trace.json"
    r = subprocess.run([sys.executable, os.path.join(EVALS, "drive_decide_cycle.py"),
                        "--manifest", str(mpath), "--perceive", stub_url,
                        "--decide", stub_url, "--clip-root", str(tmp_path),
                        "--fps", "1", "--cadence", "1", "--window", "2",
                        "--max-frames", "2", "--out", str(out)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    trace = json.loads(out.read_text())
    decs = [e for e in trace["events"] if e["type"] == "decision"]
    # 0.0 / 1.0 / 2.0 / 3.0 cadence centres over a 3 s unit
    assert len(decs) >= 3, trace["events"]
    assert trace["stageA"]["decides"] == len(decs)
    assert trace["stageA"]["mode"] == "observe-cadence"
    # the decide payload the drive built carried the observation evidence
    assert decs[0]["evidenceSummary"]["ocrHits"] >= 1
    assert decs[0]["framesJudged"] >= 1
    # provenance block makes the trace self-describing
    assert trace["drive"]["manifestSha256"] and trace["drive"]["issue"] == "ADAAAA-8122"
    assert trace["events"][0]["type"] == "observation"


def test_zero_event_run_exits_non_zero_and_names_the_seam(tmp_path, stub_url):
    """Guardrail: a run that decides nothing must not look like a scored trace."""
    clip = _tiny_clip(tmp_path)
    manifest = {"video": {"path": "clip.mp4"}, "windows": [
        # zero-length span -> no frames -> no decide
        {"id": "empty", "t_start": 1.0, "t_end": 1.0, "instant": 1.0,
         "ground_truth": "goal"},
    ]}
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    out = tmp_path / "trace.json"
    r = subprocess.run([sys.executable, os.path.join(EVALS, "drive_decide_cycle.py"),
                        "--manifest", str(mpath), "--perceive", stub_url,
                        "--decide", stub_url, "--clip-root", str(tmp_path),
                        "--fps", "1", "--cadence", "1", "--window", "2",
                        "--out", str(out)],
                       capture_output=True, text=True)
    assert r.returncode == 3, (r.returncode, r.stdout, r.stderr)
    trace = json.loads(out.read_text())
    assert trace["stageA"]["decides"] == 0
    assert "0 decide calls produced" in trace["drive"]["error"]


def test_missing_clip_is_named_and_still_not_reported_as_scored(tmp_path, stub_url):
    manifest = {"clips": [{"id": "gone", "mode": "live", "source": "host:x:/nope.mp4",
                           "startS": 0.0, "endS": 2.0,
                           "groundTruth": {"isHighlight": True, "eventType": "GOAL"}}]}
    mpath = tmp_path / "m.json"
    mpath.write_text(json.dumps(manifest))
    out = tmp_path / "trace.json"
    r = subprocess.run([sys.executable, os.path.join(EVALS, "drive_decide_cycle.py"),
                        "--manifest", str(mpath), "--perceive", stub_url,
                        "--decide", stub_url, "--out", str(out)],
                       capture_output=True, text=True)
    assert r.returncode == 3, (r.returncode, r.stdout, r.stderr)
    assert "MISSING" in r.stdout
    trace = json.loads(out.read_text())
    assert trace["events"] == []
    assert trace["stageA"]["totalCandidates"] == 0
    assert trace["drive"].get("error")
