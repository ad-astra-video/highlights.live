"""Decide watcher — the recurrent-call / summary pass (ADAAAA-6738 G1c).

Wrap the decide runner in "watcher mode", VOD first. This pass owns highlight
hypotheses and event typing: the four perceive windowed tools
(get_audio_levels / get_tracked_players / get_captioning / detect_objects) are
the signal source the watcher *may* call for a requested window, but ONLY
decide decides which tools to call and ONLY decide seeds a highlight
hypothesis / types the event.

The watcher is a bounded state machine over stream time:

- **Ingest** a rolling ``window_s`` (10 s) chunk on a ``tick_s`` (3 s) tick, up
  to ``max_frame_count`` (30) frames at ``fps`` (3). Because a 10 s window
  fires every 3 s, consecutive windows overlap by 7 s (``>= min_overlap``).
- **Emit** a timestamped ``SummaryRow`` per tick and append it to a bounded
  list of timestamped summaries.
- **Carry** the last ``summary_window_s`` (30 s) summary list (``>= 10`` rows)
  as context on every call.
- **Trace** every decide->perceive tool call/result to the server
  (``analysis_session_traces``) through an injectable trace sink.

The engine is deliberately import-light and deterministic so it can be
unit-tested without a GPU or a live perceive/decide process; the real perceive
client, trace sink and Gemma brain are injectable. Rule mode stands in for the
Gemma brain (mirrors the ``/highlight`` rule path), so a local VOD run proves
the mechanics without a model server.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

from .decider import Decision, decide

# High-value / notable event tokens used to seed a hypothesis from a caption or
# audio signal so the rule brain can type the event without a model. Only
# decide owns typing (the brain is decide's rule fallback, same as /highlight).
_EVENT_TOKENS = [
    ("GOAL", {"GOAL", "GOL", "GOOOAL"}),
    ("GOL", {"GOL"}),
    ("KILL", {"KILL", "ELIMINATED"}),
    ("DUNK", {"DUNK"}),
    ("ACE", {"ACE"}),
    ("CLUTCH", {"CLUTCH"}),
    ("OVERTAKE", {"OVERTAKE"}),
    ("KO", {"KO", "KNOCKOUT"}),
]


# --------------------------------------------------------------------------
# Config + data types
# --------------------------------------------------------------------------
@dataclass
class WatcherConfig:
    tick_s: float = 3.0
    window_s: float = 10.0
    fps: float = 3.0
    max_frame_count: int = 30          # == ceil(window_s * fps) for a 10 s / 3 fps chunk
    min_overlap: float = 0.50          # acceptance gate: >= 50 % overlap
    summary_window_s: float = 30.0     # last-30 s summary context
    summary_max_rows: int = 15         # always >= 10 rows available
    frame_max_entries: int = 480       # bounded ingest buffer (~160 s at 3 fps)
    max_velocity_for_rule: float = 0.0


@dataclass
class Frame:
    """One ingested frame. In rule mode the per-frame signals (players /
    objects / caption / audio) carry the window's evidence directly; in real
    mode the watcher queries perceive's windowed tools for the same signals."""

    ts: float
    seq: int
    players: List[Dict] = field(default_factory=list)
    objects: List[Dict] = field(default_factory=list)
    caption: str = ""
    audio_peak: float = 0.0
    audio_baseline: float = 0.0


@dataclass
class SummaryRow:
    """One timestamped summary row emitted per tick. Event typing + hypothesis
    are decided here (never derived by perceive); tools_called records which
    windowed tools decide invoked for the window."""

    ts: float
    window_start: float
    window_end: float
    frame_count: int
    event: str
    event_class: str
    is_highlight: bool
    score: float
    hypothesis: str
    text: str
    tools_called: List[str] = field(default_factory=list)
    overlap_fraction: float = 0.0
    truncated: bool = False

    def to_dict(self) -> Dict:
        return {
            "ts": round(self.ts, 3),
            "window": {"start": round(self.window_start, 3), "end": round(self.window_end, 3)},
            "frameCount": self.frame_count,
            "event": self.event,
            "eventClass": self.event_class,
            "isHighlight": self.is_highlight,
            "score": self.score,
            "hypothesis": self.hypothesis,
            "text": self.text,
            "toolsCalled": list(self.tools_called),
            "overlapFraction": round(self.overlap_fraction, 4),
            "truncated": self.truncated,
        }


# --------------------------------------------------------------------------
# Tool / trace / brain protocol (injectable callables)
# --------------------------------------------------------------------------
# perceive_tool(tool: str, start: float, end: float, max_points: int) -> dict
#   Returns the perceive envelope {tool, window, count, total, truncated, data}.
#   Skip (None) when a tool should not be called this window — decide decides.
PerceiveToolCall = Callable[[str, float, float, int], Optional[Dict]]
# trace(record: dict) -> None  — sink for analysis_session_traces (server trace).
TraceSink = Callable[[Dict], None]
# brain(window_frames, tool_results, config) -> (event, event_class, is_highlight,
#   score, hypothesis, text). Production: decide's brain; rule stub here.
Brain = Callable[[List[Frame], Dict[str, Optional[Dict]], "WatcherConfig"], tuple]


def _default_tool_policy(window_start: float, window_end: float) -> List[str]:
    """Which windowed tools decide invokes for a window (default: all four).

    This is the "only decide decides to call them" policy. In rule mode the
    watcher asks for all four bounded windows so the summary has the full
    signal picture; a real policy can narrow it (e.g. only audio + caption when
    the last summary saw no motion)."""
    return ["get_audio_levels", "get_tracked_players", "detect_objects", "get_captioning"]


def _extract_event_token(text: str) -> Optional[str]:
    """Return the canonical high-value event type named in a caption/transcript,
    else None. This is decide's rule-mode event typing: it claims the most
    salient notable token in the window's text, never a raw perceive label."""
    upper = (text or "").upper()
    for canonical, toks in _EVENT_TOKENS:
        for t in toks:
            if t in upper:
                return canonical
    return None


def default_brain(
    window_frames: List[Frame],
    tool_results: Dict[str, Optional[Dict]],
    config: WatcherConfig,
) -> tuple:
    """Rule-mode summary brain. Types the event from the window's signal (a
    caption/transcript token or an audio burst) and scores it with the shared
    `decide()` gate so the summary is consistent with the /highlight rule path.

    Returns (event, event_class, is_highlight, score, hypothesis, text)."""
    caption_text = " ".join(
        [f.caption for f in window_frames if f.caption] +
        [p.get("text", "") for p in (tool_results.get("get_captioning") or {}).get("data", [])]
    )
    audio = tool_results.get("get_audio_levels") or {}
    peak = max(
        [f.audio_peak for f in window_frames] +
        [float(p.get("peakEnergy", 0.0) or 0.0) for p in audio.get("data", [])],
        default=0.0,
    )
    objects = [o for f in window_frames for o in f.objects]
    players = [p for f in window_frames for p in f.players]
    # The four windowed tools are the watcher's signal source (decide decides
    # which to call). Fold their bounded results into the evidence as well as the
    # raw frames, so a signal survives even if a single frame is strided out by
    # the <=30-frame cap.
    tracked_data = ((tool_results.get("get_tracked_players") or {}).get("data") or [])
    obj_data = ((tool_results.get("detect_objects") or {}).get("data") or [])
    track_ids = set()
    for p in players:
        tid = str(p.get("trackId") or p.get("id") or "")
        if tid or p:
            track_ids.add(tid or p.get("label", str(id(p))))
    for pt in tracked_data:
        for p in pt.get("players", []):
            tid = str(p.get("trackId") or p.get("id") or "")
            track_ids.add(tid or p.get("label", str(id(p))))
    track_count = len(track_ids)
    ocr_hits = len(objects) + sum(int(d.get("count", 0) or 0) for d in obj_data)

    event = _extract_event_token(caption_text)
    # An audio burst (peak above a modest threshold) is a soft trigger that can
    # type an event too, but only decide decides the type from its own gate.
    if event is None and peak >= 0.7 and (track_count > 0 or ocr_hits > 0):
        event = "REACTION"  # crowd energy type, lower value than a scored event
    event = event or "NO_EVENT"

    score = 0.0
    is_highlight = False
    reaction = {"crowdEnergy": min(peak, 1.0), "humansInMotion": len(players), "ballSpeedMps": 0.0}
    if event != "NO_EVENT":
        d: Decision = decide(
            event_type=event,
            track_count=track_count,
            max_velocity=config.max_velocity_for_rule,
            ocr_hits=ocr_hits,
            reaction=reaction,
        )
        score = d.score
        is_highlight = d.is_highlight
        event_class = d.event_class
    else:
        event_class = "ordinary"

    parts = []
    if event != "NO_EVENT":
        parts.append(f"event {event}")
    if track_count:
        parts.append(f"{track_count} tracked player(s)")
    if ocr_hits:
        parts.append(f"{ocr_hits} object detections")
    if peak >= 0.4:
        parts.append(f"audio peak {peak:.2f}")
    if caption_text.strip():
        parts.append(f"caption '{caption_text.strip()[:60]}'")
    text = "; ".join(parts) if parts else "quiet window (no notable signal)"
    hypothesis = f"candidate {event} at t={window_frames[-1].ts if window_frames else 0:.1f}s" if event != "NO_EVENT" else "no hypothesis"

    return event, event_class, is_highlight, float(score), hypothesis, text


# --------------------------------------------------------------------------
# The watcher session
# --------------------------------------------------------------------------
class WatcherSession:
    """Bounded watcher state machine over stream time.

    Feed ingested frames with ``ingest(frame)`` and advance one 3 s tick with
    ``step(tick_ts)``. The rolling chunk, per-tick summary row, last-30 s
    summary context, tool-call decision and trace recording all live here.
    """

    def __init__(
        self,
        session_id: str = "",
        stream_id: str = "",
        config: Optional[WatcherConfig] = None,
        brain: Optional[Brain] = None,
        perceive: Optional[PerceiveToolCall] = None,
        trace: Optional[TraceSink] = None,
        tool_policy: Optional[Callable[[float, float], List[str]]] = None,
    ) -> None:
        self.session_id = session_id
        self.stream_id = stream_id
        self.config = config or WatcherConfig()
        self._brain = brain or default_brain
        self._perceive = perceive
        self._trace = trace
        self._tool_policy = tool_policy or _default_tool_policy
        self._frames: Deque[Frame] = deque(maxlen=self.config.frame_max_entries)
        self._summaries: Deque[SummaryRow] = deque()
        self._last_window: Optional[tuple] = None   # (start, end) of previous tick
        self._last_tick_ts: Optional[float] = None
        self.ticks = 0
        self.hypotheses_seeded = 0   # only decide seeds hypotheses (counted here)

    # -- ingest ------------------------------------------------------------
    def ingest(self, frame: Frame) -> None:
        self._frames.append(frame)

    def ingest_many(self, frames: List[Frame]) -> None:
        for f in frames:
            self.ingest(f)

    # -- helpers -----------------------------------------------------------
    def _frames_in(self, start: float, end: float) -> List[Frame]:
        # right-exclusive window so a 10 s / 3 fps window holds at most 30
        # frames (<= max_frame_count) without striding a signal frame out.
        return [f for f in self._frames if start <= f.ts < end]

    @staticmethod
    def _cap_frames(frames: List[Frame], max_count: int) -> tuple[List[Frame], bool]:
        """Bound an in-window frame list to at most ``max_count`` by even striding
        (keeps the window's temporal shape). Returns (picked, truncated)."""
        n = len(frames)
        if n <= max_count:
            return frames, False
        if max_count <= 1:
            return frames[:1], True
        idxs = [int(round(i * (n - 1) / (max_count - 1))) for i in range(max_count)]
        seen = set()
        picked = [frames[i] for i in idxs if not (i in seen or seen.add(i))]
        for f in frames:
            if len(picked) >= max_count:
                break
            if f not in picked:
                picked.append(f)
        return picked, True

    @staticmethod
    def _overlap_fraction(prev: Optional[tuple], cur: tuple, window_s: float) -> float:
        if prev is None or window_s <= 0:
            return 0.0
        ov = max(0.0, min(prev[1], cur[1]) - max(prev[0], cur[0]))
        return ov / window_s

    # -- the tick ----------------------------------------------------------
    def step(self, tick_ts: float) -> SummaryRow:
        """Emit one timestamped summary row for the rolling window ending at
        ``tick_ts`` (stream seconds). Ingest must be supplied frames up to the
        window's end. Only decide types the event + seeds the hypothesis."""
        cfg = self.config
        end = float(tick_ts)
        start = max(0.0, end - cfg.window_s)
        frames = self._frames_in(start, end)
        picked, truncated = self._cap_frames(frames, cfg.max_frame_count)
        # decide-owns-tool-calls: resolve which tools to invoke for this window.
        tools = self._tool_policy(start, end)
        tool_results: Dict[str, Optional[Dict]] = {}
        for tool in tools:
            result = None
            if self._perceive is not None:
                try:
                    result = self._perceive(tool, start, end, cfg.max_frame_count)
                except Exception:  # noqa: BLE001  a tool failure must not drop the tick
                    result = None
            tool_results[tool] = result
            if self._trace is not None:
                self._trace(self._trace_record(tool, start, end, cfg.max_frame_count, result))

        event, event_class, is_highlight, score, hypothesis, text = self._brain(picked, tool_results, cfg)
        if event != "NO_EVENT":
            self.hypotheses_seeded += 1

        overlap = self._overlap_fraction(self._last_window, (start, end), cfg.window_s)
        row = SummaryRow(
            ts=end,
            window_start=start,
            window_end=end,
            frame_count=len(picked),
            event=event,
            event_class=event_class,
            is_highlight=is_highlight,
            score=score,
            hypothesis=hypothesis,
            text=text,
            tools_called=tools,
            overlap_fraction=overlap,
            truncated=truncated,
        )
        self._summaries.append(row)
        self._trim_summaries()
        self._last_window = (start, end)
        self._last_tick_ts = end
        self.ticks += 1
        return row

    def _trim_summaries(self) -> None:
        """Keep only rows whose window overlaps the trailing summary window, and
        cap the count so the context stays bounded but always >= the gate's
        minimum row count (>= 10)."""
        if not self._summaries:
            return
        last_ts = self._summaries[-1].ts
        cutoff = last_ts - self.config.summary_window_s
        while self._summaries and self._summaries[0].ts < cutoff:
            self._summaries.popleft()
        while len(self._summaries) > self.config.summary_max_rows:
            self._summaries.popleft()

    # -- context -----------------------------------------------------------
    def summaries_context(self) -> List[SummaryRow]:
        """The last-30 s summary list (>= 10 rows once warm) that is carried as
        context on every call."""
        return list(self._summaries)

    def summaries_context_dicts(self) -> List[Dict]:
        return [r.to_dict() for r in self._summaries]

    def state(self) -> Dict:
        return {
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "ticks": self.ticks,
            "lastTickTs": self._last_tick_ts,
            "summaryRows": len(self._summaries),
            "summaryWindowS": self.config.summary_window_s,
            "hypothesesSeeded": self.hypotheses_seeded,
        }

    # -- trace -------------------------------------------------------------
    def _trace_record(self, tool: str, start: float, end: float, max_points: int, result: Optional[Dict]) -> Dict:
        # ADAAAA-6748 G1b-2: emit the AnalysisSessionTrace shape the server's
        # trace-ingest schema (packages/events AnalysisSessionTraceSchema) requires:
        # `at` = epoch ms + a `request` envelope. The earlier {type, ts, result,
        # resultOk} shape lacked those, so the server 422'd and dropped every VOD
        # trace (ADAAAA-6753). Extra keys (resultOk) are stripped by zod.
        return {
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "tool": tool,
            "window": {"start": start, "end": end},
            "at": int(time.time() * 1000),
            "request": {"tool": tool, "start": start, "end": end, "maxPoints": max_points},
            "response": result,
            "resultOk": result is not None,
        }
