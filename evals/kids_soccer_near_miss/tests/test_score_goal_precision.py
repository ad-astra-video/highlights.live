"""Self-check for the kids_soccer near-miss goal-acceptance scorer.

Runner test only (no ffmpeg, no GPU, no network): it proves the accounting —
precision / recall / FP list / duplicates / self-refuting cards — detects the
post-bounce class the harness was built for. Synthetic acceptance sets mirror
the da2d21a fix (a near-miss card rejected) and the pre-fix behaviour (that
near-miss card accepted, i.e. the reverted guard), so a precision drop between
the two is the harness's own red/green signal.
"""
import importlib
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sgp = importlib.import_module("score_goal_precision")

MANIFEST = {
    "video": {"id": "kids-soccer"},
    "windows": [
        {"id": "ks-goal-054", "t_start": 51, "t_end": 57, "ground_truth": "goal",
         "evidence": "ball_in_net"},
        {"id": "ks-goal-122", "t_start": 119, "t_end": 125, "ground_truth": "goal",
         "evidence": "ball_in_net"},
        {"id": "ks-nogoal-690", "t_start": 688, "t_end": 703, "ground_truth": "no_goal",
         "evidence": "post"},
        {"id": "ks-nogoal-129", "t_start": 126, "t_end": 132, "ground_truth": "no_goal",
         "evidence": "saved"},
    ],
}


def _card(t, reason, span=15.0):
    return {"id": f"h{t}", "eventType": "GOAL", "status": "accepted",
            "start": t - span / 2, "end": t + span / 2,
            "localizedTs": t, "reason": reason}


GOAL_REASON = "The ball clearly enters the net and the keeper is beaten."
NEAR_MISS_REASON = (
    "The ball is clearly seen being struck and moving towards the goal, but it "
    "does not enter the net; it appears to be a shot that is either saved or "
    "misses.; outcome=near_miss is not a scoring highlight"
)


def test_fixed_build_precision_is_one():
    detail = {"highlights": [_card(54, GOAL_REASON), _card(122, GOAL_REASON)]}
    r = sgp.score(MANIFEST, detail)
    assert r["accepted"] == 2
    assert r["ground_truth_goals"] == 2
    assert r["precision"] == 1.0
    assert r["recall"] == 1.0
    assert r["false_positives"] == []
    assert r["self_refuting"] == []


def test_reverted_guard_accepts_near_miss_and_precision_drops():
    """AC-3 shape: the same manifest, pre-fix acceptance set."""
    detail = {"highlights": [
        _card(54, GOAL_REASON),
        _card(122, GOAL_REASON),
        _card(695, NEAR_MISS_REASON),  # post-bounce near-miss accepted pre-fix
    ]}
    r = sgp.score(MANIFEST, detail)
    assert r["accepted"] == 3
    assert r["precision"] == round(2 / 3, 4)
    assert r["recall"] == 1.0
    assert [fp["t"] for fp in r["false_positives"]] == [695.0]
    assert "does not enter the net" in r["false_positives"][0]["reason"]
    assert [s["t"] for s in r["self_refuting"]] == [695.0]


def test_missed_goal_is_a_recall_hit_and_listed():
    detail = {"highlights": [_card(54, GOAL_REASON)]}
    r = sgp.score(MANIFEST, detail)
    assert r["precision"] == 1.0
    assert r["recall"] == 0.5
    assert [fn["id"] for fn in r["false_negatives"]] == ["ks-goal-122"]


def test_duplicate_cards_on_one_goal_are_reported_not_false_positives():
    detail = {"highlights": [_card(54, GOAL_REASON), _card(56, GOAL_REASON)]}
    r = sgp.score(MANIFEST, detail)
    assert r["precision"] == 1.0
    assert r["recall"] == 0.5
    assert r["false_positives"] == []
    assert r["duplicate_cards"] == [{"goal": "ks-goal-054", "cards": [56.0]}]


def test_min_overlap_governs_matching():
    # 0.5 s of overlap: outside the default 1.0 s, inside an explicit 0.4 s
    detail = {"highlights": [{"id": "x", "eventType": "GOAL", "status": "accepted",
                              "start": 124.5, "end": 139.5, "localizedTs": 132.0,
                              "reason": GOAL_REASON}]}
    assert sgp.score(MANIFEST, detail)["precision"] == 0.0
    assert sgp.score(MANIFEST, detail, min_overlap=0.4)["precision"] == 1.0


def test_rejected_and_non_goal_cards_are_not_counted():
    detail = {"highlights": [
        {"id": "r", "eventType": "GOAL", "status": "rejected", "start": 50,
         "end": 65, "localizedTs": 55, "reason": NEAR_MISS_REASON},
    ]}
    r = sgp.score(MANIFEST, detail)
    assert r["accepted"] == 0
    assert r["precision"] is None
    assert r["recall"] == 0.0


def test_cli_fail_under_precision(tmp_path):
    detail = {"highlights": [
        _card(54, GOAL_REASON), _card(695, NEAR_MISS_REASON)]}
    mf = tmp_path / "manifest.json"
    jd = tmp_path / "detail.json"
    mf.write_text(__import__("json").dumps(MANIFEST))
    jd.write_text(__import__("json").dumps(detail))
    assert sgp.main(["--manifest", str(mf), "--job-detail", str(jd),
                     "--fail-under-precision", "0.9"]) == 1
    assert sgp.main(["--manifest", str(mf), "--job-detail", str(jd),
                     "--fail-under-precision", "0.4"]) == 0


# --------------------------------------------------------------------------
# Corpus mode (ADAAAA-7692): pooled aggregate across per-clip manifests.
#
# Synthetic two-clip fixture (tests/fixtures/two_clip_corpus):
#   clip-a  2 accepted cards, both true positives      -> 100 % precision,
#                                                       2/2 goals, 1 hard neg
#   clip-b  8 accepted cards, 4 TP + 4 FP, 1 goal missed -> 50 % precision,
#                                                       4/5 goals, 3 hard negs
# Pooled precision must be 6/10 = 60 %, NOT the 75 % clip-average: the 2-card
# clip must not out-vote the 8-card clip. Pooled recall must be 6/7 = 85.71 %,
# NOT the 90 % clip-average. The corpus hard-negative count is 1 + 3 = 4.
# --------------------------------------------------------------------------
FIXTURES = HERE / "tests" / "fixtures" / "two_clip_corpus"


def _fixture_specs():
    return [
        {"label": "clip-a", "commit": "build-a",
         "manifest": str(FIXTURES / "manifest_a.json"),
         "job_detail": str(FIXTURES / "detail_a.json")},
        {"label": "clip-b", "commit": "build-b",
         "manifest": str(FIXTURES / "manifest_b.json"),
         "job_detail": str(FIXTURES / "detail_b.json")},
    ]


def test_corpus_mode_emits_per_clip_rows_and_one_pooled_row():
    corpus = sgp.score_corpus(_fixture_specs())
    assert corpus["mode"] == "corpus"
    assert [row["label"] for row in corpus["clips"]] == ["clip-a", "clip-b"]
    assert [row["commit"] for row in corpus["clips"]] == ["build-a", "build-b"]
    a, b = corpus["clips"]
    assert (a["accepted"], a["true_positive_cards"], a["precision"]) == (2, 2, 1.0)
    assert (b["accepted"], b["true_positive_cards"], b["precision"]) == (8, 4, 0.5)
    # per-clip recall stays visible next to the pooled figure
    assert a["recall"] == 1.0
    assert b["recall"] == 0.8
    assert corpus["corpus"]["clips"] == 2


def test_corpus_pools_the_weighted_ratio_not_the_clip_average():
    corpus = sgp.score_corpus(_fixture_specs())
    pooled = corpus["corpus"]
    # weighted: 6 TP of 10 accepted cards
    assert (pooled["true_positive_cards"], pooled["false_positive_cards"]) == (6, 4)
    assert pooled["precision"] == round(6 / 10, 4)
    assert pooled["precision"] != round((1.0 + 0.5) / 2, 4)   # not 75 %
    assert pooled["mean_clip_precision_rejected"] == 0.75
    # weighted recall: 6 credited goals of 7 labelled
    assert pooled["precision"] == 0.6
    assert pooled["recall"] == round(6 / 7, 4)
    assert pooled["recall"] != round((1.0 + 0.8) / 2, 4)      # not 90 %
    # a card at 50 % on 8 cards dominates a clip at 100 % on 2 cards
    assert pooled["min_clip_precision"] == 0.5
    assert corpus["pooling_rule"].startswith("precision = sum(TP cards)")


def test_corpus_emits_hard_negative_count_per_clip_and_summed():
    corpus = sgp.score_corpus(_fixture_specs())
    a, b = corpus["clips"]
    assert a["hard_negatives"] == 1
    assert a["hard_negative_window_ids"] == ["ks-a-n-105"]
    assert b["hard_negatives"] == 3
    assert b["hard_negative_window_ids"] == ["ks-b-n-118", "ks-b-n-138", "ks-b-n-158"]
    assert corpus["corpus"]["hard_negatives"] == 4
    # the manifest's own coverage figure agrees with the derived count
    assert a["hard_negatives_declared"] == 1 and a["hard_negatives_declared_matches"]
    assert b["hard_negatives_declared"] == 3 and b["hard_negatives_declared_matches"]
    # evidence:none windows rule out a goal but are not shot-class negatives
    assert "ks-a-n-129" not in a["hard_negative_window_ids"]


def test_corpus_rendered_report_carries_pooled_and_hard_negative_lines():
    text = sgp.render_corpus(sgp.score_corpus(_fixture_specs()))
    assert "POOLED precision      : 60.00%" in text
    assert "POOLED recall         : 85.71%" in text
    assert "corpus hard negatives : 4 verified shot-class non-goal windows" in text
    assert "naive clip-average    : 75.00%" in text
    assert "clip-b" in text and "clip-a" in text


def test_corpus_cli_pairs_write_json_and_gate_on_pooled_figure(tmp_path):
    out = tmp_path / "score_corpus.json"
    pairs = []
    for spec in _fixture_specs():
        pairs += ["--pair", f"{spec['manifest']}:{spec['job_detail']}:{spec['commit']}"]
    assert sgp.main(pairs + ["--json", str(out),
                             "--fail-under-precision", "0.6"]) == 0
    data = __import__("json").loads(out.read_text())
    assert data["corpus"]["precision"] == 0.6
    assert data["corpus"]["hard_negatives"] == 4
    assert len(data["clips"]) == 2
    # the pooled gate is the weighted figure, so 0.7 must fail even though
    # clip-a alone is at 100 %
    assert sgp.main(pairs + ["--fail-under-precision", "0.7"]) == 1


def test_corpus_cli_per_clip_floor_and_corpus_file(tmp_path):
    corpus_file = tmp_path / "corpus.json"
    corpus_file.write_text(__import__("json").dumps({"clips": _fixture_specs()}))
    # pooled 60 % clears 0.6, but clip-b at 50 % fails a 0.9 per-clip floor
    assert sgp.main(["--corpus", str(corpus_file), "--fail-under-precision", "0.6",
                     "--fail-under-clip-precision", "0.9"]) == 1
    assert sgp.main(["--corpus", str(corpus_file), "--fail-under-precision", "0.6",
                     "--fail-under-clip-precision", "0.5"]) == 0


def test_single_clip_output_shape_is_unchanged(tmp_path):
    """The additive corpus work must not touch the single-clip report/JSON."""
    detail = {"highlights": [_card(54, GOAL_REASON), _card(122, GOAL_REASON)]}
    mf = tmp_path / "manifest.json"
    jd = tmp_path / "detail.json"
    out = tmp_path / "score.json"
    mf.write_text(__import__("json").dumps(MANIFEST))
    jd.write_text(__import__("json").dumps(detail))
    assert sgp.main(["--manifest", str(mf), "--job-detail", str(jd),
                     "--commit", "x", "--json", str(out)]) == 0
    data = __import__("json").loads(out.read_text())
    assert sorted(data) == ["accepted", "commit", "duplicate_cards", "false_negatives",
                            "false_positives", "ground_truth_goals", "job_id",
                            "manifest", "precision", "recall", "self_refuting",
                            "true_positive_cards"]
    assert data["precision"] == 1.0 and data["recall"] == 1.0


def test_restated_ac1_precision_block_matches_the_committed_score():
    """AC-1 scope decision (ADAAAA-7703) is a quoted metric, so pin it.

    The restated AC-1 is "precision >= 0.78 at recall 1.0 with every accepted FP
    enumerated and classified". If the committed score moves, the manifest's
    recorded figure has to move with it — otherwise the quoted build metric and
    the measured build silently disagree.
    """
    import json

    manifest = json.loads((HERE / "label-manifest.json").read_text())
    score = json.loads((HERE / "results" / "score_da2d21a.json").read_text())
    ac1 = manifest["coverage"]["ac1_precision"]

    assert ac1["decision_issue"] == "ADAAAA-7703"
    assert ac1["status"] == "met"
    assert "confirm stage is closed" in ac1["restated"]
    measured = ac1["measured"]
    assert measured["build"] == score["commit"]
    assert measured["precision"] == score["precision"]
    assert measured["recall"] == score["recall"]
    assert measured["accepted_cards"] == score["accepted"]
    assert measured["tp_cards"] == score["true_positive_cards"]
    assert measured["false_positive_instants"] == [
        fp["t"] for fp in score["false_positives"]
    ]
    # the withdrawn 0.94 target stays withdrawn: no confirm-stage rule is usable
    assert "usable_rules: []" in ac1["withdrawn"]

