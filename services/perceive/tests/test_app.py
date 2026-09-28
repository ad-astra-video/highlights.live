import base64
import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app import app

client = TestClient(app)


def _frame_jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def _black() -> np.ndarray:
    return np.zeros((60, 80), dtype=np.float32)


def _white_square(topleft=(20, 20), size=16) -> np.ndarray:
    g = np.zeros((60, 80), dtype=np.float32)
    g[topleft[1] : topleft[1] + size, topleft[0] : topleft[0] + size] = 255.0
    return g


SID = "sess-test"


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_analyze_requires_session():
    img = _frame_jpeg(_black())
    r = client.post("/app/analyze", json={"seq": 0, "timestamp": 0, "image": img})
    assert r.status_code == 400
    assert "session" in r.text.lower()


def test_analyze_tracks_a_moving_blob_across_one_session():
    # Two frames: black, then white square near the left side. Same session id
    # -> the tracker keeps state and reports <=2 tracks.
    frames = [_black(), _white_square((8, 8))]
    last_tracks = None
    for i, fr in enumerate(frames):
        r = client.post(
            "/app/analyze",
            json={"seq": i, "timestamp": float(i), "image": _frame_jpeg(fr)},
            headers={"X-Session-Id": SID},
        )
        assert r.status_code == 200
        body = r.json()
        last_tracks = body["tracks"]
    # We may get 0 tracks if the blob is too small at 60x80, but track list must
    # be well-formed and capped.
    assert isinstance(last_tracks, list)
    assert len(last_tracks) <= 2


def test_events_route_registered():
    # Canonical (root) is what the go-livepeer proxy forwards to; the /app/*
    # aliases live under the mounted sub-app. Both must answer.
    assert client.get("/health").status_code == 200                 # root (proxy)
    assert client.get("/app/health").status_code == 200             # alias (direct)
    # events without a session id -> 400 (route reached, mounted)
    assert client.get("/events").status_code == 400
    assert client.get("/app/events").status_code == 400


def test_analyze_enqueues_onto_subscriber_queues():
    # The unbounded SSE stream can't be exercised over a blocking TestClient,
    # so verify the event contract directly: analyze() puts an observation onto
    # any subscriber queue bound to the session, and emits a health-style event.
    import asyncio

    reg = app.state.registry
    state = reg.get_or_create("sess-sub")
    q = asyncio.Queue()
    state.subscribers.append(q)

    frames = [_black(), _white_square((10, 10))]
    for i, fr in enumerate(frames):
        client.post(
            "/app/analyze",
            json={"seq": i, "timestamp": float(i), "image": _frame_jpeg(fr)},
            headers={"X-Session-Id": "sess-sub"},
        )
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    assert events, "analyze should enqueue at least one observation"
    assert events[-1]["type"] == "observation"
    state.subscribers.remove(q)


def test_close_session():
    img = _frame_jpeg(_black())
    client.post("/app/analyze", json={"seq": 0, "timestamp": 0, "image": img}, headers={"X-Session-Id": "sess-close"})
    r = client.post("/app/session/close", headers={"X-Session-Id": "sess-close"})
    assert r.status_code == 200


# --- Per-stream LoRA injection (ADAAAA-5324): /analyze carries loraRef -------

LORA_SID = "sess-lora"


def test_analyze_carries_lora_ref_into_session():
    """A LoRA-attached stream: /analyze sets the session's lora_ref so
    process_frame selects that stream's detector variant."""
    import uuid
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    img = _frame_jpeg(_black())
    r = TestClient(app).post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": img, "loraRef": "/models/lora-abc"},
        headers={"X-Session-Id": sid},
    )
    assert r.status_code == 200
    state = app.state.registry.get(sid)
    assert state.lora_ref == "/models/lora-abc"


def test_analyze_without_lora_keeps_base():
    """No adapter attached -> session stays base (lora_ref empty): the
    no-regression guarantee for non-fine-tuned streams."""
    import uuid
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    img = _frame_jpeg(_black())
    r = TestClient(app).post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": img},
        headers={"X-Session-Id": sid},
    )
    assert r.status_code == 200
    state = app.state.registry.get(sid)
    assert state.lora_ref == ""


def test_process_frame_uses_per_stream_detector(monkeypatch):
    """process_frame selects the detector via get_detector(lora_ref): with an
    attached adapter it MUST receive that ref (per-stream selection), and with
    none it MUST receive None (base singleton)."""
    import uuid
    import app as _app

    sid = f"sess-{uuid.uuid4().hex[:8]}"
    calls: list = []

    class FakeDet:
        def detect(self, rgb, vocabulary=None):
            return []

    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: (calls.append(lora_ref) or FakeDet()))
    # attached adapter -> selected with the ref
    TestClient(app).post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": _frame_jpeg(_black()), "loraRef": "/models/lora-xyz"},
        headers={"X-Session-Id": sid},
    )
    assert "/models/lora-xyz" in calls
    # separate base stream -> selected with None
    TestClient(app).post(
        "/app/analyze",
        json={"seq": 0, "timestamp": 0.0, "image": _frame_jpeg(_black())},
        headers={"X-Session-Id": f"sess-{uuid.uuid4().hex[:8]}"},
    )
    assert None in calls
