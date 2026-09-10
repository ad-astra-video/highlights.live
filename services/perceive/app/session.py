"""Perceive runner session state, keyed by Livepeer-Session-Id.

One persistent session object per stream: owns the tracker + the last frame's
grayscale (for background diff) + SSE subscriber queues. A new socket/HTTP
call on the same session id reuses this object — exactly one perceive session
per stream.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, List, Optional

import numpy as np

from .tracker import IoUTracker, MAX_TRACKS
from .sam_tracker import HybridTracker, make_tracker

RECENT_FRAMES = 30  # ~30 sampled frames kept for clip/confirm


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
    health_ts: float = field(default_factory=time.time)
    recent_frames: Deque[dict] = field(default_factory=lambda: deque(maxlen=RECENT_FRAMES))
    subscribers: List[asyncio.Queue] = field(default_factory=list)
    # Raw RGB of the most recent sampled frame + its image b64, so a control
    # `analyze-still` can force a fresh Florence+SAM3 pass on the current frame.
    last_rgb: Optional[np.ndarray] = None
    last_image_b64: str = ""
    game_hint: str = ""
    prefer_labels: List[str] = field(default_factory=list)
    sample_fps: float = 1.0
    idle_timeout_s: float = 120.0

    @property
    def is_idle(self) -> bool:
        return (time.time() - self.health_ts) > self.idle_timeout_s


class SessionRegistry:
    def __init__(self, max_sessions: int = 1):
        self._sessions: dict[str, SessionState] = {}
        self.max_sessions = max_sessions

    def get_or_create(self, session_id: str, stream_id: str = "", clip_path: str = "") -> SessionState:
        s = self._sessions.get(session_id)
        if s is None:
            if len(self._sessions) >= self.max_sessions:
                # evict nothing automatically; capacity handled by orchestrator.
                # But avoid unbounded growth: drop a single expired session.
                self._evict_expired()
            s = SessionState(session_id=session_id, stream_id=stream_id, clip_path=clip_path)
            s.tracker = make_tracker(clip_path or None)  # bind SAM to this job's clip
            self._sessions[session_id] = s
        elif clip_path and clip_path != s.clip_path:
            # A (new) clip was declared for an existing session -> (re)bind SAM
            # so the persistent session tracks THIS stream, not a stale/global one.
            s.clip_path = clip_path
            s.tracker = make_tracker(clip_path or None)
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
        return s is not None

    def _evict_expired(self) -> None:
        expired = [sid for sid, s in self._sessions.items() if s.is_idle]
        for sid in expired:
            self.drop(sid)

    def count(self) -> int:
        return len(self._sessions)
