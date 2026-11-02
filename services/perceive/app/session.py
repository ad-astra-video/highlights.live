"""Perceive runner session state, keyed by Livepeer-Session-Id.

One persistent session object per stream: owns the tracker + the last frame's
grayscale (for background diff) + SSE subscriber queues. A new socket/HTTP
call on the same session id reuses this object — exactly one perceive session
per stream.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

import numpy as np

log = logging.getLogger("highlights.perceive.session")

from .audio_gate import AudioEnergyGate, BandLimitedWhistleGate, GateConfig
from .tracker import IoUTracker, LIVE_MAX_TRACKS, VOD_MAX_TRACKS
from .sam_tracker import HybridTracker, make_tracker
from .scoreboard import ScoreboardTracker
from .scoreboard_vision import ScoreboardVerdict
from .tracking_plan import TrackingPlan
from .game_profile import (
    BALL_SPEED_WINDOW,
    DEFAULT_PROFILE,
    GameProfile,
    profile_for,
)

RECENT_FRAMES = 30  # ~30 sampled frames kept for clip/confirm


def mode_capacity(clip_path: str = "", profile: GameProfile | None = None) -> int:
    """INC-6 / ADAAAA-4330: charter is 3 live / 8 VOD tracked objects. A session
    with a clip_path is a VOD pass (deep-detail budget) -> 8; a live session -> 3.

    ADAAAA-7754: the caps now come from the session type's
    `GameProfile.tracking_roster`, which clamps to the same charter ceilings (the
    default profile reproduces 3/8 exactly).
    """
    roster = (profile or DEFAULT_PROFILE).tracking_roster
    return roster.capacity_for_clip(clip_path)


@dataclass
class SessionState:
    session_id: str
    stream_id: str = ""
    tracker: IoUTracker = field(default_factory=make_tracker)
    # Full recorded stream (per-JOB) this session tracks against. When SAM is
    # enabled this binds a Sam3Backend to the session's own clip (not a global
    # env), so the persistent perceive session tracks across the whole stream.
    clip_path: str = ""
    prev_gray: Optional[np.ndarray] = None
    seq: int = 0
    # ADAAAA-6525: monotonic count of frames run through process_frame, for the
    # default-INFO heartbeat cadence (log the salient periodic event, not every
    # frame — per-frame detail stays behind DEBUG).
    frames_processed: int = 0
    health_ts: float = field(default_factory=time.time)
    recent_frames: Deque[dict] = field(default_factory=lambda: deque(maxlen=RECENT_FRAMES))
    # ADAAAA-7008 / ADAAAA-7012: per-frame derived-context cache (the "data
    # seeder" contract). Keys are frame timestamps (content seconds); values are
    # the compact seed already computed by process_frame (tracks / objects / ocr)
    # so the on-demand `/app/evidence` recall endpoint can serve it WITHOUT
    # re-running the detector. Bounded to RECENT_FRAMES so it never grows on a
    # long stream. Absent timestamp -> no evidence (explicit no-signal).
    frame_seeds: dict[float, dict] = field(default_factory=dict)
    subscribers: List[asyncio.Queue] = field(default_factory=list)
    # Raw RGB of the most recent sampled frame + its image b64, so a control
    # `analyze-still` can force a fresh Florence+SAM3 pass on the current frame.
    last_rgb: Optional[np.ndarray] = None
    last_image_b64: str = ""
    game_hint: str = ""
    prefer_labels: List[str] = field(default_factory=list)
    # Per-stream LoRA injection (ADAAAA-5324): filesystem ref to this stream's
    # merged Florence-2 model dir (train's LoRA merge output). Empty = base
    # model (other streams keep base). Selects the detector via
    # florence.get_detector(lora_ref) at frame time.
    lora_ref: str = ""
    sample_fps: float = 1.0
    idle_timeout_s: float = 120.0
    # Stage-A audio noise-change gate (INC-2 / ADAAAA-4325). Cheap pure-DSP
    # candidate trigger fed by the server's ffmpeg audio tap (own ~10 Hz
    # cadence, independent of the 1 fps video /analyze). Never touches the GPU.
    audio_gate: AudioEnergyGate = field(
        default_factory=lambda: AudioEnergyGate(
            GateConfig(**DEFAULT_PROFILE.audio_thresholds.as_gate_kwargs())
        )
    )
    # Stage-B band-limited whistle path (ADAAAA-7682). The referee whistle is a
    # narrowband tonal burst whose RMS sits at the crowd floor, so the broadband
    # Stage-A gate above cannot see it. This path baselines the 2.4-3.4 kHz band
    # instead. Its measured ship gate (recall >= 0.80, trigger-window FP <=
    # 0.10) passed and the PO graduated it from measure-only to emitting
    # (ADAAAA-7705 Option 3, landed ADAAAA-7707): a fire is counted, reported,
    # and emitted as a candidate that anchors one gemma analysis. Flipping
    # WhistleConfig.emitted back to False is the config-only rollback.
    whistle_gate: BandLimitedWhistleGate = field(default_factory=BandLimitedWhistleGate)
    # per-session whistle fires seen; `whistle_emitted` is the subset that went
    # into candidate scheduling (equal to whistle_candidates while emitting).
    whistle_candidates: int = 0
    whistle_emitted: int = 0
    # per-session audio chunk counter (event seq for audio-sourced candidates).
    audio_seq: int = 0
    # Ball-centric candidate signal (INC-2b). `homography` is the image->field
    # pitch homography (3x3, fit on normalized image coords) when the session
    # is calibrated; `ball_signal` is the per-session orchestrator, created in
    # SessionRegistry.get_or_create. Both optional: absent -> graceful fallback.
    homography: Optional[np.ndarray] = None
    ball_signal: Optional[object] = None
    # Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth signal.
    # `goal_line_spec` is the goal-line plane in the calibration's field coords
    # (control `configure` goalLine / env); `goal_line_detector` is the
    # classifier built lazily from it. Both optional: absent -> the candidate
    # simply carries no goalCrossed/ballOutcome (graceful degradation).
    goal_line_spec: Optional[object] = None
    goal_line_detector: Optional[object] = None
    # Scoreboard OCR / score-delta confirmation (ADAAAA-6360, decide-leg I3):
    # rolling history of score readings from candidate anchor frames so a later
    # candidate can report whether the displayed score changed across the
    # candidate window. Bounded per-session state, never grows on long streams.
    scoreboard_tracker: ScoreboardTracker = field(default_factory=ScoreboardTracker)
    # ADAAAA-7084 (design follow-up to 7081): the vision LLM's per-candidate
    # "scoreboard visible?" verdict + localization for the most recent candidate
    # anchor frame. Ephemeral per-frame state (overwritten every candidate); a
    # dataclass field so the per-session cache is explicit rather than a dynamic
    # attribute, and so `None` (gate off / LLM failure) degrades to the
    # ADAAAA-7081 fixed-ROI path. Optional: absent -> fixed-ROI behaviour.
    scoreboard_vision: Optional[ScoreboardVerdict] = None
    # LLM TrackingPlan (ADAAAA-6463, child of ADAAAA-6441): the closed detection
    # roster + zones + anchor + maxTracks the decide brain emitted for this
    # session. Plan-first: when present, detect/seeding vocabulary, zone set and
    # anchor-slot preference all come from it (with canned fallback when the
    # plan is absent/empty). Set via control `configure` trackingPlan.
    tracking_plan: Optional[TrackingPlan] = None
    # ADAAAA-7218 (Increment C): the jersey number of the player the operator
    # asked to track (control `track-player`). None until such a request. Used
    # to label the surfaced track + record the request for the observer.
    requested_player_number: Optional[int] = None
    # ADAAAA-7754: the video type's game profile — the one per-type source of
    # truth for vocabulary / zone model / corroboration oracle / trigger subset /
    # audio thresholds / tracking roster / eval set. Defaults to the reference
    # profile (soccer) so a session that never declares a type keeps today's
    # behaviour; the registry/worker re-binds it from the job's gameHint.
    game_profile: GameProfile = field(default_factory=lambda: DEFAULT_PROFILE)
    # True when the profile was bound explicitly (control/analyze `gameProfile`
    # key or a direct bind): hint-derived sync then leaves it alone, so an
    # explicit per-type choice is never silently reverted by a later frame.
    game_profile_explicit: bool = False
    # Bounded recent ball-speed window. Only appended while the profile enables
    # the ball-velocity trigger, so a default-profile session never touches it.
    ball_speeds: Deque[float] = field(default_factory=lambda: deque(maxlen=BALL_SPEED_WINDOW))

    @property
    def is_idle(self) -> bool:
        return (time.time() - self.health_ts) > self.idle_timeout_s


def apply_game_profile(
    state: SessionState, profile: GameProfile, *, explicit: bool = False
) -> bool:
    """Bind a game profile to a session (ADAAAA-7754).

    Applies the parts that are session state: the audio gate's operating point,
    the tracker's roster capacity, and the profile itself (vocabulary / zone
    model / oracle / trigger subset are read from `state.game_profile` at their
    own sites). Returns True when the session changed.

    A profile whose audio thresholds differ re-arms the gate: its baseline is
    tuned against the old operating point, so carrying it over would score the
    new thresholds against the wrong ambient floor. Identical thresholds (the
    default profile) leave the live gate — and therefore the firing set — alone.
    """
    if explicit:
        state.game_profile_explicit = True
    if profile is state.game_profile:
        return False
    state.game_profile = profile

    thresholds = profile.audio_thresholds
    if thresholds.differs_from(state.audio_gate.cfg):
        state.audio_gate = AudioEnergyGate(GateConfig(**thresholds.as_gate_kwargs()))
        log.info(
            "session audio gate re-armed id=%s profile=%s thresholds=%s",
            state.session_id, profile.key, thresholds.as_gate_kwargs(),
        )

    capacity = profile.capacity_for_clip(state.clip_path)
    tracker = getattr(state, "tracker", None)
    if tracker is not None and getattr(tracker, "capacity", None) != capacity:
        tracker.capacity = capacity
        log.info(
            "session track capacity id=%s profile=%s capacity=%d",
            state.session_id, profile.key, capacity,
        )
    return True


def sync_game_profile(state: SessionState) -> bool:
    """Resolve the session's profile from its game hint and bind it.

    Never raises for an unknown hint: unmapped types resolve to the safe-default
    profile (today's generic roster + corpus-wide audio defaults). A profile
    that was bound explicitly is authoritative and is left alone.
    """
    if state.game_profile_explicit:
        return False
    return apply_game_profile(state, profile_for(state.game_hint))


class SessionRegistry:
    def __init__(self, max_sessions: int = 1):
        self._sessions: dict[str, SessionState] = {}
        self.max_sessions = max_sessions
        # Optional sync hook fired on drop (e.g. tear down a trickle rail).
        self.on_drop = None

    def get_or_create(
        self,
        session_id: str,
        stream_id: str = "",
        clip_path: str = "",
        anchor_label: str | None = None,
        profile: GameProfile | None = None,
    ) -> SessionState:
        s = self._sessions.get(session_id)
        if s is None:
            if len(self._sessions) >= self.max_sessions:
                # evict nothing automatically; capacity handled by orchestrator.
                # But avoid unbounded growth: drop a single expired session.
                self._evict_expired()
            s = SessionState(session_id=session_id, stream_id=stream_id, clip_path=clip_path)
            # INC-6: bind SAM to this job's clip AND set the mode's track capacity
            # (3 live / 8 VOD) so the tracker instantiates with the right slots.
            # ADAAAA-6463: when a plan/anchor is known up front, pass it so the
            # tracker reserves the anchor's primary slot; otherwise it is applied
            # later via control `configure` (set_anchor).
            # ADAAAA-7754: the capacity comes from the type's profile roster.
            if profile is not None:
                apply_game_profile(s, profile)
            s.tracker = make_tracker(
                clip_path or None,
                capacity=mode_capacity(clip_path, s.game_profile),
                anchor_label=anchor_label,
            )
            self._sessions[session_id] = s
            log.info(
                "session start id=%s stream=%s clip=%s profile=%s capacity=%d active=%d",
                session_id, stream_id, clip_path or "", s.game_profile.key, s.tracker.capacity,
                len(self._sessions),
            )
        elif clip_path and clip_path != s.clip_path:
            # A (new) clip was declared for an existing session -> (re)bind SAM
            # so the persistent session tracks THIS stream, not a stale/global one.
            s.clip_path = clip_path
            s.tracker = make_tracker(
                clip_path or None,
                capacity=mode_capacity(clip_path, s.game_profile),
                anchor_label=anchor_label,
            )
        if profile is not None:
            apply_game_profile(s, profile)
        s.health_ts = time.time()
        return s

    def get(self, session_id: str) -> Optional[SessionState]:
        s = self._sessions.get(session_id)
        if s is not None:
            s.health_ts = time.time()
        return s

    def drop(self, session_id: str) -> bool:
        s = self._sessions.pop(session_id, None)
        if s and s.subscribers:
            for q in s.subscribers:
                try:
                    q.put_nowait(None)  # close subscriber connection
                except Exception:
                    pass
        if s is not None and self.on_drop is not None:
            try:
                self.on_drop(session_id)
            except Exception:
                pass
        if s is not None:
            log.info("session end id=%s active=%d", session_id, len(self._sessions))
        return s is not None

    def _evict_expired(self) -> None:
        expired = [sid for sid, s in self._sessions.items() if s.is_idle]
        for sid in expired:
            self.drop(sid)

    def count(self) -> int:
        return len(self._sessions)
