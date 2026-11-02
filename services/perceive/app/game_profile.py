"""Game-profile contract (ADAAAA-7754, step 1 of the ADAAAA-7435 plan §9).

A video type is configured by **data**, not by code. A `GameProfile` is the one
per-type source of truth for the seven approved fields:

1. ``vocabulary``            closed detection vocabulary for the type
2. ``zone_model``            scoring-structure geometry, or the ``no-zone`` fallback
3. ``corroboration_oracle``  named per-type secondary-confirmation seam
                             (scoreboard OCR / HUD parse / audio-text)
4. ``triggers``              trigger subset: motion / audio / detection-in-zone /
                             ball-velocity, each individually enabled per type
5. ``audio_thresholds``      burst / swell / sustain / cooldown / max-latency per type
6. ``tracking_roster``       objects to track, with the 3 live / 8 VOD caps
7. ``eval_set``              the real held-out labeled manifest the type was
                             measured on (``None`` = unmeasured)

Soccer is the reference implementation (`SOCCER_PROFILE`) and the shipped
default, so current behaviour is preserved. The module is deliberately
import-free at module scope (stdlib only) so the eval harnesses can load it the
same dependency-light way they load ``audio_gate``.

Two rules this module enforces in code:

- **`no-zone` fallback.** A profile whose zone model is ``no-zone`` can never
  enable the detection-in-zone trigger: `GameProfile.__post_init__` drops it
  from the trigger subset rather than raising or degrading at frame time.
- **No unmeasured inheritance.** A type whose ``eval_set`` is ``None`` is
  unmeasured; `unmeasured_profile()` seeds it with the type's own vocabulary and
  the corpus-wide defaults only (audio trigger only, no zone geometry). It never
  copies soccer's zone model, and it cannot enable a trigger that needs a
  measured operating point without a profile of its own.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Optional, Sequence, Tuple

# --- trigger subset ---------------------------------------------------------

TRIGGER_MOTION = "motion"
TRIGGER_AUDIO = "audio"
TRIGGER_DETECTION_IN_ZONE = "detection-in-zone"
TRIGGER_BALL_VELOCITY = "ball-velocity"

ALL_TRIGGERS: Tuple[str, ...] = (
    TRIGGER_MOTION,
    TRIGGER_AUDIO,
    TRIGGER_DETECTION_IN_ZONE,
    TRIGGER_BALL_VELOCITY,
)

# Triggers evaluated on the frame path. `audio` is evaluated on its own ~10 Hz
# DSP path (`process_audio`), not per frame.
FRAME_TRIGGERS: Tuple[str, ...] = (
    TRIGGER_MOTION,
    TRIGGER_DETECTION_IN_ZONE,
    TRIGGER_BALL_VELOCITY,
)

# --- zone model -------------------------------------------------------------

NO_ZONE = "no-zone"  # the type has no scoring structure at all (esports, am. football)
PLAN_ZONES = "plan-zones"  # geometry comes from the decide brain's TrackingPlan

# --- corroboration oracle kinds --------------------------------------------

ORACLE_SCOREBOARD_OCR = "scoreboard-ocr"
ORACLE_HUD_PARSE = "hud-parse"
ORACLE_AUDIO_TEXT = "audio-text"

ORACLE_KINDS: Tuple[str, ...] = (
    ORACLE_SCOREBOARD_OCR,
    ORACLE_HUD_PARSE,
    ORACLE_AUDIO_TEXT,
)

# --- tracking caps (charter: 3 live / 8 VOD, schema ceiling stays 8) --------

LIVE_MAX_TRACKS = 3
VOD_MAX_TRACKS = 8

# Bounded recent-speed window a session keeps while the ball-velocity trigger is
# enabled (its structural operating point lives in `stage_a`).
BALL_SPEED_WINDOW = 8


@dataclass(frozen=True)
class ZoneSpec:
    """One scoring zone: a normalized box (x1, y1, x2, y2) in [0, 1]."""

    name: str
    normalized: Tuple[float, float, float, float]
    purpose: str = "goal_detect"

    def contains(self, bbox: Sequence[float]) -> bool:
        """True when the box *centre* falls inside this zone."""
        if bbox is None or len(bbox) < 4:
            return False
        cx = (float(bbox[0]) + float(bbox[2])) / 2.0
        cy = (float(bbox[1]) + float(bbox[3])) / 2.0
        x1, y1, x2, y2 = self.normalized
        return x1 <= cx <= x2 and y1 <= cy <= y2


@dataclass(frozen=True)
class ZoneModel:
    """The type's scoring-structure geometry, or the ``no-zone`` fallback.

    ``no-zone`` is a *declared* property of the type, not an error: the type has
    no canned scoring structure, so the detection-in-zone trigger is inert and
    the loop relies on the remaining triggers. ``kind`` names the model
    (``goal-mouth``, ``hoop-key``, ``net-service-box``, ``plan-zones``) so a
    later per-type issue can attach measured geometry without a code change.
    """

    kind: str
    zones: Tuple[ZoneSpec, ...] = ()

    def __post_init__(self) -> None:
        if self.kind == NO_ZONE and self.zones:
            raise ValueError(
                "a no-zone zone model declares no geometry: drop its zones instead of "
                "declaring both"
            )

    @property
    def is_no_zone(self) -> bool:
        return self.kind == NO_ZONE

    @classmethod
    def no_zone(cls) -> "ZoneModel":
        return cls(kind=NO_ZONE, zones=())


@dataclass(frozen=True)
class AudioThresholds:
    """Per-type Stage-A audio operating point (ADAAAA-4325 / INC-2 knobs).

    The defaults are the current shipped GateConfig values, so the default
    profile reproduces today's firing set exactly. A type overrides them only
    with a measured held-out eval set (see ``docs/game-profile-contract.md``).
    """

    burst_ratio: float = 1.3
    swell_ratio: float = 1.3
    burst_min_frames: int = 3
    swell_seconds: float = 2.5
    cooldown_s: float = 2.0
    max_latency_s: float = 5.0

    def as_gate_kwargs(self) -> dict:
        """The subset of ``GateConfig`` fields this profile owns.

        Returned as plain kwargs (no import of ``audio_gate``) so callers build
        ``GateConfig(frame_s=..., **profile.audio_thresholds.as_gate_kwargs())``
        and the eval harnesses can load this module standalone.
        """
        return {
            "burst_ratio": self.burst_ratio,
            "swell_ratio": self.swell_ratio,
            "burst_min_frames": self.burst_min_frames,
            "swell_seconds": self.swell_seconds,
            "cooldown_s": self.cooldown_s,
            "max_latency_s": self.max_latency_s,
        }

    def differs_from(self, cfg: Any) -> bool:
        """True when a ``GateConfig``-like object diverges from this profile."""
        return any(
            getattr(cfg, k, None) != v for k, v in self.as_gate_kwargs().items()
        )


@dataclass(frozen=True)
class TriggerSubset:
    """Which Stage-A triggers the type runs (each one individually enabled)."""

    enabled: frozenset = frozenset()

    def __post_init__(self) -> None:
        unknown = set(self.enabled) - set(ALL_TRIGGERS)
        if unknown:
            raise ValueError(
                f"unknown trigger(s) {sorted(unknown)}; allowed: {list(ALL_TRIGGERS)}"
            )

    def allows(self, trigger: str) -> bool:
        return trigger in self.enabled

    def without(self, trigger: str) -> "TriggerSubset":
        return TriggerSubset(enabled=frozenset(set(self.enabled) - {trigger}))

    def with_trigger(self, trigger: str) -> "TriggerSubset":
        return TriggerSubset(enabled=frozenset(set(self.enabled) | {trigger}))

    def has_any(self, triggers: Sequence[str]) -> bool:
        return bool(set(self.enabled) & set(triggers))

    def names(self) -> Tuple[str, ...]:
        return tuple(t for t in ALL_TRIGGERS if t in self.enabled)

    @classmethod
    def of(cls, *triggers: str) -> "TriggerSubset":
        return cls(enabled=frozenset(triggers))


@dataclass(frozen=True)
class TrackingRoster:
    """Objects to track for the type, with the 3 live / 8 VOD caps enforced.

    The caps are clamped to the charter ceilings here (never raised by data):
    live capacity <= 3, VOD (schema) capacity <= 8.
    """

    labels: Tuple[str, ...] = ()
    live_capacity: int = LIVE_MAX_TRACKS
    vod_capacity: int = VOD_MAX_TRACKS

    def __post_init__(self) -> None:
        live = int(self.live_capacity)
        vod = int(self.vod_capacity)
        if live < 1 or vod < 1:
            raise ValueError("tracking capacities must be >= 1")
        # The charter caps are a ceiling, never a data-driven knob: a profile
        # cannot raise live above 3 nor VOD/schema above 8.
        if live > LIVE_MAX_TRACKS:
            raise ValueError(
                f"live capacity {live} exceeds the charter ceiling {LIVE_MAX_TRACKS}"
            )
        if vod > VOD_MAX_TRACKS:
            raise ValueError(
                f"vod capacity {vod} exceeds the schema ceiling {VOD_MAX_TRACKS}"
            )
        if live > vod:
            raise ValueError(f"live capacity {live} cannot exceed VOD capacity {vod}")

    def capacity(self, mode: str) -> int:
        return self.vod_capacity if mode == "vod" else self.live_capacity

    def capacity_for_clip(self, clip_path: str = "") -> int:
        """VOD pass (a clip is bound) -> vod capacity; live session -> live cap."""
        return self.capacity("vod" if clip_path else "live")


@dataclass(frozen=True)
class EvalSet:
    """The real held-out labeled manifest a type was measured on.

    ``None`` on a profile means the type is UNMEASURED: it may run the skeleton
    with the corpus-wide defaults, but no soccer threshold, zone or vocabulary
    may be attributed to it, and it must not enable a trigger whose operating
    point has not been measured.
    """

    manifest: str
    vocabulary: Tuple[str, ...] = ()
    reference: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CorroborationVerdict:
    """Secondary-confirmation result from a type's oracle."""

    corroborated: bool
    kind: str
    detail: Mapping[str, Any] = field(default_factory=dict)


class CorroborationOracle:
    """Named per-type corroboration seam.

    The *need* to corroborate is universal; the oracle is type-specific. Soccer
    is the reference implementation (scoreboard OCR). ``hud-parse`` (esports)
    and ``audio-text`` belong to later issues (ADAAAA-7435 steps 3+).
    """

    kind: str = ""

    def corroborated(self, timestamp: float, tracker: Any = None) -> CorroborationVerdict:
        raise NotImplementedError

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"{type(self).__name__}(kind={self.kind!r})"


class ScoreboardOcrOracle(CorroborationOracle):
    """Soccer's corroboration oracle: a scoreboard score delta across the window.

    Delegates to the session's ``ScoreboardTracker`` so the already-measured
    behaviour (ADAAAA-6360 / ADAAAA-7543: the two most recent readings decide)
    is unchanged; the oracle only *names* the seam. ``tracker=None`` (OCR never
    read a score) is an explicit no-signal, never a corroboration.
    """

    kind = ORACLE_SCOREBOARD_OCR

    def corroborated(self, timestamp: float, tracker: Any = None) -> CorroborationVerdict:
        if tracker is None:
            return CorroborationVerdict(
                corroborated=False, kind=self.kind, detail={"reason": "no_score_tracker"}
            )
        try:
            changed = bool(tracker.changed(timestamp))
        except Exception as exc:  # noqa: BLE001 - an oracle never breaks the pass
            return CorroborationVerdict(
                corroborated=False, kind=self.kind, detail={"error": str(exc)}
            )
        return CorroborationVerdict(
            corroborated=changed, kind=self.kind, detail={"scoreBoardChanged": changed}
        )


@dataclass(frozen=True)
class GameProfile:
    """One video type's analysis-loop parameter set (the seven approved fields)."""

    key: str
    vocabulary: Tuple[str, ...]
    zone_model: ZoneModel
    corroboration_oracle: Optional[CorroborationOracle]
    triggers: TriggerSubset
    audio_thresholds: AudioThresholds
    tracking_roster: TrackingRoster
    eval_set: Optional[EvalSet] = None

    def __post_init__(self) -> None:
        # The `no-zone` fallback: the detection-in-zone trigger is disabled by
        # the profile itself. Data that asks for it anyway is auto-disabled
        # rather than raising or degrading mid-pass.
        if self.zone_model.is_no_zone and self.triggers.allows(TRIGGER_DETECTION_IN_ZONE):
            object.__setattr__(
                self, "triggers", self.triggers.without(TRIGGER_DETECTION_IN_ZONE)
            )
        if self.corroboration_oracle is not None:
            kind = getattr(self.corroboration_oracle, "kind", "")
            if kind not in ORACLE_KINDS:
                raise ValueError(f"unknown corroboration oracle kind {kind!r}")

    # -- convenience -----------------------------------------------------

    @property
    def measured(self) -> bool:
        """True only when the type has a real held-out labeled eval set."""
        return self.eval_set is not None

    def vocabulary_list(self) -> list:
        return list(self.vocabulary)

    def allows(self, trigger: str) -> bool:
        return self.triggers.allows(trigger)

    def has_frame_triggers(self) -> bool:
        return self.triggers.has_any(FRAME_TRIGGERS)

    def capacity_for_clip(self, clip_path: str = "") -> int:
        return self.tracking_roster.capacity_for_clip(clip_path)

    def corroborate(self, timestamp: float, tracker: Any = None) -> CorroborationVerdict:
        """Run the type's corroboration oracle (absent oracle -> no signal)."""
        if self.corroboration_oracle is None:
            return CorroborationVerdict(corroborated=False, kind="none")
        return self.corroboration_oracle.corroborated(timestamp, tracker)

    def with_audio_thresholds(self, **overrides: Any) -> "GameProfile":
        """Same profile with a per-type audio operating point (tests / tuning)."""
        return replace(self, audio_thresholds=replace(self.audio_thresholds, **overrides))

    def with_triggers(self, triggers: TriggerSubset) -> "GameProfile":
        return replace(self, triggers=triggers)

    def to_dict(self) -> dict:
        """Serializable view of the seven fields (issue docs / harness output)."""
        return {
            "key": self.key,
            "vocabulary": list(self.vocabulary),
            "zoneModel": {
                "kind": self.zone_model.kind,
                "noZone": self.zone_model.is_no_zone,
                "zones": [
                    {"name": z.name, "normalized": list(z.normalized), "purpose": z.purpose}
                    for z in self.zone_model.zones
                ],
            },
            "corroborationOracle": (
                self.corroboration_oracle.kind if self.corroboration_oracle else None
            ),
            "triggerSubset": list(self.triggers.names()),
            "audioThresholds": self.audio_thresholds.as_gate_kwargs(),
            "trackingRoster": {
                "labels": list(self.tracking_roster.labels),
                "liveCapacity": self.tracking_roster.live_capacity,
                "vodCapacity": self.tracking_roster.vod_capacity,
            },
            "evalSet": (
                None
                if self.eval_set is None
                else {
                    "manifest": self.eval_set.manifest,
                    "vocabulary": list(self.eval_set.vocabulary),
                    "reference": dict(self.eval_set.reference),
                }
            ),
            "measured": self.measured,
        }


# --- the reference profile (soccer) ----------------------------------------

# Soccer's eval label space (the INC-9 held-out labeled set) — the classes the
# detection harness scores, which is deliberately NOT the deployed per-frame
# detection roster (`SOCCER_PROFILE.vocabulary`, ball-first since ADAAAA-7217).
_SOCCER_EVAL_VOCABULARY: Tuple[str, ...] = (
    "player",
    "soccer ball",
    "goalkeeper",
    "goal",
    "referee",
)

# INC-9 / ADAAAA-4496 measured reference (evals/INC9-RESULTS.md). Recorded as
# data so a re-run is compared against the same numbers the type was certified
# on, not against a comment.
_SOCCER_EVAL_REFERENCE: Mapping[str, Any] = {
    "source": "evals/INC9-RESULTS.md (INC-9 / ADAAAA-4496)",
    "recallLivePct": 100.0,
    "recallVodPct": 100.0,
    "e2eLatencyMaxS": 2.0,
    "noiseTriggerFpPct": 36.7,
}

SOCCER_PROFILE = GameProfile(
    key="soccer",
    # Ball-first default roster (ADAAAA-7217 increment B): player/goalkeeper/
    # referee are dropped from the per-frame detection vocabulary; "goal" stays
    # as a non-player object. Player detection runs on demand (plan target).
    vocabulary=("soccer ball", "goal"),
    # Soccer carries canned scoring structure, but perceive takes the actual
    # geometry from the decide brain's TrackingPlan (`plan-zones`) rather than a
    # hand-tuned table, and ADAAAA-7108 removed the GOAL/zone *candidate* trigger.
    # The shipped trigger subset therefore runs audio only, which is exactly
    # today's firing set: the default profile must not add candidates.
    zone_model=ZoneModel(kind=PLAN_ZONES, zones=()),
    corroboration_oracle=ScoreboardOcrOracle(),
    triggers=TriggerSubset.of(TRIGGER_AUDIO),
    audio_thresholds=AudioThresholds(),
    tracking_roster=TrackingRoster(labels=("soccer ball", "goal")),
    eval_set=EvalSet(
        manifest="evals/label-manifest.json",
        vocabulary=_SOCCER_EVAL_VOCABULARY,
        reference=_SOCCER_EVAL_REFERENCE,
    ),
)

# Basketball (ADAAAA-7765, per-type step 2). Measured on a rights-cleared
# broadcast clip: evals/basketball_val/label-manifest.json (revision 2) carries
# 15 frame-verified scoring events and 13 verified non-event windows across 850 s
# of one continuous feed (Q1 into early Q2) from a CC BY 3.0 full match
# (TBF, Wikimedia Commons).
#
# What this profile does NOT claim:
# - No detection slice was labelled for basketball, so `evalSet.vocabulary` is
#   the scoring-window class ("score"), not a detection roster. `detect_precision`
#   has no basketball label space until a frame-level box slice exists
#   (`reference["detectionSlice"]` is null on purpose).
# - The audio operating point is the corpus-wide default, recorded as the
#   BASELINE measured on this clip; it was not tuned on basketball.
# - Zone geometry stays `no-zone`: no hoop-key geometry was measured.
# The deployed per-frame roster is unchanged from the canned type so registering
# the profile cannot change what the detector looks for.
_BASKETBALL_EVAL_VOCABULARY: Tuple[str, ...] = ("score",)

_BASKETBALL_EVAL_REFERENCE: Mapping[str, Any] = {
    "source": "evals/basketball_val/label-manifest.json (ADAAAA-7765)",
    "clipSpanS": 850,
    "scoringEvents": 15,
    "nonEventWindows": 13,
    "livePlayNonEventWindows": 7,
    "rightsBasis": "CC BY 3.0 (TBF, Wikimedia Commons)",
    "detectionSlice": None,
    # ADAAAA-7765 measured run, label revision 2 (evals/basketball_val/RESULTS.md).
    # Baseline at the profile's UNCHANGED audio defaults; not tuned on basketball.
    "audioHarness": {
        "harness": "evals/measure_audio_recall.py",
        # Pure DSP (ffmpeg decode + numpy gate): the box job on livepeer-ai-x99 and a
        # local CPU re-run are byte-identical for the same labels (QA verified this on
        # ADAAAA-7770). Revision 2 was produced by that same re-run.
        "host": "local CPU re-run, byte-identical to the livepeer-ai-x99 box job",
        "clip": "bb_q1_1100_1950.mp4 (850 s, CC BY 3.0)",
        "labelRevision": 2,
        "thresholdId": "stageA/burst/1.3x/0.3s",
        "events": 15,
        "candidates": 80,
        "recall": 0.26666666666666666,
        "fpRate": 0.925,
        "p50S": 0.2,
        "p95S": 1.9,
        "negativeWindowFpRate": 0.6153846153846154,
        "livePlayNegativeWindowFpRate": 1.0,
        "artifactMd5": "151192a9dd67dc2342b320b389cb3a75",
        # label-tolerance sensitivity: recall 0.53/0.67/0.87 at -5/-6/-10 s pre-window
        # but candidate FP rate only falls to 0.85/0.81/0.76 - still far over the ceiling
        "fpCeiling": 0.10,
        "fpCeilingMet": False,
        "result": "evals/basketball_val/RESULTS.md",
    },
    "qaCertification": "pending",
}

BASKETBALL_PROFILE = GameProfile(
    key="basketball",
    # Unchanged from the canned type's deployed roster (florence._GAME_VOCABULARIES).
    vocabulary=("basketball", "player", "hoop", "referee"),
    # Hoop-key geometry is not measured for this type yet, so the profile
    # declares `no-zone`; the detection-in-zone trigger stays inert.
    zone_model=ZoneModel.no_zone(),
    # The score overlay is basketball's corroboration seam, and it is what the
    # held-out set was labelled from.
    corroboration_oracle=ScoreboardOcrOracle(),
    triggers=TriggerSubset.of(TRIGGER_AUDIO),
    audio_thresholds=AudioThresholds(),
    tracking_roster=TrackingRoster(labels=("basketball", "player", "hoop")),
    eval_set=EvalSet(
        manifest="evals/basketball_val/label-manifest.json",
        vocabulary=_BASKETBALL_EVAL_VOCABULARY,
        reference=_BASKETBALL_EVAL_REFERENCE,
    ),
)

# Unmapped/unknown hint: today's generic closed roster, no zone model, audio
# trigger only. `vocabulary=()` means "no type-specific vocabulary" so the
# legacy resolution chain (preferLabels -> SAFE_DEFAULT_VOCABULARY) still runs.
SAFE_DEFAULT_PROFILE = GameProfile(
    key="safe-default",
    vocabulary=(),
    zone_model=ZoneModel.no_zone(),
    corroboration_oracle=ScoreboardOcrOracle(),
    triggers=TriggerSubset.of(TRIGGER_AUDIO),
    audio_thresholds=AudioThresholds(),
    tracking_roster=TrackingRoster(labels=()),
    eval_set=None,
)

DEFAULT_PROFILE = SOCCER_PROFILE

# Registered per-type profiles. Soccer and basketball are measured today; steps
# 3-5 of the ADAAAA-7435 plan register the rest once each has a held-out eval set.
PROFILES: Mapping[str, GameProfile] = {
    "soccer": SOCCER_PROFILE,
    "basketball": BASKETBALL_PROFILE,
}


def unmeasured_profile(
    key: str,
    vocabulary: Sequence[str],
    *,
    zone_model: Optional[ZoneModel] = None,
) -> GameProfile:
    """A type with its OWN vocabulary but no measured eval set yet.

    It inherits the corpus-wide audio defaults and the audio trigger only (that
    is today's shipped behaviour for the canned sports). It never inherits
    soccer's zone geometry, and it declares ``eval_set=None`` so nothing about
    it can be reported as measured.
    """
    return GameProfile(
        key=key,
        vocabulary=tuple(vocabulary),
        zone_model=zone_model or ZoneModel.no_zone(),
        corroboration_oracle=ScoreboardOcrOracle(),
        triggers=TriggerSubset.of(TRIGGER_AUDIO),
        audio_thresholds=AudioThresholds(),
        tracking_roster=TrackingRoster(labels=tuple(vocabulary)),
        eval_set=None,
    )


def load_game_profile(key: Optional[str] = None, *, strict: bool = True) -> GameProfile:
    """Load the registered profile for a canonical type key.

    ``None``/``""`` -> the safe default (unmapped hint). An unregistered key
    raises ``KeyError`` when ``strict`` (default), so a type can never silently
    run soccer's numbers; non-strict returns the safe default.
    """
    k = (key or "").strip().lower()
    if not k:
        return SAFE_DEFAULT_PROFILE
    if k in PROFILES:
        return PROFILES[k]
    if strict:
        raise KeyError(
            f"no registered game profile for {key!r}; registered: {sorted(PROFILES)}"
        )
    return SAFE_DEFAULT_PROFILE


def profile_for(game_hint: Optional[str] = None, category: Optional[str] = None) -> GameProfile:
    """Resolve the profile for a session's game hint / plan category.

    Registered types (soccer today) resolve to their measured profile. A canned
    but unmeasured type (basketball / tennis / american football / valorant)
    resolves to a profile carrying its own canned vocabulary and today's
    corpus-wide defaults. An unknown hint resolves to the safe default.

    Canned-type profiles are memoized so a session re-resolving the same hint
    every frame gets the SAME object (the identity check in
    `session.sync_game_profile` is what keeps that path free).

    ``florence`` is imported lazily: this module must stay import-free at module
    scope (the eval harnesses load it standalone), and florence itself imports
    this module for the soccer vocabulary.
    """
    from .florence import _GAME_VOCABULARIES, canonical_sport

    key = canonical_sport(game_hint, category)
    if key is not None and key in PROFILES:
        return PROFILES[key]
    if key is not None and key in _GAME_VOCABULARIES:
        cached = _UNMEASURED_PROFILES.get(key)
        if cached is None:
            cached = unmeasured_profile(key, _GAME_VOCABULARIES[key])
            _UNMEASURED_PROFILES[key] = cached
        return cached
    return SAFE_DEFAULT_PROFILE


# Canned-but-unmeasured type profiles, built lazily from `_GAME_VOCABULARIES`.
_UNMEASURED_PROFILES: dict = {}


__all__ = [
    "ALL_TRIGGERS",
    "FRAME_TRIGGERS",
    "NO_ZONE",
    "PLAN_ZONES",
    "TRIGGER_MOTION",
    "TRIGGER_AUDIO",
    "TRIGGER_DETECTION_IN_ZONE",
    "TRIGGER_BALL_VELOCITY",
    "ORACLE_SCOREBOARD_OCR",
    "ORACLE_HUD_PARSE",
    "ORACLE_AUDIO_TEXT",
    "ORACLE_KINDS",
    "LIVE_MAX_TRACKS",
    "VOD_MAX_TRACKS",
    "BALL_SPEED_WINDOW",
    "ZoneSpec",
    "ZoneModel",
    "AudioThresholds",
    "TriggerSubset",
    "TrackingRoster",
    "EvalSet",
    "CorroborationVerdict",
    "CorroborationOracle",
    "ScoreboardOcrOracle",
    "GameProfile",
    "SOCCER_PROFILE",
    "BASKETBALL_PROFILE",
    "SAFE_DEFAULT_PROFILE",
    "DEFAULT_PROFILE",
    "PROFILES",
    "unmeasured_profile",
    "load_game_profile",
    "profile_for",
]
