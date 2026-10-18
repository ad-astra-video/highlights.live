"""Persistent per-stream analysis session + windowed query tools.

ADAAAA-6738 G1 (watcher plan Part 0d / Part 2). A persistent perceive session
records its continuous frame-by-frame analysis — audio-energy state, tracked
players, object detections, and the ASR/scoreboard caption window — into
bounded, per-session ring buffers keyed by stream time. Four windowed query
tools slice those buffers for a requested ``[start, end]`` window and return
**bounded, schema-stable** results.

This is the "recurrent call shape" the decide watcher (and the operator UI /
webapp-relay persistence path) uses *instead of* perceive emitting autonomous
candidates: the consumer asks "what did the stream look like / sound like in
these 10 seconds?" and gets a capped, stable answer.

Boundedness (this is NOT a per-frame firehose):
- Each ring buffer is capped at a fixed max number of entries (FIFO
  drop-oldest) so per-session memory stays bounded on long streams.
- Each windowed query downsamples in-window points to at most ``maxPoints``
  (evenly-strided when the window holds more), and reports ``truncated`` so a
  consumer can tell a full window from a downsampled one.

The module is deliberately import-light (no session/tracker imports) so it can
be unit-tested without a GPU and attached to a session as a plain attribute.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, List, Optional

# --- Boundedness constants -------------------------------------------------
# Ring-buffer entry caps (FIFO drop-oldest). Kept small: these are query
# sources, not a durable log (durability is the server's analysis_events table).
AUDIO_MAX_ENTRIES = 1800      # ~3 min at the audio gate's ~10 Hz cadence
FRAME_MAX_ENTRIES = 120       # ~120 s at 1 fps / ~40 s at 3 fps (per-frame sets)
CAPTION_MAX_ENTRIES = 600     # short ASR/scoreboard caption lines

# Per-tool output caps (hard maximums the route will not exceed).
TOOL_MAX_POINTS_CAP = 240     # no tool ever returns more than this per window
AUDIO_DEFAULT_POINTS = 60     # a 10 s window at ~6/s is plenty for an energy curve
FRAME_DEFAULT_POINTS = 30     # aligns with the watcher's <=30 frames / 10 s / 3 fps
CAPTION_DEFAULT_POINTS = 20   # captions are coarser; keep the window short


@dataclass
class AudioSample:
    ts: float
    peak_energy: float
    baseline_energy: float
    kind: str = ""


@dataclass
class FrameSnapshot:
    ts: float
    seq: int
    # Bounded per-frame sets (already capped upstream to the tracker's slots /
    # the detector's top-N, so these stay small even for dense frames).
    players: List[Dict] = field(default_factory=list)   # non-ball tracks
    objects: List[Dict] = field(default_factory=list)   # raw detections


@dataclass
class CaptionLine:
    ts: float
    text: str


class AnalysisSession:
    """Bounded, per-stream ring buffers + the four windowed query tools.

    Attach one to a perceive ``SessionState``; feed it from the frame / audio
    hot path (``record_frame`` / ``record_audio`` / ``record_caption``) and
    query it via the four tools. Every method is fault-tolerant by contract:
    the tools never raise, they return an empty-but-schema-stable result when
    the window holds nothing.
    """

    def __init__(
        self,
        session_id: str = "",
        stream_id: str = "",
        audio_max: int = AUDIO_MAX_ENTRIES,
        frame_max: int = FRAME_MAX_ENTRIES,
        caption_max: int = CAPTION_MAX_ENTRIES,
    ) -> None:
        self.session_id = session_id
        self.stream_id = stream_id
        self._audio: Deque[AudioSample] = deque(maxlen=audio_max)
        self._frames: Deque[FrameSnapshot] = deque(maxlen=frame_max)
        self._captions: Deque[CaptionLine] = deque(maxlen=caption_max)
        self.started_ts: Optional[float] = None
        self.last_ts: Optional[float] = None

    # -- recording (hot path; must never break the frame) -------------------
    def record_audio(self, ts: float, peak_energy: float, baseline_energy: float, kind: str = "") -> None:
        self._touch(ts)
        self._audio.append(AudioSample(float(ts), float(peak_energy), float(baseline_energy), kind or ""))

    def record_frame(
        self,
        ts: float,
        seq: int,
        players: Optional[List[Dict]] = None,
        objects: Optional[List[Dict]] = None,
    ) -> None:
        self._touch(ts)
        self._frames.append(FrameSnapshot(float(ts), int(seq), players or [], objects or []))

    def record_caption(self, ts: float, text: str) -> None:
        if not text:
            return
        self._touch(ts)
        self._captions.append(CaptionLine(float(ts), text))

    def _touch(self, ts: float) -> None:
        try:
            ts = float(ts)
        except Exception:  # noqa: BLE001
            return
        if self.started_ts is None or ts < self.started_ts:
            self.started_ts = ts
        if self.last_ts is None or ts > self.last_ts:
            self.last_ts = ts

    # -- live state (for the webapp "live analysis state" surface) ----------
    def state(self) -> Dict:
        return {
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "startedTs": self.started_ts,
            "lastTs": self.last_ts,
            "audioSamples": len(self._audio),
            "frameSnapshots": len(self._frames),
            "captionLines": len(self._captions),
            "active": self.last_ts is not None,
        }

    # -- the four windowed query tools --------------------------------------
    def get_audio_levels(self, start: float, end: float, max_points: int = AUDIO_DEFAULT_POINTS) -> Dict:
        in_win = [s for s in self._audio if start <= s.ts <= end]
        points, truncated = _strided(
            in_win, max_points,
            lambda s: {
                "ts": round(s.ts, 3),
                "peakEnergy": s.peak_energy,
                "baselineEnergy": s.baseline_energy,
                **({"kind": s.kind} if s.kind else {}),
            },
        )
        return _envelope("get_audio_levels", self, start, end, points, truncated, len(in_win))

    def get_tracked_players(self, start: float, end: float, max_points: int = FRAME_DEFAULT_POINTS) -> Dict:
        in_win = [f for f in self._frames if start <= f.ts <= end and f.players]
        points, truncated = _strided(
            in_win, max_points,
            lambda f: {
                "ts": round(f.ts, 3),
                "seq": f.seq,
                "players": f.players[:8],  # hard per-frame cap (VOD max tracks)
                "count": len(f.players),
            },
        )
        return _envelope("get_tracked_players", self, start, end, points, truncated, len(in_win))

    def detect_objects(self, start: float, end: float, max_points: int = FRAME_DEFAULT_POINTS) -> Dict:
        in_win = [f for f in self._frames if start <= f.ts <= end and f.objects]
        points, truncated = _strided(
            in_win, max_points,
            lambda f: {
                "ts": round(f.ts, 3),
                "seq": f.seq,
                "objects": f.objects[:16],  # hard per-frame cap
                "count": len(f.objects),
            },
        )
        return _envelope("detect_objects", self, start, end, points, truncated, len(in_win))

    def get_captioning(self, start: float, end: float, max_points: int = CAPTION_DEFAULT_POINTS) -> Dict:
        in_win = [c for c in self._captions if start <= c.ts <= end]
        points, truncated = _strided(
            in_win, max_points,
            lambda c: {"ts": round(c.ts, 3), "text": c.text},
        )
        return _envelope("get_captioning", self, start, end, points, truncated, len(in_win))


# --- helpers ---------------------------------------------------------------
def _clamp_points(max_points: int) -> int:
    """Clamp a requested point count into [1, TOOL_MAX_POINTS_CAP]."""
    try:
        n = int(max_points)
    except Exception:  # noqa: BLE001
        n = FRAME_DEFAULT_POINTS
    return max(1, min(n, TOOL_MAX_POINTS_CAP))


def _strided(items: list, max_points: int, fmt):
    """Bound a time-ordered in-window list to at most ``max_points`` entries by
    even striding (keeps the window's shape, drops the interior points). Returns
    (formatted_points, truncated). Empty window -> ([], False)."""
    cap = _clamp_points(max_points)
    n = len(items)
    if n == 0:
        return [], False
    if n <= cap:
        return [fmt(x) for x in items], False
    # Even stride: pick `cap` evenly spaced indices across the window.
    idxs = [int(round(i * (n - 1) / (cap - 1))) for i in range(cap)] if cap > 1 else [0]
    # de-dup while preserving order (rounding can collapse adjacent indices)
    seen = set()
    picked = [items[i] for i in idxs if not (i in seen or seen.add(i))]
    # pad from the end if rounding collapsed more than expected (rare)
    if len(picked) < cap:
        for x in items:
            if x not in picked:
                picked.append(x)
            if len(picked) == cap:
                break
    return [fmt(x) for x in picked], True


def _envelope(tool: str, sess: AnalysisSession, start: float, end: float, points: List[Dict], truncated: bool, total: int) -> Dict:
    try:
        s = float(start)
        e = float(end)
    except Exception:  # noqa: BLE001
        s, e = 0.0, 0.0
    if e < s:
        s, e = e, s
    return {
        "tool": tool,
        "sessionId": sess.session_id,
        "streamId": sess.stream_id,
        "window": {"start": s, "end": e, "seconds": round(e - s, 3)},
        "count": len(points),
        "total": int(total),
        "truncated": bool(truncated),
        "data": points,
    }
