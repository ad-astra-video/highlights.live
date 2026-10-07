"""Scoreboard OCR / score-delta confirmation (ADAAAA-6360, decide-leg I3).

GPU-free helpers that turn a Florence-2 ``<OCR>`` reading into a score tuple
and decide whether the displayed score *changed* across a candidate window.

The perceive session runs OCR only on candidate anchor frames (bounded by the
Stage-A cooldown, per the I3 plan), so this module (a) parses the raw OCR text
into a (home, away) score and (b) keeps a short timestamped history per session
so a *later* candidate can report whether the score jumped since an earlier
reading inside the window. The delta is a hard, independent confirmation of a
goal; its absence is weak/absent evidence and never on its own confirms one.

Pure and side-effect free where possible so the parsing + delta logic can be
unit-tested without a GPU.
"""
from __future__ import annotations

import re
from collections import deque
from typing import Deque, Optional, Tuple

# A scoreboard line: two small integers joined by a dash score separator.
# Matches "2 - 1", "45-42", "Q3 45‒42". Deliberately EXCLUDES colon ("90:00"
# is a clock/minute read, not a score) and "to", so a time/clock never becomes
# a false score that could wrongly confirm a goal (ADAAAA-6360 precision).
_SCORE_LINE_RE = re.compile(
    r"(?P<a>\d{1,3})\s*[-–—]\s*(?P<b>\d{1,3})",
)

# Guard against absurd non-score integers (clock minutes, jersey numbers, etc.)
_MAX_SCORE_INT = 99


def parse_ocr_score(frame_ocr) -> Optional[Tuple[int, int]]:
    """Extract a (home, away) score tuple from OCR text lines, or ``None``.

    Heuristic: scan each OCR line for a clean two-integer score line. Returns
    ``None`` when there is no such line, so "no scoreboard / unreadable score"
    never becomes a false delta and never on its own confirms a goal.
    """
    if not frame_ocr:
        return None
    for line in frame_ocr:
        text = str(line).strip()
        if not text:
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
