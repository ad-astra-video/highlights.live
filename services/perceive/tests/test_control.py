import base64
import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app import app
from app.tracker import IoUTracker

client = TestClient(app)


def _frame_jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def _uuid_sid() -> str:
    import uuid

    return f"sess-{uuid.uuid4().hex[:8]}"


def _create_session(sid: str) -> None:
    g = np.zeros((60, 80), dtype=np.float32)
    client.post("/app/analyze", json={"seq": 0, "timestamp": 0.0, "image": _frame_jpeg(g)}, headers={"X-Session-Id": sid})


# --- tracker unit: seed / evict / lock -------------------------------------


def test_tracker_seed_and_evict():
    tr = IoUTracker(lost_before_evict=2)
    t = tr.seed((0.1, 0.1, 0.3, 0.3), slot=0, ts=0.0)
    assert t.slot == 0
    assert len(tr.tracks) == 1
    # seed into the same slot replaces the occupant
    tr.seed((0.5, 0.5, 0.7, 0.7), slot=0, ts=1.0)
    assert len(tr.tracks) == 1
    assert tr.tracks[0].slot == 0
    assert tr.evict(0)
    assert len(tr.tracks) == 0


def test_tracker_lock_prevents_auto_evict():
    tr = IoUTracker(lost_before_evict=1)
    tr.seed((0.1, 0.1, 0.3, 0.3), slot=0, ts=0.0)
    tr.lock(0)
    # no boxes -> track goes lost; locked slot must survive
    tr.step([], ts=1.0)
    tr.step([], ts=2.0)
    assert len(tr.tracks) == 1, "locked slot must not be auto-evicted"
    # unlock semantics: evict still works explicitly
    assert tr.evict(0)


# --- websocket control ------------------------------------------------------


def test_ws_rejects_unknown_session():
    import pytest

    # Server closes (code 4001) before accepting -> surfaces as a
    # WebSocketDisconnect on connect/exit, not a normal message exchange.
    with pytest.raises(Exception):
        with client.websocket_connect("/app/ws?session_id=nope") as ws:
            ws.receive_text()


def test_analyze_delivers_game_hint_and_prefer_labels_to_session():
    """ADAAAA-4109: the /analyze body carries the job's closed vocabulary and
    perceive applies it to the session BEFORE the frame is run, so a paid VOD
    session activates resolve_vocabulary (vocabulary=True) without a WS round-trip."""
    import uuid

    from app import app as _app

    sid = f"sess-{uuid.uuid4().hex[:8]}"
    g = np.zeros((60, 80), dtype=np.float32)
    client.post(
        "/app/analyze",
        json={
            "seq": 0,
            "timestamp": 0.0,
            "image": _frame_jpeg(g),
            "gameHint": "soccer",
            "preferLabels": ["player", "soccer ball"],
        },
        headers={"X-Session-Id": sid},
    )
    state = _app.state.registry.get(sid)
    assert state is not None
    assert state.game_hint == "soccer"
    assert state.prefer_labels == ["player", "soccer ball"]


def test_ws_ping_and_configure_ack():
    sid = _uuid_sid()
    _create_session(sid)
    with client.websocket_connect(f"/app/ws?session_id={sid}") as ws:
        ws.send_text('{"type":"ping"}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["pong"] is True

        ws.send_text('{"type":"configure","preferLabels":["player"],"sampleFps":2,"gameHint":"valorant"}')
        ack = ws.receive_json()
        assert ack["ok"] is True
        assert ack["cmd"] == "configure"
        assert ack["preferLabels"] == ["player"]
        assert ack["sampleFps"] == 2.0


# --- ADAAAA-6463: configure accepts a TrackingPlan ----------------------------
def test_configure_accepts_tracking_plan():
    """`configure` with a `trackingPlan` key stores the normalized plan on the
    session, reserves the anchor's primary slot on the tracker, rebuilds the
    detection-in-zone trigger on the plan's zones, and acks the roster."""
    from app import handle_control
    from app.session import SessionState
    from app.tracker import IoUTracker

    state = SessionState(session_id="s-plan")
    state.tracker = IoUTracker(capacity=3)
    plan = {
        "category": "soccer",
        "anchor": {"label": "soccer ball", "role": "ball"},
        "targets": [
            {"label": "soccer ball", "role": "ball", "slotPriority": 0},
            {"label": "player", "role": "player", "slotPriority": 1},
        ],
        "zones": [{"name": "goal-mouth", "normalized": [0.7, 0.4, 1.0, 0.9], "purpose": "goal_detect"}],
        "maxTracks": 3,
    }
    ack = handle_control(state, {"type": "configure", "trackingPlan": plan})
    assert ack["ok"] is True and ack["cmd"] == "configure"
    assert state.tracking_plan is not None
    assert state.tracking_plan.vocabulary() == ["soccer ball", "player"]
    # Anchor-slot policy: the anchor label is applied to the tracker.
    assert state.tracker.anchor_label == "soccer ball"
    # Zone trigger rebuilt on the plan zones.
    assert state.zone_trigger is not None
    assert list(state.zone_trigger.zones) == [(0.7, 0.4, 1.0, 0.9)]
    assert ack["trackingPlan"]["anchor"]["label"] == "soccer ball"
    assert ack["trackingPlan"]["roster"] == ["soccer ball", "player"]


def test_configure_bad_tracking_plan_degrades_not_crashes():
    """A malformed plan never crashes the configure path; the session keeps a
    normalized (possibly empty-roster) plan and the per-frame path falls back."""
    from app import handle_control
    from app.session import SessionState
    from app.tracker import IoUTracker

    state = SessionState(session_id="s-plan-bad")
    state.tracker = IoUTracker(capacity=3)
    # All targets untrackable -> normalize drops them -> empty roster plan.
    ack = handle_control(state, {"type": "configure", "trackingPlan": {
        "anchor": {"label": "mood", "role": "zone"},
        "targets": [{"label": "scoreboard", "role": "entity"}],
    }})
    assert ack["ok"] is True
    assert state.tracking_plan is not None
    assert state.tracking_plan.vocabulary() == []


def test_analyze_carries_tracking_plan_to_session():
    """The /analyze front door carries a `trackingPlan`; perceive applies it to the
    session (closed roster + anchor) BEFORE the frame runs (ADAAAA-6463)."""
    import uuid
    from app import app as _app

    sid = f"sess-{uuid.uuid4().hex[:8]}"
    g = np.zeros((60, 80), dtype=np.float32)
    plan = {
        "category": "football",
        "anchor": {"label": "football", "role": "ball"},
        "targets": [
            {"label": "football", "role": "ball", "slotPriority": 0},
            {"label": "player", "role": "player", "slotPriority": 1},
        ],
        "maxTracks": 3,
    }
    client.post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": _frame_jpeg(g), "trackingPlan": plan},
        headers={"X-Session-Id": sid},
    )
    state = _app.state.registry.get(sid)
    assert state is not None
    assert state.tracking_plan is not None
    assert state.tracking_plan.vocabulary() == ["football", "player"]
    assert state.tracker.anchor_label == "football"


def test_ws_seed_lock_evict_ack():
    sid = _uuid_sid()
    _create_session(sid)
    with client.websocket_connect(f"/app/ws?session_id={sid}") as ws:
        ws.send_text('{"type":"seed","slot":0,"bbox":[0.1,0.1,0.3,0.3],"kind":"player"}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["cmd"] == "seed" and ack["slot"] == 0

        ws.send_text('{"type":"lock","slot":0}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["cmd"] == "lock"

        ws.send_text('{"type":"evict","slot":0}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["cmd"] == "evict" and ack["removed"] is True


def test_ws_analyze_still_runs_on_last_frame():
    sid = _uuid_sid()
    _create_session(sid)  # samples one black frame -> state.last_rgb set
    with client.websocket_connect(f"/app/ws?session_id={sid}") as ws:
        ws.send_text('{"type":"analyze-still","timestamp":5.0}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["cmd"] == "analyze-still"
        assert "observation" in ack


def _moving_frames(n=5, dx=12):
    """Yield a bright box translating across a dark field -> enough cumulative
    displacement to fire the tracker's KILL candidate."""
    for i in range(n):
        g = np.zeros((60, 80), dtype=np.float32)
        x = 4 + i * dx
        g[10:26, x : x + 16] = 255.0
        yield g


def test_control_worker_contract_with_candidate():
    """The /analyze response keeps its contract AND stays JSON-serializable when
    a candidate fires (regression: CandidateEvent dataclass was returned and
    subscripted as a dict, crashing the analysis rail at frame 2+)."""
    sid = _uuid_sid()
    last = None
    fired = False
    for i, g in enumerate(_moving_frames(5, dx=12)):
        r = client.post("/app/analyze", json={"seq": i, "timestamp": float(i), "image": _frame_jpeg(g)}, headers={"X-Session-Id": sid})
        assert r.status_code == 200
        body = r.json()
        if "candidate" in body:
            fired = True
            assert body["candidate"]["eventType"] == "KILL"
            assert isinstance(body["candidate"]["timestamp"], (int, float))
            assert body["observation"]["sessionId"] == sid
        last = body
    assert fired, "expected a KILL candidate from the moving box"
    # response must be JSON-serializable end-to-end
    import json as _json

    _json.dumps(last)  # must not raise


def test_live_analyze_with_soccer_game_hint_emits_GOAL():
    """INC-8 (ADAAAA-4484): the live /analyze front door (the path the INC-7
    deployed soccer drive used) must activate the closed vocabulary + sport
    classification when the session is told gameHint='soccer'. Same fast-strike
    frames that emit a generic KILL with no hint must surface as GOAL, so the
    decide model judges and auto-cuts a real goal instead of rejecting a
    shooter/combat label. Without this, §6 live recall can't be met."""
    sid = _uuid_sid()
    fired = False
    for i, g in enumerate(_moving_frames(5, dx=12)):
        r = client.post(
            "/app/analyze",
            json={
                "seq": i,
                "timestamp": float(i),
                "image": _frame_jpeg(g),
                "gameHint": "soccer",
                "preferLabels": ["player", "soccer ball", "goal"],
            },
            headers={"X-Session-Id": sid},
        )
        assert r.status_code == 200
        body = r.json()
        if "candidate" in body:
            fired = True
            assert body["candidate"]["eventType"] == "GOAL", body["candidate"]
            # when a real detector is present the closed vocabulary is active
            # (the stub test env has no detector, so this is asserted only when
            # the observation surfaces a detector block).
            det = body["observation"].get("detector")
            if det is not None:
                assert det.get("vocabulary") is True
    assert fired, "expected a GOAL candidate from the soccer moving box"


def test_live_analyze_soccer_alias_alias_or_default_still_emits_GOAL():
    """INC-8: a human-facing gameHint like 'Premier League Match' (not the bare
    word 'soccer') must map through _GAME_HINT_ALIASES to soccer and still emit
    GOAL — the live drive must not fail just because the hint isn't literally
    'soccer'."""
    sid = _uuid_sid()
    fired = False
    for i, g in enumerate(_moving_frames(5, dx=12)):
        r = client.post(
            "/app/analyze",
            json={"seq": i, "timestamp": float(i), "image": _frame_jpeg(g), "gameHint": "Premier League Match"},
            headers={"X-Session-Id": sid},
        )
        assert r.status_code == 200
        body = r.json()
        if "candidate" in body:
            fired = True
            assert body["candidate"]["eventType"] == "GOAL", body["candidate"]
    assert fired, "expected a GOAL candidate from the aliased soccer hint"


# --- INC-6 on-demand find-and-track -----------------------------------------


def test_http_control_forward_track():
    """INC-6: the HTTP /control endpoint (server -> perceive forward) delivers
    a find-and-track intent to a reserved session and returns an ack."""
    sid = _uuid_sid()
    _create_session(sid)
    r = client.post(
        "/app/control",
        json={"type": "track", "bbox": [0.2, 0.2, 0.4, 0.4], "kind": "player", "label": "p1"},
        headers={"X-Session-Id": sid},
    )
    assert r.status_code == 200
    ack = r.json()
    assert ack["ok"] is True and ack["cmd"] == "track"
    assert ack["selected"] is True
    # unknown session -> 404
    r2 = client.post("/app/control", json={"type": "track", "bbox": [0, 0, 1, 1]}, headers={"X-Session-Id": "nope"})
    assert r2.status_code == 404


def test_ws_track_intent_seeds_selected_object():
    """INC-6: the surfaced `track` control selects an object (bbox) as a
    find-and-track target and acks with its slot."""
    sid = _uuid_sid()
    _create_session(sid)
    with client.websocket_connect(f"/app/ws?session_id={sid}") as ws:
        ws.send_text('{"type":"track","bbox":[0.2,0.2,0.4,0.4],"kind":"player","label":"p1"}')
        ack = ws.receive_json()
        assert ack["ok"] is True and ack["cmd"] == "track"
        assert ack["selected"] is True
        assert ack["slot"] in (0, 1)


def test_seed_selected_surfaces_accuracy_in_observation():
    """INC-6: once a find-and-track target is selected and matched on-screen,
    the /analyze observation carries selected/onScreen/ontoFrames/accuracy."""
    sid = _uuid_sid()
    _create_session(sid)
    with client.websocket_connect(f"/app/ws?session_id={sid}") as ws:
        ws.send_text('{"type":"track","bbox":[0.2,0.2,0.4,0.4],"kind":"player"}')
        ack = ws.receive_json()
        assert ack["ok"] is True
    # re-analyze a blank frame with a matching blob in the tracked region
    g = np.zeros((60, 80), dtype=np.float32)
    g[12:24, 16:32] = 255.0  # ~0.2-0.4 normalized -> overlaps selected box
    r = client.post("/app/analyze", json={"seq": 1, "timestamp": 1.0, "image": _frame_jpeg(g)}, headers={"X-Session-Id": sid})
    body = r.json()
    selected = [t for t in body.get("tracks", []) if t.get("selected")]
    assert selected, "expected a selected find-and-track track in the observation"
    assert selected[0]["onScreen"] is True
    assert selected[0]["ontoFrames"] >= 1
    assert "accuracy" in selected[0]
