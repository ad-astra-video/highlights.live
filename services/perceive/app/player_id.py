"""Player-by-number identification — perceive (ADAAAA-7218, Increment C).

Given a user request like "track player #9", identify THAT player in the anchor
frame and hand their box off so the caller can seed ONE player SAM3 slot (SAM3
then propagates the tracking). Florence-2 ``<OD>`` cannot read a jersey number,
so this adds a thin one-shot identification step:

  1. closed-vocabulary player detection on the anchor frame,
  2. read the jersey number from each candidate player bbox with a single
     Florence-2 ``<OCR>`` on the cropped bbox (a referring-expression
     segmentation is an optional alternative; OCR is the concrete path),
  3. match the read number to the requested number and return the matched box.

GATING: explicit user request only. This module is invoked solely from the
``track-player`` control handler; it is NEVER called in the default per-frame
path. Cost is one OCR inference per candidate player, per request (not
per-frame) — small on the Livepeer GPU.

The parse/match helpers are pure and GPU-free so the matching contract is
unit-testable without a model; the detector + OCR functions are injectable.
"""

from __future__ import annotations

import re
from typing import Callable, List, Optional

from .tracking_plan import canonical_trackable_class

# Closed vocabulary for the one-shot player detection pass. A `goalkeeper`
# explores the same player trackable class (canonical_trackable_class -> "player"),
# so both are covered; neither is in the default per-frame roster (Inc B).
PLAYER_DETECTION_VOCABULARY: tuple[str, ...] = ("player", "goalkeeper")

_DIGIT_RUN = re.compile(r"\d+")
# A jersey number read as its OWN token (optionally prefixed by '#'): the digits
# are not glued to letters/digits on either side. A tight player crop usually
# OCRs exactly like this ("9", "#9", "09"), while a scorebug / watermark /
# agency banner yields digits embedded inside a word ("R.MARIN18PEACE").
_STANDALONE_NUMBER = re.compile(r"(?<![0-9A-Za-z])(\d{1,2})(?![0-9A-Za-z])")

# A seeded player box must be a tight, SAM3-trackable SINGLE-player box. On a
# wide broadcast shot the one-shot full-frame <OD> can also emit a near-full-frame
# "player" detection whose <OCR> happens to read the requested jersey number off
# a scorebug / banner (ADAAAA-7262, observed on p18_seg: area ~0.50 box reading
# "R.MARIN18PEACE..."). Seeding that box makes SAM3 try to propagate a region
# spanning most of the frame -> lost every frame -> accuracy null. Gate the match
# to plausible single-player boxes so an over-large box is never the seed target.
MAX_PLAYER_SEED_AREA = 0.30   # normalized area cap for a single-player seed box
MAX_PLAYER_SEED_SIDE = 0.70   # a single normalized side beyond which the box is implausible
# A tight OD player box clips the jersey number (it sits on the chest/back edge
# of the crop), which is one reason census clips fail to identify a player at
# all (ADAAAA-7345: 0778d4c3 / 397294f3 read no number on the exact box). When
# the exact crop yields no requested number, re-read a slightly padded crop.
OCR_PAD_MARGIN = 0.05


def _bbox_area(bbox) -> float:
    """Normalized [x1,y1,x2,y2] area, guarded for malformed boxes."""
    if not bbox or len(bbox) != 4:
        return 0.0
    x1, y1, x2, y2 = (float(v) for v in bbox)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def is_plausible_player_seed_box(bbox) -> bool:
    """True when a player detection bbox is a tight, SAM3-trackable single-player
    box (not a near-full-frame box whose jersey number is read from a scorebug)."""
    if not bbox or len(bbox) != 4:
        return False
    x1, y1, x2, y2 = (float(v) for v in bbox)
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    if w > MAX_PLAYER_SEED_SIDE or h > MAX_PLAYER_SEED_SIDE:
        return False
    return _bbox_area(bbox) <= MAX_PLAYER_SEED_AREA


class _BBoxRoi:
    """Minimal ``pixel_box``-shaped ROI adapter for a normalized [x1,y1,x2,y2]
    box, so Florence ``<OCR>`` can be cropped to an arbitrary player bbox."""

    def __init__(self, bbox) -> None:
        self._bbox = tuple(float(v) for v in bbox)

    def pixel_box(self, width: int, height: int):
        x1, y1, x2, y2 = self._bbox
        return (
            int(x1 * width),
            int(y1 * height),
            int(x2 * width),
            int(y2 * height),
        )


def _numbers_from_line(line: str) -> List[int]:
    """Extract plausible jersey numbers from a single OCR line.

    A 0-99 digit run (single/two-digit jersey numbers). Leading zeros are
    normalised ("09" -> 9, "0" -> 0). Larger digit runs (clocks / scores /
    years) are ignored so a nearby scorebug cannot be misread as the number.
    """
    out: List[int] = []
    for m in _DIGIT_RUN.finditer(line or ""):
        s = m.group(0)
        v = s.lstrip("0") or "0"
        n = int(v)
        if 0 <= n <= 99:
            out.append(n)
    return out


def parse_jersey_numbers(ocr_lines: Optional[List[str]]) -> List[int]:
    """Collect the plausible numbers read across an OCR result, deduplicated
    in order. Empty/None -> [] (a player bbox whose number was not read)."""
    nums: List[int] = []
    seen: set[int] = set()
    for line in ocr_lines or []:
        for n in _numbers_from_line(line):
            if n not in seen:
                seen.add(n)
                nums.append(n)
    return nums


def standalone_jersey_numbers(ocr_lines: Optional[List[str]]) -> List[int]:
    """Numbers read as their own OCR token (see `_STANDALONE_NUMBER`).

    A high-confidence jersey read: the digits stand alone in the line instead of
    being part of a longer word, which is how watermarks, sponsor boards and
    agency banners ("Caters News Agency", "R.MARIN18PEACE") OCR. Used to RANK
    candidates (a standalone read beats an embedded one) while the permissive
    `parse_jersey_numbers` still preserves recall.
    """
    nums: List[int] = []
    seen: set[int] = set()
    for line in ocr_lines or []:
        for m in _STANDALONE_NUMBER.finditer(line or ""):
            n = int(m.group(1).lstrip("0") or "0")
            if n not in seen:
                seen.add(n)
                nums.append(n)
    return nums


def expand_box(bbox, margin: float = OCR_PAD_MARGIN):
    """Expand a normalized [x1,y1,x2,y2] box by `margin` per side, clamped to
    the frame. A tight OD box routinely clips the jersey number (it sits on the
    chest/back edge of the crop), so a padded re-read recovers reads the exact
    box misses. Returns None for a malformed box."""
    if not bbox or len(bbox) != 4:
        return None
    x1, y1, x2, y2 = (float(v) for v in bbox)
    return (
        max(0.0, x1 - margin),
        max(0.0, y1 - margin),
        min(1.0, x2 + margin),
        min(1.0, y2 + margin),
    )


def is_player_detection(obj: dict) -> bool:
    """True when a detection object belongs to the player trackable class
    (player / goalkeeper / defender / forward ...)."""
    return canonical_trackable_class(str(obj.get("label", ""))) == "player"


def match_player_by_number(
    objects: List[dict],
    requested_number: int,
    read_number_fn: Callable[[tuple], List[str]],
) -> Optional[dict]:
    """Match a requested jersey number against candidate player detections.

    ``objects``: the ``<OD>`` detections for the anchor frame. ``read_number_fn``
    takes a normalized bbox (tuple) and returns the ``<OCR>`` lines read from
    that crop. Candidates are iterated in confidence order.

    Only PLAUSIBLE single-player boxes are considered (ADAAAA-7262): an
    implausibly-large ``<OD>`` detection (whose ``<OCR>`` often reads the jersey
    number off a scorebug) is never a valid seed target because SAM3 cannot
    propagate it.

    OCR robustness (ADAAAA-7345): a read only counts when it is trustworthy.
    Two passes are used so a watermark/scorebug read cannot outrank a real one:

      1. STRICT — the requested number must appear as its own OCR token ("9",
         "#9") on either the exact crop or, when that crop reads no match at
         all, a padded crop (`OCR_PAD_MARGIN`). The jersey number is clipped by
         a tight OD box often enough that the padded re-read is what recovers
         the census clips.
      2. PERMISSIVE — if no strict read matched, fall back to the first
         candidate with the number embedded in a longer line, preserving the
         pre-existing recall.

    Returns the matched detection augmented with ``number``, the winning
    ``ocr`` lines, ``ocr_bbox`` (the crop that matched) and ``ocr_confidence``
    (``"standalone"`` | ``"embedded"``). No match -> None.
    """
    requested = int(requested_number)
    ranked = sorted(
        (
            o
            for o in objects
            if is_player_detection(o) and is_plausible_player_seed_box(o.get("bbox"))
        ),
        key=lambda o: float(o.get("confidence", 0.0) or 0.0),
        reverse=True,
    )

    def _read(bbox):
        try:
            return list(read_number_fn(tuple(bbox)) or [])
        except Exception:  # noqa: BLE001 - a bad OCR read never aborts the match
            return []

    weak: List[dict] = []   # number found, but only embedded in a longer line
    for obj in ranked:
        bbox = obj.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        tight = _read(tuple(bbox))
        if requested in standalone_jersey_numbers(tight):
            return {
                **obj,
                "number": requested,
                "ocr": tight,
                "ocr_bbox": list(bbox),
                "ocr_confidence": "standalone",
            }
        tight_nums = parse_jersey_numbers(tight)
        if requested in tight_nums:
            weak.append({
                **obj,
                "number": requested,
                "ocr": tight,
                "ocr_bbox": list(bbox),
                "ocr_confidence": "embedded",
            })
            continue
        # Only pad when the exact crop read NO number at all: a crop that read a
        # different number belongs to a different jersey, and padding it would
        # pull a neighbouring player (or the crowd) into the OCR crop.
        if tight_nums:
            continue
        padded = expand_box(bbox)
        if padded is None or padded == tuple(float(v) for v in bbox):
            continue
        lines = _read(padded)
        if requested in standalone_jersey_numbers(lines):
            return {
                **obj,
                "number": requested,
                "ocr": lines,
                "ocr_bbox": list(padded),
                "ocr_confidence": "standalone",
            }
        if requested in parse_jersey_numbers(lines):
            weak.append({
                **obj,
                "number": requested,
                "ocr": lines,
                "ocr_bbox": list(padded),
                "ocr_confidence": "embedded",
            })
    return weak[0] if weak else None


def identify_player_by_number(
    frame,
    requested_number: int,
    detector,
    ocr_fn: Optional[Callable[[tuple], List[str]]] = None,
) -> Optional[dict]:
    """Run player-by-number identification on one anchor frame.

    Runs closed-vocabulary player detection (no ROI pass — this is not ball
    recovery), then reads each candidate's jersey number and matches. Returns the
    matched detection dict ({bbox, confidence, number, ...}) or None when no
    player with the requested number is identified. ``ocr_fn`` (injectable for
    tests) defaults to a bbox-cropped ``<OCR>`` via the detector.
    """
    if frame is None or detector is None:
        return None
    objects = detector.detect(
        frame,
        vocabulary=list(PLAYER_DETECTION_VOCABULARY),
        roi_pass=False,
    ) or []

    def _default_ocr(bbox: tuple) -> List[str]:
        return detector.ocr(frame, roi=_BBoxRoi(bbox)) or []

    read_fn = ocr_fn or _default_ocr
    return match_player_by_number(objects, int(requested_number), read_fn)
