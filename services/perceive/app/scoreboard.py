"""Scoreboard OCR / score-delta confirmation (ADAAAA-6360, decide-leg I3).

GPU-free helpers that turn a Florence-2 ``<OCR>`` reading into a score tuple
and decide whether the displayed score *changed* across a candidate window.

The perceive session runs OCR only on candidate anchor frames (bounded by the
Stage-A cooldown, per the I3 plan), so this module (a) parses the raw OCR text
into a (home, away) score and (b) keeps a short timestamped history per session
so a *later* candidate can report whether the score jumped since an earlier
reading inside the window. The delta is a hard, independent confirmation of a
goal; its absence is weak/absent evidence and never on its own confirms one.

ADAAAA-7081 — the OCR read is SCOPED to a scoreboard region of interest (ROI).
Only text read from inside the scoreboard ROI may produce a score. Text from the
crowd, banners, ad boards, jerseys, shot clocks or any other on-screen graphic
must never feed the score parse (a false "N - M" read would forge a score delta
and wrongly confirm a goal). The caller crops the frame to the ROI before OCR so
every line is already in-region; ``parse_ocr_score`` additionally accepts
optional per-line bounding boxes so that, when a caller has whole-frame OCR with
positions, out-of-ROI lines are filtered out before they can become a score.

Pure and side-effect free where possible so the parsing + delta logic can be
unit-tested without a GPU.
"""
from __future__ import annotations

import os
import re
from collections import deque
from dataclasses import dataclass
from typing import Deque, Optional, Sequence, Tuple

# A scoreboard line: two small integers joined by a dash score separator.
# Matches "2 - 1", "45-42", "Q3 45‒42". Deliberately EXCLUDES colon ("90:00"
# is a clock/minute read, not a score) and "to", so a time/clock never becomes
# a false score that could wrongly confirm a goal (ADAAAA-6360 precision).
_SCORE_LINE_RE = re.compile(
    r"(?P<a>\d{1,3})\s*[-–—]\s*(?P<b>\d{1,3})",
)

# Guard against absurd non-score integers (clock minutes, jersey numbers, etc.)
_MAX_SCORE_INT = 99

# --- Scoreboard region-of-interest (ADAAAA-7081) ------------------------------
# The scoreboard graphic occupies a bounded region of the broadcast frame. OCR
# must only ever read inside that region. It is configured as a normalized box
# (x0, y0, x1, y1), each 0..1, so it is independent of the frame resolution.
_SCOREBOARD_ROI_ENV = "PERCEIVE_SCOREBOARD_ROI"  # "x0,y0,x1,y1" normalized 0..1
# Default region (a typical broadcast score bug / scoreboard band). This is a
# starting point for the labelled-set calibration; operators tune
# PERCEIVE_SCOREBOARD_ROI to the exact graphic position of the video source.
_DEFAULT_SCOREBOARD_ROI = (0.0, 0.0, 1.0, 0.25)


@dataclass(frozen=True)
class ScoreboardRoi:
    """Normalized (0..1) scoreboard region of interest: ``x0 <= x1``, ``y0 <= y1``.

    ``pixel_box`` converts to an integer source-frame rectangle (clamped), and
    ``contains`` tests whether a normalized box lies inside the ROI. Nothing
    here raises; a degenerate/invalid region yields ``None`` from ``pixel_box``
    and the caller falls back to the whole frame (no score, never a crash).
    """

    x0: float
    y0: float
    x1: float
    y1: float

    def pixel_box(self, width: int, height: int) -> Optional[Tuple[int, int, int, int]]:
        """Return ``(px0, py0, px1, py1)`` integer box clamped to the frame, or
        ``None`` when the region or frame is degenerate."""
        if width < 1 or height < 1:
            return None
        if not (0.0 <= self.x0 < self.x1 <= 1.0 and 0.0 <= self.y0 < self.y1 <= 1.0):
            return None
        px0 = max(0, int(round(self.x0 * width)))
        py0 = max(0, int(round(self.y0 * height)))
        px1 = min(width, int(round(self.x1 * width)))
        py1 = min(height, int(round(self.y1 * height)))
        if px1 - px0 < 5 or py1 - py0 < 5:
            return None
        return (px0, py0, px1, py1)

    def contains(self, box: Sequence[float]) -> bool:
        """True when the normalized ``box`` (x0, y0, x1, y1) overlaps the ROI."""
        if len(box) != 4:
            return False
        bx0, by0, bx1, by1 = (float(v) for v in box)
        # Track the ROI as inclusive on its lower/upper bounds so a line exactly
        # on the region edge is not silently dropped.
        return bx1 >= self.x0 and bx0 <= self.x1 and by1 >= self.y0 and by0 <= self.y1

    @classmethod
    def from_env(cls, raw: Optional[str] = None) -> "ScoreboardRoi":
        """Build the ROI from ``PERCEIVE_SCOREBOARD_ROI`` (``"x0,y0,x1,y1"``).

        A malformed/out-of-range value falls back to ``DEFAULT`` (and never
        raises), so a bad env value cannot crash the candidate path.
        """
        text = (raw if raw is not None else os.environ.get(_SCOREBOARD_ROI_ENV, "")).strip()
        try:
            vals = [float(v) for v in text.split(",")]
        except (TypeError, ValueError):
            vals = []
        if len(vals) == 4:
            roi = cls(*vals)
            if roi.pixel_box(1920, 1080) is not None:  # sanity: reachable region
                return roi
        return cls(*_DEFAULT_SCOREBOARD_ROI)

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"ScoreboardRoi({self.x0:.3f},{self.y0:.3f},{self.x1:.3f},{self.y1:.3f})"


def _line_in_roi(roi: ScoreboardRoi | None, box: Optional[Sequence[float]]) -> bool:
    """Whether a single OCR line (with optional normalized box) is in the ROI.

    When ``roi`` is ``None`` every line is accepted (legacy whole-frame mode).
    When ``roi`` is set but the line carries no box, the line is accepted only
    if the caller already cropped the frame to the ROI (the crop path); a
    box-less line with an active ROI is treated as in-region so cropping stays
    the single source of truth and never drops a real score.
    """
    if roi is None:
        return True
    if box is None:
        return True
    return roi.contains(box)


def parse_ocr_score(
    frame_ocr,
    roi: Optional[ScoreboardRoi] = None,
    ocr_boxes: Optional[Sequence[Optional[Sequence[float]]]] = None,
) -> Optional[Tuple[int, int]]:
    """Extract a (home, away) score tuple from OCR text lines, or ``None``.

    Heuristic: scan each OCR line for a clean two-integer score line. Returns
    ``None`` when there is no such line, so "no scoreboard / unreadable score"
    never becomes a false delta and never on its own confirms a goal.

    ADAAAA-7081 ROI scoping: ``ocr_boxes`` is an optional parallel list of
    normalized ``(x0, y0, x1, y1)`` boxes (one per OCR line). When ``roi`` and
    ``ocr_boxes`` are both given, a line is only eligible to become a score if
    its box lies within the scoreboard ROI — crowd / banner / jersey / clock
    text outside the ROI can never produce a score. When the caller crops the
    frame to the ROI before ``<OCR>`` (the production path), pass just the
    ROI-scoped ``frame_ocr`` and this behaviour is unchanged.
    """
    if not frame_ocr:
        return None
    for i, line in enumerate(frame_ocr):
        text = str(line).strip()
        if not text:
            continue
        box = ocr_boxes[i] if ocr_boxes is not None and i < len(ocr_boxes) else None
        if not _line_in_roi(roi, box):
            continue
        m = _SCORE_LINE_RE.search(text)
        if not m:
            continue
        a = int(m.group("a"))
        b = int(m.group("b"))
        if a <= _MAX_SCORE_INT and b <= _MAX_SCORE_INT:
            return (a, b)
    return None


def score_changed(prev: Optional[Tuple[int, int]], curr: Optional[Tuple[int, int]]) -> bool:
    """True when ``curr`` is a real score that differs from ``prev``.

    Either side being ``None`` (unreadable / not yet seen) is *not* a delta —
    we only confirm a change between two concrete, different readings.
    """
    if prev is None or curr is None:
        return False
    return prev != curr


class ScoreboardTracker:
    """Per-session rolling history of scoreboard readings.

    ``record`` adds a score read from a candidate anchor frame; ``changed``
    reports whether the newest reading within ``window_seconds`` differs from
    the earliest surviving one. Bounded (``maxlen``) so it never grows on long
    streams; stale readings are pruned against the window.
    """

    def __init__(self, window_seconds: float = 60.0, maxlen: int = 32):
        self.window_seconds = window_seconds
        self._readings: Deque[Tuple[float, Tuple[int, int]]] = deque(maxlen=maxlen)

    def record(self, timestamp: float, score: Optional[Tuple[int, int]]) -> None:
        if score is None:
            return
        self._readings.append((timestamp, score))

    def changed(self, timestamp: float) -> bool:
        """True when the newest score in the window differs from the earliest
        surviving score recorded within ``window_seconds`` ending at
        ``timestamp``. Requires at least two concrete readings."""
        cutoff = timestamp - self.window_seconds
        while self._readings and self._readings[0][0] < cutoff:
            self._readings.popleft()
        if len(self._readings) < 2:
            return False
        return score_changed(self._readings[0][1], self._readings[-1][1])

    def clear(self) -> None:
        self._readings.clear()
