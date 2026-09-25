"""INC-7 / ADAAAA-4452 — live vs VOD track-capacity carve-out.

Locks the mode-gated cap: a live session (no clip) tracks 3 concurrent objects,
a VOD pass (clip_path set) tracks up to 8, and the capacity is threaded into the
tracker the session instantiates. Raising the cap must never reduce the schema
ceiling nor the ball guard (covered by test_ball_persistence_at_cap.py).
"""
import pytest

from app.session import SessionRegistry, mode_capacity
from app.tracker import IoUTracker, LIVE_MAX_TRACKS, MAX_TRACKS, VOD_MAX_TRACKS
from app import session as session_mod
from app.sam_tracker import HybridTracker


def test_charter_caps_live_3_vod_8():
    # Charteer target: 3 concurrent live objects, 8 in a VOD pass.
    assert LIVE_MAX_TRACKS == 3
    assert VOD_MAX_TRACKS == 8
    assert MAX_TRACKS == 8  # schema ceiling (VOD chart target) stays 8


def test_mode_capacity_carve_out():
    # A session with a clip_path is a VOD pass (deep-detail budget) -> 8.
    assert mode_capacity(clip_path="/clips/stream-a.webm") == VOD_MAX_TRACKS
    # A live session (no clip) -> 3.
    assert mode_capacity(clip_path="") == LIVE_MAX_TRACKS
    assert mode_capacity() == LIVE_MAX_TRACKS


class StubBackend:
    def __init__(self, clip_path):
        self.clip_path = clip_path

    def ready(self):
        return True


@pytest.fixture
def florence_sam(monkeypatch):
    monkeypatch.setenv("PERCEIVE_TRACKER", "florence_sam")
    monkeypatch.setattr("app.sam_tracker._real_sam3_backend", lambda clip=None: StubBackend(clip))


def _session_iou(reg, sid, clip_path):
    """A session's tracker is an IoUTracker (default PERCEIVE_TRACKER=iou), so
    the mode carve-out is observable directly via .step()."""
    s = reg.get_or_create(sid, "", clip_path)
    assert isinstance(s.tracker, IoUTracker)
    return s.tracker


def test_live_session_caps_at_3():
    reg = SessionRegistry(max_sessions=2)
    tr = _session_iou(reg, "live-sess", "")  # no clip -> live mode
    assert tr.capacity == LIVE_MAX_TRACKS == 3
    # seek 4 objects into a live session -> only 3 slots used
    boxes = [(i * 0.2, i * 0.2, i * 0.2 + 0.1, i * 0.2 + 0.1) for i in range(4)]
    trs = tr.step(boxes, ts=1.0)
    assert len(trs) == 3
    assert {t.slot for t in trs} == {0, 1, 2}


def test_vod_session_caps_at_8():
    reg = SessionRegistry(max_sessions=2)
    tr = _session_iou(reg, "vod-sess", "/clips/stream-b.webm")  # clip -> VOD mode
    assert tr.capacity == VOD_MAX_TRACKS == 8
    boxes = [(i * 0.1, i * 0.1, i * 0.1 + 0.04, i * 0.1 + 0.04) for i in range(9)]
    trs = tr.step(boxes, ts=1.0)
    assert len(trs) == 8
    assert {t.slot for t in trs} == set(range(8))


def test_iou_default_capacity_is_schema_ceiling():
    # Default (no explicit capacity) must still honour the risen schema ceiling.
    tr = IoUTracker()
    assert tr.capacity == MAX_TRACKS == 8
