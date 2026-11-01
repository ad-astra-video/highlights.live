"""Stage-A audio noise-change gate (ADAAAA-4325 / INC-2; ADAAAA-4970 noise-adaptive
tune; ADAAAA-6312 baseline normalization + rolling lookback anomaly detector;
ADAAAA-7674 ambient-window re-tune, 8 s -> 6 s).

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


def normalized_samples(samples: np.ndarray) -> np.ndarray:
    """Mono float samples in ``[-1, 1]`` regardless of int16/float input."""
    a = np.asarray(samples, dtype=np.float64)
    if a.size == 0:
        return a
    if float(np.max(np.abs(a))) > 1.0:
        a = a / 32768.0
    return a


def band_energy(samples: np.ndarray, sample_rate: int, lo_hz: float, hi_hz: float) -> float:
    """Hann-windowed spectral energy inside ``[lo_hz, hi_hz]``, per-sample normalized.

    Returns ``sum(|X(f)|^2) / n`` over the band, which is the band's mean power
    per sample and therefore comparable between bands of different width.
    """
    a = normalized_samples(samples)
    if a.size < 32 or sample_rate <= 0:
        return 0.0
    window = np.hanning(a.size)
    spec = np.abs(np.fft.rfft(a * window)) ** 2
    freqs = np.fft.rfftfreq(a.size, 1.0 / sample_rate)
    idx = (freqs >= lo_hz) & (freqs <= hi_hz)
    if not np.any(idx):
        return 0.0
    return float(spec[idx].sum()) / float(a.size)


def band_tonality(samples: np.ndarray, sample_rate: int, lo_hz: float, hi_hz: float) -> tuple[float, float]:
    """(peak/mean, spectral flatness) of the band — a tonal vs broadband discriminator.

    A referee whistle concentrates its energy in one narrow peak (high
    peak/mean, low flatness); crowd noise spreads it across the band (flatness
    near 1). Used to reject broadband transients that merely raise the band.
    """
    a = normalized_samples(samples)
    if a.size < 32 or sample_rate <= 0:
        return 0.0, 1.0
    spec = np.abs(np.fft.rfft(a * np.hanning(a.size))) ** 2
    freqs = np.fft.rfftfreq(a.size, 1.0 / sample_rate)
    idx = (freqs >= lo_hz) & (freqs <= hi_hz)
    if not np.any(idx):
        return 0.0, 1.0
    band = spec[idx]
    mean = float(band.mean())
    if mean <= 0.0:
        return 0.0, 1.0
    peak = float(band.max())
    flat = float(np.exp(np.mean(np.log(np.maximum(band, 1e-20)))) / mean)
    return peak / mean, flat


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
    # ADAAAA-7674 re-tune: 8.0 -> 6.0 s. At 8 s the frames of a roar stay inside
    # the rolling percentile window long enough that the *following* roar in the
    # same celebration wave is measured against a baseline that still contains
    # the previous roar, so it never reaches `burst_ratio` (nearby roars
    # coalesce into one fire). 6 s clears a roar from the ambient window before
    # the next one lands, restoring the distinct fire without touching the
    # trigger ratio — measured on `real_goal_3080`: recall 0.78 (25/32) ->
    # 0.875 (28/32), trigger-window FP rate 0.14 -> 0.095, p50/p95 latency
    # unchanged at 0.20 s, and cross-clip trigger volume on `real_match_70s`
    # unchanged (13 candidates / 70 s), i.e. recall was not bought with
    # sensitivity. `thresholdId` is unchanged (`stageA/burst/1.3x/0.3s`).
    lookback_s: float = 6.0       # rolling lookback window for the baseline percentile
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
    # ADAAAA-7658 AC5: identity of the operating point that fired, so the live
    # and VOD passes agree on WHICH threshold produced a trigger record.
    threshold_id: str = ""


@dataclass
class AudioEnergyGate:
    cfg: GateConfig = field(default_factory=GateConfig)

    def __post_init__(self) -> None:
        self.baseline: float | None = None  # rolling percentile ambient floor
        self._history: deque[tuple[float, float]] = deque()  # (ts, energy) in window
        # ADAAAA-7255: bounded per-chunk (ts, energy, baseline) inspection series
        # for the web request-inspection energy-vs-baseline graph. Bounded to the
        # same rolling lookback window as ``_history`` so it never grows on a long
        # stream. Purely passive capture — the trigger logic below is unchanged.
        self._series: deque[tuple[float, float, float]] = deque()  # (ts, energy, baseline)
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

    def _capture_series(self, ts: float, energy: float) -> None:
        """Record one (ts, energy, baseline) inspection point (ADAAAA-7255).

        Bounded to the same rolling lookback window as ``_history`` so it never
        grows on a long stream. The baseline recorded is the gate's ambient
        percentile at this chunk (floored), so the web graph shows exactly the
        signal the gate compares against. Passive — never affects triggering.
        """
        base = self.baseline if self.baseline is not None else energy
        self._series.append((ts, energy, float(max(base, self.cfg.baseline_floor))))
        cutoff = ts - self.cfg.lookback_s
        while self._series and self._series[0][0] < cutoff:
            self._series.popleft()

    def series_snapshot(self) -> list[dict]:
        """The bounded per-chunk (t, energy, baseline) inspection series.

        Ordered oldest -> newest, covering at most the last ``lookback_s``
        seconds of the stream. Each point is ``{"t": ts, "energy": e,
        "baseline": b}`` (seconds over the stream, both energies 0..1). Pure
        read of captured state — no recomputation, no inference.
        """
        return [{"t": round(ts, 3), "energy": round(e, 6), "baseline": round(b, 6)} for (ts, e, b) in self._series]

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
        self._capture_series(ts, e)

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
        # ADAAAA-7658 AC5: the trigger record names the threshold that fired.
        # Threshold id = gate path + the ratio/sustain that produced the fire,
        # e.g. ``stageA/burst/1.3x/0.3s`` — stable enough for live and VOD to
        # agree on what a trigger is, specific enough to tell two operating
        # points apart after a re-tune.
        ratio = self.cfg.burst_ratio if kind == "burst" else self.cfg.swell_ratio
        sustain_s = (
            self.cfg.burst_min_frames * self.cfg.frame_s
            if kind == "burst"
            else self.cfg.swell_seconds
        )
        threshold_id = f"stageA/{kind}/{ratio:g}x/{sustain_s:g}s"
        sig = AudioGateSignal(
            kind=kind,
            ts=onset,
            fired_at=fired_at,
            onset_latency_s=round(fired_at - onset, 3),
            peak_energy=round(self._peak, 6),
            baseline_energy=round(max(baseline, self.cfg.baseline_floor), 6),
            frames=self._elevated,
            threshold_id=threshold_id,
        )
        self._last_fired_ts = fired_at
        self._reset_window()
        return sig

    def reset(self) -> None:
        """Clear all state (new session / new stream)."""
        self.baseline = None
        self._history.clear()
        self._series.clear()
        self._last_fired_ts = None
        self._reset_window()


# ---------------------------------------------------------------------------
# Stage-B band-limited whistle path (ADAAAA-7682)
#
# Stage-A above is a BROADBAND level-change gate: it compares frame RMS against
# a rolling percentile of frame RMS. A referee whistle is a narrowband tonal
# burst whose RMS sits at the crowd floor, so Stage-A measures 0.00 recall on
# it (ADAAAA-7674: 0/2 onsets, FP 1.00) — that is a property of the detector,
# not a tuning problem. This path is a separate component: it baselines the
# *2.4-3.4 kHz band* energy (the band a pea whistle occupies), so a tonal burst
# 6-30x over its own ambient fires while a crowd roar — which raises the low and
# speech bands at least as much — does not.
# ---------------------------------------------------------------------------


@dataclass
class WhistleConfig:
    """Operating point of the band-limited whistle path.

    ``emitted`` is the emit switch: detection is always computed (so the live
    log and the eval harness can count candidates), and when it is True a fire
    becomes a scheduling candidate — one anchored gemma analysis per whistle
    (ADAAAA-7705 Option 3, priced in ADAAAA-7682 AC5). It ships **True**; the
    rollback is flipping it back to False (config only — no code revert, no
    logic redeploy), which restores measure-only reporting.
    """

    frame_s: float = 0.1
    sample_rate: int = 16000  # production PCM on both rails (server tap + media relay)
    band_lo_hz: float = 2400.0
    band_hi_hz: float = 3400.0
    # Guards: a whistle band rise is only a whistle if the *other* bands stay
    # near their ambient level (a roar raises speech/low too) and the band is
    # tonal (a click/pop is broadband).
    speech_lo_hz: float = 300.0
    speech_hi_hz: float = 2000.0
    low_lo_hz: float = 60.0
    low_hi_hz: float = 300.0
    guard_max_ratio: float = 3.0     # speech/low band must stay below this x ambient
    min_tonality: float = 6.0        # peak/mean inside the whistle band
    max_flatness: float = 0.25       # spectral flatness inside the whistle band
    calibration_s: float = 0.5
    lookback_s: float = 6.0          # same rolling ambient window as Stage-A
    baseline_percentile: float = 0.55
    baseline_floor: float = 1e-10
    whistle_ratio: float = 5.0       # band energy >= ratio x rolling band baseline
    sustain_frames: int = 3          # consecutive elevated frames (~0.3 s at frame_s 0.1)
    cooldown_s: float = 2.0
    max_latency_s: float = 5.0
    emitted: bool = True             # graduated to emitting (ADAAAA-7705 Option 3); False = measure-only

    @property
    def threshold_id(self) -> str:
        """Stable identity of this operating point (named in every trigger record)."""
        lo = self.band_lo_hz / 1000.0
        hi = self.band_hi_hz / 1000.0
        sustain_s = self.sustain_frames * self.frame_s
        return f"stageB/whistle/{lo:g}-{hi:g}k/{self.whistle_ratio:g}x/{sustain_s:g}s"


@dataclass
class BandLimitedWhistleGate:
    """Band-limited (2.4-3.4 kHz) tonal-burst detector — the whistle trigger path.

    Mirrors the Stage-A baseline mechanics (rolling percentile ambient baseline,
    sustain window, cooldown, onset-anchored ``ts``) but on the whistle band
    instead of broadband RMS. ``update`` returns an :class:`AudioGateSignal` with
    ``kind="burst"`` and ``threshold_id="stageB/whistle/2.4-3.4k/<ratio>x/<sustain>s"``
    so the frozen ``AudioSignalSchema`` contract is unchanged and a later re-tune
    cannot redefine what a historical trigger meant.
    """

    cfg: WhistleConfig = field(default_factory=WhistleConfig)

    def __post_init__(self) -> None:
        self.baseline: float | None = None
        self._history: deque[tuple[float, float]] = deque()  # (ts, band energy)
        self._guard_history: dict[str, deque[float]] = {
            "speech": deque(), "low": deque(),
        }
        self._elevated: int = 0
        self._peak_band: float = 0.0
        self._peak_rms: float = 0.0
        self._onset_ts: float | None = None
        self._last_fired_ts: float | None = None
        self._frames_seen: int = 0
        # Measure-only accounting: every fire is counted even when it is not
        # emitted into candidate scheduling.
        self.fired_count: int = 0
        self.emitted_count: int = 0

    # -- internals ------------------------------------------------------

    @staticmethod
    def _percentile(values: list[float], p: float) -> float | None:
        return AudioEnergyGate._percentile(values, p)

    def _prune(self, ts: float) -> None:
        cutoff = ts - self.cfg.lookback_s
        while self._history and self._history[0][0] < cutoff:
            self._history.popleft()
        for b in self._guard_history.values():
            while len(b) > int(self.cfg.lookback_s / self.cfg.frame_s):
                b.popleft()

    def _recompute_baseline(self, ts: float) -> None:
        self._prune(ts)
        energies = [e for _ts, e in self._history]
        p = self._percentile(energies, self.cfg.baseline_percentile)
        self.baseline = None if p is None else max(p, self.cfg.baseline_floor)

    def _in_cooldown(self, ts: float) -> bool:
        return self._last_fired_ts is not None and ts - self._last_fired_ts < self.cfg.cooldown_s

    def _reset_window(self) -> None:
        self._elevated = 0
        self._peak_band = 0.0
        self._peak_rms = 0.0
        self._onset_ts = None

    # -- main API --------------------------------------------------------

    def update(self, samples: np.ndarray, ts: float) -> AudioGateSignal | None:
        """Feed one audio chunk at ``ts``; return a whistle signal when it fires."""
        cfg = self.cfg
        band = band_energy(samples, cfg.sample_rate, cfg.band_lo_hz, cfg.band_hi_hz)
        speech = band_energy(samples, cfg.sample_rate, cfg.speech_lo_hz, cfg.speech_hi_hz)
        low = band_energy(samples, cfg.sample_rate, cfg.low_lo_hz, cfg.low_hi_hz)
        tonality, flatness = band_tonality(samples, cfg.sample_rate, cfg.band_lo_hz, cfg.band_hi_hz)

        self._history.append((ts, band))
        self._guard_history["speech"].append(speech)
        self._guard_history["low"].append(low)
        self._frames_seen += 1
        self._recompute_baseline(ts)

        if ts < cfg.calibration_s or self.baseline is None:
            return None

        ratio = band / max(self.baseline, cfg.baseline_floor)
        speech_ratio = speech / max(self._percentile(list(self._guard_history["speech"]), cfg.baseline_percentile) or cfg.baseline_floor, cfg.baseline_floor)
        low_ratio = low / max(self._percentile(list(self._guard_history["low"]), cfg.baseline_percentile) or cfg.baseline_floor, cfg.baseline_floor)

        is_tone = (
            ratio >= cfg.whistle_ratio
            and speech_ratio <= cfg.guard_max_ratio
            and low_ratio <= cfg.guard_max_ratio
            and tonality >= cfg.min_tonality
            and flatness <= cfg.max_flatness
        )

        if self._in_cooldown(ts):
            return None

        if not is_tone:
            self._reset_window()
            return None

        if self._elevated == 0:
            self._onset_ts = ts
            self._peak_band = band
        else:
            self._peak_band = max(self._peak_band, band)
        self._elevated += 1
        self._peak_rms = max(self._peak_rms, frame_energy(samples))

        if self._elevated >= cfg.sustain_frames:
            return self._fire(ts)
        return None

    def _fire(self, fired_at: float) -> AudioGateSignal:
        onset = self._onset_ts if self._onset_ts is not None else fired_at
        baseline = self.baseline if self.baseline is not None else 0.0
        sig = AudioGateSignal(
            kind="burst",
            ts=onset,
            fired_at=fired_at,
            onset_latency_s=round(fired_at - onset, 3),
            peak_energy=round(min(1.0, self._peak_rms), 6),
            baseline_energy=round(max(baseline, self.cfg.baseline_floor), 6),
            frames=self._elevated,
            threshold_id=self.cfg.threshold_id,
        )
        self._last_fired_ts = fired_at
        self._reset_window()
        self.fired_count += 1
        return sig

    def reset(self) -> None:
        """Clear all state (new session / new stream)."""
        self.baseline = None
        self._history.clear()
        for b in self._guard_history.values():
            b.clear()
        self._last_fired_ts = None
        self._reset_window()

