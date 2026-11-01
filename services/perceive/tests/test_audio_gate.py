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
from app.audio_gate import (
    AudioEnergyGate,
    BandLimitedWhistleGate,
    GateConfig,
    WhistleConfig,
    frame_energy,
)

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


def test_threshold_id_names_the_operating_point():
    """ADAAAA-7658 AC5: every trigger record says WHICH threshold fired, so the
    live and VOD passes agree on what a trigger is (and a re-tune cannot
    silently redefine a historical record)."""
    g = _quiet_gate()
    sig = None
    for i in range(20):
        sig = g.update(_frame(0.05), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    cfg = GateConfig()
    assert sig.threshold_id == f"stageA/burst/{cfg.burst_ratio:g}x/{cfg.burst_min_frames * cfg.frame_s:g}s"

    # a swell-configured gate names the swell path + its sustain
    g2 = _quiet_gate()
    g2.cfg = GateConfig(burst_ratio=3.0, swell_ratio=1.3, swell_seconds=2.5)
    sig2 = None
    for i in range(40):
        sig2 = g2.update(_frame(0.02), ts=10.0 + i * 0.1)
        if sig2 is not None:
            break
    assert sig2 is not None and sig2.kind == "swell"
    assert sig2.threshold_id == f"stageA/swell/{g2.cfg.swell_ratio:g}x/{g2.cfg.swell_seconds:g}s"


def test_audio_candidate_carries_threshold_id():
    """The /audio candidate evidence carries thresholdId on the wire."""
    sid = "audio-sess-threshold"
    _warm_audio_gate(sid)
    cand = None
    for i in range(20):
        r = _post_audio(10.0 + i * 0.1, _pcm(0.05), sid=sid)
        assert r.status_code == 200
        cand = r.json()["candidate"]
        if cand is not None:
            break
    assert cand is not None
    assert cand["audio"]["thresholdId"].startswith("stageA/burst/")


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
        # `whistle` is the measure-only Stage-B report (ADAAAA-7682); it never
        # carries a candidate, so the GPU-free guarantee for /audio still holds.
        assert set(body.keys()) == {"candidate", "series", "whistle"}
        assert body["whistle"] is None
    assert client.get("/health").status_code == 200


# --- ADAAAA-7255: (t, energy, baseline) inspection series -------------


def test_series_captured_per_chunk_with_baseline():
    """Every chunk records an ordered (t, energy, baseline) point, where the
    baseline is the gate's established ambient percentile (not a fixed 0)."""
    g = _quiet_gate()  # warmed to a ~0.01 baseline over 10 s
    sn = g.series_snapshot()
    assert len(sn) > 0
    prev_t = -1.0
    for p in sn:
        assert {"t", "energy", "baseline"} <= set(p.keys())
        assert p["t"] >= prev_t
        prev_t = p["t"]
        assert 0.0 <= p["energy"] <= 1.0
        assert 0.0 <= p["baseline"] <= 1.0
        assert p["baseline"] > 0.0
    # The newest point reflects the fed energy.
    assert abs(sn[-1]["energy"] - 0.01) < 1e-6
    assert abs(sn[-1]["baseline"] - 0.01) < 1e-6


def test_series_bounded_to_lookback_window():
    """The series never grows beyond the rolling lookback window on a long feed."""
    g = AudioEnergyGate()  # lookback_s=8.0, frame_s=0.1
    for i in range(400):  # 40 s of continuous feed
        g.update(_frame(0.01), ts=0.0 + i * 0.1)
    snap = g.series_snapshot()
    # 8 s lookback / 0.1 s frame => at most ~81 points (+1 for the newest).
    assert len(snap) <= 82, f"series not bounded: {len(snap)} points"
    # Oldest retained point is within the lookback window of the newest ts.
    assert snap[0]["t"] >= 39.9 - 8.0 - 0.11


def test_audio_route_returns_series():
    """The /audio handler returns the bounded series alongside the candidate."""
    sid = "audio-sess-series"
    _warm_audio_gate(sid)
    r = _post_audio(10.0 + 0.1, _pcm(0.01), sid=sid)
    assert r.status_code == 200
    body = r.json()
    assert body["candidate"] is None
    series = body["series"]
    assert isinstance(series, list) and len(series) > 0
    last = series[-1]
    assert set(last.keys()) == {"t", "energy", "baseline"}
    assert abs(last["energy"] - 0.01) < 0.002  # _pcm quantizes to int16 (±1 LSB)


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


# --- ADAAAA-7674 re-tune guardrails -------------------------------------

def test_two_roars_in_one_loud_wave_stay_distinct():
    """Two roars inside ONE celebration wave fire as two distinct candidates.

    This is the ADAAAA-6312 coalescing defect that ADAAAA-7674 re-tuned for: the
    second roar arrives while the crowd is still loud, so its evidence is a
    relative rise over a baseline that is still partly the first roar. A
    baseline window that keeps a roar in the percentile window too long
    collapses the pair into one candidate and loses recall. Guard the
    distinct-fire property, not the exact window length.
    """
    g = AudioEnergyGate()
    t = _warm(g, 0.02, 10.0)  # quiet ambient floor
    for i in range(20):  # crowd wave rising toward the roar
        g.update(_frame(0.02 + 0.025 * i / 19), ts=t)
        t += 0.1
    fires = []
    for i in range(10):  # roar 1 (~3x the ambient floor)
        sig = g.update(_frame(0.062), ts=t)
        if sig is not None:
            fires.append(sig)
        t += 0.1
    for i in range(25):  # wave decays, but stays well above ambient
        g.update(_frame(0.045 - 0.017 * i / 24), ts=t)
        t += 0.1
    for i in range(10):  # roar 2 in the same wave
        sig = g.update(_frame(0.062), ts=t)
        if sig is not None:
            fires.append(sig)
        t += 0.1
    assert len(fires) == 2, (
        f"both roars in one loud wave must surface separately (got {len(fires)}); "
        "coalescing nearby roars is the ADAAAA-7674 recall defect"
    )
    # the second fire is anchored on the second onset, not the first
    assert fires[1].ts > fires[0].ts


def test_threshold_id_names_the_frozen_operating_point():
    """The emitted threshold id keeps naming the operating point (AC5).

    The re-tune moves the ambient window, not the ratio/sustain, so the frozen
    record shape stays ``stageA/burst/1.3x/0.3s``. A future re-tune that changes
    the ratio or sustain must change this id AND update
    ``docs/audio-trigger-contract.md`` with it.
    """
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.05), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None and sig.threshold_id == "stageA/burst/1.3x/0.3s"


# --- Stage-B band-limited whistle path (ADAAAA-7682) --------------------
#
# Stage-A above is a BROADBAND level-change gate and measures 0.00 recall on a
# referee whistle (ADAAAA-7674): a whistle is a narrowband tonal burst whose RMS
# sits at the crowd floor. These tests lock the second path's behaviour on
# synthetic audio — the band baseline, the tonal guards, the frozen threshold
# id, and the measure-only gate that keeps it out of candidate scheduling.

WHISTLE_SR = 16000
WHISTLE_N = int(WHISTLE_SR * 0.1)


def _crowd(n: int = WHISTLE_N, amp: float = 0.03, seed: int = 7) -> np.ndarray:
    """Stadium-ish ambient: broadband hiss plus low rumble, no 2.4-3.4 kHz peak."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / WHISTLE_SR
    a = rng.standard_normal(n) * amp
    a += 0.02 * np.sin(2 * np.pi * 180 * t) + 0.01 * np.sin(2 * np.pi * 700 * t)
    return a.astype(np.float32)


def _tone(hz: float = 2800.0, amp: float = 0.05, n: int = WHISTLE_N) -> np.ndarray:
    t = np.arange(n) / WHISTLE_SR
    return (amp * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _pcm_b64(x: np.ndarray) -> str:
    arr = (np.clip(x, -1.0, 1.0) * 32767.0).astype(np.int16)
    return base64.b64encode(arr.tobytes()).decode()


def _warm_whistle(g: BandLimitedWhistleGate, seconds: float = 3.0) -> float:
    ts = 0.0
    for _ in range(int(round(seconds / 0.1))):
        g.update(_crowd(), ts)
        ts += 0.1
    return ts


def test_whistle_gate_fires_on_narrowband_tone_over_crowd_noise():
    """A 2.8 kHz tonal burst over crowd ambient fires, anchored at its onset."""
    g = BandLimitedWhistleGate()
    ts = _warm_whistle(g)
    onset = ts
    sig = None
    for _ in range(5):
        out = g.update(_tone() + _crowd(), ts)
        if out is not None and sig is None:
            sig = out
        ts += 0.1
    assert sig is not None, "narrowband tone over crowd ambient must fire"
    assert sig.kind == "burst"
    assert abs(sig.ts - onset) < 1e-6, "ts is the onset, not the fire time"
    assert 0.0 <= sig.onset_latency_s <= WhistleConfig().max_latency_s
    assert sig.peak_energy > sig.baseline_energy
    assert g.fired_count == 1


def test_whistle_gate_does_not_fire_on_broadband_roar():
    """A crowd roar raises every band — the speech/low guard rejects it."""
    g = BandLimitedWhistleGate()
    ts = _warm_whistle(g)
    outs = [g.update(_crowd(amp=0.25) + _tone(hz=600.0, amp=0.2), ts + i * 0.1) for i in range(6)]
    assert all(o is None for o in outs)
    assert g.fired_count == 0


def test_whistle_gate_ignores_tone_outside_the_whistle_band():
    """A 1.2 kHz tone is not a whistle: the band baseline stays flat."""
    g = BandLimitedWhistleGate()
    ts = _warm_whistle(g)
    outs = [g.update(_tone(hz=1200.0, amp=0.08) + _crowd(), ts + i * 0.1) for i in range(6)]
    assert all(o is None for o in outs)
    assert g.fired_count == 0


def test_whistle_threshold_id_names_the_operating_point():
    """The id names band/ratio/sustain so a re-tune cannot redefine a record."""
    assert WhistleConfig().threshold_id == "stageB/whistle/2.4-3.4k/5x/0.3s"


def test_whistle_gate_is_measure_only_by_default():
    """Detection always runs, but a fire is not a scheduling candidate."""
    cfg = WhistleConfig()
    assert cfg.emitted is False
    g = BandLimitedWhistleGate()
    ts = _warm_whistle(g)
    for _ in range(5):
        g.update(_tone() + _crowd(), ts)
        ts += 0.1
    assert g.fired_count == 1
    assert g.emitted_count == 0


def test_audio_route_reports_whistle_measure_only_without_emitting_it():
    """`POST /audio` surfaces the whistle evidence but never a stageB candidate.

    This is the cost guard: a whistle fire must not become a GPU-priced gemma
    analysis until the PO graduates the path from measure-only.
    """
    sid = "audio-sess-whistle-measure-only"
    ts = 0.0
    r = None
    for _ in range(30):
        r = _post_audio(ts, _pcm_b64(_crowd()), sid=sid)
        assert r.status_code == 200
        assert r.json()["whistle"] is None  # crowd ambient alone: no whistle
        ts += 0.1
    whistle = None
    for _ in range(5):
        r = _post_audio(ts, _pcm_b64(_tone() + _crowd()), sid=sid)
        assert r.status_code == 200
        body = r.json()
        cand = body["candidate"]
        # Stage-A may fire on the level change; it must never be labelled stageB.
        assert cand is None or not cand["audio"]["thresholdId"].startswith("stageB/")
        if body["whistle"] is not None:
            whistle = body["whistle"]
        ts += 0.1
    assert whistle is not None, "the route must report the whistle fire"
    assert whistle["measureOnly"] is True and whistle["emitted"] is False
    assert whistle["thresholdId"].startswith("stageB/whistle/2.4-3.4k/")
    assert whistle["sessionCandidates"] == 1
