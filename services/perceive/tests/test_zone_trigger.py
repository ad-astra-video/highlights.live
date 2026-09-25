"""Tests for the INC-3 detection-in-zone Stage-A candidate trigger.

Lock the Stage-A trigger behaviour (research §3/§5): a UNION of cheap (no-GPU)
triggers generates candidates — this one fires on a detection entering a
per-sport scoring zone and folds the INC-2b ball velocity/possession signals
in. It is a *candidate trigger only*: it never decides a highlight (Stage-B /
Gemma runs later, on candidates only), and it is pure compute so the gate path
bills no GPU.

Module-level cases (pure, synthetic boxes):
  * zone resolution per sport (soccer goals, basketball hoop, tennis net);
  * a player detection entering a zone -> candidate (eventType GOAL on soccer);
  * a ball in a zone without velocity/possession confirmation -> gated (FP-rate
    discipline), confirmed by a real possession or fast velocity -> candidate;
  * a fast ball velocity spike on its own (no zone overlap) -> candidate;
  * cooldown suppresses a second candidate;
  * unknown sport / empty zones -> inert (no crash, no candidate);

Integration (process_frame wiring):
  * a detection-in-zone candidate fires through process_frame, carries the
    sport-classified eventType + ball signal fields, and is a candidate only.
"""
import numpy as np

import app as app_mod
from app import process_frame
from app.zone_trigger import (
    BALL_TARGET_SPEED_MPS,
    DEFAULT_ZONES,
    BallPlayConfig,
    DetectionZoneTrigger,
    ZoneTriggerConfig,
    ball_in_play_area,
    detection_in_zone,
    resolve_zones,
)

DT = 1.0 / 60


def _track(bbox, kind="player", label="player"):
    """Minimal track-like object with bbox/kind/label attributes."""
    from types import SimpleNamespace
    return SimpleNamespace(bbox=tuple(bbox), kind=kind, label=label)


def _ball_fields(speed=None, possession=None):
    f = {}
    if speed is not None:
        f["ballVelocity"] = {"speedMps": float(speed), "homography": True}
    if possession is not None:
        f["ballPossession"] = {"possessingPlayerId": possession, "distanceM": 1.2}
    return f


# ------------------------------------------------------------ zone resolution
def test_resolve_zones_per_sport():
    soccer = resolve_zones("Premier League")
    assert len(soccer) == 2  # left + right goal mouths
    assert soccer == DEFAULT_ZONES["soccer"]
    assert resolve_zones("basketball") == DEFAULT_ZONES["basketball"]
    assert resolve_zones("tennis") == DEFAULT_ZONES["tennis"]


def test_resolve_zones_unknown_sport_is_inert():
    assert resolve_zones(None) == []
    assert resolve_zones("valorant") == []  # no canned zones
    assert resolve_zones("") == []


def test_detection_in_zone_finds_center_overlap():
    zones = [DEFAULT_ZONES["soccer"][0]]  # left goal mouth
    # track center at (0.05, 0.5) -> inside the left zone
    hit = detection_in_zone([_track((0.0, 0.4, 0.10, 0.6))], zones)
    assert hit is not None
    # track center at (0.5, 0.5) -> outside the left goal mouth
    assert detection_in_zone([_track((0.4, 0.4, 0.6, 0.6))], zones) is None


def test_widened_soccer_zone_catches_near_goal(monkeypatch):
    """INC-9 (ADAAAA-4496): the soccer zones were widened so NEAR-GOAL action in
    the penalty box — outside the old 12% goal-mouth strip — still fires a GOAL
    candidate. A player at x_center=0.18 (inside the widened 0.24 zone, outside
    the old 0.12 strip) must trigger; a mid-field player must not."""
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    cand = tr.update([_track((0.10, 0.4, 0.26, 0.6))], None, ts=1.0)
    assert cand is not None and cand["eventType"] == "GOAL" and cand["trigger"] == "zone"
    tr.reset()
    assert tr.update([_track((0.4, 0.4, 0.6, 0.6))], None, ts=2.0) is None


def test_detection_in_zone_accepts_dict_tracks():
    zones = [DEFAULT_ZONES["soccer"][0]]
    hit = detection_in_zone([{"bbox": (0.0, 0.4, 0.10, 0.6), "label": "player"}], zones)
    assert hit is not None and hit[0] == "player"


# --------------------------------------------------------- trigger behaviour
def test_player_in_zone_fires_candidate():
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    cand = tr.update([_track((0.0, 0.4, 0.10, 0.6))], None, ts=1.0)
    assert cand is not None
    assert cand["eventType"] == "GOAL"
    assert cand["trigger"] == "zone"
    assert cand["timestamp"] == 1.0


def test_ball_in_zone_requires_confirm_to_fire():
    # A bare ball in the goal mouth, no velocity/possession -> gated (FP-rate
    # discipline: don't burn a Gemma call on ambient play near the goal).
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    ball = _track((0.0, 0.4, 0.10, 0.6), kind="ball", label="soccer ball")
    assert tr.update([ball], _ball_fields(speed=None, possession=None), ts=1.0) is None
    # Same ball, but a real possession assignment confirms decisive action.
    tr.reset()
    cand = tr.update([ball], _ball_fields(possession="p3"), ts=2.0)
    assert cand is not None and cand["trigger"] == "zone"
    # And with a fast velocity signal.
    tr.reset()
    cand2 = tr.update([ball], _ball_fields(speed=BALL_TARGET_SPEED_MPS * 1.2), ts=3.0)
    assert cand2 is not None and cand2["trigger"] == "zone"


def test_ball_can_fire_without_confirm_when_disabled():
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    tr.cfg.require_ball_confirm = False
    ball = _track((0.0, 0.4, 0.10, 0.6), kind="ball", label="soccer ball")
    assert tr.update([ball], None, ts=1.0) is not None


def test_ball_in_play_area_geometry():
    # centre-frame ball below the scoreboard band -> in play area (soc-near-02)
    assert ball_in_play_area((0.30, 0.20, 0.34, 0.24)) is True
    # full-width top crowd band labelled player is NOT a ball: centre y in the
    # top band -> out of play area.
    assert ball_in_play_area((0.0, 0.0, 0.998, 0.05)) is False
    # a full-frame box (too large for a real ball) -> excluded even in play area
    assert ball_in_play_area((0.0, 0.30, 1.0, 0.90), BallPlayConfig()) is False


def test_ball_play_trigger_fires_centre_frame_near_goal():
    """INC-9 (ADAAAA-4496): soc-near-02 emitted NO candidate because its ball was
    detected centre-frame (x~0.32-0.51), outside the edge goal-mouth zones. A
    raw soccer-ball detection in the play area must now fire a GOAL candidate via
    the ball_play trigger, with no velocity/possession confirmation needed."""
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    ball_obj = {"label": "soccer ball", "bbox": [0.316, 0.212, 0.329, 0.225]}
    cand = tr.update([], None, ts=1.0, ball_objects=[ball_obj])
    assert cand is not None
    assert cand["eventType"] == "GOAL"
    assert cand["trigger"] == "ball_play"


def test_ball_play_trigger_ignores_non_ball_and_crowd_band():
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    # full-width crowd band (labelled player) must NOT fire ball_play
    cand = tr.update([], None, ts=1.0,
                     ball_objects=[{"label": "player", "bbox": [0.0, 0.0, 0.998, 0.24]}])
    assert cand is None
    # but a real centre-frame ball does (respecting cooldown)
    tr.reset()
    cand2 = tr.update([], None, ts=2.0,
                      ball_objects=[{"label": "soccer ball", "bbox": [0.5, 0.30, 0.52, 0.32]}])
    assert cand2 is not None and cand2["trigger"] == "ball_play"


def test_ball_speed_spike_fires_own_candidate():
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"))
    # ball NOT in a zone (center mid-frame), but fast -> shot signature.
    ball = _track((0.4, 0.5, 0.46, 0.5), kind="ball", label="soccer ball")
    cand = tr.update([ball], _ball_fields(speed=BALL_TARGET_SPEED_MPS * 1.4), ts=1.0)
    assert cand is not None and cand["trigger"] == "ball_speed"


def test_cooldown_suppresses_second_candidate():
    tr = DetectionZoneTrigger(zones=resolve_zones("soccer"), cfg=ZoneTriggerConfig(cooldown_s=2.0))
    player = _track((0.0, 0.4, 0.10, 0.6))
    assert tr.update([player], None, ts=1.0) is not None
    assert tr.update([player], None, ts=1.5) is None  # in cooldown
    assert tr.update([player], None, ts=3.2) is not None  # cooldown elapsed


def test_no_zones_is_inert():
    tr = DetectionZoneTrigger(zones=[])
    player = _track((0.0, 0.4, 0.10, 0.6))
    assert tr.update([player], None, ts=1.0) is None
    assert tr.update([player], _ball_fields(speed=99.0), ts=2.0) is None


# --------------------------------------------------------- process_frame wiring
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


def test_process_frame_fires_detection_in_zone_candidate(monkeypatch):
    """A player standing in the (left) goal mouth triggers a Stage-A candidate
    through process_frame — classified GOAL on soccer, carrying the ball signal
    fields, and WITHOUT any motion burst (no tracker jump)."""
    from app.session import SessionState
    from app.tracker import IoUTracker

    state = SessionState(session_id="s-inc3")
    state.tracker = IoUTracker()
    state.game_hint = "soccer"

    # Player parked in the left goal mouth all frames; slow, no motion burst.
    objects_per_frame = [[{"label": "player", "confidence": 0.9, "bbox": [30, 400, 130, 650]}]]
    fake = _FakeDetector(objects_per_frame)
    monkeypatch.setattr(app_mod, "get_detector", lambda: fake)

    saw_candidate = False
    for k in range(4):
        _obs, cand = process_frame(state, seq=k, timestamp=k * DT, image_b64="")
        if cand is not None:
            saw_candidate = True
            assert cand["eventType"] == "GOAL"  # sport-classified
            assert cand["trigger"] in ("zone", "ball_speed")
            break
    assert saw_candidate, "expected a detection-in-zone candidate on soccer"


def test_process_frame_no_candidate_when_center_field_and_no_trigger(monkeypatch):
    """A player in open field (no zone, no motion burst, no ball signal) fires
    NO candidate — the Stage-A union stays bounded (FP-rate discipline)."""
    from app.session import SessionState
    from app.tracker import IoUTracker

    state = SessionState(session_id="s-inc3b")
    state.tracker = IoUTracker()
    state.game_hint = "soccer"

    objects_per_frame = [[{"label": "player", "confidence": 0.9, "bbox": [450, 300, 560, 700]}]]
    fake = _FakeDetector(objects_per_frame)
    monkeypatch.setattr(app_mod, "get_detector", lambda: fake)

    any_candidate = False
    for k in range(5):
        _obs, cand = process_frame(state, seq=k, timestamp=k * DT, image_b64="")
        if cand is not None:
            any_candidate = True
            break
    assert not any_candidate, "open-field player must not fire a Stage-A candidate"
