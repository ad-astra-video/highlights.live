"""Unit tests for the ADAAAA-8391 attestation-channel measurement.

Run: python3 -m pytest evals/tests/test_measure_attestation_channel.py -q
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "attestation_channel_8391"))

import measure_attestation_channel as M  # noqa: E402


def _row(cell, rail, window, truth, signals, pre="scoring_play"):
    cls = "goal" if truth == "goal" else truth
    return {
        "cell": cell, "rail": rail, "window": window, "truth": cls,
        "perceive_evidence": "ball_in_net" if truth == "goal" else "none",
        "pre": pre, "post": pre, "guard": None, "guard_code": None,
        "attested": bool(signals), "signals": signals,
        "criteria": {}, "reason": "", "ttft_s": 0, "wall_s": 0, "usage": {},
    }


def test_parse_raw_reply_fenced_with_prose():
    raw = 'here you go\n```json\n{"outcome": "scoring_play", "isHighlight": true}\n```\nthanks'
    assert M.parse_raw_reply(raw) == {"outcome": "scoring_play", "isHighlight": True}


def test_parse_raw_reply_plain_and_garbage():
    assert M.parse_raw_reply('{"outcome": "not_highlight"}')["outcome"] == "not_highlight"
    assert M.parse_raw_reply("no json here") is None
    assert M.parse_raw_reply("") is None


def test_measured_channels_ignores_model_criteria():
    ev = {"detections": [], "verdict": {"criteria": {"ballInNet": True}}}
    assert M.measured_channels(ev) == []
    assert M.measured_channels({"ballOutcome": "goal"}) == ["ballOutcome=goal"]
    assert M.measured_channels({"goalCrossed": True}) == ["goalCrossed=true"]
    assert M.measured_channels({"scoreBoardChanged": True}) == ["scoreBoardChanged=true"]


def test_measured_channels_timeline_records():
    ev = {"perceiveTimeline": [{"ts": 3, "ballOutcome": "goal"},
                               {"ts": 4, "goalCrossed": True},
                               {"ts": 5, "scoreBoardChanged": True}]}
    assert M.measured_channels(ev) == [
        "timeline:ballOutcome=goal", "timeline:goalCrossed=true", "timeline:score_delta"]


def test_channel_table_rates_and_windows():
    rows = [
        # goal window 1 attested on both rails -> counts once at window level
        _row("c1", "live", "g1", "goal", ["scoreBoardChanged=true"]),
        _row("c2", "live", "g1", "goal", ["scoreBoardChanged=true"]),
        _row("c1", "vod", "g1", "goal", ["scoreBoardChanged=true"]),
        # goal window 2 not attested
        _row("c1", "live", "g2", "goal", []),
        _row("c2", "live", "g2", "goal", []),
        # no_goal window 1 attested on live only
        _row("c1", "live", "n1", "shot", ["scoreBoardChanged=true"]),
        _row("c2", "live", "n1", "shot", ["scoreBoardChanged=true"]),
        _row("c1", "vod", "n1", "shot", []),
        # no_goal window 2 clean
        _row("c1", "live", "n2", "no_shot", []),
    ]
    t = M.channel_table(rows, "scoreBoardChanged=true")
    assert t["goal_rows_attested"] == 3 and t["goal_rows"] == 5
    assert t["no_goal_rows_attested"] == 2 and t["no_goal_rows"] == 4
    assert t["goal_windows_attested"] == 1          # g1 once, not per row
    assert t["no_goal_windows_attested"] == 1       # n1 once
    assert t["goal_windows_list"] == ["g1"]
    assert t["no_goal_windows_list"] == ["n1"]
    assert t["goal_windows"] == 2 and t["no_goal_windows"] == 2


def test_recall_if_reject_unattested():
    rows = [
        _row("cell", "live", "g1", "goal", ["scoreBoardChanged=true"]),
        _row("cell", "live", "g2", "goal", []),
        _row("cell", "live", "n1", "shot", []),
    ]
    cells = M.recall_if_reject_unattested(rows)
    c = cells["cell"]
    assert c["goal_rows"] == 2 and c["tp_v1"] == 2 and c["tp_attested"] == 1
    assert c["recall_v1"] == 1.0 and c["recall_attested_rule"] == 0.5
    assert c["loses_goal"] is True


def test_auc_ranks_and_ties():
    assert M.auc([1, 2, 3], [0, 0, 0]) == 1.0
    assert M.auc([0, 0, 0], [1, 2, 3]) == 0.0
    assert M.auc([1, 1], [1, 1]) == 0.5


def test_perwin_contract_matches_8370_shape():
    """The emitted row must keep the ADAAAA-8370 key set so the 8387 re-score runs unchanged."""
    assert M.PERWIN_KEYS == (
        "cell", "rail", "window", "truth", "perceive_evidence", "pre", "post",
        "guard", "guard_code", "attested", "signals", "criteria", "reason",
        "ttft_s", "wall_s", "usage",
    )


def test_ac1_pass_case(tmp_path):
    """8 of 15 goal windows attested, no no_goal window attested -> AC1 met."""
    rows = []
    for i in range(15):
        wid = f"g{i}"
        sig = ["ballOutcome=goal"] if i < 8 else []
        rows.append(_row("c", "live", wid, "goal", sig))
    for i in range(22):
        rows.append(_row("c", "live", f"n{i}", "no_shot", []))
    ch = M.channel_table(rows, "ballOutcome=goal")
    assert ch["goal_windows_attested"] == 8
    assert ch["no_goal_windows_attested"] == 0
    # 0 no_goal attestations -> infinite ratio, not a failed ratio
    assert ch["window_rate_ratio"] is None
    assert ch["window_rate_ratio_infinite"] is True
    assert ch["goal_windows_attested"] >= M.GOAL_WINDOWS_REQUIRED


def test_ac1_fail_case_scores_anti_correlated():
    """More attestations on no_goal than goal -> ratio below 1, AC1 fails."""
    rows = [_row("c", "live", "g1", "goal", [])]
    rows += [_row("c", "live", f"n{i}", "shot", ["scoreBoardChanged=true"]) for i in range(2)]
    ch = M.channel_table(rows, "scoreBoardChanged=true")
    assert ch["goal_windows_attested"] == 0
    assert ch["window_rate_ratio"] is None
    assert not ch["goal_windows_attested"] >= M.GOAL_WINDOWS_REQUIRED


def test_main_end_to_end(tmp_path):
    """A tiny frozen set round-trips: score JSON + perwin rows + fidelity gate."""
    (tmp_path / "ev").mkdir()
    (tmp_path / "ev" / "live").mkdir()
    manifest = {"windows": [
        {"id": "g1", "ground_truth": "goal", "evidence": "ball_in_net"},
        {"id": "n1", "ground_truth": "no_goal", "evidence": "saved"},
    ]}
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    evidence = {
        "g1": {"ballOutcome": "goal", "scoreBoardChanged": True},
        "n1": {"scoreBoardChanged": False},
    }
    for wid, ev in evidence.items():
        (tmp_path / "ev" / "live" / f"{wid}.json").write_text(
            json.dumps({"window": wid, "rail": "live", "evidence": ev}))
    rows = [
        {"cell": "c", "rail": "live", "window": "g1", "raw": '{"outcome":"scoring_play","reason":"net"}',
         "ttft_s": 1, "wall_s": 2, "usage": {}},
        {"cell": "c", "rail": "live", "window": "n1", "raw": '{"outcome":"near_miss","reason":"save"}',
         "ttft_s": 1, "wall_s": 2, "usage": {}},
    ]
    (tmp_path / "rows.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    v1 = [{"cell": "c", "window": "g1", "pre": "scoring_play", "post": "scoring_play"},
          {"cell": "c", "window": "n1", "pre": "near_miss", "post": "near_miss"}]
    (tmp_path / "perwin_v1.jsonl").write_text("\n".join(json.dumps(r) for r in v1))

    rc = M.main([
        "--rows", str(tmp_path / "rows.jsonl"),
        "--manifest", str(tmp_path / "manifest.json"),
        "--evidence-dir", str(tmp_path / "ev"),
        "--perwin-v1", str(tmp_path / "perwin_v1.jsonl"),
        "--out", str(tmp_path / "score.json"),
        "--perwin", str(tmp_path / "perwin.jsonl"),
    ])
    assert rc == 0
    score = json.loads((tmp_path / "score.json").read_text())
    assert score["fidelity"]["matched_v1"] == 2
    assert score["channel_coverage"]["ballOutcome_goal"] == 1
    assert score["ac1_discrimination"]["goal_windows_attested"] == 1
    assert score["ac1_discrimination"]["met"] is False       # only 1 of 15 required
    assert score["ac3_false_positive_floor"]["met"] is True   # 0 no_goal attested
    assert score["verdict"] == "does_not_discriminate"
    pws = [json.loads(l) for l in (tmp_path / "perwin.jsonl").read_text().splitlines()]
    assert len(pws) == 2
    for pw in pws:
        assert tuple(pw) == M.PERWIN_KEYS
    assert pws[0]["attested"] is True and pws[1]["attested"] is False
