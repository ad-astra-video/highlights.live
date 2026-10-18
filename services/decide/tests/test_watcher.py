"""Gates for the decide watcher (ADAAAA-6738 G1c)."""

from __future__ import annotations

from app.watcher import (
    Frame,
    SummaryRow,
    WatcherConfig,
    WatcherSession,
    default_brain,
)

CFG = WatcherConfig(tick_s=3.0, window_s=10.0, fps=3.0, max_frame_count=30, min_overlap=0.50)


def _frames_through(end_ts: float, fps: float = 3.0, caption_at: float | None = None,
                    player_at: float | None = None) -> list[Frame]:
    """Frames at ``fps`` from t=0 to ``end_ts`` inclusive. A caption / tracked
    player signal is placed on the frame whose ts is nearest to ``caption_at`` /
    ``player_at`` (within half a frame spacing)."""
    out = []
    t = 0.0
    i = 0
    spacing = 1.0 / fps
    while t <= end_ts + 1e-6:
        caption = "GOAL! crowd erupts" if caption_at is not None and abs(t - caption_at) <= spacing / 2 else ""
        players = [{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}] if player_at is not None and abs(t - player_at) <= spacing / 2 else []
        if caption or players:
            out.append(Frame(ts=round(t, 3), seq=i, players=players, objects=[], caption=caption, audio_peak=0.0))
        else:
            out.append(Frame(ts=round(t, 3), seq=i, players=[], objects=[], caption="", audio_peak=0.0))
        i += 1
        t = round(t + spacing, 3)
    return out


def _drive(session: WatcherSession, total_ts: float, tick_s: float = 3.0):
    """Ingest all frames through ``total_ts`` once, then step each tick. The
    window filter is time-based, so pre-ingesting future frames is safe."""
    session.ingest_many(_frames_through(total_ts))
    rows = []
    tick = tick_s
    while tick <= total_ts + 1e-6:
        rows.append(session.step(tick))
        tick = round(tick + tick_s, 3)
    return rows


# --- Gate: frame chunk <= 30 frames / 10 s / 3 fps ------------------------
def test_chunk_is_capped_to_30_frames_at_3fps_over_10s():
    s = WatcherSession(config=CFG)
    s.ingest_many(_frames_through(30.0))  # dense stream: 90+ frames in window
    row = s.step(30.0)
    win = row.window_end - row.window_start
    assert abs(win - 10.0) < 1e-6
    assert row.frame_count <= CFG.max_frame_count  # <= 30
    assert CFG.max_frame_count == 30
    assert CFG.max_frame_count >= int(10.0 * 3.0)  # 3 fps over 10 s


# --- Gate: >= 50 % overlap between ticks ----------------------------------
def test_overlap_between_ticks_is_at_least_50pct():
    s = WatcherSession(config=CFG)
    s.ingest_many(_frames_through(13.0))
    s.step(10.0)
    row = s.step(13.0)
    # 10 s window every 3 s => 7 s overlap => 70 %
    assert row.overlap_fraction >= 0.50
    assert abs(row.overlap_fraction - 0.70) < 1e-6


# --- Gate: timestamped summary row appended every <= 3 s ------------------
def test_summary_row_appended_every_tick_and_never_gt_3s_gap():
    s = WatcherSession(config=CFG)
    rows = _drive(s, total_ts=30.0)
    assert len(rows) == 10  # 3, 6, ..., 30
    gaps = [rows[i].ts - rows[i - 1].ts for i in range(1, len(rows))]
    assert all(g <= 3.0 + 1e-6 for g in gaps)
    assert all(abs(g - 3.0) < 1e-6 for g in gaps)


# --- Gate: summary list carries last-30 s context (>= 10 rows) ------------
def test_summary_list_carries_last_30s_context_at_least_10_rows():
    s = WatcherSession(config=CFG)
    _drive(s, total_ts=60.0)  # 20 ticks -> trimmed to summary window
    ctx = s.summaries_context()
    assert len(ctx) >= 10
    last_ts = ctx[-1].ts
    cutoff = last_ts - CFG.summary_window_s
    assert all(r.ts >= cutoff - 1e-6 for r in ctx)  # last-30 s
    assert len(ctx) <= CFG.summary_max_rows


# --- Gate: event -> first summary naming it <= 5 s latency ----------------
def test_event_to_first_summary_latency_within_5s():
    s = WatcherSession(config=CFG)
    event_ts = 14.667  # a valid 3 fps frame instant
    s.ingest_many(_frames_through(30.0, caption_at=event_ts))
    first_naming = None
    for row in _drive(s, total_ts=30.0):
        if "GOAL" in row.event:
            first_naming = row
            break
    assert first_naming is not None
    lat = first_naming.ts - event_ts
    assert lat <= 5.0
    assert lat >= 0.0


# --- Gate: decide owns tool calls + only decide seeds a hypothesis --------
def test_watcher_decides_tools_and_only_decide_seeds_hypothesis():
    called = []
    results = {}

    def fake_perceive(tool, start, end, max_points):
        called.append(tool)
        res = {"tool": tool, "window": {"start": start, "end": end}, "count": 0, "total": 0, "truncated": False, "data": []}
        if tool == "get_audio_levels":
            res["data"] = [{"ts": start, "peakEnergy": 0.95, "baselineEnergy": 0.1}]
        if tool == "get_tracked_players":
            res["data"] = [{"ts": start, "seq": 0, "players": [{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}], "count": 1}]
        results[tool] = res
        return res

    traces = []
    s = WatcherSession(config=CFG, perceive=fake_perceive, trace=lambda rec: traces.append(rec))
    # audio burst + a tracked player => corroborated, so decide types REACTION.
    s.ingest_many(_frames_through(10.0, caption_at=None, player_at=5.0))
    row = s.step(10.0)
    assert row.tools_called == ["get_audio_levels", "get_tracked_players", "detect_objects", "get_captioning"]
    assert set(called) == set(row.tools_called)
    # audio peak 0.95 with no track/object -> REACTION hypothesis seeded by decide
    assert row.event == "REACTION"
    assert s.hypotheses_seeded == 1
    # every tool call was traced to the (fake) server sink
    assert len(traces) == len(row.tools_called)
    assert all(t["type"] == "watcher_tool_call" and t["resultOk"] for t in traces)


# --- Gate: event typing only in decide (rule brain); no tool-only event ----
def test_quiet_window_emits_no_event_hypothesis():
    s = WatcherSession(config=CFG)
    s.ingest_many(_frames_through(10.0))  # no caption, no audio
    row = s.step(10.0)
    assert row.event == "NO_EVENT"
    assert row.is_highlight is False
    assert s.hypotheses_seeded == 0


# --- trace record shape ----------------------------------------------------
def test_trace_record_shape_roundtrips_through_to_dict():
    s = WatcherSession(config=CFG, perceive=lambda *a, **k: {"tool": a[0], "data": []})
    traces = []
    s._trace = traces.append  # noqa: SLF001
    s.ingest_many(_frames_through(6.0))
    s.step(6.0)
    rec = traces[0]
    assert rec["type"] == "watcher_tool_call"
    assert rec["tool"] in ("get_audio_levels", "get_tracked_players", "detect_objects", "get_captioning")
    assert isinstance(rec["resultOk"], bool)
