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
