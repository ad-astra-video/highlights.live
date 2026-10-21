"""process_frame Tier-2 signal-gate integration tests (ADAAAA-7135).

Drives process_frame and asserts the two-tier escalation wiring:

  * the gate is OFF by default, so every Stage-A candidate surfaces unchanged
    (legacy high-recall behavior — the flood fix is carried at the recording
    layer by the confirmed-only jobTrail rule, which is recall-safe);
  * with PERCEIVE_SIGNAL_GATE=1, a candidate that no goal-signal channel
    judged STILL escalates (recall safety: a genuine goal in an uncalibrated /
    disabled session is never starved).

The gate's suppression-vs-escalation predicate is covered exhaustively in
test_signal_gate.py; these integration tests only verify the module wiring
(env flag on/off, candidate surfacing, recall-safety) because the goal-crossing
recall path depends on candidate-anchor timing that must be measured on the box
against real_goal_3080.mp4 (criterion 4, ADAAAA-7136) — not on a synthetic
frame sequence.
"""

import os

import pytest

import app as app_mod
from app import process_frame
from app.session import SessionState
from app.tracker import IoUTracker

import tests.test_ball_signal as t


class _FakeDetector:
    def __init__(self, objects_per_frame):
        self._frames = list(objects_per_frame)
        self._i = 0

    def detect(self, rgb, vocabulary=None):
        if self._i < len(self._frames):
            out = self._frames[self._i]
            self._i += 1
            return out
        return []


def _state():
    state = SessionState(session_id="s-gate")
    state.tracker = IoUTracker()
    state.homography = t.H
    return state


def _move_player_frames(n, player_dx=0.20):
    """Fast-moving player frames (no ball, no goal line) that trip the tracker
    motion-burst candidate."""
    frames = []
    player_center = 0.15
    for _ in range(n):
        box = [player_center * 1000 - 60, 350, player_center * 1000 + 60, 600]
        frames.append([{"label": "player", "confidence": 0.9, "bbox": box}])
        player_center += player_dx
    return frames


@pytest.fixture
def gate_on(monkeypatch):
    os.environ["PERCEIVE_SIGNAL_GATE"] = "1"
    monkeypatch.setattr(app_mod, "SIGNAL_GATE_ENABLED", True)


@pytest.fixture
def gate_off(monkeypatch):
    os.environ["PERCEIVE_SIGNAL_GATE"] = "0"
    monkeypatch.setattr(app_mod, "SIGNAL_GATE_ENABLED", False)


def _drive(state, monkeypatch, frames, n, dt=0.1):
    fake = _FakeDetector(frames)
    monkeypatch.setattr(app_mod, "get_detector", lambda lora_ref=None: fake)
    out = []
    for k in range(n):
        _obs, cand = process_frame(state, seq=k, timestamp=k * dt, image_b64="")
        out.append(cand)
    return out


def test_gate_defaults_off(monkeypatch):
    """The flag defaults OFF (legacy behavior) even when the env var is unset."""
    monkeypatch.delenv("PERCEIVE_SIGNAL_GATE", raising=False)
    # reload the module-level switch by importing it fresh is unnecessary: the
    # default is read at import time from an unset env -> "0".
    assert app_mod.SIGNAL_GATE_ENABLED is False


def test_gate_off_surfaces_every_candidate(monkeypatch, gate_off):
    """With the gate OFF (default) the legacy high-recall behavior is preserved:
    every motion-burst candidate surfaces."""
    state = _state()
    cands = _drive(state, monkeypatch, _move_player_frames(12), 12)
    assert any(c is not None for c in cands), "gate off must preserve legacy candidate emission"


def test_gate_on_recall_safety_escalates_when_no_channel_judged(monkeypatch, gate_on):
    """With the gate ON and NO goal-signal channel configured (no goal-line spec,
    no attestation, no scoreboard), a motion-burst candidate STILL escalates —
    recall safety. A genuine goal in such a session must never be starved."""
    state = _state()
    cands = _drive(state, monkeypatch, _move_player_frames(12), 12)
    assert any(c is not None for c in cands), "gate on + no goal channel must escalate (recall safety)"
