"""ADAAAA-8139: single-frame scoreboard OCR probe.

The live rail re-reads a handful of ALREADY-PERSISTED frames of a goal window
whose scoreboard OCR never produced a post-goal read (see
`services/server/src/live-frame-reread.ts`). That re-read must cost one
score-bug crop inference per frame and nothing else: no detection, no SAM, no
tracker state, no decide call, no Livepeer debit.

`process_frame` cannot serve that need: it runs the whole perceive pipeline and
mutates session trackers. This module exposes the ONE reusable piece — the
`<OCR>` crop read — as a pure function over (image, roi), so the server's
re-read can call it per persisted frame.

The score line is parsed with `scoreboard.parse_ocr_score` for the advisory
`score` field, but the SERVER parses the returned raw lines with its own
`parseOcrScoreLine` (ADAAAA-8134: a hyphenated broadcast clock is not a score).
One parser owns what a score line is; this module never invents one.

Cost posture: exactly one `detector.ocr(...)` call per frame. A missing
detector, a bad image or an OCR failure degrades to `ocr: []` — absent
evidence, never a fabricated read and never an exception into the caller.
"""
from __future__ import annotations

import base64
import io
from typing import Optional, Sequence

from .scoreboard import ScoreboardRoi, explicit_scoreboard_roi, parse_match_clock, parse_ocr_score

# Same top-band prior the live ROI fallback uses when discovery has not run:
# the documented fallback (ADAAAA-7094 / ADAAAA-7909) rather than a guess.
_DEFAULT_PROBE_ROI = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)


def _roi_from_box(box: Optional[Sequence[float]]) -> Optional[ScoreboardRoi]:
    """A request-supplied normalized ``(x0, y0, x1, y1)`` box, or ``None``.

    Invalid/degenerate boxes are ignored (never raise): a bad request value must
    not turn into a whole-frame OCR that reads crowd/banner text as a score.
    """
    if box is None:
        return None
    try:
        vals = [float(v) for v in box]
    except (TypeError, ValueError):
        return None
    if len(vals) != 4:
        return None
    try:
        roi = ScoreboardRoi(*vals)
    except TypeError:
        return None
    return roi if roi.pixel_box(1920, 1080) is not None else None


def resolve_probe_roi(
    explicit: Optional[Sequence[float]] = None,
    state=None,
) -> ScoreboardRoi:
    """The score-bug crop for a probe, in priority order.

    1. the box the caller supplied (the server may pin it);
    2. the SESSION's cached ROI — the region discovery/selection already resolved
       for this source on the live rail, which is the exact crop every live frame
       used;
    3. the operator's ``PERCEIVE_SCOREBOARD_ROI``;
    4. the documented top-band fallback prior.

    Always returns a usable ROI, so the probe is always a single crop read.
    """
    roi = _roi_from_box(explicit)
    if roi is not None:
        return roi
    if state is not None:
        session_roi = getattr(state, "scoreboard_roi", None)
        if isinstance(session_roi, ScoreboardRoi) and session_roi.pixel_box(1920, 1080) is not None:
            return session_roi
    env_roi = explicit_scoreboard_roi()
    if env_roi is not None:
        return env_roi
    return _DEFAULT_PROBE_ROI


def _decode_rgb(image_b64: str):
    """Decode a base64 JPEG/PNG into an RGB ndarray, or ``None`` (never raises)."""
    if not image_b64:
        return None
    try:
        import numpy as np
        from PIL import Image

        raw = base64.b64decode(str(image_b64).split(",")[-1])
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img, dtype=np.uint8)
    except Exception:  # noqa: BLE001 - a bad frame is absent evidence
        return None


def probe_scoreboard_ocr(
    image_b64: str,
    roi: Optional[Sequence[float]] = None,
    state=None,
    detector=None,
) -> dict:
    """Run ONE score-bug crop OCR on a persisted frame.

    Returns ``{"ocr": [...], "score": [h, a] | None, "matchClock": {...} | None,
    "roi": [x0,y0,x1,y1] | None, "ok": bool, "reason": str}``.

    ADAAAA-8733 (GT-2): ``matchClock`` is parsed from the SAME OCR lines this
    call already returned — the same crop, the same OCR call, zero added
    GPU-seconds. It is reported BESIDE ``score`` and never feeds it.
    """
    resolved = resolve_probe_roi(roi, state)
    roi_out = [resolved.x0, resolved.y0, resolved.x1, resolved.y1]
    out = {"ocr": [], "score": None, "matchClock": None, "roi": roi_out, "ok": False, "reason": ""}
    rgb = _decode_rgb(image_b64)
    if rgb is None:
        out["reason"] = "bad_image"
        return out
    det = detector
    if det is None:
        from .florence import get_detector

        det = get_detector(None)
    if det is None:
        # Stub/CPU posture with no OCR model: absent evidence, not an error.
        out["reason"] = "no_detector"
        return out
    try:
        lines = det.ocr(rgb, roi=resolved) or []
    except Exception as e:  # noqa: BLE001 - degrade to absent evidence
        out["reason"] = f"ocr_failed: {e}"
        return out
    ocr = [str(line) for line in lines if str(line).strip()]
    score = parse_ocr_score(ocr, roi=None)
    # ADAAAA-8733: the match clock on the same crop / same OCR call.
    match_clock = parse_match_clock(ocr)
    if score is not None:
        reason = ""
    elif not ocr:
        reason = "unreadable"  # the crop printed nothing at all
    else:
        reason = "no_score"  # text, but no score-shaped line (absent evidence)
    out.update(
        {
            "ocr": ocr,
            "score": list(score) if score is not None else None,
            "matchClock": match_clock,
            "ok": True,
            "reason": reason,
        }
    )
    return out
