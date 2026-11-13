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
from typing import Deque, Mapping, Optional, Sequence, Tuple

# A scoreboard line: two small integers joined by a dash score separator.
# Matches "2 - 1", "45-42", "Q3 45‒42". Deliberately EXCLUDES colon ("90:00"
# is a clock/minute read, not a score) and "to", so a time/clock never becomes
# a false score that could wrongly confirm a goal (ADAAAA-6360 precision).
_SCORE_LINE_RE = re.compile(
    r"(?P<a>\d{1,3})\s*[-–—]\s*(?P<b>\d{1,3})",
)

# ADAAAA-8459: the scorebug OCR does not always put a hyphen between the two
# scores. The measured LaLiga share (`b55c5781`, 480-wide) printed the pair
# glued to the team plates and the watermark (`BAR0LALIGA 022 ALAMERCUR`) and
# the older measured live leg `348bd511` reached the prompt as `RMA 1/2 FCB36:54`
# / `RMA 1.0 FCB 17:22HOTELSK` — 1450 `/`-glued readings, 0 dashes. The server's
# `parseOcrScoreLine` (`services/server/src/analyzer.ts`, ADAAAA-8189) already
# reads those families, so perceive's own score/delta lane disagreed with the
# layer that owns the attestation: a line the server parsed as a pair left
# `ScoreboardTracker` with `None`, and `scoreBoardChanged` / `scoreboardDelta`
# never fired. These families mirror that parser exactly.
_GLUED_SEPARATORS = (
    # `(?<!\d)` / `(?!\d)`: the pair must be a WHOLE numeric token on both
    # sides, so a longer digit run (`FCB2110`, a clock glued to a stat) can
    # never be sliced into a score by a coincidental separator.
    ("slash", re.compile(r"(?<!\d)(\d{1,3})\s*/\s*(\d{1,3})(?!\d)")),
    ("dot", re.compile(r"(?<!\d)(\d{1,3})\.(\d{1,3})(?!\d)")),
    ("space", re.compile(r"(?<!\d)(\d{1,3})[ \t]+(\d{1,3})(?!\d)")),
)

# Per-side ceiling for the glued families. Both sides of a real scoreboard pair
# are single digits on the measured fixtures, while a clock that OCR'd with the
# score's separator carries a two-digit component (`10/47`, `17.141`). Hyphen
# pairs keep the historical `<= 99` bar (`_MAX_SCORE_INT`).
_GLUED_MAX_SIDE = 9

# A team-like token butting against a pair: one separator character (space,
# pipe, dot, hyphen) is allowed because OCR glues both ways ("|RHA2-1 BAR",
# "2-1 BAR", "BAR1 1").
_TEAM_TOKEN_LEFT_RE = re.compile(r"[A-Za-z]{2,}[^A-Za-z0-9]{0,1}$")
_TEAM_TOKEN_RIGHT_RE = re.compile(r"^[^A-Za-z0-9]{0,1}[A-Za-z]{2,}")

# Guard against absurd non-score integers (clock minutes, jersey numbers, etc.)
_MAX_SCORE_INT = 99

# ADAAAA-8507: broadcast/sponsor chrome a browser-share score crop reads instead
# of the score plate (`LALIGA`, `STANLEY`, `SPOTIFY`, `whitebit`, `LAUGA`,
# `CULERS`, the `nike.com/football` banner). Mirrors `OCR_CHROME_TOKEN_RE` in the
# server analyzer.
_CHROME_TOKEN_RE = re.compile(
    r"(?:laliga|stanley|spotify|whitebit|lauga|culers|nike\.com)", re.IGNORECASE
)
# ADAAAA-8507: a `mm:ss` clock that OCR'd with the score's dash separator
# (`05-40`, `09-40`, `08-10`). A leading zero on a two-digit group is the
# discriminator: a real double-digit score (`45-42`) has none.
_CLOCK_MMSS_LEFT_RE = re.compile(r"0\d")
_CLOCK_MMSS_RIGHT_RE = re.compile(r"\d{2}")
# ADAAAA-8841: the sports whose score plate cannot reach two digits. Mirrors
# `SINGLE_DIGIT_SCORE_SPORTS` in `services/server/src/analyzer.ts`.
_SINGLE_DIGIT_SCORE_SPORTS = frozenset({"soccer", "football", "association football"})
_ZERO_PADDED_GROUP_RE = re.compile(r"0\d+")
_CLOCK_GLUE_BEFORE_RE = re.compile(r"\d{1,2}:$")
_CLOCK_GLUE_AFTER_RE = re.compile(r":\d{1,2}")


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


# ---------------------------------------------------------------------------
# ADAAAA-7944 — temporal candidate-region selection
# ---------------------------------------------------------------------------
# The per-sport name-channel measurement found three sports (American football,
# ice hockey, baseball) whose score surface is a BOTTOM full-width band or a
# small bottom-left / bottom-right bug, while the shipped code starts from a
# fixed TOP-band prior and only "repairs" to one bottom band (ADAAAA-7909). The
# ROI that won was whatever `<DENSE_REGION_CAPTION>` guessed (the play field /
# rink banner / ad board), so the OCR read jersey numbers, "CHAMPIONS" and
# "COURTESY" instead of the clubs.
#
# This selector scores a fixed, sport-agnostic candidate set by the TEMPORAL
# STABILITY of the printed names each region produces across frames, instead of
# guessing one fixed band. It is GPU-free: the caller supplies the OCR lines it
# already read and a `pair_fn(lines) -> (home, away) | None` that knows how this
# build parses a printed pair, so the scoring logic is unit-testable.
#
# A candidate wins only when it printed a both-side name pair on at least
# `MIN_FRAMES` observed frames, on at least `MIN_PAIR_SHARE` of them, with both
# names stable across `MIN_NAME_STABILITY` of those pairs. A region whose lines
# are background-board copy (rink banner, courtesy/ad board, a domain) is never
# eligible, even if it is stable — that is the exact failure the measurement
# caught. Any sport can win any region: nothing here names a sport or a pixel
# coordinate.
@dataclass(frozen=True)
class ScoreboardRegion:
    """One candidate region: a stable name (for evidence) plus its normalized box."""

    name: str
    roi: ScoreboardRoi


SCOREBOARD_REGION_PRIORS = (
    ScoreboardRegion("bottom_band", ScoreboardRoi(0.0, 0.78, 1.0, 0.94)),
    ScoreboardRegion("bottom_left", ScoreboardRoi(0.0, 0.78, 0.50, 0.92)),
    ScoreboardRegion("bottom_right", ScoreboardRoi(0.50, 0.78, 1.0, 0.94)),
    ScoreboardRegion("top_band", ScoreboardRoi(0.0, 0.0, 1.0, 0.25)),
)
SCOREBOARD_SELECT_MIN_FRAMES = 3
SCOREBOARD_SELECT_MIN_PAIR_SHARE = 0.60
SCOREBOARD_SELECT_MIN_NAME_STABILITY = 0.60
SCOREBOARD_SELECT_MAX_FRAMES = 4
# Lines that are background-board copy rather than a score surface: a rink
# banner ("CHAMPIONS 2014"), a courtesy/ad board, an ad-board host/domain, a
# sponsor strap. Matched case-insensitively on the whole line.
_BACKGROUND_BOARD_PATTERNS = (
    "courtesy",
    "champions",
    "champion",
    "bridge to possible",
    "sponsor",
    "advertis",
    "www.",
    ".com",
    ".org",
    ".net",
    "highlights.live",
)


def is_background_board_line(text: str) -> bool:
    """True when an OCR line is banner / ad-board copy, not a score surface."""
    folded = str(text or "").strip().lower()
    if not folded:
        return False
    if any(pat in folded for pat in _BACKGROUND_BOARD_PATTERNS):
        return True
    if "://" in folded or "http" in folded:
        return True
    # A single all-caps word with no digit ("CHAMPIONS", "COURTESY") is banner
    # copy; a real score surface prints a name plus a score/timer/period token.
    tokens = [t for t in re.split(r"\s+", folded) if t]
    if len(tokens) == 1 and tokens[0].isalpha() and str(text).strip().isupper() and not any(
        ch.isdigit() for ch in folded
    ):
        return True
    return False


class ScoreboardRoiSelector:
    """Pick a scoreboard region by the temporal stability of the names it reads.

    ADAAAA-7944. Call :meth:`candidates_for_frame`, OCR each candidate, feed the
    lines to :meth:`record_frame`, then :meth:`select`. Once ``resolved`` the
    caller stops probing and uses :attr:`resolved_roi` for the session.

    Bounded by construction: at most ``max_frames`` probe frames (default
    ``SCOREBOARD_SELECT_MAX_FRAMES``) x len(candidates) extra OCR reads, so a
    broadcast whose scorebug never prints a readable pair pays a small one-off
    probe instead of a per-frame bill.
    """

    def __init__(
        self,
        candidates: Optional[Sequence["ScoreboardRegion"]] = None,
        pair_fn=None,
        max_frames: int = SCOREBOARD_SELECT_MAX_FRAMES,
    ):
        self.candidates = tuple(candidates or SCOREBOARD_REGION_PRIORS)
        self._pair_fn = pair_fn or (lambda lines: None)
        self.max_frames = max(1, int(max_frames))
        self.frames = 0
        self.resolved = False
        self.resolved_roi: Optional[ScoreboardRoi] = None
        self.resolved_name: Optional[str] = None
        self._obs: dict[str, dict] = {
            c.name: {"frames": 0, "pairs": 0, "home": {}, "away": {}, "lines": []}
            for c in self.candidates
        }
        self._last_lines: dict[str, list[str]] = {}

    def candidates_for_frame(self) -> list["ScoreboardRegion"]:
        """Candidate regions to probe on this frame (``[]`` once resolved/bounded)."""
        if self.resolved or self.frames >= self.max_frames:
            return []
        return list(self.candidates)

    def record_frame(self, observed: Mapping[str, Sequence[str]]) -> None:
        """Record one probe frame: ``{candidate_name: ocr_lines}``."""
        if self.resolved:
            return
        self.frames += 1
        self._last_lines = {}
        for region in self.candidates:
            lines = [str(line) for line in (observed.get(region.name) or []) if str(line).strip()]
            self._last_lines[region.name] = lines
            obs = self._obs[region.name]
            obs["frames"] += 1
            obs["lines"].append(lines)
            pair = self._pair_fn(lines) if lines else None
            if pair is None:
                continue
            home, away = pair
            if not home or not away or str(home).lower() == str(away).lower():
                continue
            obs["pairs"] += 1
            obs["home"][home] = obs["home"].get(home, 0) + 1
            obs["away"][away] = obs["away"].get(away, 0) + 1

    def lines_for(self, name: str) -> list[str]:
        """The lines the named candidate read on the most recent probe frame."""
        return list(self._last_lines.get(name) or [])

    def _modal_share(self, votes: Mapping[str, int]) -> float:
        total = sum(votes.values())
        if total <= 0:
            return 0.0
        return max(votes.values()) / total

    def _background_only(self, name: str) -> bool:
        obs = self._obs[name]
        lines = [line for frame in obs["lines"] for line in frame if line.strip()]
        return bool(lines) and all(is_background_board_line(line) for line in lines)

    def score(self, name: str) -> float:
        """Temporal score in 0..1 for one candidate (0.0 when not eligible)."""
        obs = self._obs[name]
        frames = int(obs["frames"])
        pairs = int(obs["pairs"])
        if frames < SCOREBOARD_SELECT_MIN_FRAMES or pairs < SCOREBOARD_SELECT_MIN_FRAMES:
            return 0.0
        share = pairs / max(1, frames)
        if share < SCOREBOARD_SELECT_MIN_PAIR_SHARE:
            return 0.0
        if self._background_only(name):
            return 0.0
        stability = min(self._modal_share(obs["home"]), self._modal_share(obs["away"]))
        if stability < SCOREBOARD_SELECT_MIN_NAME_STABILITY:
            return 0.0
        return share * stability

    def select(self) -> Optional[ScoreboardRoi]:
        """Adopt the best-scoring candidate region once its gates are met."""
        if self.resolved:
            return self.resolved_roi
        best: Optional[ScoreboardRegion] = None
        best_score = 0.0
        for region in self.candidates:
            candidate_score = self.score(region.name)
            if candidate_score > best_score:
                best = region
                best_score = candidate_score
        if best is None:
            return None
        self.resolved = True
        self.resolved_name = best.name
        self.resolved_roi = best.roi
        return best.roi

    def status(self) -> dict:
        """Inspectable account of what each candidate read (evidence/AC report)."""
        return {
            "frames": self.frames,
            "resolved": self.resolved,
            "selected": self.resolved_name,
            "candidates": {
                region.name: {
                    "frames": self._obs[region.name]["frames"],
                    "pairs": self._obs[region.name]["pairs"],
                    "home": dict(self._obs[region.name]["home"]),
                    "away": dict(self._obs[region.name]["away"]),
                    "score": round(self.score(region.name), 3),
                }
                for region in self.candidates
            },
        }


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


def _pair_team_adjacent(text: str, index: int, length: int) -> Tuple[bool, bool]:
    """``(left, right)``: does a team-like token butt against the pair there?

    ADAAAA-8459 (mirrors ``ocrPairTeamAdjacent`` in the server analyzer). The
    scorebug renders both scores BETWEEN/next to the team abbreviations, so
    adjacency is the cheapest signal that a digit pair is the score and not a
    clock or a stat the line also carries.
    """
    before = text[max(0, index - 3):index]
    after = text[index + length:index + length + 3]
    return (
        bool(_TEAM_TOKEN_LEFT_RE.search(before)),
        bool(_TEAM_TOKEN_RIGHT_RE.search(after)),
    )


def _glued_score_pair(text: str) -> Optional[Tuple[int, int]]:
    """The score pair when the line glues it with ``/``, ``.`` or one space.

    Both sides must be team-adjacent (the pair sits between the two
    abbreviations) and each side must be a single digit. The EARLIEST such pair
    wins: the score follows the home abbreviation, while a clock that OCR'd with
    the same separator comes after the away one.
    """
    best: Optional[Tuple[int, int, Tuple[int, int]]] = None
    for kind_index, (_kind, pattern) in enumerate(_GLUED_SEPARATORS):
        for m in pattern.finditer(text):
            a, b = int(m.group(1)), int(m.group(2))
            if a > _GLUED_MAX_SIDE or b > _GLUED_MAX_SIDE:
                continue
            left, right = _pair_team_adjacent(text, m.start(), len(m.group(0)))
            if not (left and right):
                continue
            if best is None or m.start() < best[0] or (
                m.start() == best[0] and kind_index < best[1]
            ):
                best = (m.start(), kind_index, (a, b))
    return best[2] if best is not None else None


def _pair_is_noise(
    text: str,
    raw_left: str,
    raw_right: str,
    index: int,
    length: int,
    adjacent: Tuple[bool, bool],
    sport: Optional[str] = None,
) -> bool:
    """Whether this dash pair is a clock / chrome fragment, not a score plate.

    ADAAAA-8507 (mirrors ``ocrScorePairIsNoise`` in the server analyzer). The
    browser (customer) live path read the sponsor banner as the scoreboard: on
    job ``c4d33a26`` the crop's lines are ``LALIGA``, ``LALIGASPOTIFY CAMP NOU``,
    ``whitebitwhitebitLALIGA``, ``LALIGA|0JALIGA05-40 AL1UberFC B`` and the
    clock-glued ``…|LALIGA02:28-1om/football``. The dash lane turned those into
    scores ``(5,40)``, ``(9,40)``, ``(28,1)``, ``(53,1)``, so 79 of 147 judged
    windows claimed a score change over a STATIC scorebug.

    Three shapes are refused (fail closed — an unreadable plate stays absent
    evidence, never a forged delta):

    1. CLOCK GLUE — the pair sits right after a ``H:`` / ``HH:`` clock
       (``02:28-1``, ``04:53-1``, ``03:29-1``), or right before a ``:MM`` one;
    2. CLOCK SHAPE — the pair has the shape of a ``mm:ss`` clock that OCR'd with
       the score's dash. Three keys (ADAAAA-8841):
         (a) a ZERO-PADDED group (``05``, ``019``, ``034``) is never a score
             plate: plates do not render leading zeros, and every measured
             clock-dash family zero-pads its seconds field;
         (b) ``M-mm`` where ``mm`` is a seconds field (2-3 digits, <= 59) and
             ``M`` is a plausible clock minute — refused ONLY for a sport whose
             plate cannot reach two digits (football), so ``45-42`` (pinned by
             the suite) stays a score;
         (c) the pair equals the ``mm:ss`` split of the clock the SAME line
             carries (:func:`parse_match_clock_line`, GT-2). Sport-independent:
             the line itself names the clock;
    3. CHROME LINE — the line carries a broadcast/sponsor token and the pair is
       not sandwiched between the two team tokens (``…LALIGA RMA 1-1 BAR…``
       still parses, its pair IS sandwiched).

    ADAAAA-8841 (the live Sky Sports share ``1ee3c97d``): keying (a) on a leading
    zero in the LEFT group only was fitted to an early-match sample, so a
    ``mm:ss`` clock at minute >= 10 (``24-35``) and a minute-0 clock whose
    seconds field reached the pair as ``0-019`` / ``0-034`` both passed the gate
    and became the window's score reading — which attested phantom transitions
    that were pure clock ticks (``0-19 -> 0-20``, ``0-33 -> 0-34``).
    """
    if _CLOCK_GLUE_BEFORE_RE.search(text[:index]):
        return True
    if _CLOCK_GLUE_AFTER_RE.match(text[index + length:]):
        return True
    # (a) a zero-padded group is never a score plate (ADAAAA-8841).
    if _ZERO_PADDED_GROUP_RE.fullmatch(raw_left) or _ZERO_PADDED_GROUP_RE.fullmatch(raw_right):
        return True
    # (b) sport-scoped ceiling: a plate that cannot reach two digits refuses
    # any pair with a two-digit side (a `mm:ss` clock at minute >= 10).
    if _sport_scores_are_single_digit(sport):
        if int(raw_left) > 9 or int(raw_right) > 9:
            return True
    # (c) the pair IS the clock the same line carries (GT-2).
    if _pair_equals_line_clock(text, raw_left, raw_right):
        return True
    if _CHROME_TOKEN_RE.search(text) and not (adjacent[0] and adjacent[1]):
        return True
    return False


def _sport_scores_are_single_digit(sport: Optional[str]) -> bool:
    """Does this sport cap a score at a single digit?

    ADAAAA-8841: basketball (``45-42``) and American football (``24-17``)
    legitimately print two-digit plates, so the dash-clock shape must never
    refuse those, and an ``unknown`` sport stays lenient — byte-identical to the
    pre-8841 gate. Mirrors ``ocrSportScoresAreSingleDigit`` in the server.
    """
    key = str(sport or "").strip().lower()
    return key in _SINGLE_DIGIT_SCORE_SPORTS


def _pair_equals_line_clock(text: str, raw_left: str, raw_right: str) -> bool:
    """Is this dash pair the ``mm:ss`` split of the clock the SAME line carries?

    ADAAAA-8841, mirroring ``ocrPairEqualsLineClock`` in the server. The seconds
    field must be rendered as two digits exactly as the clock renders it, so a
    genuine ``1-1`` plate next to a ``1:01`` clock is NOT refused.
    """
    if len(raw_right) != 2:
        return False
    clock = parse_match_clock_line(text)
    if not clock or clock.get("seconds") is None:
        return False
    try:
        seconds = int(clock["seconds"])
        a, b = int(raw_left), int(raw_right)
    except (TypeError, ValueError):
        return False
    if a * 60 + b == seconds:
        return True
    return a == seconds // 60 and b == seconds % 60


def _score_pair_in_line(text: str, sport: Optional[str] = None) -> Optional[Tuple[int, int]]:
    """The one score pair a single OCR line carries, or ``None``.

    Ordered by how score-shaped the pair looks, NOT by position (ADAAAA-8134):
    a hyphen pair with a team token immediately BEFORE it wins (the score sits
    after the home abbreviation in every measured variant), then one with a team
    token immediately AFTER it, then a team-adjacent glued pair, then the first
    hyphen pair of the line. Selection only decides WHICH pair a line yields; it
    never widens what counts as a score.
    """
    left = right = any_pair = None
    for m in _SCORE_LINE_RE.finditer(text):
        a, b = int(m.group("a")), int(m.group("b"))
        if a > _MAX_SCORE_INT or b > _MAX_SCORE_INT:
            continue
        adj_left, adj_right = _pair_team_adjacent(text, m.start(), len(m.group(0)))
        # ADAAAA-8507: a clock / sponsor-chrome fragment is not a score plate.
        if _pair_is_noise(
            text, m.group("a"), m.group("b"), m.start(), len(m.group(0)),
            (adj_left, adj_right), sport,
        ):
            continue
        if adj_left and left is None:
            left = (a, b)
        elif adj_right and right is None:
            right = (a, b)
        elif not adj_left and not adj_right and any_pair is None:
            any_pair = (a, b)
    if left is not None:
        return left
    if right is not None:
        return right
    glued = _glued_score_pair(text)
    if glued is not None:
        return glued
    return any_pair


def parse_ocr_score(
    frame_ocr,
    roi: Optional[ScoreboardRoi] = None,
    ocr_boxes: Optional[Sequence[Optional[Sequence[float]]]] = None,
    sport: Optional[str] = None,
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

    ADAAAA-8459: a line may also carry the pair glued with ``/``, ``.`` or a
    space (``RMA 1/2 FCB``), or a clock ahead of it (``19-41 RMA-2-1 BAR``). The
    per-line decision is made by :func:`_score_pair_in_line`, which mirrors the
    server's ``parseOcrScoreLine`` so perceive's delta lane reads the same pairs
    the attestation layer does.
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
        pair = _score_pair_in_line(text, sport)
        if pair is not None:
            return pair
    return None


def score_changed(prev: Optional[Tuple[int, int]], curr: Optional[Tuple[int, int]]) -> bool:
    """True when ``curr`` is a real score that differs from ``prev``.

    Either side being ``None`` (unreadable / not yet seen) is *not* a delta —
    we only confirm a change between two concrete, different readings.
    """
    if prev is None or curr is None:
        return False
    return prev != curr


# --- ADAAAA-8733 (GT-2): the scorebug MATCH CLOCK ----------------------------
# The clock sits in the SAME crop and the SAME OCR line as the score pair
# (``LALIGA00:56``, ``RMA 1/2 FCB36:54``, ``GER 4 1 SCO86:35FOXEURO2``), so
# reading it costs no extra OCR call and no GPU-second. Until now every clock
# shape was deliberately REFUSED by the score parser (a clock must never become
# a score — see ``_SCORE_LINE_RE``); this parser reads it WITHOUT feeding the
# score/delta lane, so ``scoreBoardChanged`` can never be driven by a clock.
#
# This mirrors ``parseOcrMatchClockLine`` in services/server/src/analyzer.ts
# token for token — same shape precedence, same guards, same period
# normalisation — because the two layers read the same OCR text and must not
# disagree about it. Change one, change the other; the parity fixture in
# services/perceive/tests/test_match_clock_8733.py pins the table.
_MATCH_CLOCK_MEDIA_TIMECODE_RE = re.compile(r"\d{1,3}:\d{2}:\d{2}:\d{1,3}")
_MATCH_CLOCK_HHMMSS_RE = re.compile(r"(?<![\d:])(\d{1,2}):([0-5]\d):([0-5]\d)(?![\d:])")
_MATCH_CLOCK_MMSS_RE = re.compile(r"(?<!\d)(\d{1,3}):([0-5]\d)(?![\d:])")
# The colon lost to the crop (``ENG82.29``). The left side is 2-3 digits
# (minutes >= 10), which is what keeps a dot-glued SCORE pair (both sides <= 9)
# out of the clock's hands and the clock out of the score parser's.
_MATCH_CLOCK_DOT_RE = re.compile(r"(?<![\d.])(\d{2,3})\.([0-5]\d)(?![\d.])")
_MATCH_CLOCK_BARE_MINUTE_RE = re.compile(r"(?<![\d:])(\d{1,2})(?:\+(\d{1,2}))?'(?![A-Za-z])")

_MATCH_CLOCK_PERIOD_PATTERNS = (
    (re.compile(r"\b(?:HT|MT|HALF[-\s]?TIME)\b", re.IGNORECASE), lambda m: "HT"),
    (re.compile(r"(?<!\d)([12])\s*\.\s*[ÇC](?![A-Za-z])"), lambda m: f"Q{m.group(1)}"),
    (re.compile(r"\bQ([1-4])\b", re.IGNORECASE), lambda m: f"Q{m.group(1)}"),
    (re.compile(r"\b([12])H\b", re.IGNORECASE), lambda m: f"{m.group(1)}H"),
    (re.compile(r"\bH([12])\b"), lambda m: f"{m.group(1)}H"),
    (
        re.compile(r"\b([12])(?:st|nd)\s+(?:half|period|quarter)\b", re.IGNORECASE),
        lambda m: f"{m.group(1)}H",
    ),
)


def parse_match_clock_period(text: str) -> Optional[str]:
    """The period a line shows, normalised (``1H`` / ``2H`` / ``Q3`` / ``HT``),
    or ``None`` when the bug shows none."""
    for pattern, period in _MATCH_CLOCK_PERIOD_PATTERNS:
        m = pattern.search(text)
        if m:
            return period(m)
    return None


def parse_match_clock_line(text) -> Optional[dict]:
    """The match clock carried by ONE OCR line, or ``None``.

    Returns ``{"seconds", "shape", "period", "legible", "token"}``. Shape
    precedence is ``hh:mm:ss`` -> ``mm:ss`` -> ``dot`` -> ``bare_minute`` and the
    first token of the winning shape wins. An unreadable clock returns ``None``
    (absent evidence, never a fabricated reading), and a media timecode
    (``0:03:04:800`` — a player scrub overlay) is refused outright: it reads as
    perfect ``mm:ss`` coverage but is not a match clock.
    """
    line = str(text or "").strip()
    if not line:
        return None
    if _MATCH_CLOCK_MEDIA_TIMECODE_RE.search(line):
        return None
    period = parse_match_clock_period(line)
    shapes = (
        ("hh:mm:ss", _MATCH_CLOCK_HHMMSS_RE, lambda m: int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))),
        ("mm:ss", _MATCH_CLOCK_MMSS_RE, lambda m: int(m.group(1)) * 60 + int(m.group(2))),
        ("dot", _MATCH_CLOCK_DOT_RE, lambda m: int(m.group(1)) * 60 + int(m.group(2))),
        (
            "bare_minute",
            _MATCH_CLOCK_BARE_MINUTE_RE,
            lambda m: (int(m.group(1)) + int(m.group(2) or 0)) * 60,
        ),
    )
    for shape, pattern, to_seconds in shapes:
        m = pattern.search(line)
        if not m:
            continue
        seconds = to_seconds(m)
        if seconds < 0:
            continue
        return {
            "seconds": int(seconds),
            "shape": shape,
            "period": period,
            "legible": True,
            "token": m.group(0),
        }
    return None


def parse_match_clock(lines) -> Optional[dict]:
    """The first legible match clock among a window's OCR lines, or ``None``."""
    for raw in lines or ():
        reading = parse_match_clock_line(raw)
        if reading is not None:
            return reading
    return None


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
