"""Preload (ADAAAA-3305) tests.

Verifies the container-startup model preload contract without touching the GPU
or the real SAM 3 / Florence-2 weights:
  - start_background_preload() returns immediately (never blocks /health) and is
    idempotent (one thread only).
  - Sam3Backend reuses the shared preloaded predictor when available, so the
    first VOD pass never pays a fresh GPU build mid-call.
  - /health always answers "ok" and exposes model preload progress without ever
    flipping to a failing state while models load.
"""
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app import app, preload
from app.sam3_backend import Sam3Backend, _get_shared_predictor, preload_sam3


def _reset_preload_state():
    with preload._lock:
        preload._state["started"] = False
        preload._state["done"] = False
        preload._state["result"] = None


def _reset_shared():
    import app.sam3_backend as sb

    with sb._shared_lock:
        sb._shared_predictor = None


# --- preload.state -----------------------------------------------------------
def test_preload_state_idempotent_and_fast(monkeypatch):
    _reset_preload_state()
    threads_seen = []

    # Patch start_background_preload's threading.Thread factory so we can count
    # how many workers are actually spawned.
    class _FakeThread(threading.Thread):
        def start(self):
            threads_seen.append(self)  # never actually run (no model load in test)

    monkeypatch.setattr(preload.threading, "Thread", _FakeThread)
    t0 = time.time()
    preload.start_background_preload()  # must return immediately
    dt = time.time() - t0
    assert dt < 1.0, "start_background_preload must not block the caller"
    assert preload.preload_status()["started"] is True
    # second call must not spawn another worker (idempotent)
    preload.start_background_preload()
    assert len(threads_seen) == 1
    _reset_preload_state()


def test_preload_state_async_done(monkeypatch):
    _reset_preload_state()
    calls = []

    def _fast_preload():
        calls.append("ran")
        preload._state["result"] = {"florence2": False, "sam3": False}
        preload._state["done"] = True  # real _run sets this in finally

    monkeypatch.setattr(preload, "_run", _fast_preload)
    preload.start_background_preload()
    for _ in range(100):
        if preload.preload_status()["done"]:
            break
        time.sleep(0.02)
    assert preload.preload_status()["done"] is True
    assert calls == ["ran"]
    _reset_preload_state()


# --- shared SAM 3 predictor reuse --------------------------------------------
class _FakePredictor:
    def __init__(self, label):
        self.label = label
        self.session = None

    def handle_request(self, req):
        if req["type"] == "start_session":
            self.session = req["resource_path"]
            return {"session_id": "s1"}
        return {}


def test_sam3_backend_reuses_shared_predictor(monkeypatch):
    _reset_shared()
    built = []

    def _fake_build():
        built.append("build")
        return _FakePredictor("SHARED")

    # make preload_sam3 build our fake without importing sam3 SDK
    monkeypatch.setattr(Sam3Backend, "_default_predictor", staticmethod(_fake_build))
    assert preload_sam3() is True
    assert built == ["build"]
    shared = _get_shared_predictor()
    assert shared is not None and shared.label == "SHARED"

    # A backend with NO explicit factory must pick up the shared predictor
    b = Sam3Backend(clip_path="x.mp4")
    assert b.ready()
    assert b._predictor is shared  # reused the boot build, not a fresh one
    assert built == ["build"]     # no second GPU build happened
    _reset_shared()


def test_explicit_factory_wins_over_shared(monkeypatch):
    _reset_shared()
    monkeypatch.setattr(
        Sam3Backend, "_default_predictor", staticmethod(lambda: _FakePredictor("SHARED"))
    )
    preload_sam3()
    shared = _get_shared_predictor()
    assert shared is not None and shared.label == "SHARED"

    mine = _FakePredictor("MINE")
    b = Sam3Backend(predictor_factory=lambda: mine, clip_path="x.mp4")
    assert b.ready()
    assert b._predictor is mine  # explicit factory beats the shared predictor
    _reset_shared()


def test_preload_sam3_never_raises_when_sdk_missing(monkeypatch):
    _reset_shared()

    def _boom():
        raise RuntimeError("no triton / no gated weights")

    monkeypatch.setattr(Sam3Backend, "_default_predictor", staticmethod(_boom))
    assert preload_sam3() is False  # CPU / no-SDK -> skip, fall back to JIT
    _reset_shared()


# --- /health stays ok while models preload ----------------------------------
def test_health_ok_after_startup_preload():
    # TestClient runs the startup event; in the default stub/iou env the preload
    # is a fast no-op, but /health must return 200 "ok" with model progress.
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert "models" in body
        assert body["models"]["started"] is True
