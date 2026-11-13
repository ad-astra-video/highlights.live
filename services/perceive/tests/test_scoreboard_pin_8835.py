"""ADAAAA-8835 (Inc 1): the per-job score-bug PIN.

A live stream can carry a PIP of another game with its own score bug. The score
surface used to be a process-global env box or a session-cached discovery guess,
so the foreign bug was a valid winner. The pin (`scoreboardRoi` on every
`/app/analyze`) makes the operator's normalized box the session ROI with source
`explicit`, ahead of discovery, and — for a pinned session — makes it a HARD
scope: no vision-LLM box, no multi-region selector probe, no bottom-prior repair
and no whole-frame team/score fallback can read outside it.

These drive the real frame path (`POST /app/analyze`) with a scripted detector so
the shipped behaviour is asserted where it happens.
"""
import base64
import io
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import app
from app.scoreboard import ScoreboardRoi

PIN = [0.0, 0.0, 0.55, 0.18]
PIN_ROI = ScoreboardRoi(*PIN)
SCORE_LINE = "18:19 RMA 2-1 BAR"
# A foreign PIP bug's plate, read only by a WHOLE-FRAME (out-of-pin) read.
FOREIGN_LINE = "LALIGA 05-40 AL1"
HASHTAG = "#BarçaAlavés"


def _jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


FRAME = _jpeg(np.zeros((60, 80), dtype=np.float32))


class ScriptedDet:
    """Crop reads the scripted lines; the WHOLE frame carries a foreign bug."""

    def __init__(self, crop_lines, whole_lines=(FOREIGN_LINE,)):
        self.crop_lines = list(crop_lines)
        self.whole_lines = list(whole_lines)
        self.ocr_calls = []
        self.whole_frame_calls = 0
        self.discover_calls = 0

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
            return list(self.whole_lines)
        return list(self.crop_lines)

    def discover(self, image, task=None):
        self.discover_calls += 1
        # A confident "scoreboard" region elsewhere (the foreign PIP bug).
        return {"regions": [{"caption": "scoreboard 0-0", "bbox": [0.6, 0.7, 0.95, 0.9]}]}


@pytest.fixture()
def client():
    return TestClient(app)


def _post(client, sid, seq, timestamp=0.0, hint="soccer", roi=None):
    body = {"seq": seq, "timestamp": timestamp, "image": FRAME, "gameHint": hint}
    if roi is not None:
        body["scoreboardRoi"] = roi
    return client.post("/app/analyze", json=body, headers={"X-Session-Id": sid})


def _run(client, det, monkeypatch, frames, roi=None, hint="soccer"):
    sid = f"sess-pin-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq in range(frames):
        r = _post(client, sid, seq, timestamp=seq / 3.0, hint=hint, roi=roi)
        assert r.status_code == 200
        out.append(r.json())
    return sid, out, app.state.registry.get(sid)


def test_pin_is_adopted_as_explicit_ahead_of_discovery(client, monkeypatch):
    """AC1/AC6: the crop is the pin, reported with source `explicit` (never discovery)."""
    det = ScriptedDet([SCORE_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=3, roi=PIN)

    assert state.scoreboard_roi_source == "explicit"
    assert state.scoreboard_roi == PIN_ROI
    # The pin wins BEFORE discovery: the region pass is never even attempted.
    assert det.discover_calls == 0
    for o in obs:
        assert o["scoreboardRoi"] == PIN
        assert o["scoreboardRoiSource"] == "explicit"
        assert o["scoreboardRoiVerified"] is True
    # Every crop this session paid used the pin box (AC2: nothing outside it).
    assert det.ocr_calls and all(roi == PIN_ROI for roi in det.ocr_calls)


def test_pinned_session_never_reads_the_whole_frame(client, monkeypatch):
    """AC2/AC3: the crop reads nothing legible, yet no out-of-pin read happens."""
    det = ScriptedDet([HASHTAG], whole_lines=[FOREIGN_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=4, roi=PIN)

    assert det.whole_frame_calls == 0, "a pinned session read the whole frame"
    assert all(roi == PIN_ROI for roi in det.ocr_calls)
    assert all(o["scoreboardRoiVerified"] is False for o in obs)
    assert obs[0]["scoreboardRoiSource"] == "explicit"


def test_unpinned_session_keeps_todays_behaviour(client, monkeypatch):
    """AC4: without a pin the shipped fallbacks and resolution order are unchanged."""
    det = ScriptedDet([HASHTAG], whole_lines=[FOREIGN_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=4, roi=None)

    # No `scoreboardRoi` delivered -> the scripted detector has no usable
    # discovery region and the session falls to the documented top-band prior,
    # then spends its bounded whole-frame fallback exactly as before.
    assert state.scoreboard_roi_source in ("default_top_band", "selector", "discovery", "learned_crop")
    assert state.scoreboard_roi_source != "explicit"
    assert det.whole_frame_calls > 0, "the unpinned fallback stopped firing (behaviour changed)"
    # The reported surface is ADDITIVE: on this probe-gated frame it may be
    # absent, which is truthful (a union-of-regions read names no single box).
    # What must never happen is a pin label on a session nobody pinned.
    assert obs[0].get("scoreboardRoiSource") != "explicit"


def test_pinned_session_suppresses_the_selector_probe(client, monkeypatch):
    """AC2: the multi-region name probe (bottom bands etc.) must not run on a pin."""
    det = ScriptedDet([HASHTAG], whole_lines=[FOREIGN_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=6, roi=PIN, hint="soccer")

    assert det.whole_frame_calls == 0
    assert all(roi == PIN_ROI for roi in det.ocr_calls)
    assert state.scoreboard_roi_source == "explicit"


def test_pin_is_not_re_resolved_when_it_prints_no_digit(client, monkeypatch):
    """A pin is the operator's call: the digit-less re-resolve cycle never moves it."""
    det = ScriptedDet([HASHTAG], whole_lines=[FOREIGN_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=_app._SCOREBOARD_ROI_DIGITLESS_FRAMES + 3, roi=PIN)

    assert state.scoreboard_roi == PIN_ROI
    assert state.scoreboard_roi_source == "explicit"
    assert state.scoreboard_roi_reresolves == 0


def test_bad_pin_is_ignored_not_fatal(client, monkeypatch):
    """A malformed box never kills the stream and never becomes a scope."""
    det = ScriptedDet([SCORE_LINE])
    sid, obs, state = _run(client, det, monkeypatch, frames=2, roi=[0.0, 0.0, 1.0])

    assert state.scoreboard_roi_source != "explicit"
    assert det.whole_frame_calls >= 0  # still running; no crash
    assert obs[0].get("scoreboardRoiSource") != "explicit"


def test_pin_delivered_per_frame_does_not_re_adopt_or_relog(client, monkeypatch, caplog):
    """The per-analyze carriage costs nothing: one adoption, one log line."""
    import logging

    det = ScriptedDet([SCORE_LINE])
    with caplog.at_level(logging.INFO, logger=_app.log.name):
        sid, obs, state = _run(client, det, monkeypatch, frames=5, roi=PIN)

    pinned_lines = [r.getMessage() for r in caplog.records if "scoreboard ROI pinned" in r.getMessage()]
    assert len(pinned_lines) == 1
    assert "source=job_pin" in pinned_lines[0]


# --- AC3: the PIP repro fixture ---------------------------------------------
#
# The parent defect was a live stream carrying a PIP of ANOTHER game with its own
# score bug inside the shipped top band. The foreign bug's score moved; the
# primary bug's score did not; the OCR read the foreign one and a clip was cut.
#
# The fixture below is geometry-aware so the two bugs are distinguishable by the
# region that is read, which is what makes the AC3 pair meaningful:
#   - a crop that overlaps the FOREIGN bug (bottom-right, OUTSIDE the pin) reads
#     the foreign score, which changes 05-40 -> 06-41 -> 07-42;
#   - a crop that overlaps the PRIMARY bug (top-left, INSIDE the pin) reads the
#     primary score, which never changes;
#   - a whole-frame read (roi=None) sees the foreign bug, as the shipped
#     whole-frame fallback did on the parent report.
# The unpinned control must FIRE on this fixture; the pinned run must not.
FOREIGN_BOX = (0.56, 0.66, 0.99, 0.94)
# `05-40` is deliberately NOT used: perceive's ADAAAA-8507 noise rule reads a
# minute-style pair as clock chrome, so a fixture built on it would never fire
# even unpinned and would prove nothing about the pin.
#
# Schedule (one entry per frame): 1-1 settles, then 2-1, then 3-1. The tracker's
# ADAAAA-7844 legibility bar needs >= 2 contiguous reads per side, so each score
# holds for several frames. Frame 0-3 are the shipped selector-probe frames;
# discovery adopts the FOREIGN box at frame 4, so the delta lands late.
FOREIGN_SCORES = ["LIGA ALV 1-1 BAR"] * 4 + ["LIGA ALV 2-1 BAR"] * 3 + ["LIGA ALV 3-1 BAR"] * 3
PIP_FRAMES = len(FOREIGN_SCORES)
PRIMARY_SCORE = "18:19 RMA 2-1 BAR"


def _overlaps(roi, box) -> bool:
    if roi is None:
        return False
    cx = (float(roi.x0) + float(roi.x1)) / 2.0
    cy = (float(roi.y0) + float(roi.y1)) / 2.0
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


class PipDet:
    """Two score bugs on one frame, separated by geometry (the PIP repro).

    `roi_passes` / `roi_tiles` are the TRACKING ROI tiling counters the real
    detector reports (perceive mirrors their deltas into `roiPasses` /
    `roiTiles`). They are driven here by the tracking pass, never by the
    scoreboard crop, which is what AC5 measures: the pin may not change them.
    """

    def __init__(self):
        self.ocr_calls = []
        self.whole_frame_calls = 0
        self.frame = 0
        self.roi_passes = 0
        self.roi_tiles = 0

    def detect(self, rgb, vocabulary=None):
        self.roi_passes += 1
        self.roi_tiles += 2
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            self.whole_frame_calls += 1
            return [FOREIGN_SCORES[min(self.frame, len(FOREIGN_SCORES) - 1)]]
        if _overlaps(roi, FOREIGN_BOX):
            return [FOREIGN_SCORES[min(self.frame, len(FOREIGN_SCORES) - 1)]]
        return [PRIMARY_SCORE]

    def discover(self, image, task=None):
        # A confident "scoreboard" region over the FOREIGN PIP bug.
        return {"regions": [{"caption": "scoreboard 0-0", "bbox": list(FOREIGN_BOX)}]}


def _run_pip(client, monkeypatch, frames, roi):
    sid = f"sess-pip-{uuid.uuid4().hex[:8]}"
    det = PipDet()
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq in range(frames):
        det.frame = seq
        r = _post(client, sid, seq, timestamp=seq / 3.0, hint="soccer", roi=roi)
        assert r.status_code == 200
        out.append(r.json())
    return det, out, app.state.registry.get(sid)


def test_ac3_pip_fixture_unpinned_control_fires_on_the_foreign_bug(client, monkeypatch):
    """The fixture must reproduce the parent defect, or AC3 proves nothing."""
    det, obs, state = _run_pip(client, monkeypatch, frames=PIP_FRAMES, roi=None)

    assert _overlaps(state.scoreboard_roi, FOREIGN_BOX), "control did not settle on the foreign bug"
    fired = [o for o in obs if o.get("scoreBoardChanged") is True]
    assert fired, "control never saw the foreign score move"
    assert any((o.get("scoreboardDelta") or {}).get("post") == [3, 1] for o in fired)


def test_ac3_pinned_pip_fixture_reads_nothing_outside_the_pin(client, monkeypatch):
    """AC3: with the pin, the foreign bug produces 0 scoreBoardChanged and 0 clips."""
    det, obs, state = _run_pip(client, monkeypatch, frames=PIP_FRAMES, roi=PIN)

    assert det.whole_frame_calls == 0
    assert all(roi == PIN_ROI for roi in det.ocr_calls), "a pinned read went outside the pin"
    assert state.scoreboard_roi == PIN_ROI
    assert all(o.get("scoreBoardChanged") is not True for o in obs)
    # No candidate => no clip. The per-frame payload carries `candidate` only when
    # one was produced, so its absence on every frame is the "0 clips" measurement.
    assert all("candidate" not in o for o in obs)
    assert all(o.get("scoreboardRoiSource") == "explicit" for o in obs)
    # And the pin's own bug is still read every frame (the crop is not blind).
    assert all(o.get("ocr") == [PRIMARY_SCORE] for o in obs)


# --- AC1 / AC5: crop == pin in pixels, and the pin adds no inference ---------

def test_ac1_every_observation_crops_the_pin_within_2px_at_native_resolution(client, monkeypatch):
    """AC1: at 1920x1080 the reported crop is the pin, 0 px off (bar: 2 px)."""
    det, obs, state = _run_pip(client, monkeypatch, frames=PIP_FRAMES, roi=PIN)

    native = (1920, 1080)
    want_px = PIN_ROI.pixel_box(*native)
    assert want_px == (0, 0, 1056, 194)
    for o in obs:
        reported = o["scoreboardRoi"]
        # the normalized box is the pin exactly
        assert reported == PIN
        # and in native pixels it is the pin's pixel box, 0 px off
        assert ScoreboardRoi(*reported).pixel_box(*native) == want_px
    # every crop the detector actually paid was the pin's pixel box
    assert det.ocr_calls and all(roi == PIN_ROI for roi in det.ocr_calls)


def test_ac5_pin_changes_crop_coordinates_only(client, monkeypatch):
    """AC5: roiPasses / roiTiles are identical pinned vs unpinned, and the pin
    never ADDS a read (it removes reads instead: no whole-frame fallback)."""
    det_pin, obs_pin, _ = _run_pip(client, monkeypatch, frames=PIP_FRAMES, roi=PIN)
    det_raw, obs_raw, _ = _run_pip(client, monkeypatch, frames=PIP_FRAMES, roi=None)

    assert [o.get("roiPasses") for o in obs_pin] == [o.get("roiPasses") for o in obs_raw]
    assert [o.get("roiTiles") for o in obs_pin] == [o.get("roiTiles") for o in obs_raw]
    # The counters are live in this fixture (the tracking pass fires), so the
    # equality above is a real reading, not 0 == 0.
    assert any((o.get("roiPasses") or 0) > 0 for o in obs_pin)
    assert sum((o.get("roiTiles") or 0) for o in obs_pin) == sum((o.get("roiTiles") or 0) for o in obs_raw)
    assert len(det_pin.ocr_calls) <= len(det_raw.ocr_calls)
    assert det_pin.whole_frame_calls == 0


