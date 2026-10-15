"""Decide pass-2 deep investigation (ADAAAA-6740 G3).

For each moment the depth router flagged, run a deeper verdict over the
**3 s-forward / 12 s-back window** (video + audio), with perceive's four
windowed tools as corroborating evidence. The deep verdict is where the
highlight decision + clip decision are resolved: it resolves through the
**single accept gate** (``finalize_goal_acceptance`` — only a ``scoring_play``
is a board-accepted highlight), and a refuted/non-highlight moment is
**discarded** (no clip).

Noise-trigger reliability: the deep gemma call is **gated by decide** — a
cheap audio-reliability / corroboration pre-check runs before any expensive
inference, so gemma is not fired for an audio-noise-only moment. The
audio-noise false-positive rate is measured and bounded via
``get_audio_levels`` (see ``evals/decide_watcher_deep_investigation.py``).

The engine is deterministic and import-light so it can be unit-tested without a
GPU; the deep brain (Gemma) and perceieve client are injectable, and rule mode
stands in for the Gemma brain exactly like the watcher's ``default_brain``.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .decider import decide, Decision
from .depth_router import DeepFlag
from .gemma import finalize_goal_acceptance, _rule_outcome
from .watcher import Frame

# High-value types the deep investigator will accept through the gate if the
# single accept gate confirms a scoring_play outcome.
_HIGH_VALUE = {"GOAL", "GOL", "KILL", "DUNK", "CLUTCH", "ACE", "PENTAKILL", "OVERTAKE", "KO"}


# --------------------------------------------------------------------------
# Config + data types
# --------------------------------------------------------------------------
@dataclass
class DeepInvestigationConfig:
    deep_back_s: float = 12.0       # seconds back from the trigger
    deep_forward_s: float = 3.0     # seconds forward from the trigger
    audio_peak_min: float = 0.55    # audio-noise gate: window peak bar
    audio_rise_min: float = 0.15    # audio-noise gate: peak must clear baseline
    max_points: int = 64            # bounded tool sample count per window
    max_frame_count: int = 45       # ~15 s at 3 fps (capped chunk)
    require_corroboration: bool = True  # a flagged moment must carry evidence


@dataclass
class DeepVerdict:
    """The deep-investigation verdict for a flagged moment.

    ``discarded`` is True when the moment did NOT confirm a highlight (no clip).
    ``is_highlight`` is the post-single-accept-gate verdict (only a scoring_play
    stays True).
    """

    flag_ts: float
    window_start: float
    window_end: float
    event: str
    event_class: str
    outcome: str
    is_highlight: bool
    score: float
    reason: str
    hypothesis: str
    discarded: bool
    gated: bool = False
    gate_reason: str = ""
    tools_called: List[str] = field(default_factory=list)
    source: str = "rule"

    def to_dict(self) -> dict:
        return {
            "flagTs": round(self.flag_ts, 3),
            "window": {"start": round(self.window_start, 3), "end": round(self.window_end, 3)},
            "event": self.event,
            "eventClass": self.event_class,
            "outcome": self.outcome,
            "isHighlight": self.is_highlight,
            "score": round(self.score, 1),
            "reason": self.reason,
            "hypothesis": self.hypothesis,
            "discarded": self.discarded,
            "gated": self.gated,
            "gateReason": self.gate_reason,
            "toolsCalled": list(self.tools_called),
            "source": self.source,
        }


# --------------------------------------------------------------------------
# Injectable protocols
# --------------------------------------------------------------------------
# frames_provider(start, end) -> List[Frame]  (the decide runner's frame stash)
FramesProvider = Callable[[float, float], List[Frame]]
PerceiveToolCall = Callable[[str, float, float, int], Optional[dict]]
TraceSink = Callable[[dict], None]
# deep_brain(window_frames, tool_results, config) -> (event, event_class,
#   is_highlight, score, hypothesis, outcome)
DeepBrain = Callable[[List[Frame], dict, "DeepInvestigationConfig"], tuple]


def _audio_reliability(tool_results: dict, cfg: DeepInvestigationConfig) -> tuple[bool, str]:
    """Cheap audio-noise-reliability pre-check via ``get_audio_levels``.

    Returns (ok, reason). A window with no audio data is inconclusive (ok False
    with a reason to require other corroboration); a high-but-flat peak that
    never clears its baseline is audio noise (rejected)."""
    audio = tool_results.get("get_audio_levels") or {}
    pts = audio.get("data") or []
    if not pts:
        return False, "no audio signal in deep window"
    peak = max(float(p.get("peakEnergy", 0.0) or 0.0) for p in pts)
    baseline = min(float(p.get("baselineEnergy", 0.0) or 0.0) for p in pts)
    if peak < cfg.audio_peak_min:
        return False, f"audio peak {peak:.2f} below bar {cfg.audio_peak_min:.2f}"
    if (peak - baseline) < cfg.audio_rise_min:
        return False, f"audio flat (no baseline-relative rise) peak {peak:.2f}"
    return True, f"audio peak {peak:.2f} (rise {peak - baseline:.2f})"


def default_deep_brain(
    window_frames: List[Frame],
    tool_results: dict,
    cfg: DeepInvestigationConfig,
) -> tuple:
    """Rule-mode deep brain: type the event from the deep window's full signal
    picture and score it with the shared ``decide()`` gate. Returns
    (event, event_class, is_highlight, score, hypothesis, outcome)."""
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
    tracked_data = ((tool_results.get("get_tracked_players") or {}).get("data") or [])
    obj_data = ((tool_results.get("detect_objects") or {}).get("data") or [])
    track_ids = set()
    for p in players:
        tid = str(p.get("trackId") or p.get("id") or "")
        track_ids.add(tid or p.get("label", str(id(p))))
    for pt in tracked_data:
        for p in pt.get("players", []):
            tid = str(p.get("trackId") or p.get("id") or "")
            track_ids.add(tid or p.get("label", str(id(p))))
    track_count = len(track_ids)
    ocr_hits = len(objects) + sum(int(d.get("count", 0) or 0) for d in obj_data)

    # Decide owns event typing for the deep verdict (same rule as pass 1).
    upper = (caption_text or "").upper()
    event = None
    for canonical, toks in _EVENT_TOKENS:
        for t in toks:
            if t in upper:
                event = canonical
                break
        if event:
            break
    if event is None and peak >= 0.7 and (track_count > 0 or ocr_hits > 0):
        event = "REACTION"
    event = event or "NO_EVENT"

    score = 0.0
    is_highlight = False
    event_class = "ordinary"
    reaction = {"crowdEnergy": min(peak, 1.0), "humansInMotion": len(players), "ballSpeedMps": 0.0}
    outcome = "not_highlight"
    if event != "NO_EVENT":
        d: Decision = decide(
            event_type=event,
            track_count=track_count,
            max_velocity=0.0,
            ocr_hits=ocr_hits,
            reaction=reaction,
        )
        score = d.score
        is_highlight = d.is_highlight
        event_class = d.event_class
        # _rule_outcome expects a Decision (has .is_highlight), not a bare bool.
        outcome = _rule_outcome(d)

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
    hypothesis = f"deep candidate {event} at t={window_frames[-1].ts if window_frames else 0:.1f}s" if event != "NO_EVENT" else "no hypothesis"
    return event, event_class, is_highlight, float(score), hypothesis, outcome


# move _EVENT_TOKENS here for the deep brain (decide owns typing)
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
# The deep investigator
# --------------------------------------------------------------------------
class DeepInvestigator:
    """Runs the deep-investigation verdict for a flagged moment.

    Assembles the deep window (video + audio + perceive tool evidence),
    gates the expensive brain on audio-reliability/corroboration, runs the
    deep brain, and resolves through the single accept gate. A refuted /
    non-highlight moment is discarded (no clip).
    """

    def __init__(
        self,
        session_id: str = "",
        stream_id: str = "",
        config: Optional[DeepInvestigationConfig] = None,
        brain: Optional[DeepBrain] = None,
        perceive: Optional[PerceiveToolCall] = None,
        trace: Optional[TraceSink] = None,
    ) -> None:
        self.session_id = session_id
        self.stream_id = stream_id
        self.config = config or DeepInvestigationConfig()
        self._brain = brain or default_deep_brain
        self._perceive = perceive
        self._trace = trace
        self.verdicts: List[DeepVerdict] = []
        self.deep_calls = 0
        self.gated_discards = 0
        self.confirmed = 0

    def investigate(
        self,
        flag: DeepFlag,
        frames_provider: FramesProvider,
    ) -> DeepVerdict:
        """Run the deep investigation for one flagged moment. Returns the
        ``DeepVerdict`` (discard for a non-highlight — no clip)."""
        cfg = self.config
        start = flag.window_start
        end = flag.window_end

        # Decide owns tool calls; pull the deep-window evidence.
        tools = ["get_audio_levels", "get_tracked_players", "detect_objects", "get_captioning"]
        tool_results: dict = {}
        for tool in tools:
            result = None
            if self._perceive is not None:
                try:
                    result = self._perceive(tool, start, end, cfg.max_points)
                except Exception:  # noqa: BLE001  a tool hiccup must not drop the verdict
                    result = None
            tool_results[tool] = result
            if self._trace is not None:
                self._trace(self._trace_record(tool, flag, result))

        frames = frames_provider(start, end) if frames_provider else []
        picked = self._cap_frames(frames, cfg.max_frame_count)

        # Audio-noise-reliability gate: a high-value typed event is confirmed by
        # its own context; otherwise require a real baseline-relative audio rise
        # OR visual corroboration, so gemma is not fired for nothing.
        gate_ok, gate_reason = True, ""
        self.gated = False
        if (flag.event or "").upper() not in _HIGH_VALUE:
            audio_ok, audio_reason = _audio_reliability(tool_results, cfg)
            tracked_dat = ((tool_results.get("get_tracked_players") or {}).get("data") or [])
            obj_dat = ((tool_results.get("detect_objects") or {}).get("data") or [])
            visual = bool(
                any(f.players or f.objects for f in frames)
                or tracked_dat
                or obj_dat
            )
            if not (audio_ok or visual):
                gate_ok = False
                gate_reason = audio_reason
                self.gated_discards += 1
                return self._verdict(
                    flag, "NO_EVENT", "ordinary", "not_highlight", False, 0.0,
                    f"gated: {gate_reason} (no corroboration)", "no hypothesis",
                    discarded=True, gated=True, gate_reason=gate_reason, tools_called=tools,
                )

        event, event_class, is_highlight, score, hypothesis, outcome = self._brain(picked, tool_results, cfg)
        self.deep_calls += 1

        # Resolve through the single accept gate (only scoring_play is accepted).
        decision = {
            "isHighlight": bool(is_highlight),
            "score": float(score or 0.0),
            "eventType": event if event != "NO_EVENT" else None,
            "reason": "",
            "outcome": outcome,
            "eventClass": event_class,
        }
        decision = finalize_goal_acceptance(decision)
        final_hl = bool(decision.get("isHighlight"))
        final_outcome = decision.get("outcome") or "not_highlight"
        if final_hl:
            self.confirmed += 1

        discarded = not final_hl
        reason = decision.get("reason") or hypothesis
        return self._verdict(
            flag, event, event_class, final_outcome, final_hl, score, reason, hypothesis,
            discarded=discarded, tools_called=tools,
        )

    @staticmethod
    def _cap_frames(frames: List[Frame], max_count: int) -> List[Frame]:
        n = len(frames)
        if n <= max_count:
            return frames
        if max_count <= 1:
            return frames[:1]
        idxs = [int(round(i * (n - 1) / (max_count - 1))) for i in range(max_count)]
        seen = set()
        picked = [frames[i] for i in idxs if not (i in seen or seen.add(i))]
        for f in frames:
            if len(picked) >= max_count:
                break
            if f not in picked:
                picked.append(f)
        return picked

    def _verdict(
        self, flag: DeepFlag, event, event_class, outcome, is_highlight,
        score, reason, hypothesis, discarded, gated=False, gate_reason="", tools_called=None,
    ) -> DeepVerdict:
        v = DeepVerdict(
            flag_ts=flag.ts,
            window_start=flag.window_start,
            window_end=flag.window_end,
            event=event,
            event_class=event_class,
            outcome=outcome,
            is_highlight=is_highlight,
            score=score,
            reason=reason,
            hypothesis=hypothesis,
            discarded=discarded,
            gated=gated,
            gate_reason=gate_reason,
            tools_called=tools_called or [],
            source="rule",
        )
        self.verdicts.append(v)
        if self._trace is not None:
            self._trace(self._verdict_trace(v))
        return v

    # -- state -------------------------------------------------------------
    def state(self) -> dict:
        return {
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "deepCalls": self.deep_calls,
            "gatedDiscards": self.gated_discards,
            "confirmed": self.confirmed,
            "verdicts": len(self.verdicts),
        }

    def verdicts_dicts(self) -> List[dict]:
        return [v.to_dict() for v in self.verdicts]

    # -- trace -------------------------------------------------------------
    def _trace_record(self, tool: str, flag: DeepFlag, result: Optional[dict]) -> dict:
        return {
            "type": "deep_tool_call",
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "tool": tool,
            "window": {"start": flag.window_start, "end": flag.window_end},
            "ts": time.time(),
            "result": result,
            "resultOk": result is not None,
        }

    def _verdict_trace(self, v: DeepVerdict) -> dict:
        return {
            "type": "deep_verdict",
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "ts": time.time(),
            "verdict": v.to_dict(),
        }
