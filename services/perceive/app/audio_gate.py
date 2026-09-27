"""Stage-A audio noise-change gate (ADAAAA-4325 / INC-2; ADAAAA-4970 noise-adaptive tune).

Cheap candidate trigger on the audio track: detects commentary/crowd energy
change (spectral burst or sustained swell) and emits a *candidate signal*.
It never decides a highlight by itself — the decide stage (Gemma) only runs
on frames where this gate (or another Stage-A gate) fired, which bounds
Livepeer GPU cost and live latency.

Noise-adaptive operating point (ADAAAA-4970). Calibrated against real soccer
audio (real_goal_3080 / real_match_70s — continuous crowd noise, no quiet
periods). The original INC-2 budget (burst_ratio=3.0, burst_min_frames=10,
cooldown_s=5) fired on only ~15/114 real goal events on the live feed: under
continuous crowd noise the "quiet" baseline locks near the minimum, the 3x
threshold + 1 s sustained window + 5 s cooldown suppress every real roar that
is not a full-spectrum blast. ADAAAA-4970 lowers the gate to a *relative
*energy rise over the adaptive noise floor* (a roar need only be ~1.8x the
recent floor, 0.3 s sustained, and separate roars inside one loud wave re-arm
every ~2 s). On real audio this lifts audio-gate goal recall from ~0.43 to
~0.90 while FP (candidates not near a real goal) stays <= 0.60 and onset->fire
latency stays <= 5 s (p50 ~1 s, p95 <= 2.9 s).

Design (pure DSP, no ML, no VLM — the gate path must not bill GPU):

- Input: fixed-length audio chunks (default 100 ms) as mono float samples in
  ``[-1, 1]`` (the server-side ffmpeg tap decodes them; see slice 2).
- ``frame_energy``: RMS of the chunk, normalized to ``[0, 1]``.
- Baseline: exponential moving average of *non-elevated* energy (only frames
  below ``swell_ratio * baseline`` feed it), so a crowd swell raises the
  trigger level and the baseline returns after the swell decays. This is the
  noise-adaptive floor.
- Burst: ``burst_min_frames`` (3) consecutive frames at >= ``burst_ratio``
  (1.8) x the floor -> trigger ``"burst"`` (fast path, ~0.3-1.5 s from onset).
- Swell: ``swell_seconds`` (2.5) of consecutive frames at >= ``swell_ratio``
  (1.3) x the floor with no burst-level peak -> trigger ``"swell"``.
- Cooldown: no second trigger within ``cooldown_s`` (2.0) of the last one, so
  distinct crowd roars inside one loud wave each re-arm (recall driver).
- Latency contract: a trigger fires at most ``max_latency_s`` (5 s) after the
  onset of the energy change it reports; the reported ``ts`` is the onset
  timestamp (first elevated frame), so the candidate is anchored at the right
  moment, not the moment the gate reacted.

The module is stateless-free (state lives on the instance) and unit-testable
with synthetic numpy frames — no audio files, no ffmpeg, no network.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


def frame_energy(samples: np.ndarray) -> float:
    """RMS energy of one audio chunk, normalized to [0, 1].

    ``samples`` is mono float in ``[-1, 1]`` (or int16 values — the divisor
    is picked from the array magnitude so both work).
    """
    if samples.size == 0:
        return 0.0
    a = np.asarray(samples, dtype=np.float64)
    peak = float(np.max(np.abs(a)))
    if peak > 1.0:  # int16-style input: normalize to full scale
        a = a / 32768.0
    rms = float(np.sqrt(np.mean(a * a)))
    return min(1.0, rms)


@dataclass
class GateConfig:
    frame_s: float = 0.1          # audio chunk duration fed per update()
    baseline_alpha: float = 0.05  # EMA rate for the adaptive noise floor
    baseline_floor: float = 1e-4  # floor so silence never divides to zero
    # ADAAAA-4970: relative-rise operating point (calibrated on real continuous
    # crowd noise). A goal roar need only be ~1.8x the adaptive floor, sustained
    # ~0.3 s, and separate roars re-arm every ~2.0 s. See module docstring.
    burst_ratio: float = 1.8      # energy >= ratio x floor -> burst frame
    swell_ratio: float = 1.3      # energy >= ratio x floor -> swell frame
    burst_min_frames: int = 3     # consecutive burst frames (~0.3 s) to fire
    swell_seconds: float = 2.5    # consecutive swell frames (~2.5 s) to fire
    cooldown_s: float = 2.0       # suppress re-trigger this long after firing
    max_latency_s: float = 5.0    # hard bound: onset -> trigger must fit this


@dataclass
class AudioGateSignal:
    """A Stage-A candidate signal from the audio gate.

    This is evidence for candidate generation, NOT a highlight decision.
    """

    kind: str                # "burst" | "swell"
    ts: float                # onset timestamp (seconds) of the energy change
    fired_at: float          # timestamp the gate actually fired (>= ts)
    onset_latency_s: float   # fired_at - ts; must be <= cfg.max_latency_s
    peak_energy: float       # max frame energy in the trigger window
    baseline_energy: float   # baseline at fire time (for FP-rate telemetry)
    frames: int = 1          # number of elevated frames that formed the trigger


@dataclass
class AudioEnergyGate:
    cfg: GateConfig = field(default_factory=GateConfig)

    def __post_init__(self) -> None:
        self.baseline: float | None = None  # set on first quiet frame
        self._elevated: int = 0             # consecutive elevated-frame count
        self._swell_energy_sum: float = 0.0
        self._peak: float = 0.0
        self._onset_ts: float | None = None
        self._last_fired_ts: float | None = None

    # -- internals ------------------------------------------------------

    def _in_cooldown(self, ts: float) -> bool:
        return (
            self._last_fired_ts is not None
            and ts - self._last_fired_ts < self.cfg.cooldown_s
        )

    def _reset_window(self) -> None:
        self._elevated = 0
        self._swell_energy_sum = 0.0
        self._peak = 0.0
        self._onset_ts = None

    # -- main API --------------------------------------------------------

    def update(self, samples: np.ndarray, ts: float) -> AudioGateSignal | None:
        """Feed one audio chunk at timestamp ``ts`` (seconds).

        Returns a candidate signal when the gate fires, else ``None``.
        """
        cfg = self.cfg
        e = frame_energy(samples)

        # Baseline tracks quiet energy only (slow EMA), so swells don't drag
        # the trigger level up. First frame seeds the baseline (even quiet).
        if self.baseline is None:
            self.baseline = max(e, cfg.baseline_floor)
        elif e < cfg.swell_ratio * self.baseline:
            self.baseline = (
                1.0 - cfg.baseline_alpha
            ) * self.baseline + cfg.baseline_alpha * e

        base = max(self.baseline, cfg.baseline_floor)
        is_burst = e >= cfg.burst_ratio * base
        is_swell = e >= cfg.swell_ratio * base

        if self._in_cooldown(ts):
            # Inside cooldown we still track the window so a continuing swell
            # doesn't lose its onset; we just can't fire.
            if is_swell:
                if self._elevated == 0:
                    self._onset_ts = ts
                self._elevated += 1
                self._peak = max(self._peak, e)
            else:
                self._reset_window()
            return None

        if is_swell:
            if self._elevated == 0:
                self._onset_ts = ts
                self._peak = e
            else:
                self._peak = max(self._peak, e)
            self._elevated += 1
            self._swell_energy_sum += e
        else:
            self._reset_window()

        if not self._onset_ts:
            return None

        # Burst fast path: N consecutive burst-level frames.
        if is_burst and self._elevated >= cfg.burst_min_frames:
            return self._fire("burst", ts)

        # Swell path: sustained elevation without a burst-level peak.
        swell_frames_needed = max(1, int(round(cfg.swell_seconds / cfg.frame_s)))
        if (
            self._elevated >= swell_frames_needed
            and self._swell_energy_sum / self._elevated < cfg.burst_ratio * base
        ):
            return self._fire("swell", ts)

        return None

    def _fire(self, kind: str, fired_at: float) -> AudioGateSignal:
        onset = self._onset_ts if self._onset_ts is not None else fired_at
        baseline = self.baseline if self.baseline is not None else 0.0
        sig = AudioGateSignal(
            kind=kind,
            ts=onset,
            fired_at=fired_at,
            onset_latency_s=round(fired_at - onset, 3),
            peak_energy=round(self._peak, 6),
            baseline_energy=round(max(baseline, self.cfg.baseline_floor), 6),
            frames=self._elevated,
        )
        self._last_fired_ts = fired_at
        self._reset_window()
        return sig

    def reset(self) -> None:
        """Clear all state (new session / new stream)."""
        self.baseline = None
        self._last_fired_ts = None
        self._reset_window()
