"""ADAAAA-7909: scorebug read allowance, ROI-repair skip and per-frame line union.

These drive the real frame path (``POST /app/analyze``) with a scripted detector so
the behaviour the bounded basketball job measured is asserted where it happens —
the flat 40-read cap starved the read allowance 18 % into the clip, the redundant
"repair" re-read the already-active bottom band, and the whole-frame read threw
away the crop's club text.
"""
import base64
import io
import uuid

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import app, _same_roi, _team_fallback_allowance, _union_ocr_lines
from app.scoreboard import ScoreboardRoi, SCOREBOARD_SELECT_MAX_FRAMES

BOTTOM = ScoreboardRoi(0.0, 0.80, 1.0, 1.0)


def _jpeg(gray: np.ndarray) -> str:
    img = Image.fromarray(gray.astype(np.uint8), "L")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


FRAME = _jpeg(np.zeros((60, 80), dtype=np.float32))

# The measured clip shape: the ROI crop clips the home plate off the graphic
# ("…13 8Samsungpor1.C"), while the whole-frame read carries it.
CROP_LINE = "TURKEYMB13 8Samsungpor1.C"
WHOLE_LINE = "TURKIYEBASKETBOLMB13 8Samsunspor1.CDenizi Basket"


class FakeDet:
    """Scripted detector: the crop names only the away club, the frame names both."""

    def __init__(self):
        self.ocr_calls = []

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            return [WHOLE_LINE]
        return [CROP_LINE]


class AlternatingDet(FakeDet):
    """The measured clip shape: a wrong top band first, then a bottom band that
    clips the home plate on ~half the frames (the other half read both clubs)."""

    def __init__(self):
        super().__init__()
        self.frames = 0

    def detect(self, rgb, vocabulary=None):
        self.frames += 1
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is None:
            return [WHOLE_LINE]
        if roi is not None and abs(getattr(roi, "y0", 0.0) - 0.80) < 1e-6:
            # the bottom band: clips the home plate on odd frames
            return [CROP_LINE] if self.frames % 2 else [WHOLE_LINE]
        # any other region (the top-band prior) never reads the graphic
        return ["05ASTEKISTEK"]


def _post(client, sid, seq, timestamp=0.0):
    return client.post(
        "/app/analyze",
        json={
            "seq": seq,
            "timestamp": timestamp,
            "image": FRAME,
            "gameHint": "basketball",
        },
        headers={"X-Session-Id": sid},
    )


def test_team_fallback_allowance_grows_with_the_job_and_is_capped():
    class S:
        frames_processed = 0

    s = S()
    assert _team_fallback_allowance(s) == 8  # headroom, so early frames can repair, so the first frames can repair
    s.frames_processed = 300
    assert _team_fallback_allowance(s) == 158  # a 90 s clip at 3 fps: covers the job
    s.frames_processed = 10**6
    assert _team_fallback_allowance(s) == _app._TEAM_FALLBACK_MAX_READS


def test_same_roi_matches_the_bottom_prior():
    assert _same_roi(BOTTOM, ScoreboardRoi(*_app._SCOREBOARD_BOTTOM_CENTRE_PRIOR))
    assert not _same_roi(ScoreboardRoi(0.0, 0.0, 1.0, 0.25), BOTTOM)
    assert not _same_roi(None, BOTTOM)


def test_union_ocr_lines_keeps_both_reads_deduped_and_capped():
    assert _union_ocr_lines([CROP_LINE], [WHOLE_LINE]) == [CROP_LINE, WHOLE_LINE]
    assert _union_ocr_lines([CROP_LINE], [CROP_LINE]) == [CROP_LINE]
    assert _union_ocr_lines(["a"], ["a", "b", "c", "d", "e"], cap=3) == ["a", "b", "c"]
    assert _union_ocr_lines(None, ["b"]) == ["b"]


def test_clipped_frames_keep_being_repaired_past_the_old_flat_cap(monkeypatch):
    """The read allowance must not run out 18 % into the clip (measured 40@seq 55)."""
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    det = AlternatingDet()
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    client = TestClient(app)
    bodies = {}
    for seq in range(120):
        r = _post(client, sid, seq, timestamp=seq / 3.0)
        assert r.status_code == 200
        bodies[seq] = r.json()
    state = app.state.registry.get(sid)
    # 60 clipped frames were repaired; the flat cap (40) stopped at seq ~55, i.e.
    # 18 % into a 90 s clip.
    assert state.team_fallback_reads >= 60
    # A clipped frame well past the old cap carries the club text the whole-frame
    # read recovered AND the crop's own line, so it votes for both sides.
    clipped = [seq for seq in bodies if seq > 60 and seq % 2 == 0]  # frames counter = seq + 1
    assert clipped, "the fixture produces clipped frames past seq 60"
    kept = [bodies[seq]["ocr"] for seq in clipped if WHOLE_LINE in bodies[seq]["ocr"]]
    assert kept, "a clipped frame past the old cap keeps the recovered club text"
    assert any(CROP_LINE in lines and WHOLE_LINE in lines for lines in kept)


def test_repair_read_is_skipped_when_the_bottom_prior_is_already_active(monkeypatch):
    """Re-reading the already-active region wastes the allowance (2 reads -> 1)."""
    sid = f"sess-{uuid.uuid4().hex[:8]}"
    det = FakeDet()
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    client = TestClient(app)
    # ADAAAA-7944: the temporal ROI selector probes the candidate regions on the
    # first frames (it cannot resolve on this fixture — no line names a pair).
    # Spend that bounded probe first so the measured frame runs the shipped path.
    for seq in range(SCOREBOARD_SELECT_MAX_FRAMES):
        assert _post(client, sid, seq, timestamp=seq / 3.0).status_code == 200
    state = app.state.registry.get(sid)
    assert state.scoreboard_selector.frames == SCOREBOARD_SELECT_MAX_FRAMES
    state.scoreboard_roi = BOTTOM  # as adopted from the first frame
    det.ocr_calls.clear()
    _post(client, sid, SCOREBOARD_SELECT_MAX_FRAMES, timestamp=2.0)
    # The active crop + the whole frame, and NOT a third read of the identical
    # bottom band the crop already covered.
    assert len(det.ocr_calls) == 2
    assert det.ocr_calls[1] is None
