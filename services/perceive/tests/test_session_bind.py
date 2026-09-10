"""Per-JOB clip binding on the persistent session: each session's tracker gets a
Sam3Backend pointed at ITS recorded stream (not a global env), and a (re)declared
clip rebuilds/rebinds it so a session can move to a fresh stream."""
import pytest

from app import session as session_mod
from app.sam_tracker import HybridTracker


class StubBackend:
    def __init__(self, clip_path):
        self.clip_path = clip_path

    def ready(self):
        return True


@pytest.fixture
def florence_sam(monkeypatch):
    monkeypatch.setenv("PERCEIVE_TRACKER", "florence_sam")
    monkeypatch.setattr("app.sam_tracker._real_sam3_backend", lambda clip=None: StubBackend(clip))


def test_new_session_binds_clip(florence_sam):
    reg = session_mod.SessionRegistry(max_sessions=4)
    s = reg.get_or_create("s1", "", "/clips/stream-a.webm")
    assert isinstance(s.tracker, HybridTracker)
    assert s.tracker._backend.clip_path == "/clips/stream-a.webm"
    assert s.clip_path == "/clips/stream-a.webm"


def test_clip_redeclared_rebinds_tracker(florence_sam):
    reg = session_mod.SessionRegistry(max_sessions=4)
    s = reg.get_or_create("s1", "", "/clips/a.webm")
    first = s.tracker
    s2 = reg.get_or_create("s1", "", "/clips/b.webm")
    assert s2 is s  # same persistent session object
    assert s.clip_path == "/clips/b.webm"
    assert s.tracker is not first  # tracker rebound to the new clip
    assert s.tracker._backend.clip_path == "/clips/b.webm"


def test_repeat_same_clip_preserves_tracker(florence_sam):
    reg = session_mod.SessionRegistry(max_sessions=4)
    s = reg.get_or_create("s1", "", "/clips/a.webm")
    first = s.tracker
    s2 = reg.get_or_create("s1", "", "/clips/a.webm")
    assert s.tracker is first  # unchanged


def test_no_clip_defaults_to_fallback(monkeypatch):
    # mode florence_sam but no clip -> backend built with clip=None (falls back
    # to Florence->IoU at runtime when SAM can't open a clip)
    monkeypatch.setenv("PERCEIVE_TRACKER", "florence_sam")
    monkeypatch.setattr("app.sam_tracker._real_sam3_backend", lambda clip=None: StubBackend(clip))
    s = session_mod.SessionRegistry(max_sessions=4).get_or_create("s1")
    assert isinstance(s.tracker, HybridTracker)
    assert s.tracker._backend.clip_path is None
