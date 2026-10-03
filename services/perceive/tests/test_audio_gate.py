"""Unit tests for the Stage-A audio noise-change gate (ADAAAA-4325 / INC-2;
ADAAAA-4970 noise-adaptive tune; ADAAAA-6312 baseline normalization + rolling
lookback anomaly detector).

Synthetic numpy audio frames — no ffmpeg, no audio files, no network. These
lock the acceptance criteria that are testable at this slice under the
ADAAAA-6312 operating point (calibration_s=0.5, lookback_s=8.0,
baseline_percentile=0.55, burst_ratio=1.3, burst_min_frames=3, cooldown_s=2.0):

- Baseline is established over a calibration window (rolling percentile), and
  the gate is disarmed until the baseline has formed.
- A quiet feed never triggers.
- A relative energy rise over the adaptive (rolling-percentile) baseline fires
  ``burst`` within the live 1-5 s budget.
- A short single-sample / sparse spike does NOT trigger (minimum sustain window).
- A *gradual build* is an anomaly once; once the loud level persists beyond the
  lookback window it becomes the baseline and no longer re-triggers.
- A *constant loud crowd* is baseline (no re-trigger), while a roar ON TOP of
  that baseline still fires (recall under crowd noise).
- Continuous crowd noise that stays near the floor does NOT spam candidates.
- Cooldown suppresses immediate re-trigger but re-arms for a later roar.
- Baseline resets so a later event still fires.
- The gate is pure DSP: it emits a candidate signal, never a highlight verdict.
"""
import base64

import numpy as np
from fastapi.testclient import TestClient

from app import app
from app.audio_gate import AudioEnergyGate, GateConfig, frame_energy

client = TestClient(app)

AUDIO_SID = "sess-audio"


def _pcm(energy: float, n: int = 800) -> str:
    """base64 int16 mono LE PCM whose RMS is approximately ``energy``."""
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
    return np.full(n, energy, dtype=np.float64)


def _warm(g: AudioEnergyGate, energy: float, seconds: float, start: float = 0.0) -> float:
    """Feed ``seconds`` worth of frames at a fixed energy; returns the end ts.

    Warms the gate past the calibration window AND past ``lookback_s`` so the
    rolling-percentile baseline is fully established on ``energy``.
    """
    n = int(round(seconds * 10))
    for i in range(n):
        g.update(_frame(energy), ts=start + i * 0.1)
    return start + n * 0.1


def _quiet_gate(quiet_energy: float = 0.01) -> AudioEnergyGate:
    """Gate warmed past calibration+lookback on a quiet ambient floor."""
    g = AudioEnergyGate()
    _warm(g, quiet_energy, 10.0)
    return g


# --- frame energy ------------------------------------------------------


def test_frame_energy_rms():
    assert frame_energy(np.zeros(4)) == 0.0
    assert abs(frame_energy(np.full(100, 0.5)) - 0.5) < 1e-9
    assert abs(frame_energy(np.full(100, 3276.8)) - 0.1) < 1e-6


# --- baseline normalization ------------------------------------------


def test_baseline_established_over_calibration_window():
    """The ambient floor is a rolling percentile over the calibration window.

    A loud-at-start feed establishes a *loud* baseline (not an absolute level),
    and the gate is disarmed until the baseline has formed (ts < calibration_s).
    """
    g = AudioEnergyGate()  # calibration_s=0.5 -> disarmed for the first 0.5 s
    # During the calibration window the gate must not fire, even on loud energy.
    for i in range(5):  # ts 0.0..0.4
        assert g.update(_frame(0.05), ts=0.0 + i * 0.1) is None
    # baseline established ~0.05 (percentile of the loud calibration frames)
    assert g.baseline is not None and 0.04 <= g.baseline <= 0.06
    # Armed at ts >= 0.5 s; a ~2x roar over the loud baseline fires.
    fired = None
    for i in range(10):
        fired = g.update(_frame(0.10), ts=0.5 + i * 0.1)
        if fired is not None:
            break
    assert fired is not None and fired.kind == "burst"


def test_quiet_audio_never_triggers():
    g = _quiet_gate()
    for i in range(50):  # 5 s more quiet
        assert g.update(_frame(0.01), ts=10.0 + i * 0.1) is None


def test_baseline_recovers_after_event():
    """After a burst, a long quiet period lets the rolling baseline settle back
    down so a later burst on a fresh level still triggers cleanly."""
    g = _quiet_gate()
    for i in range(15):
        if g.update(_frame(0.20), ts=10.0 + i * 0.1):
            break
    # long quiet period
    last = None
    for i in range(120):
        last = g.update(_frame(0.01), ts=11.0 + i * 0.1)
    assert last is None
    assert g.baseline is not None and g.baseline < 0.02


# --- burst / sustained-rise detection ---------------------------------


def test_burst_triggers_within_budget():
    """A relative energy rise (~5x the ambient baseline) fires 'burst' fast."""
    g = _quiet_gate()
    sig = None
    onset_ts = 10.0
    for i in range(20):
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.05), ts=t)
        if sig is not None:
            break
    assert sig is not None, "burst should have fired"
    assert sig.kind == "burst"
    assert abs(sig.ts - onset_ts) < 1e-6
    assert 0.0 <= sig.onset_latency_s <= GateConfig().max_latency_s
    assert sig.onset_latency_s <= 1.5
    assert sig.baseline_energy > 0.0


def test_short_spike_rejected():
    """A single-sample / sparse spike must NOT fire (minimum sustain window)."""
    g = _quiet_gate()
    # a lone loud frame (spike) then quiet -> no trigger
    assert g.update(_frame(0.30), ts=10.0) is None
    assert g.update(_frame(0.01), ts=10.1) is None
    # 2 loud frames (< burst_min_frames=3) then quiet -> no trigger
    for i in range(2):
        assert g.update(_frame(0.30), ts=10.2 + i * 0.1) is None
    for i in range(20):
        assert g.update(_frame(0.01), ts=10.4 + i * 0.1) is None
    # 3 consecutive loud frames arm the burst (burst_min_frames=3)
    fired = None
    for i in range(3):
        fired = g.update(_frame(0.30), ts=12.4 + i * 0.1)
        if fired is not None:
            break
    assert fired is not None and fired.kind == "burst"


def test_sustained_moderate_rise_triggers():
    """A sustained moderate rise (~1.5x the floor) triggers under the default
    operating point (burst fast-path) within the sustain bound."""
    g = _quiet_gate()
    sig = None
    onset_ts = 10.0
    for i in range(40):
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.015), ts=t)
        if sig is not None:
            break
    assert sig is not None, "sustained moderate rise should have fired"
    assert sig.onset_latency_s <= GateConfig().max_latency_s
    assert sig.onset_latency_s <= 3.5


def test_swell_distinct_config_fires_swell():
    """A config that separates the swell path (swell_ratio < burst_ratio)
    still emits a distinct ``swell`` candidate for a slow, sustained rise."""
    cfg = GateConfig(swell_ratio=1.2, burst_ratio=1.5)
    g = AudioEnergyGate(cfg)
    _warm(g, 0.01, 10.0)  # baseline ~0.01
    sig = None
    onset_ts = 10.0
    # 1.3x (0.013): >= swell_ratio 1.2, < burst_ratio 1.5 -> swell, not burst
    for i in range(40):
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.013), ts=t)
        if sig is not None:
            break
    assert sig is not None, "sustained swell should have fired"
    assert sig.kind == "swell"
    assert sig.onset_latency_s <= GateConfig().max_latency_s


# --- gradual build / constant crowd (rolling lookback) ----------------


def test_gradual_build_fires_once_then_becomes_baseline():
    """A gradual crowd build is an anomaly once, but once the level persists
    beyond the lookback window it becomes baseline (no re-trigger)."""
    g = AudioEnergyGate()
    _warm(g, 0.01, 10.0)  # ambient quiet floor
    # gradual build: ramp 0.01 -> 0.05 over 5 s
    fired = False
    for i in range(50):
        e = 0.01 + 0.04 * (i / 49)
        sig = g.update(_frame(e), ts=10.0 + i * 0.1)
        if sig is not None:
            fired = True
            break
    assert fired, "the gradual build should have been detected as an anomaly"
    # hold the loud level for longer than lookback_s so it becomes baseline
    for i in range(110):  # 11 s
        g.update(_frame(0.05), ts=15.0 + i * 0.1)
    # now 0.05 is (part of) the rolling baseline -> feeding it must NOT fire
    for i in range(40):
        assert g.update(_frame(0.05), ts=26.0 + i * 0.1) is None
    # a real roar on top (relative rise over the new baseline) still fires
    roar = None
    for i in range(10):
        roar = g.update(_frame(0.10), ts=30.0 + i * 0.1)  # 2x the 0.05 baseline
        if roar is not None:
            break
    assert roar is not None and roar.kind == "burst"


def test_constant_loud_crowd_is_baseline_no_retrigger():
    """A constant loud crowd is baseline: it never fires, and only a relative
    roar on top of that floor triggers (recall under continuous crowd noise)."""
    g = AudioEnergyGate()
    _warm(g, 0.05, 10.0)  # start directly on a constant loud crowd
    # constant loud with slight waviness (within ~1.06x) -> never fires
    for i in range(200):
        e = 0.047 + 0.006 * ((i % 10) / 10)
        assert g.update(_frame(e), ts=10.0 + i * 0.1) is None
    # ~2x roar over the loud baseline fires
    roar = None
    for i in range(10):
        roar = g.update(_frame(0.10), ts=30.0 + i * 0.1)
        if roar is not None:
            break
    assert roar is not None and roar.kind == "burst"


def test_crowd_noise_alone_does_not_spam():
    """Continuous loud crowd noise that never produces a sustained rise above
    the baseline must not produce a flood of candidates."""
    import random

    g = AudioEnergyGate()
    _warm(g, 0.036, 10.0)
    fires = 0
    rnd = random.Random(7)
    for i in range(200):
        e = 0.03 + 0.012 * rnd.random()
        if g.update(_frame(e), ts=10.0 + i * 0.1) is not None:
            fires += 1
    assert fires == 0, f"pure crowd noise must not spam (fired {fires} times)"


# --- cooldown ---------------------------------------------------------


def test_cooldown_suppresses_retrigger_then_rearms():
    """Fire a burst, stay loud inside cooldown -> no re-fire; after cooldown a
    fresh roar on re-armed state fires again (separate roars surface)."""
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.05), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    fired_at = sig.fired_at
    # still loud immediately after, but inside cooldown (2 s) -> no second signal
    for i in range(15):  # 1.5 s
        assert g.update(_frame(0.05), ts=fired_at + 0.1 + i * 0.1) is None
    # after cooldown elapses, continued loud energy re-arms and fires
    sig2 = None
    for i in range(20):
        sig2 = g.update(_frame(0.05), ts=fired_at + 2.5 + i * 0.1)
        if sig2 is not None:
            break
    assert sig2 is not None, "gate should re-arm after cooldown and fire again"


# --- reset / contract -------------------------------------------------


def test_reset_clears_state():
    g = _quiet_gate()
    for i in range(15):
        if g.update(_frame(0.05), ts=10.0 + i * 0.1):
            break
    g.reset()
    assert g.baseline is None
    assert g._last_fired_ts is None
    assert len(g._history) == 0
    assert g.update(_frame(0.01), ts=0.0) is None  # disarmed / re-calibrating


def test_signal_is_candidate_not_decision():
    """The gate emits a candidate signal with telemetry fields, never a
    highlight verdict."""
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.05), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    fields = set(vars(sig).keys())
    assert {"kind", "ts", "fired_at", "onset_latency_s"} <= fields
    assert not any(f in fields for f in ("highlight", "decision", "verdict"))


# --- HTTP /audio endpoint (slice 2 wiring) -------------------------------


def _warm_audio_gate(sid: str, quiet_seconds: float = 10.0, quiet_energy: float = 0.01):
    """POST ~10 fps quiet chunks to establish the gate's rolling baseline for
    ``sid`` (past the calibration window and lookback window)."""
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
        r = _post_audio(10.0 + i * 0.1, _pcm(0.01), sid=sid)
        assert r.status_code == 200
        assert r.json()["candidate"] is None


def test_audio_burst_emits_candidate_with_audio_signal():
    sid = "audio-sess-burst"
    _warm_audio_gate(sid)
    cand = None
    onset = 10.0
    for i in range(20):
        t = onset + i * 0.1
        r = _post_audio(t, _pcm(0.05), sid=sid)  # 5x floor -> burst
        assert r.status_code == 200
        cand = r.json()["candidate"]
        if cand is not None:
            break
    assert cand is not None, "burst should emit a candidate"
    assert cand["type"] == "candidate"
    assert cand["eventType"] == "AUDIO"
    audio = cand["audio"]
    assert audio["kind"] == "burst"
    assert abs(audio["ts"] - onset) < 1e-6
    assert 0.0 <= audio["onsetLatencyS"] <= GateConfig().max_latency_s
    assert 0.0 <= audio["peakEnergy"] <= 1.0
    assert audio["baselineEnergy"] > 0.0


def test_audio_sustained_rise_emits_candidate():
    sid = "audio-sess-swell"
    _warm_audio_gate(sid)
    cand = None
    onset = 10.0
    for i in range(40):  # sustained 1.5x floor
        t = onset + i * 0.1
        r = _post_audio(t, _pcm(0.015), sid=sid)
        assert r.status_code == 200
        cand = r.json()["candidate"]
        if cand is not None:
            break
    assert cand is not None, "sustained rise should emit a candidate"
    assert cand["audio"]["onsetLatencyS"] <= GateConfig().max_latency_s


def test_audio_endpoint_does_not_run_detector():
    sid = "audio-sess-gas"
    _warm_audio_gate(sid)
    for i in range(15):
        r = _post_audio(10.0 + i * 0.1, _pcm(0.05), sid=sid)
        assert r.status_code == 200
        body = r.json()
        assert "tracks" not in body
        assert set(body.keys()) == {"candidate"}
    assert client.get("/health").status_code == 200


def test_audio_accepts_root_route_alias():
    r = client.post("/audio", json={"timestamp": 0.0, "samples": _pcm(0.01)})
    assert r.status_code == 400  # route reached (missing session) -> 400


def test_audio_bad_payload_rejected():
    r = client.post(
        "/app/audio",
        json={"timestamp": 0.0, "samples": _pcm(0.0, n=2)},
        headers={"X-Session-Id": "audio-sess-bad"},
    )
    assert r.status_code == 200
    assert r.json()["candidate"] is None
    r2 = client.post(
        "/app/audio",
        json={"timestamp": 0.0, "samples": "AAAA"},  # decodes to 3 bytes (odd)
        headers={"X-Session-Id": "audio-sess-bad2"},
    )
    assert r2.status_code == 400
