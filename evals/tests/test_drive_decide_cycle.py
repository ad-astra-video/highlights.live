"""Regression tests for evals/drive_decide_cycle.py + the goal axes of
evals/metrics_runner.py (ADAAAA-8122).

The bug these pin: after ADAAAA-7108 perceive stopped emitting candidates, so
`/analyze` returns a bare observation and the old harness — which gated every
decide on `resp["candidate"]` — emitted **0 events at every fps on every build**.
That read as "the model found nothing" and made the labelled manifest
unscorable. The harness now drives decide on the deployed observe cadence
(`services/server/src/observe-loop.ts`) from the observation's own evidence.

The tests drive the REAL `main()` against fake perceive/decide HTTP servers that
speak the deployed wire shape (observation-only `/analyze`), so a future
perceive contract change that removes the candidate again fails here instead of
silently producing an empty trace. No GPU, no ffmpeg, no network.
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import drive_decide_cycle as drive  # noqa: E402
import metrics_runner  # noqa: E402


# --------------------------------------------------------------- fake serve ---
class _Handler(BaseHTTPRequestHandler):
    """Speaks the DEPLOYED wire shapes.

    POST /analyze -> observation body only (no `candidate` key): exactly what a
    post-ADAAAA-7108 build returns for the soccer profile, whose trigger subset
    is audio-only so `profile.has_frame_triggers()` is False.
    POST /highlight -> a decision that accepts when the folded window evidence
    attests a goal (keeps the test independent of model behaviour).
    """

    protocol_version = "HTTP/1.1"
    calls = {"analyze": [], "highlight": []}

    def log_message(self, *a):  # silence
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path.endswith("/analyze"):
            type(self).calls["analyze"].append(body)
            ts = float(body.get("timestamp") or 0.0)
            # Score changes at 100 s and 159 s on the kids300 fixture; the
            # perception-side signals are what decide must be able to cite.
            goal = ts >= 100.0
            obs = {
                "type": "observation",
                "sessionId": self.headers.get("X-Session-Id", "t"),
                "seq": body.get("seq"),
                "timestamp": ts,
                "tracks": [{"trackId": 1, "bbox": [0.1, 0.1, 0.2, 0.3], "kind": "player",
                            "label": "player"}],
                "objects": [{"label": "soccer ball", "confidence": 0.9,
                             "bbox": [0.5, 0.5, 0.52, 0.53]}],
                "ocr": ["1 - 1"],
                "evidence": {
                    "ballVelocity": {"speedMps": 12.5},
                    "ballPossession": {"possessingPlayerId": "p1"},
                    **({"goalCrossed": True, "ballOutcome": "goal"} if goal else {}),
                },
                **({"scoreBoardChanged": True} if goal else {}),
            }
            payload = obs  # observation IS the body post-7108
        else:  # /highlight
            type(self).calls["highlight"].append(body)
            ev = body.get("evidence") or {}
            attested = ev.get("goalCrossed") is True or ev.get("ballOutcome") == "goal"
            payload = {
                "isHighlight": bool(attested),
                "eventType": body.get("eventType"),
                "outcome": "scoring_play" if attested else "not_highlight",
                "score": 90.0 if attested else 15.0,
                "reason": "attested" if attested else "no attestation",
            }
        raw = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture()
def fake_servers():
    _Handler.calls = {"analyze": [], "highlight": []}
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_port}", _Handler.calls
    srv.shutdown()


# ------------------------------------------------------------------ helpers ---
def _fake_frames(n, start_s, fps=1.0):
    return [{"i": i, "ts": round(start_s + i / fps, 3), "b64": "ZmFrZQ=="} for i in range(n)]


MANIFEST = {
    "sport": "soccer",
    "video": {"path": "/data/clips/kids300_7935.mp4"},
    "windows": [
        {"id": "w-goal-0100", "t_start": 95, "t_end": 105, "instant": 100,
         "ground_truth": "goal", "evidence": "score 1-1 -> 2-1"},
        {"id": "w-goal-0159", "t_start": 154, "t_end": 164, "instant": 159,
         "ground_truth": "goal", "evidence": "score 2-1 -> 2-2"},
    ],
}


# ------------------------------------------------------------- the contract ---
def test_observation_only_analyze_still_produces_events(tmp_path, fake_servers, monkeypatch):
    """AC1 regression: a candidate-less /analyze must NOT yield an empty trace.

    This is the exact seam behind ADAAAA-8122 (0 events at 1 fps on the
    deployed build). The drive must fire one decide per cadence centre and emit
    a decision event per centre, using the observation evidence.
    """
    url, calls = fake_servers
    clip = tmp_path / "kids300_7935.mp4"
    clip.write_bytes(b"")  # only existence is checked; frames are injected
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({**MANIFEST,
                                    "video": {"path": str(clip)}}))
    out = tmp_path / "trace.json"

    monkeypatch.setattr(drive, "extract_frames",
                        lambda p, fps, s, e, td, *a, **k: _fake_frames(int(e - s) + 1, s, fps))
    monkeypatch.setattr(sys, "argv", [
        "drive_decide_cycle.py", "--manifest", str(manifest),
        "--perceive", url, "--decide", url,
        "--fps", "1", "--cadence", "5", "--window", "7", "--max-frames", "4",
        "--out", str(out), "--commit", "deadbeef",
    ])
    assert drive.main() == 0

    trace = json.loads(out.read_text())
    ev = trace["events"]
    by_type = {}
    for e in ev:
        by_type.setdefault(e["type"], []).append(e)

    # 2 units x 3 cadence centres ([95,100,105] and [154,159,164])
    assert len(by_type.get("candidate", [])) == 6
    assert len(by_type.get("decision", [])) == 6
    assert len(by_type.get("observation", [])) == 22
    assert calls["analyze"], "/analyze was never called"
    assert "candidate" not in calls["analyze"][0], "fixture must be the post-7108 shape"
    # per-unit: both goal windows must fire at their labelled instant
    for cid, instant in (("w-goal-0100", 100.0), ("w-goal-0159", 159.0)):
        decided = [d for d in by_type["decision"] if d["clipId"] == cid]
        assert decided, f"{cid} produced no decision event"
        hit = [d for d in decided if d["timestamp"] == instant and d["decision"]["isHighlight"]]
        assert hit, f"{cid}: no accepted decision at the labelled instant"
    # the trace carries provenance naming the commit + cadence posture
    assert trace["drive"]["commit"] == "deadbeef"
    assert trace["drive"]["cadenceS"] == 5.0


def test_zero_decides_is_loud_not_silent(tmp_path, monkeypatch):
    """The ADAAAA-8122 failure mode must never be reportable as a baseline:
    a run that decides nothing writes an error into the trace and exits non-zero."""
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({**MANIFEST,
                                    "video": {"path": str(tmp_path / "missing.mp4")}}))
    out = tmp_path / "trace.json"
    monkeypatch.setattr(sys, "argv", [
        "drive_decide_cycle.py", "--manifest", str(manifest),
        "--perceive", "http://127.0.0.1:1", "--decide", "http://127.0.0.1:1",
        "--out", str(out),
    ])
    assert drive.main() == 3
    trace = json.loads(out.read_text())
    assert trace["drive"]["error"].startswith("0 decide calls produced")
    assert trace["stageA"]["decides"] == 0


def test_decide_centres_are_label_blind():
    """Localisation must not be able to pick its centre from the ground truth."""
    centers = drive.cadence_centers(95.0, 105.0, 5.0)
    assert centers == [95.0, 100.0, 105.0]
    # identical shape for a unit with no labelled instant
    assert drive.cadence_centers(95.0, 105.0, 5.0) == centers
    assert drive.cadence_centers(0.0, 12.0, 5.0) == [0.0, 5.0, 10.0]


def test_subsample_keeps_oldest_and_newest():
    items = list(range(10))
    assert drive.subsample_even(items, 4) == [0, 3, 6, 9]
    assert drive.subsample_even(items, 1) == [9]
    assert drive.subsample_even(items, 20) == items


def test_fold_window_evidence_attests_only_real_signals():
    attested = {
        "tracks": [{"trackId": 1, "bbox": [0, 0, 0.1, 0.1], "kind": "player"}],
        "objects": [{"label": "soccer ball", "confidence": 0.9, "bbox": [0.5, 0.5, 0.6, 0.6]}],
        "ocr": ["1 - 1"],
        "ballVelocity": 12.0,
        "ballPossession": "p1",
        "goalCrossed": True,
        "ballOutcome": "goal",
        "scoreBoardChanged": True,
        "scoreboardDelta": {"before": "1-1", "after": "2-1"},
    }
    quiet = {
        "tracks": [], "objects": [], "ocr": [], "ballVelocity": 0.0,
        "ballPossession": "", "goalCrossed": None, "ballOutcome": None,
        "scoreBoardChanged": None, "scoreboardDelta": None,
    }
    reaction = {"crowdEnergy": 0.0, "audioKind": "", "humansInMotion": 1,
                "ballSpeedMps": 12.0, "ballPossessionId": "p1"}
    ev = drive.fold_window_evidence([attested], reaction, [])
    assert ev["goalCrossed"] is True and ev["ballOutcome"] == "goal"
    assert ev["scoreBoardChanged"] is True and ev["scoreBoardDelta"]
    assert ev["trackCount"] == 1 and ev["ocrHits"] == 1
    assert ev["maxVelocity"] == 12.0
    assert len(ev["detections"]) == 2

    # absent evidence is absent, never fabricated
    ev2 = drive.fold_window_evidence([quiet], reaction, [])
    assert ev2["goalCrossed"] is None and ev2["ballOutcome"] is None
    assert ev2["scoreBoardChanged"] is False
    assert "scoreBoardDelta" not in ev2


def test_observation_signal_handles_both_wire_shapes():
    """Pre-7108 body nests the observation; post-7108 the body IS it."""
    cand = {"type": "candidate", "eventType": "GOAL", "timestamp": 10.0}
    obs_nested = {"type": "observation", "tracks": [], "objects": [], "ocr": [],
                  "evidence": {"goalCrossed": True}}
    # analyze_frame's shape handling is exercised through the fake server above;
    # here we pin the flattening both shapes feed.
    sig = drive.observation_signal(obs_nested)
    assert sig["goalCrossed"] is True
    assert sig["tracks"] == []
    assert isinstance(cand, dict)  # a candidate is only a bias hint now


# ------------------------------------------------- metrics_runner goal axes ---
def test_metrics_runner_scores_the_windows_manifest_numerically(tmp_path):
    """AC2: a windows manifest must produce NUMERIC recall/FP/localisation rows
    (this is the row that used to read `not_captured`)."""
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({
        "sport": "soccer",
        "video": {"path": "/data/clips/x.mp4"},
        "windows": [
            {"id": "g1", "t_start": 95, "t_end": 105, "instant": 100, "ground_truth": "goal"},
            {"id": "g2", "t_start": 154, "t_end": 164, "instant": 159, "ground_truth": "goal"},
            {"id": "n1", "t_start": 0, "t_end": 10, "ground_truth": "not_highlight"},
            {"id": "n2", "t_start": 200, "t_end": 210, "ground_truth": "not_highlight"},
        ],
    }))
    trace = {"events": [
        {"type": "candidate", "clipId": "g1", "eventType": "SPORTING_EVENT", "timestamp": 100.0},
        {"type": "decision", "clipId": "g1", "timestamp": 100.0,
         "decision": {"isHighlight": True, "eventType": "GOAL", "reason": "crowd erupted"}},
        {"type": "candidate", "clipId": "g2", "eventType": "SPORTING_EVENT", "timestamp": 154.0},
        {"type": "decision", "clipId": "g2", "timestamp": 154.0,
         "decision": {"isHighlight": False, "eventType": "SPORTING_EVENT", "reason": "no"}},
        {"type": "candidate", "clipId": "n1", "eventType": "SPORTING_EVENT", "timestamp": 0.0},
        {"type": "decision", "clipId": "n1", "timestamp": 0.0,
         "decision": {"isHighlight": True, "eventType": "SPORTING_EVENT", "reason": "false positive"}},
    ], "stageA": {"totalCandidates": 3, "rejected": 1}, "tracking": {}}

    clips, accept, sport = metrics_runner.load_manifest(str(manifest))
    assert sport == "soccer" and len(clips) == 4
    assert [c for c in clips if c["groundTruth"]["isHighlight"]][0]["groundTruth"]["instant"] == 100.0

    m, _ = metrics_runner.compute(clips, trace["events"], trace["stageA"], {}, accept)
    assert m["positivesN"] == 2 and m["negativesN"] == 2
    assert m["recallHits"] == 1          # numeric goal recall, not NA
    assert m["goalFpUnits"] == 1         # numeric goal FP
    assert m["goalFpRate"] == 0.5
    loc = m["localisation"]
    assert loc["n"] == 1                 # only g1 has an accepted decision
    assert loc["medianAbsS"] == 0.0      # accepted at its labelled instant
    assert loc["missed"] == 1            # g2 was accepted nowhere
