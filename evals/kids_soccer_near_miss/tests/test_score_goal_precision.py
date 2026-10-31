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
