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

ADAAAA-7086 — the ROI is no longer a hard-coded / per-source calibrated box.
``ScoreboardLocator`` uses the vision model's region-discovery pass to (a)
assess whether a scoreboard is actually visible in the frame and (b) predict the
normalized scoreboard box per source, so a scorebug sitting anywhere in the
frame (e.g. bottom-right) is still found without a hand-tuned
``PERCEIVE_SCOREBOARD_ROI``. When no scoreboard is visible the caller gates the
OCR pass off entirely (no score, no ``ocrHits``), so non-scoreboard text can
never drive ``scoreBoardChanged`` or ``ocrHits``. ``PERCEIVE_SCOREBOARD_ROI``
remains as an explicit per-source calibration override.

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


def _parse_env_roi(raw: Optional[str]) -> Optional[ScoreboardRoi]:
    """Parse a normalized ROI string (``"x0,y0,x1,y1"``) into a ``ScoreboardRoi``.

    Returns ``None`` for an unset, malformed, or out-of-range value. Unlike
    ``from_env`` (whose whole point is a safe default fallback and never raises),
    this returns ``None`` so a caller can tell "no calibration configured" apart
    from "calibrated to the default region".
    """
    text = (raw or "").strip()
    if not text:
        return None
    try:
        vals = [float(v) for v in text.split(",")]
    except (TypeError, ValueError):
        return None
    if len(vals) != 4:
        return None
    roi = ScoreboardRoi(*vals)
    if roi.pixel_box(1920, 1080) is not None:  # sanity: reachable region
        return roi
    return None


def explicit_scoreboard_roi(raw: Optional[str] = None) -> Optional[ScoreboardRoi]:
    """The explicitly-configured ``PERCEIVE_SCOREBOARD_ROI``, or ``None``.

    Use this when you need to distinguish an operator-supplied calibration ROI
    (an explicit override that says "this source's scoreboard lives here") from
    the built-in default that ``ScoreboardRoi.from_env`` would fall back to. A
    ``None`` result means "no explicit calibration" and lets the caller fall
    through to auto-detection instead of silently cropping to a top-band guess.
    """
    return _parse_env_roi(raw if raw is not None else os.environ.get(_SCOREBOARD_ROI_ENV, ""))


# --- Scoreboard visibility / locator (ADAAAA-7086) ----------------------------
# Instead of assuming a fixed geometric ROI, the perceive vision step assesses
# whether a scoreboard is actually visible in the frame and, when it is, predicts
# the scoreboard box. This removes the per-source PERCEIVE_SCOREBOARD_ROI
# calibration dependency for recall (a scorebug in a non-default corner is still
# found) and gates the OCR pass off when no scoreboard is present (so non-score
# text can never drive scoreBoardChanged / ocrHits).
#
# A single "N - M" style caption keyword is a strong signal the region is a
# scoreboard; generic arena words are weaker. The score is deliberately coarse
# and the threshold conservative: an unreliable region is better ignored (gate)
# than misread as a scoreboard.
_SCOREBOARD_CAPTION_KEYWORDS = (
    "scoreboard",
    "score board",
    "score bug",
    "scorebug",
    "score card",
    "score line",
    "scoreline",
    "home score",
    "away score",
    "score",
)
# A caption that itself contains a "N - M" score is a strong scoreboard signal.
_SCOREBOARD_CAPTION_PATTERN = _SCORE_LINE_RE
# Minimum region score for a region to be treated as a scoreboard (recall vs
# precision: too low picks up an unrelated number graphic; too high drops a real
# scoreboard). Requiring at least one keyword/signal keeps the gate honest.
_SCOREBOARD_MIN_REGION_SCORE = 2


def _bbox_normalized(box: Optional[Sequence[float]]) -> bool:
    """True when ``box`` is a well-formed normalized (0..1) ``(x0,y0,x1,y1)`` box."""
    if box is None or len(box) != 4:
        return False
    try:
        xs = [float(v) for v in box]
    except (TypeError, ValueError):
        return False
    return 0.0 <= xs[0] < xs[2] <= 1.0 and 0.0 <= xs[1] < xs[3] <= 1.0


def _region_score(region: dict) -> int:
    """Score a discovery region (caption + optional bbox) for scoreboard-ness."""
    cap = str((region.get("caption") or "")).lower()
    if not cap:
        return 0
    score = 0
    for kw in _SCOREBOARD_CAPTION_KEYWORDS:
        if kw in cap:
            score += 2
    if _SCOREBOARD_CAPTION_PATTERN.search(cap):
        score += 4  # a literal home-away score read is a strong scoreboard signal
    if _bbox_normalized(region.get("bbox")):
        score += 1
    return int(score)


def _region_to_roi(box: Optional[Sequence[float]], pad: float = 0.04) -> Optional[ScoreboardRoi]:
    """Expand a normalized discovery ``bbox`` into a padded, valid ``ScoreboardRoi``."""
    if not _bbox_normalized(box):
        return None
    assert box is not None  # _bbox_normalized rejected None above
    x0, y0, x1, y1 = (float(v) for v in box)
    roi = ScoreboardRoi(
        max(0.0, x0 - pad),
        max(0.0, y0 - pad),
        min(1.0, x1 + pad),
        min(1.0, y1 + pad),
    )
    if roi.pixel_box(1920, 1080) is None:
        return None
    return roi


class ScoreboardLocator:
    """Predict the scoreboard region of a broadcast frame (ADAAAA-7086).

    Wraps the vision model's region-discovery pass (``<DENSE_REGION_CAPTION>`` /
    ``<REGION_PROPOSAL>``), which returns candidate regions with captions and
    normalized boxes. ``locate`` picks the region that looks most like a
    scoreboard and returns a padded ``ScoreboardRoi`` for it; it returns ``None``
    when no scoreboard is visible so the caller can gate the OCR pass off.

    The ``discover`` callable is injected (production passes
    ``florence.FlorenceDetector.discover``) so this class stays GPU-free and can
    be unit-tested with a stub. Detection failure never raises — it degrades to
    ``None`` (no scoreboard) rather than crashing the candidate path.
    """

    def __init__(self, discover, pad: float = 0.04):
        self._discover = discover
        self._pad = pad

    def locate(self, image) -> Optional[ScoreboardRoi]:
        """Return a ``ScoreboardRoi`` for the frame's scoreboard, or ``None``.

        ``None`` means "no scoreboard visible" — the caller gates the OCR pass
        off. Also ``None`` on a missing image, a failing/poor discovery result,
        or when no region scores above the threshold, so it can never misfire.
        """
        if image is None:
            return None
        try:
            res = self._discover(image, task="<DENSE_REGION_CAPTION>")
        except Exception:  # noqa: BLE001 - never crash the candidate path
            return None
        regions = (res or {}).get("regions") or []
        best = None
        best_score = 0
        for region in regions:
            score = _region_score(region)
            if score > best_score:
                best = region
                best_score = int(score)
        if best is None or best_score < _SCOREBOARD_MIN_REGION_SCORE:
            return None
        return _region_to_roi(best.get("bbox"), pad=self._pad)


def fallback_score_eligible(
    box: Optional[Sequence[float]], roi: Optional[ScoreboardRoi]
) -> bool:
    """Whether the vision-LLM ``score`` text may stand in for an empty OCR crop
    (ADAAAA-7094).

    The vision-LLM score-text fallback — used when the LLM-localized crop
    ``<OCR>`` comes back empty (e.g. a faint scorebug Florence-2 cannot parse)
    — is only trusted as a score when the LLM *localized* the scoreboard AND
    that box actually overlaps the configured scoreboard ROI (``roi``). A
    hallucinated / unsupported box over a no-text region (crowd, banners, ad
    boards), or a score the LLM could not localize, never qualifies. So a
    hallucinated ``"N - M"`` can never reach :func:`parse_ocr_score` and forge a
    ``scoreBoardChanged`` delta. A missing box or ROI degrades to ``False``
    ("no clean score line"), never a forged delta, while real in-ROI faint
    scorebugs (the recall case the fallback exists to catch) still pass.
    """
    if roi is None or box is None:
        return False
    if len(box) != 4:
        return False
    try:
        return roi.contains([float(v) for v in box])
    except (TypeError, ValueError):
        return False


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


# ADAAAA-7844: a measured scoreboard delta must be LEGIBLE on both sides and
# CONSISTENT across OCR samples, not a single-frame flip. A one-frame OCR
# misread (a stat line / sponsor graphic / clock read as "N - M") produced a
# paired spurious delta (0-0 -> X-Y on the misread frame, X-Y -> 0-0 on the
# next), and the server folded each of those single-frame "changes" into the
# window as a measured scoreboard attestation. Requiring at least this many
# concrete readings on EACH side of the transition means a transient misread
# can never corroborate a goal: the post side has to stay stable, and the pre
# side has to have been read more than once before the flip.
SCOREBOARD_MIN_CONSISTENT_SAMPLES = 2

# ADAAAA-7844: the confirming read must be close to the transition instant. A
# transition whose post side only gets its second read tens of seconds later is
# a STALE delta relative to the frame that would attest the window (the class
# ADAAAA-7543 closed); it is reported as no measurement rather than a fresh one.
SCOREBOARD_MAX_CONFIRM_GAP_S = 10.0


@dataclass(frozen=True)
class ScoreboardDelta:
    """A legible, time-tied scoreboard transition measured from OCR readings.

    ``pre`` / ``post`` are the two parsed ``(home, away)`` scores; ``pre_ts`` /
    ``post_ts`` are the timestamps of the concrete reads that bracket the
    transition (``post_ts`` is the first frame showing the new score, i.e. the
    delta instant). ``pre_samples`` / ``post_samples`` are the contiguous
    concrete reads supporting each side inside the tracker window.

    ``to_dict`` is the wire shape the server folds into a window bias hint and
    forwards to the decide ``/confirm`` pass, so the corroboration label can be
    tied to a MEASURED delta instead of a bare boolean (ADAAAA-7844).
    """

    pre: Tuple[int, int]
    post: Tuple[int, int]
    pre_ts: float
    post_ts: float
    pre_samples: int
    post_samples: int

    def to_dict(self) -> dict:
        return {
            "pre": [int(self.pre[0]), int(self.pre[1])],
            "post": [int(self.post[0]), int(self.post[1])],
            "preTs": round(float(self.pre_ts), 3),
            "postTs": round(float(self.post_ts), 3),
            "deltaTs": round(float(self.post_ts), 3),
            "preSamples": int(self.pre_samples),
            "postSamples": int(self.post_samples),
        }


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
        """True when a LEGIBLE, time-tied score transition is measured at this
        frame (ADAAAA-7543, tightened by ADAAAA-7844).

        Historic (ADAAAA-6360) behaviour compared the newest reading against the
        EARLIEST surviving reading within ``window_seconds``; that re-reported a
        stale delta for up to a full window. ADAAAA-7543 changed it to compare
        the two most recent readings, which time-correlates the delta to the
        frame where the score actually changed. ADAAAA-7844 adds the legibility
        bar: the transition only counts when both sides are parsed, differ, and
        are each supported by at least ``min_samples`` contiguous OCR readings
        inside the window (see :meth:`delta`). A single-frame OCR misread can no
        longer fire ``scoreBoardChanged``.
        """
        return self.delta(timestamp) is not None

    def delta(
        self, timestamp: float, min_samples: int = SCOREBOARD_MIN_CONSISTENT_SAMPLES
    ) -> Optional[ScoreboardDelta]:
        """The most recent legible, time-tied score transition, or ``None``.

        A transition is the boundary between two CONSECUTIVE concrete readings
        that differ. It is credited only when the reading immediately before it
        and the one at it are both parsed, and each side is backed by at least
        ``min_samples`` contiguous readings (the post side proves the new score
        is stable, the pre side proves the old score was not a transient
        misread). Returns the parsed pre/post strings plus the sample counts and
        timestamps so the caller can report and persist a MEASURED delta rather
        than a boolean.
        """
        cutoff = timestamp - self.window_seconds
        while self._readings and self._readings[0][0] < cutoff:
            self._readings.popleft()
        readings = list(self._readings)
        if len(readings) < 2:
            return None
        idx: Optional[int] = None
        for i in range(len(readings) - 1, 0, -1):
            if score_changed(readings[i - 1][1], readings[i][1]):
                idx = i
                break
        if idx is None:
            return None
        pre_score = readings[idx - 1][1]
        post_score = readings[idx][1]
        post_samples = 0
        for j in range(len(readings) - 1, idx - 1, -1):
            if readings[j][1] != post_score:
                break
            post_samples += 1
        pre_samples = 0
        for j in range(idx - 1, -1, -1):
            if readings[j][1] != pre_score:
                break
            pre_samples += 1
        need = max(1, int(min_samples))
        if pre_samples < need or post_samples < need:
            return None
        # ADAAAA-7844: fire ONCE per transition — only on the frame whose read
        # completes the post-side consistency (the need-th consecutive read of
        # the new score). A later frame that keeps reading the same score is not
        # a fresh measurement, so the stale-delta re-fire ADAAAA-7543 closed
        # cannot come back through the legibility bar.
        if post_samples != need:
            return None
        # The confirming read must be time-tied to the transition (a second read
        # arriving 30 s later proves the score is stable, not that it just
        # changed at this frame).
        if (float(timestamp) - float(readings[idx][0])) > SCOREBOARD_MAX_CONFIRM_GAP_S:
            return None
        return ScoreboardDelta(
            pre=pre_score,
            post=post_score,
            pre_ts=readings[idx - 1][0],
            post_ts=readings[idx][0],
            pre_samples=pre_samples,
            post_samples=post_samples,
        )

    def clear(self) -> None:
        self._readings.clear()
