"""Profile-driven Stage-A trigger sites (ADAAAA-7754).

Stage-A is the cheap, GPU-free candidate layer that gates the expensive Stage-B
`decide` call. Each site below is routed through the session's `GameProfile`:

- ``motion``              — tracker peak single-step displacement
- ``detection-in-zone``   — a detection whose box centre falls inside a scoring zone
- ``ball-velocity``       — a ball-speed surge relative to its own recent window
- ``hud-event``           — a DISCRETE HUD band transition (ADAAAA-8742 WP1),
                            one candidate per transition, GPU-free; the
                            discrete state machine lives in ``hud_reader``
- ``audio``               — lives on its own ~10 Hz DSP path (``process_audio``),
                            routed through the profile there, not per frame

Routing is the deliverable of this issue, not new trigger efficacy: every site
is evaluated ONLY when the type's trigger subset enables it, which is what makes
"a profile with only motion + audio never evaluates zone logic" a checkable
property instead of a hope. No profile shipped today enables motion, zone or
ball-velocity (ADAAAA-7108 removed the soccer GOAL/motion candidate triggers and
perceive must reproduce that firing set exactly), so this module is inert for
soccer by construction.

Thresholds for the frame sites are STRUCTURAL, not sport numbers:

- motion reuses the tracker's existing ``IoUTracker.FAST_STEP`` operating point;
- ball-velocity is a relative surge over the ball's own recent speed window
  (same relative-change idiom as the audio gate's rolling baseline).

No soccer threshold, zone or vocabulary is copied to another type here; a type
that wants one of these triggers enabled must supply a measured held-out eval
set (see ``docs/game-profile-contract.md``).
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional, Sequence

from .game_profile import (
    BALL_SPEED_WINDOW,
    NO_ZONE,
    PLAN_ZONES,
    TRIGGER_BALL_VELOCITY,
    TRIGGER_DETECTION_IN_ZONE,
    TRIGGER_HUD_EVENT,
    TRIGGER_MOTION,
    GameProfile,
    ZoneModel,
    ZoneSpec,
)

# --- structural operating points (not measured sport thresholds) ----------

# Peak normalized single-step displacement that reads as a fast move. Pinned to
# `services/perceive/app/tracker.py::IoUTracker.FAST_STEP` (asserted in
# services/perceive/tests/test_game_profile.py) so there is one operating point.
MOTION_MIN_STEP = 0.15

# Ball-speed surge: fire when the current speed is at least this multiple of the
# median of the ball's own recent window. A relative change, so it carries no
# absolute km/h claim for any sport.
BALL_VELOCITY_SURGE_RATIO = 2.0
# Near-stationary floor so a still ball's jitter is never a "surge".
BALL_VELOCITY_FLOOR_MPS = 0.5


@dataclass(frozen=True)
class StageAFire:
    """One Stage-A candidate trigger that fired on this frame."""

    trigger: str
    detail: Mapping[str, Any] = field(default_factory=dict)


def _plan_zone_model(plan_zones: Iterable[Any], base: ZoneModel) -> ZoneModel:
    """A zone model built from plan-supplied zones (never from soccer geometry)."""
    specs: list[ZoneSpec] = []
    for raw in plan_zones or ():
        if not isinstance(raw, Mapping):
            continue
        box = raw.get("normalized")
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            continue
        try:
            normalized = tuple(min(1.0, max(0.0, float(v))) for v in box)
        except (TypeError, ValueError):
            continue
        specs.append(
            ZoneSpec(
                name=str(raw.get("name") or f"zone{len(specs)}"),
                normalized=normalized,  # type: ignore[arg-type]
                purpose=str(raw.get("purpose") or "goal_detect"),
            )
        )
    kind = base.kind if base.kind and base.kind != NO_ZONE else PLAN_ZONES
    return ZoneModel(kind=kind, zones=tuple(specs))


def detection_in_zone_hits(
    objects: Sequence[Mapping[str, Any]],
    zone_model: ZoneModel,
) -> list:
    """Detections whose box centre falls inside a zone of ``zone_model``.

    A ``no-zone`` model (or a model with no geometry) has no hits and never
    raises — that is the declared fallback for types with no scoring structure.
    """
    if zone_model is None or zone_model.is_no_zone or not zone_model.zones:
        return []
    hits: list = []
    for obj in objects or ():
        if not isinstance(obj, Mapping):
            continue
        bbox = obj.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) < 4:
            continue
        for zone in zone_model.zones:
            if zone.contains(bbox):
                hits.append(
                    {
                        "zone": zone.name,
                        "label": str(obj.get("label") or ""),
                        "bbox": [float(v) for v in bbox[:4]],
                    }
                )
                break  # one hit per detection is enough to fire the trigger
    return hits


def motion_peak_step(tracks: Sequence[Any]) -> Optional[float]:
    """Largest single-step displacement across this frame's tracks (normalized)."""
    best: Optional[float] = None
    for track in tracks or ():
        hist = getattr(track, "step_hist", None)
        if hist:
            step = max(float(disp) for _ts, disp in hist)
        else:
            step = float(getattr(track, "last_step_disp", 0.0) or 0.0)
        best = step if best is None else max(best, step)
    return best


def motion_fire(tracks: Sequence[Any]) -> Optional[StageAFire]:
    """Fire when any track moved at least ``MOTION_MIN_STEP`` in one step."""
    peak = motion_peak_step(tracks)
    if peak is None or peak < MOTION_MIN_STEP:
        return None
    return StageAFire(trigger=TRIGGER_MOTION, detail={"peakStep": round(peak, 4)})


def ball_velocity_fire(
    velocity: Optional[Mapping[str, Any]],
    recent_speeds: Optional[Sequence[float]] = None,
) -> Optional[StageAFire]:
    """Fire when the ball's speed surges over its own recent window.

    ``velocity`` is the ball-signal contract dict (``speedMps`` etc.). With no
    history yet the frame only seeds the window — a single sample is never a
    surge.
    """
    if not isinstance(velocity, Mapping):
        return None
    if velocity.get("speedMps") is None:
        return None
    try:
        speed = abs(float(velocity["speedMps"]))
    except (TypeError, ValueError):
        return None
    recent = [float(s) for s in (recent_speeds or ()) if s is not None]
    if not recent:
        return None
    base = max(statistics.median(recent), BALL_VELOCITY_FLOOR_MPS)
    if speed < BALL_VELOCITY_SURGE_RATIO * base:
        return None
    return StageAFire(
        trigger=TRIGGER_BALL_VELOCITY,
        detail={"speedMps": round(speed, 3), "baselineMps": round(base, 3)},
    )


def hud_event_fires(
    profile: GameProfile,
    reader: Any,
    frame: Any,
    timestamp: Optional[float],
    *,
    seq: Optional[int] = None,
) -> list:
    """The ``hud-event`` site (ADAAAA-8742 WP1): one fire per HUD transition.

    The reader owns the discrete state machine (per-band change score, dwell
    gate, per-band latch); this function only converts a confirmed transition
    into the layer's ``StageAFire`` shape. It is inert — and evaluates nothing —
    when the profile does not enable the trigger, when no reader is supplied, or
    when there is no frame. The reader itself is inert while
    ``PERCEIVE_HUD_EVENT_ENABLED`` is off, so an unarmed deployment yields zero
    candidates even with a fully declared ``hudModel``.
    """
    if not profile.allows(TRIGGER_HUD_EVENT):
        return []
    if reader is None or frame is None or timestamp is None:
        return []
    observe = getattr(reader, "observe", None)
    if observe is None:
        return []
    transitions = observe(frame, float(timestamp), seq=seq) or ()
    fires: list = []
    for transition in transitions:
        detail = {
            "band": str(getattr(transition, "band", "") or ""),
            "kind": str(getattr(transition, "kind", "") or ""),
            "direction": str(getattr(transition, "direction", "enter") or "enter"),
            "score": round(float(getattr(transition, "score", 0.0) or 0.0), 4),
        }
        coincident = getattr(transition, "coincident_bands", ()) or ()
        if coincident:
            detail["coincidentBands"] = list(coincident)
        fires.append(StageAFire(trigger=TRIGGER_HUD_EVENT, detail=detail))
    return fires


def evaluate_stage_a(
    profile: GameProfile,
    *,
    tracks: Sequence[Any] = (),
    objects: Sequence[Mapping[str, Any]] = (),
    ball_velocity: Optional[Mapping[str, Any]] = None,
    ball_recent_speeds: Optional[Sequence[float]] = None,
    plan_zones: Optional[Sequence[Any]] = None,
    frame: Any = None,
    hud_reader: Any = None,
    timestamp: Optional[float] = None,
    seq: Optional[int] = None,
) -> list:
    """Evaluate the frame-path trigger sites this profile enables.

    A site that the profile does not enable is not evaluated at all: its inputs
    are never consulted (no zone geometry is built, no motion history is read,
    no ball speed is scored, no HUD band is cropped). Returns the fires that
    survived, in trigger order.

    ``frame`` / ``hud_reader`` exist for the ``hud-event`` site (ADAAAA-8742).
    The reader is duck-typed on purpose: this module stays stdlib+numpy-free at
    import time, and a caller that does not pass a reader leaves the site inert
    instead of building geometry the profile never measured.
    """
    fires: list = []

    if profile.allows(TRIGGER_MOTION):
        fire = motion_fire(tracks)
        if fire is not None:
            fires.append(fire)

    if profile.allows(TRIGGER_DETECTION_IN_ZONE):
        model = profile.zone_model
        if plan_zones:
            model = _plan_zone_model(plan_zones, model)
        hits = detection_in_zone_hits(objects, model)
        if hits:
            fires.append(
                StageAFire(trigger=TRIGGER_DETECTION_IN_ZONE, detail={"hits": hits})
            )

    if profile.allows(TRIGGER_BALL_VELOCITY):
        fire = ball_velocity_fire(ball_velocity, ball_recent_speeds)
        if fire is not None:
            fires.append(fire)

    if profile.allows(TRIGGER_HUD_EVENT):
        fires.extend(
            hud_event_fires(profile, hud_reader, frame, timestamp, seq=seq)
        )

    return fires


__all__ = [
    "MOTION_MIN_STEP",
    "BALL_VELOCITY_SURGE_RATIO",
    "BALL_VELOCITY_FLOOR_MPS",
    "BALL_SPEED_WINDOW",
    "StageAFire",
    "detection_in_zone_hits",
    "motion_peak_step",
    "motion_fire",
    "ball_velocity_fire",
    "hud_event_fires",
    "evaluate_stage_a",
]
