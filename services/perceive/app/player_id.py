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
    that crop. Iterates candidates in confidence order and returns the first
    detection whose read numbers contain the requested one, augmented with the
    matched ``number`` and the raw ``ocr`` lines. No match -> None.
    """
    requested = int(requested_number)
    ranked = sorted(
        (o for o in objects if is_player_detection(o)),
        key=lambda o: float(o.get("confidence", 0.0) or 0.0),
        reverse=True,
    )
    for obj in ranked:
        bbox = obj.get("bbox")
        if not bbox or len(bbox) != 4:
            continue
        try:
            lines = list(read_number_fn(tuple(bbox)) or [])
        except Exception:  # noqa: BLE001 - a bad OCR read never aborts the match
            lines = []
        if requested in parse_jersey_numbers(lines):
            return {**obj, "number": requested, "ocr": lines}
    return None


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
