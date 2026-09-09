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


def test_control_worker_contract():
    """The /analyze response still carries the same contract after the shared
    process_frame refactor (observation with tracks, or candidate+observation)."""
    sid = _uuid_sid()
    g = np.zeros((60, 80), dtype=np.float32)
    g[10:26, 10:26] = 255.0
    r = client.post("/app/analyze", json={"seq": 0, "timestamp": 0.0, "image": _frame_jpeg(g)}, headers={"X-Session-Id": sid})
    assert r.status_code == 200
    body = r.json()
    # either plain observation or {candidate, observation}
    if "observation" in body:
        assert body["observation"]["sessionId"] == sid
    else:
        assert body["tracks"] is not None or "tracks" in body
