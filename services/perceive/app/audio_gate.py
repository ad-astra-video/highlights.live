"""Stage-A audio noise-change gate (ADAAAA-4325 / INC-2; ADAAAA-4970 noise-adaptive
tune; ADAAAA-6312 baseline normalization + rolling lookback anomaly detector).

Cheap candidate trigger on the audio track: detects commentary/crowd energy
*change* (spectral burst or sustained swell) and emits a *candidate signal*.
It never decides a highlight by itself — the decide stage (Gemma) only runs
on frames where this gate (or another Stage-A gate) fired, which bounds
Livepeer GPU cost and live latency.

ADAAAA-6312 replaces the absolute-level / quiet-only-EMA baseline with a
**per-stream baseline normalization + rolling lookback anomaly detector**:

- Baseline is established over a **calibration window** (the first
  ``calibration_s`` seconds of a stream) as a *rolling percentile* of the
  frame energies seen so far, not a fixed absolute level. This makes the gate
  per-stream adaptive: a quiet studio feed and an already-loud stadium feed
  both normalize to their own ambient floor.
- After calibration the baseline is a **rolling lookback percentile** over the
  last ``lookback_s`` seconds. Because the percentile is taken over a long
  window, a *short* energy rise is an anomaly relative to the (still-ambient)
  baseline and fires, while a *persistent* loud level gradually fills the
  window so the percentile (baseline) rises with it — a constant loud crowd
  becomes baseline and stops re-triggering (the "no re-trigger" property).
- The trigger threshold is an **adaptive delta** (``energy >= ratio x
  baseline``) combined with a **minimum sustain window** (``burst_min_frames``
  / ``swell_seconds`` consecutive elevated frames) so a single-sample spike
  never fires.
- **Cooldown / rate-limit** (``cooldown_s``) suppresses immediate re-trigger so
  one event does not cascade a stream of decide calls; separate roars inside a
  loud wave re-arm after the cooldown (recall driver).

Latency contract (unchanged): a trigger fires at most ``max_latency_s`` (5 s)
after the onset of the energy change it reports; the reported ``ts`` is the
onset timestamp so the candidate is anchored at the right moment.

The module is stateless-free (state lives on the instance) and unit-testable
with synthetic numpy frames — no audio files, no ffmpeg, no network.
"""
from __future__ import annotations

from collections import deque
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
    frame_s: float = 0.1  # audio chunk duration fed per update()
    # Per-stream baseline normalization (ADAAAA-6312): the ambient floor is a
    # rolling percentile, not an absolute level. During the calibration window
    # (first ``calibration_s`` seconds) the gate is disarmed and the baseline
    # is the percentile of the frames seen so far; afterwards it is the
    # percentile over the rolling lookback window so a constant loud crowd
    # becomes baseline over time (no re-trigger). ``calibration_s`` is set
    # small so a real event in the first second of a stream is still caught.
    calibration_s: float = 0.5    # disarm + establish the ambient baseline
    lookback_s: float = 8.0       # rolling lookback window for the baseline percentile
    baseline_percentile: float = 0.55  # percentile of the window = baseline
    baseline_floor: float = 1e-4  # floor so silence never divides to zero
    # Adaptive delta (relative rise over the rolling baseline) + sustain window.
    # At the tuned default the burst fast-path (burst_ratio) subsumes the swell
    # path — the two are equal, so every elevated run surfaces as a ``burst``
    # candidate within ``burst_min_frames``. Any config with swell_ratio <
    # burst_ratio re-enables distinct ``swell`` candidates for slow, sustained
    # rises; on the labeled eval set that pushes rm70 FP-rate to ~0.21
    # (marginally over the <=0.20 bound), so the default keeps them equal.
    burst_ratio: float = 1.3      # energy >= ratio x baseline -> burst frame
    swell_ratio: float = 1.3      # energy >= ratio x baseline -> swell frame
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
        self.baseline: float | None = None  # rolling percentile ambient floor
        self._history: deque[tuple[float, float]] = deque()  # (ts, energy) in window
        self._elevated: int = 0             # consecutive elevated-frame count
        self._swell_energy_sum: float = 0.0
        self._peak: float = 0.0
        self._onset_ts: float | None = None
        self._last_fired_ts: float | None = None

    # -- internals ------------------------------------------------------

    @staticmethod
    def _percentile(values: list[float], p: float) -> float | None:
        if not values:
            return None
        v = np.sort(np.asarray(values, dtype=np.float64))
        if len(v) == 1:
            return float(v[0])
        idx = (len(v) - 1) * p
        lo = int(np.floor(idx))
        hi = int(np.ceil(idx))
        if lo == hi:
            return float(v[lo])
        return float(v[lo] + (v[hi] - v[lo]) * (idx - lo))

    def _recompute_baseline(self, ts: float) -> None:
        """Prune the lookback window and set ``baseline`` to its percentile.

        While the stream is inside the calibration window the percentile is
        taken over all frames seen so far (establishes the ambient floor);
        afterwards it is the percentile over the rolling ``lookback_s`` window
        so a *persistent* loud level becomes the baseline over time.
        """
        cfg = self.cfg
        cutoff = ts - cfg.lookback_s
        while self._history and self._history[0][0] < cutoff:
            self._history.popleft()
        energies = [e for _ts, e in self._history]
        p = self._percentile(energies, cfg.baseline_percentile)
        if p is None:
            self.baseline = None
        else:
            self.baseline = max(p, cfg.baseline_floor)

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
        self._history.append((ts, e))
        self._recompute_baseline(ts)

        # Disarmed during the calibration window: let the ambient baseline
        # form before we start treating deviations as anomalies.
        if ts < cfg.calibration_s:
            return None

        base = max(self.baseline if self.baseline is not None else e, cfg.baseline_floor)
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
        self._history.clear()
        self._last_fired_ts = None
        self._reset_window()
