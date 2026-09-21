"""Container-startup model preload for the perceive live-runner.

Loads the heavy models (Florence-2 detector + SAM 3.1 predictor) in a
background thread at boot, so the first live/VOD pass never pays the
multi-second model-build mid-call — and /health stays responsive the whole
time (the load never runs on the asyncio event loop).

This is the async half of the ADAAAA-3305 VOD-404 fix: go-livepeer
health-probes perceive every ~5s and marks the runner unavailable + releases
the live session if /health stalls. Building a cold predictor (or loading
Florence weights) on the event loop / on first use is what caused that trip.
By preloading off-loop at startup, the runner is warm before the first pass and
/health never blocks on model loading.
"""
from __future__ import annotations

import logging
import os
import threading

from . import sam3_backend
from .florence import get_detector

log = logging.getLogger("highlights.perceive.preload")

# Shared introspecable preload state (thread-safe via the lock).
_state = {"started": False, "done": False, "result": None}
_lock = threading.Lock()


def _preload_florence() -> bool:
    """Build + load the shared Florence-2 detector (idempotent: no-op if already
    loaded, or when PERCEIVE_MODE != florence). Returns whether it became
    ready. Never raises: a host without the model stays in stub mode."""
    if os.environ.get("PERCEIVE_MODE", "stub") != "florence":
        log.info("preload: florence disabled (stub) — skipping")
        return False
    try:
        d = get_detector()
        if d is None:
            return False
        d.load()
        log.info("preload: florence-2 ready @ %s", d.device_label)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("preload: florence-2 load failed: %s", e)
        return False


def _preload_sam3() -> bool:
    """Build the shared SAM 3.1 GPU predictor once, off-loop, so the first VOD
    pass never does the expensive build mid-call. Gated so we don't waste GPU
    building a predictor on an iou-only runner. Never raises."""
    if os.environ.get("PERCEIVE_TRACKER", "iou") != "florence_sam":
        log.info("preload: sam3 disabled (tracker != florence_sam) — skipping")
        return False
    try:
        ok = sam3_backend.preload_sam3()
        log.info("preload: sam3 shared predictor %s", "ready" if ok else "unavailable")
        return ok
    except Exception as e:  # noqa: BLE001
        log.warning("preload: sam3 load failed: %s", e)
        return False


def preload_models() -> dict:
    """Run both preloads. Called from the background thread. Returns a status
    dict the /health endpoint reflects."""
    return {
        "florence2": _preload_florence(),
        "sam3": _preload_sam3(),
    }


def _run() -> None:
    try:
        _state["result"] = preload_models()
    except Exception as e:  # noqa: BLE001
        log.warning("preload: unexpected error: %r", e)
        _state["result"] = {"error": str(e)}
    finally:
        _state["done"] = True


def start_background_preload() -> None:
    """Kick off the model preload on a daemon thread and return immediately so
    /health (and the whole event loop) never blocks on model loading."""
    with _lock:
        if _state["started"]:
            return
        _state["started"] = True
    threading.Thread(target=_run, name="perceive-preload", daemon=True).start()


def preload_status() -> dict:
    """Read-only snapshot for /health."""
    with _lock:
        return dict(_state)
