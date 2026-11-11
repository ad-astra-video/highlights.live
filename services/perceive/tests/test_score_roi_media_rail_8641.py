"""ADAAAA-8641: the media-rail crop was misdirected, not broken.

Measured on browser job `f02ec0bf` (session `0a59dabf`, media rail 640x360,
deployed `origin/master` `a8b5b70`):

* seq 1 used the shipped TOP-BAND prior `(0,0,1,0.25)` and the crop parsed the
  score — no whole-frame fallback read was charged for the first 70 frames;
* at seq 71 `locate()` returned an ad-board box `(0.433,0.050,0.654,0.486)` and
  the session adopted it, so every later crop read `Aszende` and never a score;
* re-resolving threw that box away and discovery returned the IDENTICAL box at
  seq 76; after three cycles the session settled on the bottom-centre prior,
  which reads only the `Art Soccer` watermark;
* the bounded whole-frame fallback then carried every read until
  `fallback exhausted ... reads=119 allowance=119` at seq 211.

Replayed against the session's own stored frames inside the running perceive
container, the crop path itself is healthy: the top band reads
`19:38 RMA 2-1 BAR` (frame 71) / `18:03 RMA 1-1 BAR` (frame 111) while the
ad-board box reads `Aszende` and the bottom prior reads `Art Soccer`. So the
fix belongs in region selection, and these tests pin it through the real
`POST /app/analyze` frame path:

1. a crop that PARSES a score is adopted for the session (`learned_crop`), so a
   later discovery guess cannot replace the box that actually reads;
2. a box a re-resolve threw away as digit-less is never re-adopted;
3. a session that once had a parsing box settles back on it instead of the
   bottom-centre prior;
4. the once-per-session crop probe line records box, crop pixels and both reads.
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
    _SCOREBOARD_ROI_DIGITLESS_FRAMES,
    _SCOREBOARD_ROI_RERESOLVE_MAX,
    app,
)
from app.scoreboard import SCOREBOARD_SELECT_MAX_FRAMES, ScoreboardRoi
from app.session import SessionState

TOP = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
# The measured discovery box (before the locator's 0.04 pad).
RAIL_BBOX = (0.433, 0.050, 0.654, 0.486)
RAIL_BOX = ScoreboardRoi(0.393, 0.010, 0.694, 0.526)
BOTTOM = ScoreboardRoi(*_app._SCOREBOARD_BOTTOM_CENTRE_PRIOR)
# The plate the media-rail crop carries on a real frame of this session.
SCORE_LINE = "19:38 RMA 2-1 BAR"
# The ad-board copy the wrong discovery box read instead.
AD_LINE = "Aszende"
# The watermark the abandoned bottom prior read instead.
WATERMARK = "Art Soccer"


def _jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


# 640x360 like the measured media-rail frame, so the crop pixel sizes in the
# probe line are the ones the field log would print.
FRAME = _jpeg(np.zeros((360, 640), dtype=np.float32))


def _same(roi, other, tol=1e-3):
    if roi is None:
        return False
    return all(
        abs(float(getattr(roi, k)) - float(getattr(other, k))) <= tol
        for k in ("x0", "y0", "x1", "y1")
    )


class MediaRailDet:
    """The measured media-rail frame: only the TOP BAND crop parses a score."""

    def __init__(self, discover_bbox=RAIL_BBOX, discover_misses=0):
        self.discover_bbox = discover_bbox
        self.discover_misses = discover_misses
        self.discover_calls = 0
        self.ocr_calls = []
        self.whole_frame_calls = 0

    def detect(self, rgb, vocabulary=None):
        return []

    def discover(self, image, task=None):
        self.discover_calls += 1
        if self.discover_misses > 0:
            self.discover_misses -= 1
            return {"regions": []}
        if self.discover_bbox is None:
            return {"regions": []}
        return {
            "regions": [
                {"caption": "scoreboard", "bbox": list(self.discover_bbox)},
            ]
        }

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
            return ["19:38RMA 2-1 BARAszendeArt Soccer"]
        if _same(roi, TOP):
            return [SCORE_LINE]
        if _same(roi, BOTTOM):
            return [WATERMARK]
        return [AD_LINE]


class BlindPriorDet(MediaRailDet):
    """The prior cannot read this source; only the discovered box can."""

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
            return [SCORE_LINE]
        if _same(roi, TOP):
            return [WATERMARK]
        if _same(roi, BOTTOM):
            return [WATERMARK]
        return [SCORE_LINE]


def _post(client, sid, seq, timestamp=0.0):
    return client.post(
        "/app/analyze",
        json={"seq": seq, "timestamp": timestamp, "image": FRAME},
        headers={"X-Session-Id": sid},
    )


@pytest.fixture()
def client():
    return TestClient(app)


def _run(client, det, monkeypatch, frames, hint=""):
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    # Discovery every frame keeps the media-rail geometry under test without
    # depending on the shipped 5-frame backoff.
    monkeypatch.setattr(_app, "_SCOREBOARD_DETECT_BACKOFF", 1)
    for seq in range(frames):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    return sid, app.state.registry.get(sid)


def test_media_rail_learns_the_crop_that_parses_and_pays_no_fallback(client, monkeypatch, caplog):
    """A discovering miss + a parsing crop: the crop is adopted and no fallback runs."""
    # The measured session: discovery MISSED on the first frames (its
    # `<DENSE_REGION_CAPTION>` pass is flaky), the top-band crop parsed the score.
    det = MediaRailDet(discover_misses=1000)
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=30)

    assert _same(state.scoreboard_roi, TOP), "the parsing crop was not adopted for the session"
    assert state.scoreboard_roi_source == "learned_crop"
    # Recall-safe and cheap: once learned, every read is the crop the session
    # proved — no whole-frame escape hatch, no extra OCR per frame.
    assert state.score_fallback_reads == 0
    assert det.whole_frame_calls == 0
    assert any("scoreboard ROI learned" in r.getMessage() for r in caplog.records)


def test_learned_crop_survives_a_later_wrong_discovery_box(client, monkeypatch, caplog):
    """Once the crop is learned, a subsequent discovery guess cannot replace it."""
    # Discovery returns the measured ad-board box on its first attempt; the prior
    # has already parsed the score, so the incumbent box is kept and the crop
    # stays the reader.
    det = MediaRailDet(discover_misses=1)
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=60)

    assert _same(state.scoreboard_roi, TOP)
    assert state.scoreboard_roi_source in ("learned_crop", "incumbent_proven_box")
    # The frame that first read the discovery box already paid one whole-frame
    # read before the incumbent could be known; every read after it is the crop.
    assert state.score_fallback_reads <= 1
    assert det.whole_frame_calls <= 1
    assert not _same(state.scoreboard_roi, RAIL_BOX)
    assert any("scoreboard ROI incumbent kept" in r.getMessage() for r in caplog.records)


def test_rejected_discovery_box_is_never_readopted(client, monkeypatch, caplog):
    """The measured seq-75/76 loop: the same bad box must not come back."""
    # Discovery succeeds immediately with the ad-board box, so the session starts
    # on the wrong region; the prior is what reads the score once it is dropped.
    det = MediaRailDet()
    frames = (_SCOREBOARD_ROI_DIGITLESS_FRAMES + 1) * 6
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _, state = _run(client, det, monkeypatch, frames=frames)

    messages = [r.getMessage() for r in caplog.records]
    assert any("scoreboard ROI re-resolve" in m for m in messages)
    assert any("scoreboard ROI discovery rejected" in m for m in messages)
    # The bad box was rejected exactly once and never became the region again.
    assert _app._roi_signature(RAIL_BOX) in state.scoreboard_roi_rejected
    assert not _same(state.scoreboard_roi, RAIL_BOX)
    assert state.scoreboard_roi_reresolves <= _SCOREBOARD_ROI_RERESOLVE_MAX
    # The session ends reading the crop that actually parses the score, so the
    # last recorded reading comes from a crop, not from the escape hatch.
    assert _same(state.scoreboard_roi, TOP)
    assert state.scoreboard_tracker is not None


def test_proven_box_is_restored_instead_of_the_bottom_prior():
    """A session that once parsed a score settles back on that box on abandon."""
    state = SessionState(session_id="sess-restore")
    proven = _app.ScoreboardRoi(*_app._SCOREBOARD_BOTTOM_CENTRE_PRIOR)
    state.scoreboard_roi_proven = _app._roi_signature(TOP)
    state.scoreboard_roi = _app.ScoreboardRoi(0.0, 0.19, 1.0, 0.448)
    state.scoreboard_roi_reresolves = _SCOREBOARD_ROI_RERESOLVE_MAX - 1
    state.scoreboard_roi_digitless = _SCOREBOARD_ROI_DIGITLESS_FRAMES - 1
    status = _app._abandon_digitless_scoreboard_roi(
        state, 111, state.scoreboard_roi, ["Aszende"], "discovery"
    )
    assert status == "restored"
    assert _same(state.scoreboard_roi, TOP)
    assert state.scoreboard_roi_source == "restored_proven_box"
    assert _app._roi_signature(state.scoreboard_roi) == _app._roi_signature(TOP)
    assert not _same(state.scoreboard_roi, proven)


def test_crop_probe_line_names_box_pixels_and_both_reads(client, monkeypatch, caplog):
    """One INFO line per session: crop box, crop px, crop text next to the whole text."""
    det = MediaRailDet()
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        _run(client, det, monkeypatch, frames=20)

    probes = [r.getMessage() for r in caplog.records if "scorebug crop probe" in r.getMessage()]
    assert probes, "no crop probe line was logged"
    assert len(probes) == 1, "the probe must cost one line per session, not one per frame"
    line = probes[0]
    # The measured wrong box, its pixel size on a 640x360 media-rail frame, and
    # both reads of the SAME frame.
    assert "box=(0.393,0.010,0.694,0.526)" in line
    assert "crop_px=192x185" in line
    assert "crop_text=['Aszende']" in line
    assert "19:38RMA 2-1 BAR" in line
    assert "whole_score=2-1" in line
