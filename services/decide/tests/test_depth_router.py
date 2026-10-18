"""Gates for the decide pass-2 depth router (ADAAAA-6740 G3)."""

from __future__ import annotations

from app.depth_router import DepthRouter, DepthRouterConfig, DeepFlag
from app.watcher import SummaryRow


def _row(ts: float, event: str = "NO_EVENT", score: float = 0.0,
         frame_count: int = 0, is_highlight: bool = False) -> SummaryRow:
    return SummaryRow(
        ts=ts, window_start=max(0.0, ts - 10.0), window_end=ts, frame_count=frame_count,
        event=event, event_class="high" if event in ("GOAL", "KILL") else "ordinary",
        is_highlight=is_highlight, score=score, hypothesis="", text="", tools_called=[],
    )


def _audio_envelope(peak: float, baseline: float) -> dict:
    return {"tool": "get_audio_levels", "window": {"start": 0, "end": 1}, "count": 1,
            "total": 1, "truncated": False,
            "data": [{"ts": 0.0, "peakEnergy": peak, "baselineEnergy": baseline}]}


def _no_audio() -> dict:
    return {"tool": "get_audio_levels", "window": {"start": 0, "end": 1}, "count": 0,
            "total": 0, "truncated": False, "data": []}


CFG = DepthRouterConfig()


# --- Gate: the depth router is the sole trigger authority (feeds on dialog) ---
def test_depth_router_flags_a_high_value_moment():
    r = DepthRouter(config=CFG, perceive=lambda *a, **k: _audio_envelope(0.95, 0.1))
    r.observe(_row(ts=50.0, event="GOAL", score=70, frame_count=30))
    flag = r.step(50.0)
    assert flag is not None
    assert flag.event == "GOAL"
    # deep window: 3 s forward / 12 s back
    assert abs(flag.window_end - (50.0 + CFG.deep_forward_s)) < 1e-6
    assert abs(flag.window_start - (50.0 - CFG.deep_back_s)) < 1e-6
    assert r.flagged_rows == 1


# --- Gate: quiet / low-signal moment is never flagged ----------------------
def test_depth_router_does_not_flag_quiet_or_low_signal():
    r = DepthRouter(config=CFG)
    r.observe(_row(ts=10.0, event="NO_EVENT", score=0.0))
    r.observe(_row(ts=13.0, event="NO_EVENT", score=20.0))
    assert r.step(13.0) is None
    assert r.flagged_rows == 0


# --- Gate: audio-noise-only moment (no corroboration) is not flagged -------
def test_depth_router_gates_out_audio_noise_only():
    def no_visual_perceive(tool, start, end, max_points):
        # audio peak high but flat / no baseline rise AND no visual corroboration
        return _audio_envelope(0.9, 0.85)  # rise 0.05 < audio_rise_min 0.15
    r = DepthRouter(config=CFG, perceive=no_visual_perceive)
    # REACTION row (audio burst) but the audio is flat noise -> gated out
    r.observe(_row(ts=20.0, event="REACTION", score=45, frame_count=5))
    flag = r.step(20.0)
    assert flag is None
    assert r.flagged_rows == 0


# --- Gate: true reaction (audio rise) with corroboration is flagged --------
def test_depth_router_flags_corroborated_reaction():
    def perceive(tool, start, end, max_points):
        return _audio_envelope(0.95, 0.1)  # rise 0.85 >= min -> genuine response
    r = DepthRouter(config=CFG, perceive=perceive)
    r.observe(_row(ts=30.0, event="REACTION", score=50, frame_count=10))
    flag = r.step(30.0)
    assert flag is not None
    assert flag.event == "REACTION"
    assert flag.audio_ok is True


# --- Gate: flag rate bounded (cooldown -> <=5 flags/min target) ------------
def test_depth_router_bounds_flag_rate_with_cooldown():
    r = DepthRouter(config=CFG)
    # 20 ticks of GOAL at 3 s spacing = 60 s; cooldown_s=12 -> at most 5 flags
    flags = []
    t = 10.0
    while t <= 60.0 + 1e-6:
        r.observe(_row(ts=t, event="GOAL", score=70, frame_count=30))
        f = r.step(t)
        if f is not None:
            flags.append(f)
        t = round(t + 3.0, 3)
    assert len(flags) <= 5
    assert len(flags) >= 1  # at least the first moments flagged
    assert r.flagged_rows == len(flags)


# --- Gate: deep window is 3s-forward / 12s-back ----------------------------
def test_deep_window_shape_is_3s_forward_12s_back():
    r = DepthRouter(config=CFG, perceive=lambda *a, **k: _audio_envelope(0.95, 0.1))
    r.observe(_row(ts=45.0, event="GOAL", score=70, frame_count=20))
    flag = r.step(45.0)
    assert flag is not None
    assert round(flag.window_end - flag.ts, 6) == CFG.deep_forward_s
    assert round(flag.ts - flag.window_start, 6) == CFG.deep_back_s


# --- Gate: tool calls are decided by decide (only audio queried on hint) ---
def test_depth_router_only_decide_queries_tools_on_a_hint():
    called = []
    def perceive(tool, start, end, max_points):
        called.append(tool)
        return _audio_envelope(0.95, 0.1)
    r = DepthRouter(config=CFG, perceive=perceive)
    # no hint -> no tool query (keeps tool-call / deep cost low)
    r.observe(_row(ts=5.0, event="NO_EVENT", score=0.0))
    r.step(5.0)
    assert called == []
    # hint -> only the audio tool is queried for the noise gate
    r.observe(_row(ts=50.0, event="GOAL", score=70, frame_count=10))
    f = r.step(50.0)
    assert f is not None
    assert called == ["get_audio_levels"]


# --- flag -> dict roundtrip ------------------------------------------------
def test_deep_flag_to_dict_roundtrips():
    r = DepthRouter(config=CFG, perceive=lambda *a, **k: _audio_envelope(0.95, 0.1))
    r.observe(_row(ts=40.0, event="GOAL", score=70, frame_count=30))
    f = r.step(40.0)
    assert f is not None
    d = f.to_dict()
    assert d["event"] == "GOAL"
    assert set(d) >= {"ts", "window", "event", "score", "reason", "gatedAudio", "audioOk", "toolsCalled"}
    assert d["gatedAudio"] is True
