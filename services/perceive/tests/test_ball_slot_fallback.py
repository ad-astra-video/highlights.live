"""ADAAAA-7540: dedicated ball slot ownership for the ball-first soccer roster,
tested end to end through process_frame with a stub SAM backend + a counting
Florence detector.

Root cause (verified on job 7fbcdb02: 0 of 3691 ball tracks carried
`selected`/`onScreen`): the dedicated ball SAM slot is seeded from
`_reseed_from` inside `_sam_step`, which only runs when `_backend.ready()` is
True. When the SAM backend is not ready (the path the job took) `step_frame`
degraded to the pure Florence -> IoU branch, the slot never engaged
(`ball_live` stayed False), and the ball regressed to a generic per-frame
Florence `<OD>` detection with no `selected`/`onScreen` — plus a single
hallucinated "soccer ball" box on non-ball content (confidence 1.0).

Fix: `HybridTracker._own_fallback_ball` owns the ball in the SAME locked slot
even without a ready SAM backend — seeds/refreshes it from the collapsed
single-ball detection, gates by continuity so a hallucination far from the
tracked ball is suppressed (held, never surfaced), and holds through short
absence so `ball_needs_redetect`/`_recover_sam_ball` re-identifies it.
The per-frame vocabulary keeps the ball when the slot is owned by the fallback
(not SAM-propagated) so the fallback has a per-frame presence signal.

No real model required.
"""
import numpy as np

import app as app_mod
from app import florence
from app import process_frame
from app.ball_signal import is_ball_label
from app.sam_tracker import HybridTracker, SamBackend
from app.session import SessionState


class _NotReadyBackend(SamBackend):
    """SAM backend that is NOT ready (the job 7fbcdb02 fallback path)."""

    def ready(self):
        return False

    def advance(self, prompts):
        pass

    def get(self, slot):
        return None


class _ReadyBackend(SamBackend):
    def ready(self):
        return True

    def advance(self, prompts):
        self._cur = dict(prompts)

    def get(self, slot):
        return self._cur.get(slot)


class _ScriptedDetector:
    """Florence counting detector driven by a per-frame ball box script.

    Each call returns the ball box for this frame (or none) from `script`,
    plus a goal box so the frame has a non-ball detection. `calls` indexes the
    script. A call with `ball_vocab` empty/None returns no ball box.
    """

    def __init__(self, script):
        self.script = list(script)  # list of (ball_box or None)
        self.calls = 0
        self.vocabs = []

    def detect(self, rgb, vocabulary=None, roi_pass=True):
        i = self.calls
        self.calls += 1
        self.vocabs.append(list(vocabulary) if vocabulary is not None else None)
        v = vocabulary or []
        objs = []
        if any(is_ball_label(x) for x in v):
            bb = self.script[i] if i < len(self.script) else None
            if bb is not None:
                objs.append({"label": "soccer ball", "confidence": 1.0, "bbox": list(bb)})
        if any(x.lower().startswith("goal") for x in v):
            objs.append({"label": "goal", "confidence": 1.0, "bbox": [0.05, 0.7, 0.45, 0.95]})
        return objs


def _center(b):
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


def _radius(script):
    # ball box nearest to center (0.44, 0.44)
    return [_center(b) for b in script if b is not None]


def _mk(monkeypatch, backend, script):
    det = _ScriptedDetector(script)
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: det)
    state = SessionState(session_id="s-7540")
    state.game_hint = "soccer"
    state.tracker = HybridTracker(backend=backend, ball_label="soccer ball")
    state.last_rgb = np.full((64, 64, 3), 128, np.uint8)
    return state, det


REAL = [0.42, 0.42, 0.46, 0.46]   # real ball, center ~ (0.44, 0.44)
HALL = [0.05, 0.10, 0.30, 0.35]   # far hallucination (ad-board), center ~ (0.175, 0.225)


def test_ball_slot_engages_when_backend_not_ready(monkeypatch):
    """The dedicated ball slot owns a single selected/onScreen ball even without
    a ready SAM backend — no regression to the per-frame generic detection."""
    script = [REAL] * 6
    state, _det = _mk(monkeypatch, _NotReadyBackend(), script)
    for i in range(6):
        obs, _ = process_frame(state, i, float(i), "")
    assert state.tracker.ball_live is True
    ball_tracks = [t for t in obs["tracks"] if is_ball_label(t.get("label", ""))]
    assert ball_tracks, "ball must be tracked"
    assert ball_tracks[0].get("selected") is True
    assert ball_tracks[0].get("onScreen") is True
    # the slot is pinned (never auto-evicted)
    assert state.tracker._ball_slot in state.tracker._iou.locked


def test_fallback_suppresses_far_hallucination(monkeypatch):
    """A hallucinated 'soccer ball' box far from the tracked ball (non-ball
    content) must NOT be surfaced — the ball holds at its last real position."""
    script = [REAL] * 5 + [HALL] * 4 + [REAL] * 3
    state, _det = _mk(monkeypatch, _NotReadyBackend(), script)
    loop_centers = []
    for i in range(len(script)):
        obs, _ = process_frame(state, i, float(i), "")
        btracks = [t for t in obs["tracks"] if is_ball_label(t.get("label", ""))]
        if btracks:
            loop_centers.append(_center(btracks[0]["bbox"]))
    # through the hallucination frames the surfaced ball stays near the real ball
    for c in loop_centers:
        assert abs(c[0] - 0.44) < 0.05 and abs(c[1] - 0.44) < 0.05, c
    # the far hallucination is never surfaced in the object contract either
    state2, _d2 = _mk(monkeypatch, _NotReadyBackend(), script)
    for i in range(len(script)):
        obs, _ = process_frame(state2, i, float(i), "")
        bobj = [o for o in obs["objects"] if is_ball_label(o.get("label", ""))]
        if bobj:
            c = _center(bobj[0]["bbox"])
            assert abs(c[0] - 0.44) < 0.05 and abs(c[1] - 0.44) < 0.05, c


def test_fallback_ball_is_followed_within_continuity_gate(monkeypatch):
    """A real ball moving modestly (within the continuity gate) is adopted and
    followed, not held.""" 
    script = [
        [0.42, 0.42, 0.46, 0.46],
        [0.38, 0.40, 0.42, 0.44],
        [0.34, 0.38, 0.38, 0.42],
    ]
    state, _det = _mk(monkeypatch, _NotReadyBackend(), script)
    seen = []
    for i in range(len(script)):
        obs, _ = process_frame(state, i, float(i), "")
        btracks = [t for t in obs["tracks"] if is_ball_label(t.get("label", ""))]
        if btracks:
            seen.append(_center(btracks[0]["bbox"]))
    # frame 2 should follow the ball to ~ (0.36, 0.40)
    assert abs(seen[-1][0] - 0.36) < 0.05 and abs(seen[-1][1] - 0.40) < 0.05, seen[-1]


def test_sam_path_still_drops_ball_from_perframe_vocab(monkeypatch):
    """When SAM IS ready (the ADAAAA-7217 path), the per-frame vocabulary is
    still ball-stripped once the slot is live — no regression."""
    script = [REAL] * 2
    det = _ScriptedDetector(script)
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: det)
    state = SessionState(session_id="s-sam")
    state.game_hint = "soccer"
    state.tracker = HybridTracker(backend=_ReadyBackend(), ball_label="soccer ball")
    state.last_rgb = np.full((64, 64, 3), 128, np.uint8)
    process_frame(state, 0, 0.0, "")
    obs1, _ = process_frame(state, 1, 1.0, "")
    last_vocab = det.vocabs[-1]
    assert last_vocab is None or not any(is_ball_label(v) for v in last_vocab), last_vocab
    assert any(is_ball_label(o.get("label")) for o in obs1["objects"])
    assert state.tracker.ball_sam_active is True
