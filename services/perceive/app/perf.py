"""Per-stage wall-clock accounting for the perceive runner (ADAAAA-8004).

The live rail's AC3 gate is measured on a per-observation step cost (~0.93 s
observed against a 0.35 s arrival interval at 3 fps), but until this module the
only timed stage was the Florence `<OD>` pass (`record_analyze`) — SAM, the ROI
recovery pass, scoreboard OCR, decode and the trickle fetch/publish legs were
inferred, not measured. This module times every stage of one frame and
summarises the samples so an operator can read the decomposition from the log
(`[perf]` lines, no DEBUG needed) or from `GET /perf`.

Design rules:

- Wall-clock seconds, monotonic clock. A stage that is skipped on a frame simply
  contributes no sample (its `count` stays lower than `steps`).
- Bounded memory: a fixed-size deque per stage (`PERCEIVE_PERF_WINDOW`, default
  512 samples). A long stream never grows it.
- Cheap: one `monotonic()` pair per stage, a lock held only for the append.
- No behaviour change: importing/using this module never alters the pipeline.
  It is accounting only.
- Stage names are constants so the log line, the `/perf` payload and the tests
  all agree.

Stages logged per frame (all optional except `frame`):

    decode        base64/PNG/JPEG -> RGB array
    fetch_wait    trickle subscribe wait for the next video-in segment (idle time)
    detect        full-frame Florence <OD> pass
    roi           bounded zoomed-crop ROI recovery pass (up to N tiles)
    ocr           scoreboard <OCR> reads for the frame (all of them)
    sam           tracker.step_frame / step (SAM advance + IoU/CD layer)
    ball_signal   ball-centric velocity/possession signal
    goal_signal   goal-plane classifier update
    publish       events-out publish of the observation
    frame         whole process_frame() call (the observe step's compute)
"""
from __future__ import annotations

import logging
import math
import os
import threading
from collections import deque
from contextlib import contextmanager

log = logging.getLogger("highlights.perceive.perf")

# Ordered so the log line and the /perf payload are stable and comparable.
STAGES: tuple[str, ...] = (
    "decode",
    "fetch_wait",
    "detect",
    "roi",
    "ocr",
    "sam",
    "ball_signal",
    "goal_signal",
    "publish",
    "frame",
    "step",
)


def _env_int(name: str, default: int) -> int:
    try:
        v = int(str(os.environ.get(name, default)).strip())
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


def _percentile(sorted_vals: list[float], q: float) -> float:
    """Nearest-rank percentile on an already-sorted list (q in 0..1)."""
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, math.ceil(q * len(sorted_vals)) - 1))
    return sorted_vals[idx]


class StageRecorder:
    """Thread-safe per-stage duration recorder with bounded sample windows."""

    def __init__(self, window: int | None = None, log_every: int | None = None) -> None:
        self.window = window or _env_int("PERCEIVE_PERF_WINDOW", 512)
        self.log_every = log_every or _env_int("PERCEIVE_PERF_LOG_EVERY", 50)
        self._samples: dict[str, deque[float]] = {s: deque(maxlen=self.window) for s in STAGES}
        self._lock = threading.Lock()
        self.steps = 0
        self._last: dict[str, float] = {}

    # --- recording -------------------------------------------------------
    def add(self, stage: str, seconds: float) -> None:
        if seconds is None or seconds < 0:
            return
        if stage not in self._samples:
            # Unknown stage names are recorded too (a future stage should not be
            # silently dropped); they just never appear in the canonical order.
            with self._lock:
                self._samples[stage] = deque(maxlen=self.window)
        with self._lock:
            self._samples[stage].append(float(seconds))
            self._last[stage] = float(seconds)

    def add_many(self, timings: dict[str, float]) -> None:
        for stage, seconds in timings.items():
            self.add(stage, seconds)

    def step_done(self) -> None:
        """Count one completed frame and emit the periodic INFO summary."""
        with self._lock:
            self.steps += 1
            steps = self.steps
        if steps == 1 or steps % self.log_every == 0:
            self.log_summary()

    # --- reads -----------------------------------------------------------
    def last(self) -> dict[str, float]:
        with self._lock:
            return dict(self._last)

    def summary(self) -> dict:
        with self._lock:
            steps = self.steps
            snapshot = {s: list(v) for s, v in self._samples.items()}
            last = dict(self._last)
        out: dict = {"steps": steps, "window": self.window, "stages": {}, "last": last}
        for stage, vals in snapshot.items():
            if not vals:
                continue
            ordered = sorted(vals)
            n = len(ordered)
            out["stages"][stage] = {
                "count": n,
                "mean": round(sum(ordered) / n, 4),
                "p50": round(_percentile(ordered, 0.50), 4),
                "p95": round(_percentile(ordered, 0.95), 4),
                "max": round(ordered[-1], 4),
                "sum": round(sum(ordered), 3),
            }
        return out

    def log_summary(self) -> dict:
        s = self.summary()
        parts = []
        for stage in STAGES:
            st = s["stages"].get(stage)
            if not st:
                continue
            parts.append(f"{stage} p50={st['p50']:.3f} p95={st['p95']:.3f} max={st['max']:.3f} n={st['count']}")
        if parts:
            log.info("[perf] steps=%d %s", s["steps"], " | ".join(parts))
        return s

    def reset(self) -> None:
        with self._lock:
            for d in self._samples.values():
                d.clear()
            self.steps = 0
            self._last.clear()


# Process-wide recorder: one perceive process serves every session, and the
# live rail is capacity-bounded, so a single window is the honest sample.
_recorder = StageRecorder()


def recorder() -> StageRecorder:
    return _recorder


def reset() -> None:
    _recorder.reset()


@contextmanager
def timed(stage: str, rec: StageRecorder | None = None):
    """Time a block into `stage`. Never swallows an exception from the block."""
    import time

    t0 = time.monotonic()
    try:
        yield
    finally:
        (rec or _recorder).add(stage, time.monotonic() - t0)


def now() -> float:
    """Monotonic seconds — shared clock for callers that time several stages."""
    import time

    return time.monotonic()
