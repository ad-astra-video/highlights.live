"""Unit tests for the scoreboard OCR / score-delta logic (ADAAAA-6360, decide-leg
I3). Pure functions and the tracker — no GPU, no network.

ADAAAA-7081 also covers the scoreboard-region-of-interest scoping: only OCR
read from the scoreboard ROI may become a score; crowd / banner / jersey /
shot-clock text is cropped out and can never set ``scoreBoardChanged``.
"""
from __future__ import annotations

from app.scoreboard import (
    ScoreboardLocator,
    ScoreboardRoi,
    ScoreboardTracker,
    fallback_score_eligible,
    parse_ocr_score,
    score_changed,
)
from app import _scoreboard_roi


def test_parse_ocr_score_standard_dash():
    assert parse_ocr_score(["Chelsea 2 - 1 Arsenal"]) == (2, 1)


def test_parse_ocr_score_separator_variants():
    assert parse_ocr_score(["45-42"]) == (45, 42)
    assert parse_ocr_score(["2–1"]) == (2, 1)  # en dash


def test_parse_ocr_score_rejects_time_clock():
    # Colon / clock reads are NOT scores; a false score could wrongly confirm a
    # goal (ADAAAA-6360 precision), so they must not become a delta.
    assert parse_ocr_score(["10:15"]) is None
    assert parse_ocr_score(["min 90:00"]) is None


def test_parse_ocr_score_ignores_non_score_lines():
    # No clean two-integer score line -> None (weak/absent evidence).
    assert parse_ocr_score(["second half", "corner kick", "12"]) is None
    assert parse_ocr_score(["2to1"]) is None


def test_parse_ocr_score_empty_and_unicode_dash():
    assert parse_ocr_score([]) is None
    assert parse_ocr_score([None, ""]) is None


def test_parse_ocr_score_rejects_absurd_values():
    # Jersey / clock-like numbers that are not a score should not be a delta.
    assert parse_ocr_score(["123 - 456"]) is None


def test_score_changed_requires_two_concrete():
    assert score_changed(None, (1, 0)) is False
    assert score_changed((1, 0), None) is False
    assert score_changed(None, None) is False
    assert score_changed((1, 0), (2, 0)) is True
    assert score_changed((2, 0), (2, 0)) is False


def test_tracker_delta_across_window():
    tr = ScoreboardTracker(window_seconds=60.0)
    # One reading only -> no delta yet.
    tr.record(10.0, (1, 0))
    assert tr.changed(10.0) is False
    # Same score later -> no delta.
    tr.record(30.0, (1, 0))
    assert tr.changed(40.0) is False
    # Score goes 2-0 within the window -> delta.
    tr.record(45.0, (2, 0))
    assert tr.changed(50.0) is True


def test_tracker_prunes_stale_window():
    tr = ScoreboardTracker(window_seconds=60.0)
    tr.record(1.0, (1, 0))
    tr.record(100.0, (2, 0))
    # The first reading is outside the 60 s window ending at 100 -> pruned,
    # so only "2-0" remains and there is no delta.
    assert tr.changed(100.0) is False


def test_tracker_ignores_none_readings():
    tr = ScoreboardTracker()
    tr.record(10.0, None)
    tr.record(20.0, (1, 0))
    assert tr.changed(20.0) is False


# --- ADAAAA-7081: scoreboard ROI scoping -------------------------------------
# A copy/banner "N - M" line OUTSIDE the scoreboard ROI must never become a
# score. The scoreboard ROI occupies, say, the top-left score bug region; the
# crowd/banner/jersey/clock text lives elsewhere in the frame. We pass per-line
# normalized boxes alongside the OCR text, exactly like a position-aware OCR.


def test_parse_ocr_score_ignores_crowd_line_outside_roi():
    # A banner in the crowd reads "3 - 2" but sits at the bottom-left of the
    # frame, far outside the top-left scoreboard ROI. It must not become a score.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)  # top-left scorebug region
    crowd_line = "HALF TIME 3 - 2"
    crowd_box = [0.05, 0.70, 0.55, 0.80]  # bottom-left crowd/banner band
    assert parse_ocr_score([crowd_line], roi=roi, ocr_boxes=[crowd_box]) is None


def test_parse_ocr_score_returns_only_roi_scoreboard():
    # A real scoreboard inside the ROI wins even when a crowd "N - M" line outside
    # it is also present — the scoreboard read is what we keep.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    crowd_line = "FANS 4 - 1"
    crowd_box = [0.5, 0.6, 0.9, 0.75]
    board_line = "MCI 2 - 1 LIV"
    board_box = [0.02, 0.03, 0.30, 0.20]
    assert parse_ocr_score(
        [crowd_line, board_line], roi=roi, ocr_boxes=[crowd_box, board_box]
    ) == (2, 1)


def test_parse_ocr_score_no_boxes_still_scoped_by_crop():
    # The production path crops the frame to the ROI BEFORE <OCR>, so every line
    # passed in is already in-region and there are no per-line boxes. A line with
    # no box and an active ROI is still eligible (cropping is the single source
    # of truth); a real scoreboard read is kept.
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    assert parse_ocr_score(["2 - 1"], roi=roi) == (2, 1)


def test_parse_ocr_score_crowd_line_cannot_drive_tracker_delta():
    # End-to-end at the pure level: a crowd/banner "N - M" line outside the ROI
    # produces no score, so the tracker can never report a score change for it.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    tr = ScoreboardTracker(window_seconds=60.0)
    tr.record(10.0, parse_ocr_score(["BILLBOARD 1 - 1"], roi=roi, ocr_boxes=[[0.6, 0.7, 0.95, 0.85]]))
    tr.record(
        30.0,
        parse_ocr_score(["BILLBOARD 2 - 1"], roi=roi, ocr_boxes=[[0.6, 0.7, 0.95, 0.85]]),
    )
    # Both reads were outside the ROI -> no score ever recorded -> no delta.
    assert tr.changed(40.0) is False


def test_scoreboard_roi_pixel_box():
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    assert roi.pixel_box(1280, 720) == (0, 0, 640, 180)
    # Degenerate / out-of-range region -> None (caller falls back, never crashes).
    assert ScoreboardRoi(0.5, 0.5, 0.5, 0.6).pixel_box(1280, 720) is None
    assert ScoreboardRoi(-0.1, 0.0, 0.5, 0.6).pixel_box(1280, 720) is None
    assert ScoreboardRoi(0.0, 0.0, 1.0, 1.0).pixel_box(0, 0) is None


def test_scoreboard_roi_contains():
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    assert roi.contains([0.02, 0.03, 0.30, 0.20]) is True   # inside
    assert roi.contains([0.5, 0.6, 0.9, 0.75]) is False     # outside
    assert roi.contains([0.39, 0.24, 0.40, 0.25]) is True   # right on the edge
    assert roi.contains([0.0, 0.0, 1.0, 1.0]) is True       # spans, overlaps


def test_scoreboard_roi_from_env_and_fallback():
    import os
    from app import scoreboard as sb

    env_key = sb._SCOREBOARD_ROI_ENV
    previous = os.environ.get(env_key)
    try:
        os.environ[env_key] = "0.0,0.0,0.5,0.25"
        roi = ScoreboardRoi.from_env()
        assert (roi.x0, roi.y0, roi.x1, roi.y1) == (0.0, 0.0, 0.5, 0.25)
        # Malformed value falls back to the default, never raises.
        os.environ[env_key] = "not,a,box"
        roi2 = ScoreboardRoi.from_env()
        assert roi2.x1 == 1.0 and roi2.y1 == sb._DEFAULT_SCOREBOARD_ROI[3]
    finally:
        if previous is None:
            os.environ.pop(env_key, None)
        else:
            os.environ[env_key] = previous


# --- ADAAAA-7086: scoreboard visibility locator + recall / gate ---------------
# Instead of a fixed per-source PERCEIVE_SCOREBOARD_ROI, the perceive vision step
# predicts the scoreboard region per frame. A scorebug in ANY position (e.g. the
# bottom-right, far outside the old top-band default) must still be found (recall),
# and a frame with no scoreboard must gate the OCR pass off (no ocrHits).


def test_locator_finds_scoreboard_outside_default_top_band():
    # A genuine broadcast scoreboard overlay at the BOTTOM-RIGHT. The old default
    # top-band ROI (0,0,1,0.25) does NOT overlap it, so a fixed-ROI approach would
    # crop it out and never read a score. The locator predicts the region instead
    # of assuming a position -> recall is no longer calibration-dependent.
    def discover(image, task="<DETAILED_CAPTION>"):
        return {
            "method": "region",
            "task": task,
            "regions": [
                {"bbox": [0.55, 0.72, 0.93, 0.90], "caption": "broadcast scoreboard, home 2, away 1"}
            ],
        }

    loc = ScoreboardLocator(discover)
    roi = loc.locate(object())
    assert roi is not None
    # The detected region must cover the actual scorebug box (padded).
    assert roi.contains([0.58, 0.75, 0.90, 0.88])
    # Crucially it does NOT overlap the old default top-band region.
    assert not ScoreboardRoi(0.0, 0.0, 1.0, 0.25).contains([0.58, 0.75, 0.90, 0.88])
    # And a score read from that ROI is a valid reading (recall).
    assert parse_ocr_score(["home 2 away 1", "2 - 1"], roi=roi) == (2, 1)


def test_locator_gates_when_no_scoreboard_visible():
    # A frame with only crowd/banner/ad text (no scoreboard). The locator must
    # return None so the caller gates the OCR pass off -> no score, no ocrHits.
    def discover(image, task="<DETAILED_CAPTION>"):
        return {
            "method": "region",
            "task": task,
            "regions": [
                {"bbox": [0.05, 0.40, 0.95, 0.95], "caption": "crowd of spectators in the stands"}
            ],
        }

    assert ScoreboardLocator(discover).locate(object()) is None


def test_locator_prefers_real_scoreboard_over_generic_region():
    # Two candidate regions: a generic number graphic and a real scoreboard. The
    # locator must select the scoreboard, not the first/noisiest region.
    def discover(image, task="<DETAILED_CAPTION>"):
        return {
            "method": "region",
            "task": task,
            "regions": [
                {"bbox": [0.10, 0.10, 0.40, 0.30], "caption": "advertisement board"},
                {"bbox": [0.55, 0.72, 0.93, 0.90], "caption": "scoreboard showing home 1 away 2"},
            ],
        }

    roi = ScoreboardLocator(discover).locate(object())
    assert roi is not None
    assert roi.contains([0.58, 0.75, 0.90, 0.88])
    assert not roi.contains([0.12, 0.12, 0.38, 0.28])


def test_locator_never_raises_on_missing_or_poor_discovery():
    def failing(image, task="<DETAILED_CAPTION>"):
        raise RuntimeError("gpu down")

    assert ScoreboardLocator(failing).locate(object()) is None
    assert ScoreboardLocator(lambda i, t: {}).locate(object()) is None
    # Missing image -> None (gate), never a crash.
    assert ScoreboardLocator(lambda i, t: {"regions": []}).locate(None) is None


def test_explicit_scoreboard_roi_distinguishes_calibration_from_unset():
    from app import scoreboard as sb

    assert sb.explicit_scoreboard_roi(None) is None
    assert sb.explicit_scoreboard_roi("") is None
    assert sb.explicit_scoreboard_roi("not,a,box") is None
    roi = sb.explicit_scoreboard_roi("0.5,0.6,0.9,0.95")
    assert roi is not None and (roi.x0, roi.y0, roi.x1, roi.y1) == (0.5, 0.6, 0.9, 0.95)


def test_scoreboard_roi_autodetects_bottom_right_and_recall_delta():
    # End-to-end at the pure level: the perceive `_scoreboard_roi` resolves the
    # ROI from a bottom-right scoreboard (no per-source calibration), and a score
    # read from that ROI drives a real `scoreBoardChanged` delta across two
    # different readings.
    from types import SimpleNamespace

    from app import _scoreboard_roi

    class FakeDetector:
        def __init__(self, regions, ocr_lines):
            self._regions = regions
            self._ocr_lines = ocr_lines

        def discover(self, image, task="<DETAILED_CAPTION>"):
            return {"method": "region", "task": task, "regions": self._regions}

        def ocr(self, image, roi=None):
            return self._ocr_lines

    regions = [{"bbox": [0.55, 0.72, 0.93, 0.90], "caption": "broadcast scoreboard"}]
    det = FakeDetector(regions, ["2 - 1"])
    state = SimpleNamespace(last_rgb=object(), scoreboard_visible=None)
    roi = _scoreboard_roi(state, det)
    assert roi is not None
    assert state.scoreboard_visible is True

    tr = ScoreboardTracker(window_seconds=60.0)
    tr.record(10.0, parse_ocr_score(["2 - 1"], roi=roi))
    tr.record(30.0, parse_ocr_score(["3 - 1"], roi=roi))
    assert tr.changed(40.0) is True  # genuine delta on a genuine scoreboard


def test_scoreboard_roi_discovery_miss_falls_back_to_top_band():
    # ADAAAA-7190: the `<DENSE_REGION_CAPTION>` discovery pass is flaky and
    # frequently reports NO scoreboard region even when a numeric scorebug IS
    # present and changing (observed live on job 5c886c12: a discovery miss used
    # to gate the OCR pass off entirely, so every candidate carried eventType
    # SPORTING_EVENT but never scoreBoardChanged, dropping the independent
    # corroboration for a real goal). On a miss the ROI now falls back to the
    # documented default top-band prior (the same prior used when no
    # region-capable detector exists) so the scoreboard OCR can still read a
    # scorebug discovery missed. The anti-forgery property is preserved:
    # `parse_ocr_score` still requires a clean two-integer "N - M" line and the
    # delta still needs two differing concrete readings, so a non-scoreboard
    # top-band read cannot forge a scoreBoardChanged on its own.
    from types import SimpleNamespace

    from app import _scoreboard_roi

    class FakeDetector:
        def discover(self, image, task="<DETAILED_CAPTION>"):
            return {
                "method": "region",
                "task": task,
                "regions": [{"bbox": [0.05, 0.4, 0.95, 0.95], "caption": "banner ad copy"}],
            }

        def ocr(self, image, roi=None):  # pragma: no cover - not driven here
            return ["banner ad copy", "no score here"]

    state = SimpleNamespace(last_rgb=object(), scoreboard_visible=None)
    roi = _scoreboard_roi(state, FakeDetector())
    assert roi is not None
    # Falls back to the default top-band prior (full width, top 25%).
    assert (roi.x0, roi.y0, roi.x1, roi.y1) == (0.0, 0.0, 1.0, 0.25)
    assert state.scoreboard_visible is True
    # Even with the fallback a non-scoreboard top-band read never parses as a
    # score (no clean two-integer line), so no delta can be forged.
    assert parse_ocr_score(["banner ad copy", "no score here"], roi=roi) is None


def test_scoreboard_roi_backoff_bounds_region_pass_and_preserves_recall():
    # ADAAAA-7086 (QA non-blocking finding): an always-no-scoreboard source must
    # not pay a billable region-discovery pass on every candidate frame. We
    # re-attempt only every `_SCOREBOARD_DETECT_BACKOFF` candidates, but a
    # scoreboard that appears mid-stream is still picked up after the backoff.
    from types import SimpleNamespace

    from app import _SCOREBOARD_DETECT_BACKOFF, _scoreboard_roi

    calls = {"n": 0}

    class FakeDetector:
        def discover(self, image, task="<DETAILED_CAPTION>"):
            calls["n"] += 1
            if calls["n"] == 1:
                # No scoreboard yet: only a generic in-frame region.
                return {"method": "region", "task": task,
                        "regions": [{"bbox": [0.1, 0.1, 0.4, 0.3], "caption": "banner ad copy"}]}
            # Scoreboard appears mid-stream -> must be found on the next attempt.
            return {"method": "region", "task": task,
                    "regions": [{"bbox": [0.55, 0.72, 0.93, 0.90], "caption": "broadcast scoreboard"}]}

        def ocr(self, image, roi=None):  # pragma: no cover - gated off
            raise AssertionError("OCR ran when no scoreboard is visible")

    det = FakeDetector()
    state = SimpleNamespace(last_rgb=object(), scoreboard_visible=None)
    # Drive enough candidates to cross one full backoff boundary.
    found = None
    for _ in range(_SCOREBOARD_DETECT_BACKOFF + 1):
        found = _scoreboard_roi(state, det)
    # The region pass ran on candidate 1 and again after the backoff (found now).
    assert calls["n"] == 2, f"region pass not bounded: {calls['n']}"
    assert found is not None, "mid-stream scoreboard not picked up after backoff"
    assert state.scoreboard_visible is True
    assert found.contains([0.58, 0.75, 0.90, 0.88])
    # Once found the region is cached: subsequent candidates pay no region pass.
    before = calls["n"]
    for _ in range(3):
        assert _scoreboard_roi(state, det) == found
    assert calls["n"] == before


# --- ADAAAA-7094: vision-LLM score-text fallback eligibility -----------------
# The empty-crop fallback accepts the LLM `score` only when the LLM-box overlaps
# the configured scoreboard ROI, so a hallucinated box/score off the graphic
# can never become a score and forge a scoreBoardChanged delta.


def test_fallback_eligible_on_roi_overlap():
    # A localized scoreboard inside the configured ROI qualifies (recall case).
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    assert fallback_score_eligible([0.02, 0.03, 0.30, 0.20], roi) is True
    # Overlapping the region edge / spanning it also qualifies.
    assert fallback_score_eligible([0.39, 0.24, 0.40, 0.25], roi) is True
    assert fallback_score_eligible([0.0, 0.0, 1.0, 1.0], roi) is True


def test_fallback_ineligible_for_hallucinated_off_roi_box():
    # The QA finding: a hallucinated box over a no-text region (crowd/banner)
    # is ineligible, so the LLM's "3 - 1" never becomes a score.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)  # top-left scorebug band
    crowd_box = [0.5, 0.6, 0.9, 0.75]  # crowd/banner band, off the ROI
    assert fallback_score_eligible(crowd_box, roi) is False


def test_fallback_ineligible_without_localization():
    # An LLM score without a bounding box (could not localize) must not be
    # trusted on the empty-crop path.
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    assert fallback_score_eligible(None, roi) is False


def test_fallback_ineligible_malformed_or_missing_roi():
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    # Wrong arity / non-numeric box -> not eligible, never raises.
    assert fallback_score_eligible([0.1, 0.1, 0.2], roi) is False
    assert fallback_score_eligible([0.1, 0.1, "x", 0.2], roi) is False  # type: ignore[arg-type]
    # No ROI configured at all -> not eligible (no score, never a delta).
    assert fallback_score_eligible([0.1, 0.1, 0.3, 0.2], None) is False


def test_fallback_score_cannot_forge_delta_when_box_off_roi():
    # End-to-end at the pure level mirroring the ADAAAA-7091 finding: two
    # candidate frames with the crop OCR forced EMPTY and a hallucinated LLM
    # score "3 - 1" then "3 - 2" over an OFF-ROI box. With the eligibility gate
    # the LLM score never becomes a score, so the tracker can never report a
    # delta — the false-positive window is structurally closed.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)  # configured scoreboard ROI
    tr = ScoreboardTracker(window_seconds=60.0)
    for ts, llm_score in [(10.0, "3 - 1"), (30.0, "3 - 2")]:
        hallucinated_box = [0.5, 0.6, 0.9, 0.75]  # off-ROI crowd region
        ocr_lines = (
            [llm_score]
            if fallback_score_eligible(hallucinated_box, roi)
            else []
        )
        score = parse_ocr_score(ocr_lines, roi=roi)
        tr.record(ts, score)
    # No score ever recorded (both reads rejected) -> no delta.
    assert tr.changed(40.0) is False


def test_fallback_score_still_forges_delta_when_box_on_roi():
    # Control: a REAL in-ROI scoreboard (box overlapping the ROI) reading a
    # change across the window still fires a delta — recall is preserved.
    roi = ScoreboardRoi(0.0, 0.0, 0.4, 0.25)
    tr = ScoreboardTracker(window_seconds=60.0)
    for ts, llm_score in [(10.0, "3 - 1"), (30.0, "3 - 2")]:
        real_box = [0.02, 0.03, 0.30, 0.20]  # inside the ROI
        ocr_lines = [llm_score] if fallback_score_eligible(real_box, roi) else []
        score = parse_ocr_score(ocr_lines, roi=roi)
        tr.record(ts, score)
    assert tr.changed(40.0) is True
