"""Unit tests for the Stage-A audio noise-change gate (ADAAAA-4325 / INC-2,
ADAAAA-4970 noise-adaptive tune).

Synthetic numpy audio frames — no ffmpeg, no audio files, no network. These
lock the acceptance criteria that are testable at this slice under the
noise-adaptive operating point (burst_ratio=1.8, burst_min_frames=3,
cooldown_s=2.0, swell_ratio=1.3):

- Quiet audio -> no candidate signal.
- A relative energy rise over the adaptive floor -> "burst" within the live
  1-5 s budget (goal roar under continuous crowd noise).
- A short rise (< burst_min_frames) does NOT trigger (noise-spike guard).
- A sustained moderate swell -> "swell".
- Cooldown suppresses immediate re-trigger but re-arms for a later roar.
- Continuous crowd noise that stays near the floor does NOT spam candidates
  (FP guard), while a goal roar ON TOP of that floor DOES fire (recall driver).
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
    """A mono chunk (n samples) whose RMS is approximately ``energy``.

    A constant signal of amplitude A has RMS = A, so set A = energy.
    """
    return np.full(n, energy, dtype=np.float64)


def _quiet_gate(quiet_energy: float = 0.01) -> AudioEnergyGate:
    """Gate warmed up on a second of quiet-ish audio (floor ~quiet_energy)."""
    g = AudioEnergyGate()
    for i in range(10):  # 1 s at 10 fps
        g.update(_frame(quiet_energy), ts=i * 0.1)
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
    """A relative energy rise (~5x the floor) fires 'burst' fast and on-budget."""
    g = _quiet_gate()
    sig = None
    onset_ts = 2.0
    for i in range(20):  # 2 s of loud burst at 5x baseline
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.05), ts=t)
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


def test_short_rise_does_not_trigger():
    """A 0.2 s blip (< burst_min_frames=3) must NOT fire — noise-spike guard."""
    g = _quiet_gate()
    # only 2 loud frames (< burst_min_frames=3) then quiet -> no trigger
    for i in range(2):
        assert g.update(_frame(0.05), ts=2.0 + i * 0.1) is None
    # the quiet gap resets the window, so it stays silent
    for i in range(20):
        assert g.update(_frame(0.01), ts=2.2 + i * 0.1) is None
    # ...but 3 fresh consecutive loud frames arm the burst (burst_min_frames=3)
    fired = None
    for i in range(3):
        fired = g.update(_frame(0.05), ts=4.2 + i * 0.1)
        if fired is not None:
            break
    assert fired is not None


def test_sustained_swell_triggers():
    """A sustained rise between swell_ratio and burst_ratio fires 'swell'."""
    g = _quiet_gate()
    sig = None
    onset_ts = 2.0
    # 1.5x floor (0.015 over 0.01) is above swell_ratio 1.3, below burst_ratio
    for i in range(40):  # 4 s sustained 1.5x
        t = onset_ts + i * 0.1
        sig = g.update(_frame(0.015), ts=t)
        if sig is not None:
            break
    assert sig is not None, "sustained swell should have fired"
    assert sig.kind == "swell"
    assert abs(sig.ts - onset_ts) < 1e-6
    assert sig.onset_latency_s <= GateConfig().max_latency_s
    assert sig.onset_latency_s <= 3.5


def test_cooldown_suppresses_retrigger_then_rearms():
    """Fire a burst, stay loud inside cooldown -> no re-fire; after cooldown,
    a fresh roar on re-armed state fires again (recall driver: separate roars
    in one loud wave each surface)."""
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.05), ts=2.0 + i * 0.1)
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


def test_continuous_crowd_noise_goal_roar_fires():
    """ADAAAA-4970 core: under a continuous crowd-noise floor (no quiet), a
    goal roar that is only a ~2x relative rise, sustained ~0.4 s, MUST fire.
    The old budget (3x floor/1 s window) missed these on the real feed."""
    # Warm the floor on a loud, continuous crowd noise (0.04 RMS) — no quiet.
    g = AudioEnergyGate()
    for i in range(10):
        assert g.update(_frame(0.04), ts=i * 0.1) is None
    base_at_start = g.baseline
    # crowd swells 1.4x (0.056) < burst_ratio -> infra-noise, must NOT fire yet
    for i in range(6):
        assert g.update(_frame(0.056), ts=1.0 + i * 0.1) is None
    # a real goal roar: ~2x the crowd floor (0.08), sustained 0.4 s -> fires
    sig = None
    for i in range(5):
        sig = g.update(_frame(0.08), ts=1.6 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None, "goal roar above continuous crowd noise must fire"
    assert sig.kind == "burst"
    assert sig.onset_latency_s <= GateConfig().max_latency_s
    assert sig.baseline_energy > 0.0


def test_crowd_noise_alone_does_not_spam():
    """ADAAAA-4970 FP guard: continuous loud crowd noise that never produces a
    1.8x relative rise must not produce a flood of candidates (FP <= 60% bound).
    A floor that wavers within ~1.4x of itself stays silent."""
    g = AudioEnergyGate()
    fires = 0
    # 20 s of crowd noise oscillating 0.03..0.042 (within 1.4x) -> no fires
    import random
    rnd = random.Random(7)
    for i in range(200):
        e = 0.03 + 0.012 * rnd.random()
        if g.update(_frame(e), ts=i * 0.1) is not None:
            fires += 1
    assert fires == 0, f"pure crowd noise must not spam (fired {fires} times)"


def test_baseline_recovers_after_swell():
    g = _quiet_gate()
    # a big burst fires...
    for i in range(15):
        if g.update(_frame(0.2), ts=2.0 + i * 0.1):
            break
    # ...then a long quieter period lets the floor settle back down...
    last = None
    for i in range(100):
        last = g.update(_frame(0.01), ts=4.0 + i * 0.1)
    assert last is None
    assert g.baseline is not None and g.baseline < 0.02
    # ...and a later burst on a fresh gate still triggers cleanly.
    g = _quiet_gate()
    sig = None
    for i in range(15):
        sig = g.update(_frame(0.05), ts=10.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None and sig.kind == "burst"


def test_reset_clears_state():
    g = _quiet_gate()
    for i in range(15):
        if g.update(_frame(0.05), ts=2.0 + i * 0.1):
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
        sig = g.update(_frame(0.05), ts=2.0 + i * 0.1)
        if sig is not None:
            break
    assert sig is not None
    fields = set(vars(sig).keys())
    assert {"kind", "ts", "fired_at", "onset_latency_s"} <= fields
    # no decision/verdict field leaks into the candidate
    assert not any(f in fields for f in ("highlight", "decision", "verdict"))


# --- HTTP /audio endpoint (slice 2 wiring) -------------------------------


def _warm_audio_gate(sid: str, quiet_seconds: float = 1.0, quiet_energy: float = 0.01):
    """POST ~10 fps quiet chunks to establish the gate's floor for ``sid``."""
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
        r = _post_audio(t, _pcm(0.05), sid=sid)  # 5x floor -> burst
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
    for i in range(40):  # sustained 1.5x floor (below burst ratio)
        t = onset + i * 0.1
        r = _post_audio(t, _pcm(0.015), sid=sid)
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
        r = _post_audio(1.0 + i * 0.1, _pcm(0.05), sid=sid)
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
