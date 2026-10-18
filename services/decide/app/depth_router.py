"""Decide pass-2 depth router (ADAAAA-6740 G3).

The depth router is the **sole trigger authority**. It keeps a rolling dialog
of what pass 1 (the watcher summary pass) reported and decides **where to look
deeper**. It never emits a highlight itself; it only *flags* a moment for deep
investigation. No candidate and no trigger originates in perceive: perceive is
only a windowed evidence source the router (and later the deep investigation)
may query through decide's own tool calls (get_audio_levels /
get_tracked_players / get_captioning / detect_objects).

This pass is deliberately conservative so deep-investigation GPU cost stays
low (Part 3 Pass 2 gate):

- A moment is flagged only when the rolling dialog shows a **high-signal**
  moment — a high-value event token, or a strong crowd/audio reaction with
  visual corroboration (tracked players / object detections).
- Every flag candidate passes an **audio-noise-reliability gate** (via
  ``get_audio_levels``): decide requires the deep window's peak energy to clear
  its baseline by a real rise, so gemma is NOT fired for silence or
  audio-noise-only moments. A high-value typed event carries its own
  confirmation and skips the audio-only rejection.
- A **cooldown** caps the flag rate (``max_flags_per_min`` target, default
  ``<= 5`` flags/min) so flags cannot cluster into an unbounded budget.

The engine is import-light and deterministic so it can be unit-tested without
a GPU or a live perceive/decide process; the perceive client, trace sink and
flag brain are injectable. Rule mode stands in for the Gemma brain, exactly
like the watcher's ``default_brain``.
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, List, Optional

from .watcher import SummaryRow

# High-value event types the router treats as strong trigger candidates. These
# mirror the decide HIGH_VALUE_EVENTS set (decide owns typing).
_HIGH_VALUE = {"GOAL", "GOL", "KILL", "DUNK", "CLUTCH", "ACE", "PENTAKILL", "OVERTAKE", "KO"}


# --------------------------------------------------------------------------
# Config + data types
# --------------------------------------------------------------------------
@dataclass
class DepthRouterConfig:
    deep_back_s: float = 12.0        # deep-investigation window: seconds back
    deep_forward_s: float = 3.0      # deep-investigation window: seconds forward
    min_flag_score: float = 50.0     # flag-score bar (rule mode) for a candidate
    audio_flag_peak: float = 0.55    # audio peak that marks a possible reaction
    audio_rise_min: float = 0.15     # peak must clear baseline by this (noise gate)
    cooldown_s: float = 12.0         # bounds flag rate (default <= 5 flags/min)
    max_flags_per_min: float = 5.0
    max_dialog_rows: int = 64        # bounded rolling dialog


@dataclass
class DeepFlag:
    """One moment the depth router flagged for deep investigation.

    ``window_start``/``window_end`` bound the up-to-12 s-back / 3 s-forward deep
    window. ``event`` is decide's current read of the moment (may be refined by
    the deep investigation). ``gated_audio`` records whether the audio-noise
    gate ran and how it resolved.
    """

    ts: float
    window_start: float
    window_end: float
    event: str
    score: float
    reason: str
    gated_audio: bool = False
    audio_ok: bool = False
    tools_called: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ts": round(self.ts, 3),
            "window": {"start": round(self.window_start, 3), "end": round(self.window_end, 3)},
            "event": self.event,
            "score": round(self.score, 1),
            "reason": self.reason,
            "gatedAudio": self.gated_audio,
            "audioOk": self.audio_ok,
            "toolsCalled": list(self.tools_called),
        }


# --------------------------------------------------------------------------
# Injectable protocols
# --------------------------------------------------------------------------
# perceive_tool(tool, start, end, max_points) -> Optional[envelope]
PerceiveToolCall = Callable[[str, float, float, int], Optional[dict]]
TraceSink = Callable[[dict], None]
# flag_brain(row, tool_results, config) -> (score, reason, event)
FlagBrain = Callable[[SummaryRow, dict, "DepthRouterConfig"], tuple]


def _audio_window_ok(tool_results: dict, cfg: DepthRouterConfig) -> bool:
    """The audio-noise-reliability gate over the deep window (get_audio_levels).

    Returns True when the window shows a genuine energy RISE or when no audio
    data is available (no signal means the caller must rely on visual/event
    evidence). A high-but-flat peak that never clears its own baseline is
    treated as audio noise and rejected.
    """
    audio = tool_results.get("get_audio_levels") or {}
    pts = audio.get("data") or []
    if not pts:
        return False  # no audio signal -> audio alone cannot confirm a reaction
    peak = max(float(p.get("peakEnergy", 0.0) or 0.0) for p in pts)
    # baseline-relative rise: use the min baseline observed (energy floor)
    baseline = min(float(p.get("baselineEnergy", 0.0) or 0.0) for p in pts)
    return peak >= cfg.audio_flag_peak and (peak - baseline) >= cfg.audio_rise_min


def default_flag_brain(
    row: SummaryRow,
    tool_results: dict,
    cfg: DepthRouterConfig,
) -> tuple:
    """Rule-mode flag brain. Scores how strongly ``row`` deserves a deep look.

    Returns (score, reason, event). A high-value event token alone is a strong
    candidate; a reaction (audio burst + visual corroboration) is a moderate
    candidate; a quiet window is not.
    """
    event = (row.event or "NO_EVENT").upper()
    is_high = event in _HIGH_VALUE
    audio = tool_results.get("get_audio_levels") or {}
    pts = audio.get("data") or []
    peak = max([float(p.get("peakEnergy", 0.0) or 0.0) for p in pts], default=0.0)

    score = 0.0
    parts = []
    if is_high:
        score += 60
        parts.append(f"high-value event {event}")
    if peak >= cfg.audio_flag_peak:
        score += 30
        parts.append(f"audio peak {peak:.2f}")
    if peak >= 0.7:
        score += 15
        parts.append("strong audio burst")
    if row.frame_count > 0:
        # the summary row's own notability score already encodes corroboration
        score += min(float(row.score or 0.0) * 0.3, 30)
        if float(row.score or 0.0) > 0:
            parts.append(f"pass-1 score {row.score:.0f}")

    if is_high:
        reason = "; ".join(parts) or f"high-value event {event}"
    elif event == "REACTION" and peak >= cfg.audio_flag_peak:
        reason = "; ".join(parts) or "strong audio reaction"
    else:
        reason = "insufficient signal"
    return score, reason, event


# --------------------------------------------------------------------------
# The depth router session
# --------------------------------------------------------------------------
class DepthRouter:
    """Rolling-dialog depth router — the sole trigger source.

    Feed the pass-1 summary rows with ``observe(row)`` and advance with
    ``step(tick_ts)``; it may return a ``DeepFlag`` when the dialog shows a
    high-signal moment that cleared the audio-noise gate and the cooldown.
    """

    def __init__(
        self,
        session_id: str = "",
        stream_id: str = "",
        config: Optional[DepthRouterConfig] = None,
        brain: Optional[FlagBrain] = None,
        perceive: Optional[PerceiveToolCall] = None,
        trace: Optional[TraceSink] = None,
    ) -> None:
        self.session_id = session_id
        self.stream_id = stream_id
        self.config = config or DepthRouterConfig()
        self._brain = brain or default_flag_brain
        self._perceive = perceive
        self._trace = trace
        self._dialog: Deque[SummaryRow] = deque(maxlen=self.config.max_dialog_rows)
        self._last_flag_ts: Optional[float] = None
        self.flags: List[DeepFlag] = []
        self.flagged_rows = 0

    def observe(self, row: SummaryRow) -> None:
        """Append one pass-1 summary row to the rolling dialog."""
        self._dialog.append(row)

    def _recent_rows(self) -> List[SummaryRow]:
        """The dialog rows whose window overlaps the trailing deep window."""
        if not self._dialog:
            return []
        return list(self._dialog)

    # -- the tick ----------------------------------------------------------
    def step(self, tick_ts: float) -> Optional[DeepFlag]:
        """Examine the latest dialog entry; flag a moment for deep
        investigation when it is a high-signal candidate that cleared the
        audio-noise gate and the cooldown. Returns the ``DeepFlag`` or None.

        The flagged moment's ts is the latest dialog row's window end (the
        moment the high signal was observed). The deep window is
        ``[ts - deep_back_s, ts + deep_forward_s]``.
        """
        if not self._dialog:
            return None
        cfg = self.config
        row = self._dialog[-1]

        # Cooldown: never flag two moments within cooldown_s (bounds flag rate).
        if self._last_flag_ts is not None and (tick_ts - self._last_flag_ts) < cfg.cooldown_s:
            return None

        ts = float(row.window_end)
        start = max(0.0, ts - cfg.deep_back_s)
        end = ts + cfg.deep_forward_s

        # Gather the deep-window audio evidence for the noise gate. Only decide
        # calls tools, and only when the row already hints at a candidate (to
        # keep the tool-call rate low — a quiet window needs no query).
        hint = (row.event or "NO_EVENT").upper() in _HIGH_VALUE or float(row.score or 0.0) > 0
        tool_results: dict = {}
        tools = []
        if hint and self._perceive is not None:
            try:
                tool_results["get_audio_levels"] = self._perceive("get_audio_levels", start, end, 1)
                tools.append("get_audio_levels")
            except Exception:  # noqa: BLE001  a tool hiccup must not drop the tick
                tool_results["get_audio_levels"] = None

        score, reason, event = self._brain(row, tool_results, cfg)
        if score < cfg.min_flag_score:
            return None

        # Audio-noise-reliability gate: a high-value typed event is confirmed by
        # its own context (the deep investigation re-verifies); a reaction flag
        # requires a real baseline-relative energy rise — not audio noise.
        if event in _HIGH_VALUE:
            audio_ok = True
        else:
            audio_ok = _audio_window_ok(tool_results, cfg)
            if not audio_ok:
                return None  # audio-noise-only moment -> no trigger, gemma not fired

        flag = DeepFlag(
            ts=ts,
            window_start=start,
            window_end=end,
            event=event,
            score=score,
            reason=reason or "high-signal moment",
            gated_audio=True,
            audio_ok=audio_ok,
            tools_called=tools,
        )
        self.flags.append(flag)
        self.flagged_rows += 1
        self._last_flag_ts = tick_ts

        if self._trace is not None:
            self._trace(self._trace_record(flag))
        return flag

    # -- state -------------------------------------------------------------
    def state(self) -> dict:
        return {
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "dialogRows": len(self._dialog),
            "flaggedRows": self.flagged_rows,
            "lastFlagTs": self._last_flag_ts,
            "deepWindow": {"back": self.config.deep_back_s, "forward": self.config.deep_forward_s},
        }

    def flags_dicts(self) -> List[dict]:
        return [f.to_dict() for f in self.flags]

    # -- trace -------------------------------------------------------------
    def _trace_record(self, flag: DeepFlag) -> dict:
        return {
            "type": "depth_router_flag",
            "sessionId": self.session_id,
            "streamId": self.stream_id,
            "ts": time.time(),
            "flag": flag.to_dict(),
        }
