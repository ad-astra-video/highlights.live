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

RECENT_FRAMES = 30  # ~30 sampled frames kept for clip/confirm


@dataclass
class SessionState:
    session_id: str
    stream_id: str = ""
    tracker: IoUTracker = field(default_factory=IoUTracker)
    prev_gray: Optional[np.ndarray] = None
    seq: int = 0
    health_ts: float = field(default_factory=time.time)
    recent_frames: Deque[dict] = field(default_factory=lambda: deque(maxlen=RECENT_FRAMES))
    subscribers: List[asyncio.Queue] = field(default_factory=list)
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

    def get_or_create(self, session_id: str, stream_id: str = "") -> SessionState:
        s = self._sessions.get(session_id)
        if s is None:
            if len(self._sessions) >= self.max_sessions:
                # evict nothing automatically; capacity handled by orchestrator.
                # But avoid unbounded growth: drop a single expired session.
                self._evict_expired()
            s = SessionState(session_id=session_id, stream_id=stream_id)
            self._sessions[session_id] = s
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
