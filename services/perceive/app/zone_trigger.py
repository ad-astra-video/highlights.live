"""Detection-in-zone Stage-A candidate trigger (INC-3 / ADAAAA-4327).

Research §3/§5: Stage-A candidate generation is a UNION of cheap (no-GPU)
triggers — motion-burst (tracker), audio noise-change (INC-2), ball-velocity /
possession (INC-2b), and THIS module: a detection entering a defined scoring
"zone" (goal mouth / hoop / net region per sport). Each candidate is high
recall, low precision by design; the decide()/Gemma stage (Stage-B) runs ONLY
on surviving candidates, which bounds Livepeer GPU cost and live latency.

This module implements the detection-in-zone trigger and folds the INC-2b ball
signals in:

  * `resolve_zones(game_hint)` — per-sport normalized-image zones (goal mouth
    left/right for soccer, centre-top hoop for basketball, net for tennis).
  * `DetectionZoneTrigger.update(tracks, ball_fields, ts)` — returns a
    candidate trigger dict when a relevant detection (ball or player) center
    enters a zone, OR when the ball-velocity/possession signal corroborates
    the zone entry (fast ball heading toward goal). Rate-limited by a shared
    cooldown so the union of Stage-A triggers stays bounded (FP-rate <= 60%).

The module is pure (no IO / GPU / VLM) and unit-testable with synthetic boxes.

Coordinate convention: bboxes are NORMALIZED 0..1 (same as the tracker + ball
signal), so zones are defined in normalized image coordinates.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from .florence import canonical_sport

ZoneBox = Tuple[float, float, float, float]  # x1, y1, x2, y2 normalized 0..1


def _b_center(b: Sequence[float]) -> Tuple[float, float]:
    return ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0)


# Per-sport normalized-image scoring zones. Coordinates are 0..1; a detection
# whose center lands inside a zone is a candidate trigger (high recall). Tuned
# off a broadcast soccer/hoops/tennis framing — over-broad by design (precision
# is Stage-B's job), but narrow enough to avoid firing on the whole frame.
DEFAULT_ZONES: Dict[str, List[ZoneBox]] = {
    # goal mouths at the left and right edges of a side-on broadcast frame
    "soccer": [
        (0.00, 0.15, 0.12, 0.88),  # left goal mouth / penalty area
        (0.88, 0.15, 1.00, 0.88),  # right goal mouth / penalty area
    ],
    "basketball": [
        (0.00, 0.10, 0.20, 0.45),  # left hoop / key
        (0.80, 0.10, 1.00, 0.45),  # right hoop / key
    ],
    "tennis": [
        (0.30, 0.10, 0.70, 0.55),  # net + service box
    ],
}


def resolve_zones(game_hint: Optional[str] = None) -> List[ZoneBox]:
    """Zones for the session's sport, or [] when the sport is unknown.

    Unknown sports have no canned zones -> the detection-in-zone trigger is
    simply inert (motion-burst + audio still generate candidates). Never
    crashes on a missing/unknown hint.
    """
    sport = canonical_sport(game_hint)
    if sport is None:
        return []
    return DEFAULT_ZONES.get(sport, [])


def _in_zone(b: Sequence[float], zone: ZoneBox) -> bool:
    cx, cy = _b_center(b)
    x1, y1, x2, y2 = zone
    return x1 <= cx <= x2 and y1 <= cy <= y2


def detection_in_zone(tracks: Sequence[object], zones: List[ZoneBox]) -> Optional[Tuple[str, ZoneBox]]:
    """Return (track_id-ish_label, zone) for the first relevant detection whose
    center is inside a zone, else None. A "relevant" detection is the ball (by
    kind/label) or any player-like track — the goal mouth is where the action
    is. Tracks may be real ``Track`` objects or simple {bbox} dicts."""
    for t in tracks:
        b = getattr(t, "bbox", None)
        if b is None:
            b = t.get("bbox", (0, 0, 0, 0)) if isinstance(t, dict) else (0, 0, 0, 0)
        if not b or len(b) != 4:
            continue
        kind = getattr(t, "kind", "")
        label = getattr(t, "label", "")
        if isinstance(t, dict):
            kind = t.get("kind", "") or ""
            label = t.get("label", "") or ""
        for zone in zones:
            if _in_zone(b, zone):
                return (label or kind or "track", zone)
    return None


# A ball fast-moving toward a goal mouth is high-value even before its center
# fully enters the zone. Threshold in homography m/s (INC-2b ground-plane).
BALL_TARGET_SPEED_MPS = 10.0


@dataclass
class ZoneTriggerConfig:
    cooldown_s: float = 2.0        # suppress a second candidate this long
    ball_speed_mps: float = BALL_TARGET_SPEED_MPS
    # Require a corroborating ball-velocity spike (or possession change) for a
    # MOTION-driven zone candidate when the ball is involved, to bias toward
    # real shots rather than ambient play near the goal (FP-rate discipline).
    require_ball_confirm: bool = True


@dataclass
class DetectionZoneTrigger:
    """Per-session detection-in-zone Stage-A candidate trigger.

    ``zones`` is fixed at construction from the session's gameHint (a control
    ``configure`` gameHint change rebuilds the session / this trigger via the
    caller). ``update()`` returns a candidate dict (``eventType``/``timestamp``
    / ``trigger``) when a relevant detection is in a scoring zone AND the
    trigger is not in cooldown; else None. Ball velocity/possession (from the
    INC-2b signal) fold in as corroboration + a velocity-driven trigger.
    """

    cfg: ZoneTriggerConfig = field(default_factory=ZoneTriggerConfig)
    zones: List[ZoneBox] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._last_fired: Optional[float] = None

    def _in_cooldown(self, ts: float) -> bool:
        return self._last_fired is not None and (ts - self._last_fired) < self.cfg.cooldown_s

    def _make_candidate(self, ts: float, event_type: str, trigger: str) -> dict:
        self._last_fired = ts
        return {"eventType": event_type, "timestamp": ts, "trigger": trigger}

    def _ball_speed(self, ball_fields: Optional[dict]) -> Optional[float]:
        if not ball_fields:
            return None
        vel = ball_fields.get("ballVelocity") or {}
        s = vel.get("speedMps")
        try:
            return float(s) if s is not None else None
        except (TypeError, ValueError):
            return None

    def _possession_changed(self, ball_fields: Optional[dict]) -> bool:
        """A possession signal whose owner is a real (non-"none") player is
        treated as corroborating action near the goal (INC-2b trigger)."""
        if not ball_fields:
            return False
        poss = ball_fields.get("ballPossession") or {}
        pid = poss.get("possessingPlayerId")
        return bool(pid) and pid != "none"

    def update(
        self,
        tracks: Sequence[object],
        ball_fields: Optional[dict],
        ts: float,
        event_type: str = "GOAL",
    ) -> Optional[dict]:
        """Check the detection-in-zone + ball-velocity/possession triggers.

        ``tracks`` are this frame's tracked detections (ball + players),
        ``ball_fields`` the INC-2b signal dict (with ballVelocity/ballPossession).
        Returns a Stage-A candidate trigger dict, or None.

        Fires when:
          * a relevant detection is inside a scoring zone, AND
            - the detection is a player (human near the goal), or
            - the detection is the ball corroborated by a fast velocity spike
              or a real possession assignment (shot / decisive touch), or
          * the ball-velocity signal itself spikes toward the target speed
            (shot signature, high recall) — catches a fast ball that a motion
            gate or zone-overlap missed.

        Cooldown suppresses a second candidate so the union of Stage-A triggers
        stays bounded (bounds Gemma Stage-B invocations).
        """
        if not self.zones or self._in_cooldown(ts):
            return None

        speed = self._ball_speed(ball_fields)
        possessed = self._possession_changed(ball_fields)

        hit = detection_in_zone(tracks, self.zones)
        if hit is not None:
            label, _zone = hit
            is_ball = "ball" in (label or "").lower()
            # Player near the goal is a strong, cheap trigger; a ball needs a
            # velocity/possession confirmation to bias toward real shots.
            if not is_ball or not self.cfg.require_ball_confirm or speed or possessed:
                return self._make_candidate(ts, event_type, "zone")
            return None

        # Velocity-spike trigger: a fast ball on its own (no zone overlap
        # resolved this frame) is still a high-recall shot signature.
        if speed is not None and speed >= self.cfg.ball_speed_mps:
            return self._make_candidate(ts, event_type, "ball_speed")

        return None

    def reset(self) -> None:
        self._last_fired = None
