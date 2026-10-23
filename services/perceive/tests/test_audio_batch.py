"""Tests for the windowed ``/audio/batch`` Stage-A gate path (ADAAAA-7313).

Locks the acceptance criteria testable at the HTTP/app layer:

- Equivalence: for identical ordered audio + session state, a batch request
  returns the SAME candidate set as the sequential single-chunk path
  (kind / ts / onsetLatencyS / peakEnergy / baselineEnergy / frames).
- Request reduction surface: one batch call returns 0..n candidates for a whole
  window (the caller sends a window in one request, not one per 100 ms).
- State carry-over: the gate stays stateful across separate batch requests
  (split a window into several calls; candidates + baseline persist).
- Drop-chunk resilience: a gap / partial window keeps gate state correct and
  does not manufacture spurious candidates.
- No GPU: the batch path never runs the detector / SAM / Gemma (pure DSP).
"""
import base64

import numpy as np
from fastapi.testclient import TestClient

import app as appmod
from app import app
from app.audio_gate import GateConfig

client = TestClient(app)

BATCH_SID = "sess-audio-batch"


def _pcm(energy: float, n: int = 800) -> str:
    a = int(round(energy * 32768.0))
    arr = np.full(n, a, dtype=np.int16)
    return base64.b64encode(arr.tobytes()).decode()


def _chunk(ts: float, energy: float, seq: int) -> dict:
    return {"timestamp": ts, "samples": _pcm(energy), "seq": seq}


def _candidate_ids(cands: list) -> list:
    """Extract the equality set for a list of candidates (audio fields)."""
    out = []
    for c in cands:
        a = c.get("audio", {})
        out.append(
            (
                c.get("eventType"),
                round(c.get("timestamp", 0.0), 3),
                a.get("kind"),
                round(a.get("ts", 0.0), 3),
                round(a.get("onsetLatencyS", 0.0), 3),
                round(a.get("peakEnergy", 0.0), 6),
                round(a.get("baselineEnergy", 0.0), 6),
                a.get("frames"),
            )
        )
    return out


def _window() -> list[dict]:
    """Deterministic ordered window: quiet baseline, then a loud burst.

    Warms past the calibration window and the rolling lookback percentile on a
    quiet floor (0.01), then applies a 3-frame loud burst (~0.3 s) so the gate
    fires a ``burst`` candidate within the live budget.
    """
    chunks: list[dict] = []
    seq = 0
    ts = 0.0
    # 60 quiet frames -> baseline established (calibration 0.5s + lookback 8s)
    for _ in range(60):
        chunks.append(_chunk(ts, 0.01, seq))
        ts += 0.1
        seq += 1
    # 3 loud frames -> burst fires on the 3rd (burst_min_frames=3).
    for _ in range(3):
        chunks.append(_chunk(ts, 0.9, seq))
        ts += 0.1
        seq += 1
    # a few quiet frames after the burst
    for _ in range(5):
        chunks.append(_chunk(ts, 0.01, seq))
        ts += 0.1
        seq += 1
    return chunks


def _post_sequential(chunks: list[dict], sid: str) -> list[dict]:
    """Feed chunks one-per-request (the pre-existing single-chunk path)."""
    cands = []
    for c in chunks:
        r = client.post(
            "/app/audio",
            json={"timestamp": c["timestamp"], "samples": c["samples"], "seq": c["seq"]},
            headers={"X-Session-Id": sid},
        )
        assert r.status_code == 200, r.text
        if r.json().get("candidate"):
            cands.append(r.json()["candidate"])
    return cands


def _post_batch(chunks: list[dict], sid: str):
    r = client.post("/app/audio/batch", json={"chunks": chunks}, headers={"X-Session-Id": sid})
    assert r.status_code == 200, r.text
    return r.json()


def test_batch_equivalent_to_sequential_single_chunk():
    """Equivalence (criterion 1): identical ordered audio -> identical candidates."""
    seq_cands = _post_sequential(_window(), "sess-seq-eq")
    batch_body = _post_batch(_window(), "sess-batch-eq")
    batch_cands = batch_body["candidates"]

    # Both paths must produce the same equality set in the same order.
    assert _candidate_ids(batch_cands) == _candidate_ids(seq_cands)
    # And at least the burst fired in both (the window is designed to trigger).
    assert len(batch_cands) >= 1
    assert batch_cands[0]["audio"]["kind"] == "burst"


def test_batch_returns_all_candidates_in_window():
    """A window can fire more than one candidate; batch returns all of them."""
    # Build a window with TWO separated bursts so two candidates fire.
    chunks: list[dict] = []
    seq = 0
    ts = 0.0
    for _ in range(40):  # warm quiet
        chunks.append(_chunk(ts, 0.01, seq)); ts += 0.1; seq += 1
    for _ in range(3):   # burst 1
        chunks.append(_chunk(ts, 0.9, seq)); ts += 0.1; seq += 1
    for _ in range(30):  # quiet -> out of cooldown
        chunks.append(_chunk(ts, 0.01, seq)); ts += 0.1; seq += 1
    for _ in range(3):   # burst 2
        chunks.append(_chunk(ts, 0.9, seq)); ts += 0.1; seq += 1

    body = _post_batch(chunks, "sess-batch-multi")
    cands = body["candidates"]
    assert len(cands) == 2, f"expected 2 candidates, got {len(cands)}"
    assert cands[0]["audio"]["kind"] == "burst"
    assert cands[1]["audio"]["kind"] == "burst"
    # monotonic fire order across the window
    assert cands[0]["timestamp"] < cands[1]["timestamp"]


def test_batch_quiet_window_is_empty():
    """A quiet window returns zero candidates (no spurious FP)."""
    chunks = [_chunk(i * 0.1, 0.01, i) for i in range(40)]
    body = _post_batch(chunks, "sess-batch-quiet")
    assert body["candidates"] == []


def test_gate_state_carries_across_separate_batches():
    """A window split into several batch requests keeps gate baseline/cooldown.

    The burst in the FIRST batch must still be detected when its frames arrive
    in a later batch (state persists across requests) — a caller may split a
    file into windows without losing candidates.
    """
    seq = 0
    ts = 0.0
    # Batch 1: warm quiet baseline
    warm = []
    for _ in range(55):
        warm.append(_chunk(ts, 0.01, seq)); ts += 0.1; seq += 1
    body1 = _post_batch(warm, "sess-batch-split")
    assert body1["candidates"] == []

    # Batch 2: the burst arrives in a separate request (state persists).
    burst = []
    for _ in range(3):
        burst.append(_chunk(ts, 0.9, seq)); ts += 0.1; seq += 1
    body2 = _post_batch(burst, "sess-batch-split")
    assert len(body2["candidates"]) == 1, f"expected split burst to fire, got {len(body2['candidates'])}"
    assert body2["candidates"][0]["audio"]["kind"] == "burst"


def test_drop_chunk_gap_does_not_manufacture_candidates():
    """A gap (missing chunk in the middle) keeps gate state and fires no FP.

    The gate tracks energy *change* over a monotonic timestamp stream; a jump in
    timestamp from a dropped chunk is not itself an energy anomaly, so a quiet
    stream with a gap must still emit NO candidate.
    """
    seq = 0
    ts = 0.0
    chunks = []
    # warm quiet frames
    for _ in range(55):
        chunks.append(_chunk(ts, 0.01, seq)); ts += 0.1; seq += 1
    # DROP a window of frames -> timestamp jumps forward (a gap), same quiet level.
    ts += 5.0
    # continue quiet after the gap
    for _ in range(20):
        chunks.append(_chunk(ts, 0.01, seq)); ts += 0.1; seq += 1
    body = _post_batch(chunks, "sess-batch-gap")
    assert body["candidates"] == [], "a quiet gap must not fire a spurious candidate"


def test_batch_path_never_runs_gpu_inference():
    """No GPU (criterion 5): the batch path must never call the frame detector.

    Monkeypatch the detector/SAM entry points to fail loudly; the batch gate
    (pure DSP) must still succeed, proving it never touches inference.
    """
    sentinel = {"called": False}

    def _boom(*args, **kwargs):
        sentinel["called"] = True
        raise AssertionError("batch path must not call GPU inference")

    orig_frame = appmod.process_frame
    orig_offloop = appmod._analyze_offloop
    # Patch the module-level frame/analyze entry points that the video (GPU)
    # path uses; the audio batch path shares none of them.
    appmod.process_frame = _boom
    appmod._analyze_offloop = _boom
    try:
        body = _post_batch(_window(), "sess-batch-nogpu")
        assert not sentinel["called"], "batch path invoked GPU inference"
        # The gate still fired a candidate through pure DSP.
        assert len(body["candidates"]) >= 1
    finally:
        # restore real references directly (a module reload here would recreate
        # the app/registry and corrupt other tests that share the module).
        appmod.process_frame = orig_frame
        appmod._analyze_offloop = orig_offloop
