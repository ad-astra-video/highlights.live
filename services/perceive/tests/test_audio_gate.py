"""Unit tests for the Stage-A audio noise-change gate (ADAAAA-4325 / INC-2).

Synthetic numpy audio frames — no ffmpeg, no audio files, no network. These
lock the acceptance criteria that are testable at this slice:

- Quiet audio -> no candidate signal.
- Spectral burst -> "burst" signal within the live 1-5s budget.
- Sustained swell -> "swell" signal after the swell window.
- Cooldown suppresses immediate re-trigger.
- Baseline recovers after a swell so a later event still fires.
- The gate is pure DSP: no VLM/Gemma path, no billed GPU.
"""
import base64

import numpy as np
from fastapi.testclient import TestClient

from app import app
from app.audio_gate import AudioEnergyGate, GateConfig, frame_energy

client = TestClient(app)

AUDIO_SID = "sess-audio"


def _pcm(energy: float, n: int = 800) -> str:
    """base64 int16 mono LE PCM whose RMS is approximately ``energy``.

    A constant int16 amplitude A has RMS = A (integer rounding aside), so the
    full-scale-normalized energy is A / 32768.
    """
    a = int(round(energy * 32768.0))
    arr = np.full(n, a, dtype=np.int16)
    return base64.b64encode(arr.tobytes()).decode()


def _post_audio(timestamp: float, samples: str, sid: str = AUDIO_SID, seq: int = -1):
    return client.post(
        "/app/audio",
        json={"timestamp": timestamp, "samples": samples, "seq": seq},
        headers={"X-Session-Id": sid},
    )


def _frame(energy: float, n: int = 1000) -> np.ndarray:
    """A mono chunk (n samples) whose RMS is approximately ``energy``."""
    # A constant signal of amplitude A has RMS = A, so set A = energy.
    return np.full(n, energy, dtype=np.float64)


def _quiet_gate() -> AudioEnergyGate:
    """Gate warmed up on a second of quiet audio (baseline ~0.01)."""
    g = AudioEnergyGate()
    for i in range(10):  # 1 s of quiet at 10 fps
        g.update(_frame(0.01), ts=i * 0.1)
    return g


def test_frame_energy_rms():
    assert frame_energy(np.zeros(4)) == 0.0
    # constant amplitude 0.5 -> RMS 0.5
    assert abs(frame_energy(np.full(100, 0.5)) - 0.5) < 1e-9
    # int16-style input is normalized to full scale
    assert abs(frame_energy(np.full(100, 3276.8)) - 0.1) < 1e-6


def test_quiet_audio_never_triggers():
    g = _quiet_gate()
    for i in range(50):  # 5 s more quiet
        assert g.update(_frame(0.01), ts=1.0 + i * 0.1) is None


def test_burst_triggers_within_budget():
    g = _quiet_gate()
    sig = None
    onset_ts = 2.0
    for i in range(20):  # 2 s of loud burst at 10x baseline
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.1), ts=t)
        if sig is not None:
            break
    assert sig is not None, "burst should have fired"
    assert sig.kind == "burst"
    # anchored at onset, fires within the live budget
    assert abs(sig.ts - onset_ts) < 1e-6
    assert 0.0 <= sig.onset_latency_s <= GateConfig().max_latency_s
    # fast path: fires well under ~1.5 s from onset
    assert sig.onset_latency_s <= 1.5
    assert sig.baseline_energy > 0.0


def test_sustained_swell_triggers():
    g = _quiet_gate()
    sig = None
    onset_ts = 2.0
    for i in range(60):  # 6 s of a sustained 2x-baseline swell (below burst)
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.02), ts=t)
        if sig is not None:
            break
    assert sig is not None, "sustained swell should have fired"
    assert sig.kind == "swell"
    assert abs(sig.ts - onset_ts) < 1e-6
    assert sig.onset_latency_s <= GateConfig().max_latency_s
    # swell path is the ~3 s sustained window
    assert 2.0 <= sig.onset_latency_s <= 3.5


def test_short_burst_does_not_trigger():
    g = _quiet_gate()
    # only 5 loud frames (< burst_min_frames=10) then quiet -> no trigger
    for i in range(5):
        assert g.update(_frame(0.1), ts=2.0 + i * 0.1) is None
    for i in range(20):
        assert g.update(_frame(0.01), ts=2.5 + i * 0.1) is None


def test_cooldown_suppresses_retrigger():
    g = _quiet_gate()
    # fire a burst
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.1), ts=2.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    fired_at = sig.fired_at
    # still loud immediately after, but inside cooldown -> no second signal
    for i in range(40):  # 4 s, within the 5 s cooldown
        assert g.update(_frame(0.1), ts=fired_at + 0.1 + i * 0.1) is None


def test_baseline_recovers_after_swell():
    g = _quiet_gate()
    # a big burst fires...
    for i in range(15):
        if g.update(_frame(0.2, ), ts=2.0 + i * 0.1):
            break
    # ...then a long quiet period lets the baseline settle back down...
    last = None
    for i in range(100):
        last = g.update(_frame(0.01), ts=4.0 + i * 0.1)
    assert last is None
    assert g.baseline is not None and g.baseline < 0.02
    # ...and a later burst on a fresh gate still triggers cleanly.
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.1), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None and sig.kind == "burst"


def test_reset_clears_state():
    g = _quiet_gate()
    for i in range(15):
        if g.update(_frame(0.2), ts=2.0 + i * 0.1):
            break
    g.reset()
    assert g.baseline is None
    assert g._last_fired_ts is None
    # fresh gate behaves like a brand-new one on quiet audio
    assert g.update(_frame(0.01), ts=0.0) is None


def test_signal_is_candidate_not_decision():
    """The gate emits a candidate signal with telemetry fields, never a
    highlight verdict — there is no highlight/decide field on the type."""
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.1), ts=2.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    fields = set(vars(sig).keys())
    assert {"kind", "ts", "fired_at", "onset_latency_s"} <= fields
    # no decision/verdict field leaks into the candidate
    assert not any(f in fields for f in ("highlight", "decision", "verdict"))


# --- HTTP /audio endpoint (slice 2 wiring) -------------------------------


def _warm_audio_gate(sid: str, quiet_seconds: float = 1.0, quiet_energy: float = 0.01):
    """POST ~10 fps quiet chunks to establish the gate's baseline for ``sid``."""
    for i in range(int(quiet_seconds * 10)):
        _post_audio(i * 0.1, _pcm(quiet_energy), sid=sid)


def test_audio_route_requires_session():
    r = client.post("/app/audio", json={"timestamp": 0.0, "samples": _pcm(0.01)})
    assert r.status_code == 400
    assert "session" in r.text.lower()


def test_audio_quiet_never_emits_candidate():
    sid = "audio-sess-quiet"
    _warm_audio_gate(sid)
    for i in range(30):
        r = _post_audio(1.0 + i * 0.1, _pcm(0.01), sid=sid)
        assert r.status_code == 200
        assert r.json()["candidate"] is None


def test_audio_burst_emits_candidate_with_audio_signal():
    sid = "audio-sess-burst"
    _warm_audio_gate(sid)
    cand = None
    onset = 2.0
    for i in range(20):
        t = onset + i * 0.1
        r = _post_audio(t, _pcm(0.1), sid=sid)  # 10x baseline -> burst
        assert r.status_code == 200
        cand = r.json()["candidate"]
        if cand is not None:
            break
    assert cand is not None, "burst should emit a candidate"
    # CandidateEvent shape (packages/events): candidate, NOT a decision.
    assert cand["type"] == "candidate"
    assert cand["eventType"] == "AUDIO"  # gate doesn't classify; decide will
    audio = cand["audio"]
    assert audio["kind"] == "burst"
    # anchored at onset, fired within the live 1-5 s budget
    assert abs(audio["ts"] - onset) < 1e-6
    assert 0.0 <= audio["onsetLatencyS"] <= GateConfig().max_latency_s
    assert 0.0 <= audio["peakEnergy"] <= 1.0
    assert audio["baselineEnergy"] > 0.0


def test_audio_sustained_swell_emits_candidate():
    sid = "audio-sess-swell"
    _warm_audio_gate(sid)
    cand = None
    onset = 3.0
    for i in range(60):  # sustained 2x baseline (below burst ratio)
        t = onset + i * 0.1
        r = _post_audio(t, _pcm(0.02), sid=sid)
        assert r.status_code == 200
        cand = r.json()["candidate"]
        if cand is not None:
            break
    assert cand is not None, "sustained swell should emit a candidate"
    assert cand["audio"]["kind"] == "swell"
    assert cand["audio"]["onsetLatencyS"] <= GateConfig().max_latency_s


def test_audio_endpoint_does_not_run_detector():
    """The gate path must never touch the GPU detector / SAM — it only runs
    cheap DSP. Assert /health still answers and no observation/track pipeline is
    exercised: the response carries only a candidate (or None), no tracks."""
    sid = "audio-sess-gas"
    _warm_audio_gate(sid)
    for i in range(15):
        r = _post_audio(1.0 + i * 0.1, _pcm(0.1), sid=sid)
        assert r.status_code == 200
        body = r.json()
        assert "tracks" not in body  # no vision/observation path on /audio
        assert set(body.keys()) == {"candidate"}
    assert client.get("/health").status_code == 200


def test_audio_accepts_root_route_alias():
    # Both the canonical root and the /app alias must answer (like /analyze).
    r = client.post("/audio", json={"timestamp": 0.0, "samples": _pcm(0.01)})
    assert r.status_code == 400  # route reached (missing session) -> 400


def test_audio_bad_payload_rejected():
    # aligned quiet payload -> accepted (no candidate)
    r = client.post(
        "/app/audio",
        json={"timestamp": 0.0, "samples": _pcm(0.0, n=2)},
        headers={"X-Session-Id": "audio-sess-bad"},
    )
    assert r.status_code == 200
    assert r.json()["candidate"] is None
    # odd-length payload -> aligned error
    r2 = client.post(
        "/app/audio",
        json={"timestamp": 0.0, "samples": "AAAA"},  # decodes to 3 bytes (odd)
        headers={"X-Session-Id": "audio-sess-bad2"},
    )
    assert r2.status_code == 400
