"""AC-3 guard A/B: pin the class the stage1_contradicts guard catches.

The two job details are large and not committed, so the decisive facts are
recorded in ``results/ac3_guard_ab.json`` (produced by ``guard_ab.py``) and the
rule itself is pinned here with synthetic cards.
"""
import json
import os
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from guard_ab import (accepted_cards, anchored, confirm_disagreement,  # noqa: E402
                      guard_bites, ab)

RESULT = os.path.join(str(HERE), "results", "ac3_guard_ab.json")


def card(**kw):
    t = kw.pop("t", 100.0)
    base = {"localizedTs": t, "status": "accepted",
            "trigger": {"timestamp": t},
            "corroborationSource": "scoreboard", "stage1Disagreed": False,
            "corroborated": True, "goalConfirmed": "confirmed_goal"}
    base.update(kw)
    return base


def test_window_scoreboard_delta_on_contradicted_read_is_the_bite_class():
    # the t=688.6 / t=690 shape: own read says near_miss, only corroboration is
    # a window-level scoreboard delta => the guard rejects it.
    assert guard_bites(card(stage1Disagreed=True, corroborationSource="scoreboard"))


def test_instant_anchored_evidence_survives_the_guard():
    assert not guard_bites(card(stage1Disagreed=True,
                                corroborationSource="frame_attestation"))
    assert not guard_bites(card(stage1Disagreed=True, corroborationSource="audio"))
    assert anchored(card(corroborationSource="frame_attestation"))


def test_agreeing_window_keeps_scoreboard_credit():
    # the guard is a contradiction gate, not a scoreboard ban.
    assert not guard_bites(card(stage1Disagreed=False,
                                corroborationSource="scoreboard"))
    assert not guard_bites(card(stage1Disagreed=None))


def test_rejected_and_unaccepted_cards_are_ignored():
    detail = {"highlights": [card(status="rejected"), card(status="accepted")]}
    got = accepted_cards(detail)
    assert [c["t"] for c in got] == [100.0]


def test_confirm_disagreement_rate():
    d = {"job": {"confirmMetrics": {"totalRuns": 200, "disagreed": 20}}}
    got = confirm_disagreement(d)
    assert got["confirm_runs"] == 200
    assert got["disagree_rate"] == 0.1
    assert confirm_disagreement({})["disagree_rate"] is None


def test_ab_splits_the_accepted_sets(tmp_path):
    g = {"job": {"id": "g"}, "highlights": [card(t=1.0), card(t=2.0)]}
    r = {"job": {"id": "r"}, "highlights": [card(t=1.0),
                                            card(t=9.0, stage1Disagreed=True)]}
    gp = tmp_path / "guarded.json"
    rp = tmp_path / "reverted.json"
    gp.write_text(json.dumps(g))
    rp.write_text(json.dumps(r))
    rep = ab(str(gp), str(rp))
    assert rep["only_guarded"] == [2.0]
    assert rep["only_reverted"] == [9.0]
    assert rep["checks"]["guarded_has_no_bite_card"] is True
    assert rep["checks"]["reverted_has_bite_card"] is True


@pytest.mark.skipif(not os.path.exists(RESULT), reason="run guard_ab.py first")
def test_recorded_ab_keeps_the_guarded_build_clean():
    with open(RESULT) as fh:
        rep = json.load(fh)
    assert rep["checks"]["guarded_has_no_bite_card"] is True
    assert rep["checks"]["reverted_has_bite_card"] is True
    assert rep["reverted"]["guard_bite_cards"][0]["t"] == 690.0
    assert rep["guarded"]["accepted"] == 23
    assert rep["reverted"]["accepted"] == 21
    assert rep["only_guarded"] == [171, 624]
    assert rep["only_reverted"] == []
