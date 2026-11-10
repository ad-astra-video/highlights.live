"""ADAAAA-8548: score-ROI provenance, digit-less region recovery, bounded fallback.

Measured cause of the ADAAAA-8542 AC1 failure: on browser job `50b7aed6` the
`<OCR>` pass ran (4648 records) but EVERY per-frame crop read the same hashtag
graphic (`#BarçaAlavés` and its OCR variants) instead of the score surface —
`WINDOWS_WITH_READS 3/316`, `scoreReads=0`. Two things let that persist for the
whole 1113 s session:

1. no line said WHICH region source chose that box, so the misdirection could not
   be attributed (explicit calibration / discovery / the ADAAAA-7944 selector /
   the vision-LLM box / the built-in top-band prior);
2. a region that printed no digit stayed cached forever, and the whole-frame
   score fallback had no bounded, disclosed budget of its own.

These drive the real frame path (`POST /app/analyze`) with a scripted detector so
the shipped behaviour is asserted where it happens.
"""
import base64
import io
import logging
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import (
    _SCORE_FALLBACK_MAX_READS,
    _SCOREBOARD_ROI_DIGITLESS_FRAMES,
    _SCOREBOARD_ROI_RERESOLVE_MAX,
    _score_fallback_allowance,
    app,
)
from app.scoreboard import SCOREBOARD_SELECT_MAX_FRAMES, ScoreboardRoi

# The measured browser-rail read: a hashtag graphic, never the score surface.
HASHTAG = "#BarçaAlavés"
# A real scorebug read, for the no-regression direction.
SCORE_LINE = "18:19 RMA 2-1 BAR"
BOTTOM = ScoreboardRoi(*_app._SCOREBOARD_BOTTOM_CENTRE_PRIOR)


def _jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


FRAME = _jpeg(np.zeros((60, 80), dtype=np.float32))


class HashtagDet:
    """Every region (and the whole frame) reads the hashtag graphic only."""

    def __init__(self):
        self.ocr_calls = []
        self.whole_frame_calls = 0

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
        return [HASHTAG]


class ScoreDet(HashtagDet):
    """The healthy direction: the crop prints a two-sided score."""

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
        return [SCORE_LINE]


class BlankDet(HashtagDet):
    """The crop reads nothing at all: absent evidence, not a wrong region."""

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
        return []


class FallbackScoreDet(HashtagDet):
    """Crop reads the hashtag; the whole frame DOES carry the score."""

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
            return ["RMA 1-0 BAR"]
        return [HASHTAG]


def _post(client, sid, seq, timestamp=0.0, hint="soccer"):
    return client.post(
        "/app/analyze",
        json={"seq": seq, "timestamp": timestamp, "image": FRAME, "gameHint": hint},
        headers={"X-Session-Id": sid},
    )


@pytest.fixture()
def client():
    return TestClient(app)


def _run(client, det, monkeypatch, frames, hint="soccer"):
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    for seq in range(frames):
        assert _post(client, sid, seq, timestamp=seq / 3.0, hint=hint).status_code == 200
    return sid, app.state.registry.get(sid)


def test_roi_source_is_logged_once_with_its_box(client, monkeypatch, caplog):
    """One INFO line names the region source and its box (the missing evidence)."""
    det = HashtagDet()
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _run(client, det, monkeypatch, frames=SCOREBOARD_SELECT_MAX_FRAMES + 1)

    lines = [r.getMessage() for r in caplog.records if "scoreboard ROI source" in r.getMessage()]
    assert lines, "no ROI provenance line was logged"
    # The scripted detector has no `discover`, so resolution falls to the
    # documented top-band prior — exactly the box an unattributed read needed.
    assert any("source=default_top_band" in line for line in lines)
    assert any("box=(0.000,0.000,1.000,0.250)" in line for line in lines)
    assert any("session=" in line for line in lines)
    # Attributed once per source change, not once per frame.
    assert len(lines) == len(set(lines))


def test_hashtag_only_region_is_reresolved_then_abandoned(client, monkeypatch, caplog):
    """A crop that prints no digit for N frames is re-resolved (bounded) / abandoned."""
    det = HashtagDet()
    frames = (
        SCOREBOARD_SELECT_MAX_FRAMES
        + (_SCOREBOARD_ROI_DIGITLESS_FRAMES + 1) * _SCOREBOARD_ROI_RERESOLVE_MAX
        + 4
    )
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=frames)

    messages = [r.getMessage() for r in caplog.records]
    # The region was not kept for the session: it was re-resolved and finally
    # abandoned onto the documented bottom-centre prior.
    assert state.scoreboard_roi_reresolves == _SCOREBOARD_ROI_RERESOLVE_MAX
    assert state.scoreboard_roi_source == "abandoned_bottom_prior"
    assert _app._same_roi(state.scoreboard_roi, BOTTOM)
    assert any("scoreboard ROI re-resolve" in m for m in messages)
    assert any("scoreboard ROI abandoned" in m and "action=bottom_centre_prior" in m for m in messages)
    # Bounded: no further re-resolve cycles however long the hashtag lasts (the
    # digit-less counter may still be mid-count on the terminal region).
    assert state.scoreboard_roi_digitless < _SCOREBOARD_ROI_DIGITLESS_FRAMES


def test_abandoned_region_stops_churning_after_the_bound(client, monkeypatch):
    """Once the bound is spent the session settles; it never cycles forever."""
    det = HashtagDet()
    _, state = _run(
        client,
        det,
        monkeypatch,
        frames=SCOREBOARD_SELECT_MAX_FRAMES + (_SCOREBOARD_ROI_DIGITLESS_FRAMES + 1) * 4,
    )
    settled = state.scoreboard_roi_source
    cycles = state.scoreboard_roi_reresolves
    assert cycles == _SCOREBOARD_ROI_RERESOLVE_MAX
    # Ten more hashtag frames: no new cycle, same terminal region.
    sid = state.session_id
    for seq in range(200, 200 + _SCOREBOARD_ROI_DIGITLESS_FRAMES * 2):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    assert state.scoreboard_roi_reresolves == cycles
    assert state.scoreboard_roi_source == settled


def test_score_fallback_is_bounded_per_session(client, monkeypatch, caplog):
    """The whole-frame score read fires on 'no parseable score' but cannot run forever."""
    det = HashtagDet()
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=90)

    allowance = _score_fallback_allowance(state)
    assert state.score_fallback_reads > 0, "the whole-frame fallback never fired"
    assert state.score_fallback_reads <= allowance
    assert state.score_fallback_reads < 90, "the fallback ran on (nearly) every frame"
    assert det.whole_frame_calls <= allowance
    # Disclosure: the budget running out is reported, not silent.
    assert any("whole-frame score fallback exhausted" in r.getMessage() for r in caplog.records)


def test_fallback_recovers_a_score_the_crop_could_not_read(client, monkeypatch, caplog):
    """A crop that reads no score is rescued by the whole-frame read (and says so)."""
    det = FallbackScoreDet()
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        sid, state = _run(client, det, monkeypatch, frames=SCOREBOARD_SELECT_MAX_FRAMES + 6)

    # The first frame past the selector probe parses the score from the whole
    # frame instead of leaving the lane unread.
    asserts = [r.getMessage() for r in caplog.records if "whole-frame score fallback" in r.getMessage()]
    assert asserts, "the recovered score was not disclosed"
    assert any("score=1-0" in m for m in asserts)
    assert state.score_fallback_reads >= 1


def test_healthy_two_sided_score_pays_no_extra_read_per_frame(client, monkeypatch):
    """No regression: a legible crop does exactly the reads it did before."""
    det = ScoreDet()
    client_det = det
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: client_det)
    # Spend the bounded selector probe first (ADAAAA-7944) so the steady state
    # is the shipped single-crop path.
    for seq in range(SCOREBOARD_SELECT_MAX_FRAMES):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    state = app.state.registry.get(sid)
    det.ocr_calls.clear()
    det.whole_frame_calls = 0
    det.ocr_calls.clear()
    for seq in range(SCOREBOARD_SELECT_MAX_FRAMES, SCOREBOARD_SELECT_MAX_FRAMES + 12):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    # Exactly one crop read per frame and no whole-frame read: the score parsed
    # from the crop, so the fallback never engaged.
    assert det.whole_frame_calls == 0
    assert len(det.ocr_calls) == 12
    assert all(call is not None for call in det.ocr_calls)
    assert state.score_fallback_reads == 0
    assert state.scoreboard_roi_reresolves == 0


def test_operator_pinned_roi_is_never_invalidated(client, monkeypatch):
    """PERCEIVE_SCOREBOARD_ROI is the operator's call, digit or not."""
    monkeypatch.setenv("PERCEIVE_SCOREBOARD_ROI", "0.1,0.2,0.9,0.8")
    det = HashtagDet()
    _, state = _run(client, det, monkeypatch, frames=SCOREBOARD_SELECT_MAX_FRAMES + 20)
    assert state.scoreboard_roi_source == "explicit"
    assert state.scoreboard_roi_reresolves == 0
    assert (state.scoreboard_roi.x0, state.scoreboard_roi.y0) == (0.1, 0.2)


def test_blank_crop_is_absent_evidence_not_a_wrong_region(client, monkeypatch):
    """A crop that reads NOTHING does not count as a digit-less (wrong) region."""
    det = BlankDet()
    _, state = _run(client, det, monkeypatch, frames=SCOREBOARD_SELECT_MAX_FRAMES + 12)
    assert state.scoreboard_roi_reresolves == 0
    assert state.scoreboard_roi_digitless == 0


def test_fallback_allowance_grows_with_the_job_and_is_capped():
    class S:
        frames_processed = 0

    s = S()
    assert _score_fallback_allowance(s) == _app._SCORE_FALLBACK_HEADROOM
    s.frames_processed = 300
    assert _score_fallback_allowance(s) == 174
    s.frames_processed = 10**6
    assert _score_fallback_allowance(s) == _SCORE_FALLBACK_MAX_READS


class DiscoveryDet(HashtagDet):
    """A region-capable detector whose discovery pass points the ROI at the hashtag."""

    def __init__(self, caption: str = "soccer scoreboard", bbox=(0.0, 0.0, 1.0, 0.25)):
        super().__init__()
        self.regions = [{"caption": caption, "bbox": list(bbox)}]
        self.discover_calls = 0

    def discover(self, image, task=None):
        self.discover_calls += 1
        return {"regions": self.regions}


class DiscoveryScoreDet(DiscoveryDet):
    """Discovery-sourced ROI that DOES print the two-sided score."""

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
        return [SCORE_LINE]


def test_discovered_hashtag_region_is_reresolved_then_abandoned(client, monkeypatch, caplog):
    """A DISCOVERED region (not just the prior) that prints only a hashtag is dropped.

    The ticket's measured defect was a discovered/selected box pointing at the
    hashtag graphic; the shipped top-band test only covers the fallback prior, so
    this pins the discovered-source path through the real `POST /app/analyze` frame
    path: the region is attributed, re-resolved, and finally abandoned.
    """
    det = DiscoveryDet()
    frames = (
        SCOREBOARD_SELECT_MAX_FRAMES
        + (_SCOREBOARD_ROI_DIGITLESS_FRAMES + 1) * _SCOREBOARD_ROI_RERESOLVE_MAX
        + 4
    )
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=frames)

    messages = [r.getMessage() for r in caplog.records]
    assert det.discover_calls > 0, "discovery never ran, so the source was not discovery"
    assert any("source=discovery" in m for m in messages), "the discovered box was not attributed"
    assert any("scoreboard ROI re-resolve" in m and "from_source=discovery" in m for m in messages)
    assert state.scoreboard_roi_reresolves == _SCOREBOARD_ROI_RERESOLVE_MAX
    assert state.scoreboard_roi_source == "abandoned_bottom_prior"
    assert _app._same_roi(state.scoreboard_roi, BOTTOM)


def test_discovered_legible_score_pays_no_extra_read_per_frame(client, monkeypatch):
    """No regression on the discovered path: a legible crop is never churned."""
    det = DiscoveryScoreDet()
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    for seq in range(SCOREBOARD_SELECT_MAX_FRAMES):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    state = app.state.registry.get(sid)
    det.ocr_calls.clear()
    det.whole_frame_calls = 0
    for seq in range(SCOREBOARD_SELECT_MAX_FRAMES, SCOREBOARD_SELECT_MAX_FRAMES + 12):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200

    assert state.scoreboard_roi_source == "discovery"
    assert state.scoreboard_roi_reresolves == 0
    assert state.score_fallback_reads == 0
    assert det.whole_frame_calls == 0
    assert len(det.ocr_calls) == 12
    assert all(call is not None for call in det.ocr_calls)
