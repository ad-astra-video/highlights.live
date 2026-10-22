"""ADAAAA-7217 (Increments A+B): ball/player on-demand handoff, tested end to end
through process_frame with a stub SAM backend + a counting Florence detector.

  * Increment A: once the ball SAM slot is live, the per-frame full-frame
    Florence <OD> pass no longer includes the ball (its vocabulary is ball-free),
    and the SAM ball box is fed to the ball-signal pipeline / the observation.
  * Increment B: on a default soccer stream nobody asks for a player, so the
    per-frame roster is ball-first — the detector is never asked for players.

No real model required.
"""
import numpy as np

import app as app_mod
from app import florence
from app import process_frame
from app.ball_signal import is_ball_label
from app.sam_tracker import HybridTracker, SamBackend
from app.session import SessionState


class _TrackBall(SamBackend):
    """Stub SAM: always propagates the prompts (so the ball slot box survives)."""

    def ready(self):
        return True

    def advance(self, prompts):
        self._cur = dict(prompts)

    def get(self, slot):
        return self._cur.get(slot)


class _CountingDetector:
    """Records the closed vocabulary passed to each per-frame detect() call.

    On the very first call it identifies the ball (bootstrapping the SAM slot);
    the per-frame pass afterwards returns nothing (the ball is dropped), so we
    can assert the ball is no longer in the per-frame vocabulary.
    """

    def __init__(self, ball_box):
        self.ball_box = list(ball_box)
        self.calls = 0
        self.vocabs = []

    def detect(self, rgb, vocabulary=None, roi_pass=True):
        self.calls += 1
        self.vocabs.append(list(vocabulary) if vocabulary is not None else None)
        if self.calls == 1:
            return [{"label": "soccer ball", "confidence": 0.9, "bbox": list(self.ball_box)}]
        return []


def test_process_frame_ball_handoff_drops_ball_from_perframe_detect(monkeypatch):
    det = _CountingDetector(ball_box=(0.3, 0.3, 0.5, 0.5))
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: det)

    state = SessionState(session_id="s-ab")
    state.game_hint = "soccer"
    state.tracker = HybridTracker(backend=_TrackBall(), ball_label="soccer ball")
    state.last_rgb = np.full((64, 64, 3), 128, np.uint8)

    # Frame 0: Florence identifies the ball -> the locked ball SAM slot starts.
    obs0, _ = process_frame(state, 0, 0.0, "")
    assert state.tracker.ball_live is True
    assert any(is_ball_label(o.get("label")) for o in obs0["objects"])
    assert state.tracker._ball_slot in state.tracker._iou.locked  # never evicted

    # Frame 1: SAM owns the ball -> the per-frame full-frame <OD> vocabulary no
    # longer includes the ball (ball-first, AND ball dropped when SAM is live).
    obs1, _ = process_frame(state, 1, 1.0, "")
    last_vocab = det.vocabs[-1]
    assert last_vocab is None or not any(is_ball_label(v) for v in last_vocab), last_vocab
    # The observation still reports the ball, sourced from the SAM box.
    assert any(is_ball_label(o.get("label")) for o in obs1["objects"])
    # And the SAM ball box is fed forward on the track cadence (no new full-frame
    # ball detect: the detector was asked for a ball-free vocabulary).
    assert state.tracker.ball_live is True
