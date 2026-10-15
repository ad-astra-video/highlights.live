"""Gates for the decide pass-2 deep investigation (ADAAAA-6740 G3)."""

from __future__ import annotations

from app.deep_investigation import DeepInvestigator, DeepInvestigationConfig, DeepVerdict
from app.depth_router import DeepFlag
from app.watcher import Frame


def _flag(ts: float, event: str = "GOAL") -> DeepFlag:
    return DeepFlag(ts=ts, window_start=max(0.0, ts - 12.0), window_end=ts + 3.0,
                    event=event, score=80.0, reason="high-value event")


def _frames(start: float, end: float, event_ts: float | None = None) -> list[Frame]:
    out = []
    t = start
    while t < end - 1e-6:
        in_event = event_ts is not None and abs(t - event_ts) <= 1.5
        players = [{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}] if in_event else []
        caption = "GOAL! crowd erupts" if in_event else ""
        out.append(Frame(ts=round(t, 3), seq=int(t * 3), players=players, objects=[],
                         caption=caption, audio_peak=0.95 if in_event else 0.1, audio_baseline=0.05))
        t = round(t + 1.0 / 3.0, 3)
    return out


def _audio(peak: float, baseline: float) -> dict:
    return {"tool": "get_audio_levels", "data": [{"ts": 0.0, "peakEnergy": peak, "baselineEnergy": baseline}]}


CFG = DeepInvestigationConfig()


def _no_perceive(tool, start, end, max_points):
    # no evidence (no audio, no data) so any non-high-value gets gated
    return {"tool": tool, "data": []}


# --- Gate: deep verdict truth for a confirmed highlight (single accept gate) --
def test_deep_confirms_a_true_highlight_through_single_accept_gate():
    def perceive(tool, start, end, max_points):
        if tool == "get_audio_levels":
            return _audio(0.95, 0.1)
        return {"tool": tool, "data": []}
    d = DeepInvestigator(config=CFG, perceive=perceive)
    v = d.investigate(_flag(ts=50.0, event="GOAL"), lambda s, e: _frames(s, e, event_ts=50.0))
    assert v.is_highlight is True
    assert v.outcome == "scoring_play"
    assert v.discarded is False
    assert v.event == "GOAL"
    assert d.confirmed == 1
    assert d.deep_calls == 1


# --- Gate: non-highlight discard -> no clip ----------------------------------
def test_deep_gates_out_audio_noise_only_and_discards_no_clip():
    d = DeepInvestigator(config=CFG, perceive=_no_perceive)
    # a REACTION flag with no audio signal, no visual corroboration -> gated
    v = d.investigate(_flag(ts=20.0, event="REACTION"), lambda s, e: [])
    assert v.discarded is True
    assert v.gated is True
    assert v.is_highlight is False
    assert d.gated_discards == 1
    assert d.deep_calls == 0  # gemma NOT fired for nothing


# --- Gate: a refuted (non-highlight) deep brain -> discard, no clip ---------
def test_deep_discards_a_low_value_moment_no_clip():
    def perceive(tool, start, end, max_points):
        return {"tool": tool, "data": []}
    # A "REACTION" flag whose deep window has no event noise (quiet frames).
    # Because the flag is REACTION (not high-value), the gate requires audio OR
    # visual corroboration; provide audio rise so the brain runs, but the brain
    # sees NO_EVENT -> not_highlight -> discard.
    def p_audio(tool, start, end, max_points):
        if tool == "get_audio_levels":
            return _audio(0.9, 0.1)
        return {"tool": tool, "data": []}
    d = DeepInvestigator(config=CFG, perceive=p_audio)
    frames = [Frame(ts=round(0 + i / 3.0, 3), seq=i, audio_peak=0.2, audio_baseline=0.05) for i in range(40)]
    v = d.investigate(_flag(ts=20.0, event="REACTION"), lambda s, e: frames)
    assert v.discarded is True
    assert v.is_highlight is False
    assert v.event in ("NO_EVENT", "REACTION")
    assert v.outcome == "not_highlight"


# --- Gate: deep window is 3s-forward / 12s-back ------------------------------
def test_deep_window_shape_3s_forward_12s_back():
    d = DeepInvestigator(config=CFG, perceive=_no_perceive)
    v = d.investigate(_flag(ts=30.0, event="GOAL"), lambda s, e: _frames(s, e, event_ts=30.0))
    assert abs(v.window_end - (30.0 + CFG.deep_forward_s)) < 1e-6
    assert abs(v.window_start - (30.0 - CFG.deep_back_s)) < 1e-6


# --- Gate: deep verdict traces to the analysis-session trace ---------------
def test_deep_verdict_and_tool_calls_are_traced():
    traces = []
    def perceive(tool, start, end, max_points):
        if tool == "get_audio_levels":
            return _audio(0.95, 0.1)
        return {"tool": tool, "data": []}
    d = DeepInvestigator(config=CFG, perceive=perceive, trace=traces.append)
    d.investigate(_flag(ts=40.0, event="GOAL"), lambda s, e: _frames(s, e, event_ts=40.0))
    types = [t["type"] for t in traces]
    assert "deep_verdict" in types
    assert types.count("deep_tool_call") == 4
    assert all(t["resultOk"] is True for t in traces if t["type"] == "deep_tool_call")


# --- verdict -> dict roundtrip ---------------------------------------------
def test_deep_verdict_to_dict_roundtrips():
    d = DeepInvestigator(config=CFG, perceive=_no_perceive)
    v = d.investigate(_flag(ts=20.0, event="REACTION"), lambda s, e: [])
    dd = v.to_dict()
    assert dd["discarded"] is True
    assert set(dd) >= {"flagTs", "window", "event", "outcome", "isHighlight",
                       "score", "reason", "discarded", "gated", "gateReason", "toolsCalled", "source"}
