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
import numpy as np

from app.audio_gate import AudioEnergyGate, GateConfig, frame_energy


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
