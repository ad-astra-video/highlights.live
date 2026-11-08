"""ADAAAA-8120 — deterministic scoring_play contract guard (ADAAAA-8101 AC-E3).

The v3 decide-emphasis A/B (ADAAAA-8103) proved that a warm-up / commentary-lull
window whose frames read `not_highlight` on their own, but whose commentary text
is replaced by a goal shout, is accepted as `scoring_play` by 8 of 8 calls at
both prompt versions and both output contracts, with `contradictedBy: null`.
More emphasis text is not the fix; a deterministic check on the accept path is.

These tests pin:

* the MEASURED attestation the guard computes from evidence the model already
  receives (perceive timeline / geometry / scoreboard), never from the model's
  self-reported verdict;
* the AC-G1 scenario itself (the recorded 8103 soc-warm-01 / soc-lull-01 goal-
  text-injected replies + their exact evidence) now returning isHighlight=false
  with a machine-readable contradictedBy;
* that a genuinely attested goal accept is untouched (no recall regression);
* that `isHighlight=false` reads are never touched, and (ADAAAA-8370, v2) that an
  ACCEPT no measured channel attests is REJECTED and downgraded to
  `not_highlight` — including when the goal-line claim lives only in the model's
  structured criteria;
* the integration: `/highlight` carries the guard outcome on the decision and on
  the audit descriptor's `timings.contractGuard` (AC-G5 — re-gradable from a
  stored decide_audit row without a replay).
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from fastapi.testclient import TestClient

from app import app as decide_app
from app.gemma import (
    apply_contract_guard,
    decide_with_gemma,
    goal_text_claim,
    measured_goal_attestation,
)

client = TestClient(decide_app)

# --- the AC-G1 fixture, exactly as ADAAAA-8103 built it ----------------------
# Both clips carried the SAME measured audio curve and the SAME injected
# commentary text; only the frames differed (and they read not_highlight alone).
GOAL_SHOUT = "IT'S IN! What a finish! 2-1 to the away side!"
WARM_LEVELS = [
    0.63, 0.59, 0.59, 0.6, 0.61, 0.58, 0.73, 0.79, 0.81, 0.81, 0.86, 0.84, 0.9,
    0.97, 0.95, 0.96, 0.86, 0.86, 0.83, 0.8, 0.82, 0.78, 0.74, 0.68, 0.65, 0.64,
    0.65, 0.61, 0.59, 0.58, 0.57, 0.54, 0.56, 0.56, 0.57, 0.52, 0.54, 0.56, 0.54,
    0.54, 0.56, 0.54, 0.55, 0.59, 0.54, 0.52, 0.54, 0.54, 0.53, 0.47, 0.49, 0.49,
    0.51, 0.47, 0.49, 0.49, 0.49, 0.46, 0.47, 0.45, 0.45, 0.46, 0.48, 0.44,
]
LULL_LEVELS = [
    0.74, 0.57, 0.43, 0.48, 0.46, 0.54, 0.49, 0.51, 0.48, 0.48, 0.5, 0.79, 0.93,
    0.92, 0.91, 0.92, 0.93, 0.87, 0.93, 1.0, 0.91, 0.91, 0.9, 0.87, 0.95, 0.9,
    0.92, 0.88, 0.81, 0.86, 0.85, 0.78, 0.71, 0.75, 0.76, 0.7, 0.68, 0.67, 0.64,
    0.57, 0.67, 0.58, 0.59, 0.55, 0.53, 0.53, 0.49, 0.68, 0.7, 0.63, 0.73, 0.79,
    0.64, 0.41, 0.6, 0.69, 0.66, 0.71, 0.69, 0.59, 0.35, 0.49, 0.72, 0.63,
]

WARM_COMPACT_REPLY = json.dumps(
    {
        "isHighlight": True,
        "score": 95,
        "eventType": "GOAL",
        "outcome": "scoring_play",
        "reason": "ASR confirms 'IT'S IN!' at peak audio (0.97) while frames show ball in net.",
        "reasoning": "The commentary shout and audio peak are read as a goal; the frames are taken to confirm the ball in the net.",
        "verdict": {
            "hypothesis": "GOAL",
            "independentlyObserved": "ASR confirms goal with 'IT'S IN!' and audio peaks at 0.97",
            "criteria": {
                "ballCrossedLineBetweenPosts": True,
                "ballInNet": True,
                "scoreboardChanged": False,
                "crowdErupted": True,
            },
            "contradictedBy": None,
        },
        "runningSummary": "GOAL 0s — the away side double their lead.",
    }
)

LULL_FULL_REPLY = json.dumps(
    {
        "isHighlight": True,
        "score": 95,
        "eventType": "GOAL",
        "outcome": "scoring_play",
        "reason": (
            "The ASR commentary explicitly states 'IT'S IN! What a finish!' and the audio "
            "energy curve peaks at 1.00, while the frames show the ball in the vicinity of "
            "the goal and players reacting to a scoring event."
        ),
        "reasoning": "The commentary confirms a goal and the audio peaks; the frames show players reacting.",
        "verdict": {
            "hypothesis": "GOAL",
            "independentlyObserved": "The ASR commentary confirms a goal ('IT'S IN!') and the audio energy curve peaks.",
            "criteria": {
                "ballCrossedLineBetweenPosts": None,
                "ballInNet": None,
                "scoreboardChanged": False,
                "crowdErupted": True,
            },
            "contradictedBy": None,
        },
        "evidenceAttested": [
            "ASR: 'IT'S IN! What a finish! 2-1 to the away side!'",
            "Audio energy peak at 1.00",
            "Frame 3 shows a player striking the ball towards the goal",
        ],
        "runningSummary": "GOAL 0s — the away side make it 2-1.",
    }
)


def _g1_evidence(levels: list[float]) -> dict:
    """The AC-G1 window's evidence: no measured goal channel at all — no
    ballOutcome / goalCrossed / score change / detectons / perceive timeline —
    only the measured audio curve the model may cite."""
    return {
        "trackCount": 0,
        "maxVelocity": 0.0,
        "ocrHits": 0,
        "scoreBoardChanged": False,
        "audioLevels": levels,
    }


def _parsed(reply: str) -> dict:
    from app.gemma import parse_decision

    d = parse_decision(reply)
    assert d is not None
    return d


# --- measured attestation ---------------------------------------------------

def test_measured_attestation_absent_on_the_g1_window():
    att = measured_goal_attestation(_g1_evidence(WARM_LEVELS))
    assert att["attested"] is False
    assert att["signals"] == []
    # the audit trail names every measured channel the window did NOT carry
    assert "ballOutcome" in att["missing"]
    assert "scoreBoardChanged" in att["missing"]
    assert "perceiveTimeline" in att["missing"]
    # the audio curve is recorded but is NEVER goal attestation
    assert att["audioSamples"] == 64
    assert att["audioPeak"] == 0.97
    assert att["attested"] is False


def test_measured_attestation_reads_every_measured_channel():
    cases = [
        ({"ballOutcome": "goal"}, "ballOutcome=goal"),
        ({"goalCrossed": True}, "goalCrossed=true"),
        ({"scoreBoardChanged": True}, "scoreBoardChanged=true"),
        ({"goalLineDelta": 0.12}, "goalLineDelta=0.12>=0"),
        (
            {"perceiveTimeline": [{"ts": 1.0, "ballInNet": True}]},
            "timeline:ballInNet=true",
        ),
        (
            {"perceiveTimeline": [{"ts": 1.0, "ballOutcome": "goal"}]},
            "timeline:ballOutcome=goal",
        ),
        (
            {"perceiveTimeline": [{"ts": 1.0, "scoreBoardChanged": True}]},
            "timeline:score_delta",
        ),
    ]
    for evidence, signal in cases:
        att = measured_goal_attestation(evidence)
        assert att["attested"] is True, evidence
        assert signal in att["signals"], evidence


def test_model_self_report_is_never_attestation():
    # The confabulation class: the model's own criteria say ballInNet=true and
    # the crowd erupted, but no measured channel attests the goal.
    d = _parsed(WARM_COMPACT_REPLY)
    att = measured_goal_attestation(_g1_evidence(WARM_LEVELS))
    assert att["attested"] is False
    assert d["verdict"]["criteria"]["ballInNet"] is True  # self-report only


# --- the AC-G1 regression: the recorded 8103 replies are now rejected -------

def test_contract_guard_rejects_g1_warm_compact_accept():
    d = _parsed(WARM_COMPACT_REPLY)
    assert d["isHighlight"] is True  # what the shipped prompt version returned

    d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "GOAL", transcript=GOAL_SHOUT)

    assert d["isHighlight"] is False
    assert rec["outcome"] == "rejected"
    assert rec["contradictedBy"] == "goal_text_without_measurement"
    assert d["contradictedBy"].startswith("goal_text_without_measurement:")
    # machine-readable facts behind the rejection
    assert rec["claim"]["transcript_goal_shout"] is True
    assert rec["claim"]["score_line_claim"] is True  # "2-1 to the away side"
    assert rec["attestation"]["attested"] is False
    assert rec["refutingEvidence"]
    assert "ballOutcome" in d["contradictedBy"]
    # ADAAAA-8370: the emitted taxonomy member is DOWNGRADED (the accept is not a
    # scoring_play any more); the model's own read survives on the audit record.
    assert d["outcome"] == "not_highlight"
    assert rec["modelOutcome"] == "scoring_play"
    assert d["eventType"] == "GOAL"
    assert d["score"] <= 55.0
    assert "rejected by contract guard" in d["reason"]


def test_contract_guard_rejects_g1_lull_full_accept():
    d = _parsed(LULL_FULL_REPLY)
    assert d["isHighlight"] is True

    d, rec = apply_contract_guard(d, _g1_evidence(LULL_LEVELS), "GOAL", transcript=GOAL_SHOUT)

    assert d["isHighlight"] is False
    assert rec["contradictedBy"] == "goal_text_without_measurement"
    assert rec["claim"]["reason_cites_commentary"] is True
    assert d["contradictedBy"]
    assert d["contractGuard"]["outcome"] == "rejected"


def test_contract_guard_records_the_full_record_for_regrade():
    d = _parsed(WARM_COMPACT_REPLY)
    d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "GOAL", transcript=GOAL_SHOUT)
    assert d["contractGuard"] is rec
    assert rec["version"] == "2"
    assert set(rec) >= {
        "version", "outcome", "contradictedBy", "claim", "attestation",
        "refutingEvidence", "detail", "downgradeTo", "modelOutcome",
    }
    assert rec["attestation"]["audioPeak"] == 0.97
    # JSON-serialisable: it is merged into decide_audit.timings verbatim
    assert json.loads(json.dumps(rec))["outcome"] == "rejected"


# --- no recall regression: every measured attestation keeps the accept ------

def test_attested_goal_accept_is_never_touched():
    for evidence in (
        {"ballOutcome": "goal"},
        {"goalCrossed": True},
        {"scoreBoardChanged": True},
        {"perceiveTimeline": [{"ts": 1.0, "ballOutcome": "goal"}]},
        {"goalLineDelta": 0.2, "audioLevels": [0.1, 0.2]},
    ):
        d = _parsed(WARM_COMPACT_REPLY)
        d.pop("contractGuard", None)
        before = dict(d)
        d, rec = apply_contract_guard(d, evidence, "GOAL", transcript=GOAL_SHOUT)
        assert rec["outcome"] == "attested", evidence
        assert d["isHighlight"] is True, evidence
        assert d["score"] == before["score"], evidence
        assert "contradictedBy" not in d, evidence


def test_non_goal_accept_is_out_of_scope():
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 70,
                "eventType": "DUNK",
                "outcome": "scoring_play",
                "reason": "commentator shouts 'he scores!' as he slams it home",
            }
        )
    )
    before = dict(d)
    d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "DUNK", transcript="he scores!")
    assert rec["outcome"] == "not_a_goal_accept"
    assert d["isHighlight"] is True
    assert d["score"] == before["score"]


def test_goal_claim_on_a_non_goal_trigger_label_is_in_scope():
    # ADAAAA-8120 served run: the live rail's candidate label is a trigger
    # (AUDIO_BURST), so the model copies it into `eventType`. A scoring_play
    # accept whose own reason claims the ball is in the net is a goal claim
    # whatever the trigger label was, and must be guarded too.
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 95,
                "eventType": "AUDIO_BURST",
                "outcome": "scoring_play",
                "reason": "ASR confirms 'IT'S IN!' at peak audio (0.97) while frames show ball in net.",
                "verdict": {
                    "hypothesis": "AUDIO_BURST",
                    "independentlyObserved": "ASR goal shout, audio peak",
                    "criteria": {
                        "ballCrossedLineBetweenPosts": True,
                        "ballInNet": True,
                        "scoreboardChanged": False,
                        "crowdErupted": True,
                    },
                },
            }
        )
    )
    d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "AUDIO_BURST", transcript=GOAL_SHOUT)
    assert rec["outcome"] == "rejected"
    assert rec["contradictedBy"] == "goal_text_without_measurement"
    assert d["isHighlight"] is False
    assert rec["claim"]["goal_specific_claim"] is True


# --- null preserved / absent-but-plausible is inert ------------------------

def test_reject_reads_are_never_touched():
    for read in (False, None):
        d = {
            "isHighlight": read,
            "score": 20,
            "eventType": "GOAL",
            "outcome": "not_highlight",
            "reason": "no goal",
        }
        d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "GOAL", transcript=GOAL_SHOUT)
        assert rec["outcome"] == "not_an_accept"
        assert d["isHighlight"] is read
        assert "contradictedBy" not in d


def test_unattested_accept_with_no_refutation_is_rejected(monkeypatch):
    # ADAAAA-8370 (v2 contract): absent-but-plausible evidence used to leave the
    # accept untouched (`unverifiable_evidence`, inert). It is now a REJECTION
    # with its own refutation code — the ADAAAA-8343 eval measured this exact
    # shape as 13 of the 30 false accepts.
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 80,
                "eventType": "GOAL",
                "outcome": "scoring_play",
                "reason": "striker slots it low into the far corner past the keeper",
                "verdict": {
                    "hypothesis": "GOAL",
                    "independentlyObserved": "striker striking from the edge of the box",
                    "criteria": {
                        "ballCrossedLineBetweenPosts": None,
                        "ballInNet": None,
                        "scoreboardChanged": None,
                        "crowdErupted": None,
                    },
                },
            }
        )
    )
    d, rec = apply_contract_guard(d, {}, "GOAL", transcript="")
    assert rec["outcome"] == "rejected"
    assert rec["contradictedBy"] == "unattested_goal_accept"
    assert rec["downgradeTo"] == "not_highlight"
    assert d["isHighlight"] is False
    assert d["outcome"] == "not_highlight"
    assert d["score"] == 55.0  # capped, never left at the model's 80
    assert "unattested_goal_accept" in d["contradictedBy"]
    # the tri-state criteria stay null (unverifiable), never coerced to false
    assert d["verdict"]["criteria"]["ballInNet"] is None


def test_criteria_goal_line_claim_puts_the_accept_in_scope():
    # ADAAAA-8370: 17 of the 30 measured false accepts asserted the goal-line /
    # ball-in-net pair in `verdict.criteria` while phrasing the reason without
    # the literal "in the net" ("Ball enters net at t=0.51"). They fell through
    # as `not_a_goal_accept` and were emitted untouched. Criteria are SCOPE only;
    # with no measured attestation the accept must now be refused.
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 88,
                "eventType": "SPORTING_EVENT",
                "outcome": "scoring_play",
                "reason": "Ball enters net at t=0.51 and scoreboard changes to 1-1.",
                "verdict": {
                    "hypothesis": "SPORTING_EVENT",
                    "criteria": {
                        "ballCrossedLineBetweenPosts": True,
                        "ballInNet": True,
                        "scoreboardChanged": False,
                        "crowdErupted": False,
                    },
                },
            }
        )
    )
    assert goal_text_claim(d, "")["goal_specific_claim"] is False  # text alone misses it
    d, rec = apply_contract_guard(d, {"audioLevels": [0.4, 0.9, 1.0]}, "SPORTING_EVENT")
    assert rec["outcome"] == "rejected"
    assert rec["contradictedBy"] == "unattested_goal_accept"
    assert d["isHighlight"] is False
    assert d["outcome"] == "not_highlight"


def test_criteria_goal_line_claim_cannot_attest_a_goal():
    # The criteria route is scope, not attestation: the same accept WITH one
    # measured channel is attested and kept, so the change cannot cost recall on
    # a goal perceive actually saw.
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 88,
                "eventType": "GOAL",
                "outcome": "scoring_play",
                "reason": "Ball enters net at t=0.51.",
                "verdict": {
                    "hypothesis": "GOAL",
                    "criteria": {
                        "ballCrossedLineBetweenPosts": True,
                        "ballInNet": True,
                    },
                },
            }
        )
    )
    d, rec = apply_contract_guard(d, {"ballOutcome": "goal"}, "GOAL")
    assert rec["outcome"] == "attested"
    assert d["isHighlight"] is True
    assert d["outcome"] == "scoring_play"
    assert "contradictedBy" not in d


def test_confirm_enabled_still_rejects_and_downgrades(monkeypatch):
    # The served posture has DECIDE_CONFIRM_ENABLED=1. The guard must still
    # reject at Stage-A (AC-G1) — and ADAAAA-8370 makes that rejection an
    # EMITTED downgrade: `outcome` no longer says scoring_play, so the refused
    # accept cannot be counted (or published) as a goal.
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    d = _parsed(WARM_COMPACT_REPLY)
    d, rec = apply_contract_guard(d, _g1_evidence(WARM_LEVELS), "GOAL", transcript=GOAL_SHOUT)
    assert rec["outcome"] == "rejected"
    assert rec["stage2ConfirmEligible"] is True
    assert d["isHighlight"] is False
    assert d["outcome"] == "not_highlight"
    # a goal-type event label is preserved (it is the confirm trigger's fallback)
    assert d["eventType"] == "GOAL"


# --- measured refutations beyond the text-only case ------------------------

def test_perceive_timeline_refutation_rejects():
    evidence = {
        "perceiveTimeline": [
            {"ts": 0.0, "ballOutcome": "off_target", "tracks": 4},
            {"ts": 1.0, "ballOutcome": "blocked", "tracks": 4},
            {"ts": 2.0, "ballOutcome": "no_shot", "tracks": 3},
        ]
    }
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 88,
                "eventType": "GOAL",
                "outcome": "scoring_play",
                "reason": "the striker buries it into the far corner",
            }
        )
    )
    d, rec = apply_contract_guard(d, evidence, "GOAL")
    assert rec["outcome"] == "rejected"
    assert rec["contradictedBy"] == "perceive_timeline_not_goal"
    assert d["isHighlight"] is False
    assert "off_target@0.0s" in d["contradictedBy"]


def test_ball_before_goal_line_refutation_rejects():
    evidence = {"goalLineDelta": -0.24}
    d = _parsed(
        json.dumps(
            {
                "isHighlight": True,
                "score": 91,
                "eventType": "GOAL",
                "outcome": "scoring_play",
                "reason": "keeper is beaten at the near post",
            }
        )
    )
    d, rec = apply_contract_guard(d, evidence, "GOAL")
    assert rec["contradictedBy"] == "ball_before_goal_line"
    assert d["isHighlight"] is False
    assert "goalLineDelta=-0.24" in d["contradictedBy"]


def test_goal_text_claim_reads_transcript_and_reason():
    claim = goal_text_claim({"reason": "ASR confirms a goal shout"} | {"reasoning": ""}, GOAL_SHOUT)
    assert claim["transcript_goal_shout"] is True
    assert claim["reason_cites_commentary"] is True
    assert claim["score_line_claim"] is True
    # a vision-only reason with no commentary citation makes no text claim
    vision = goal_text_claim(
        {"reason": "striker slots it low into the far corner past the keeper"}, ""
    )
    assert vision["text_bits"] == []
    assert vision["score_line_claim"] is False


# --- integration: the accept path + the audit row --------------------------

class _MockLlama:
    """Minimal chat-completions stand-in (one canned reply per request)."""

    def __init__(self, reply: str):
        self.reply = reply
        self.requests: list = []
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def _handler(self):
        owner = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length", 0))
                owner.requests.append(json.loads(self.rfile.read(n)))
                body = json.dumps({"choices": [{"message": {"content": owner.reply}}]}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # noqa: D102
                pass

        return H

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self._srv.shutdown()


def test_decide_with_gemma_stamps_guard_on_decision_and_audit(monkeypatch):
    llama = _MockLlama(WARM_COMPACT_REPLY)
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    try:
        res = decide_with_gemma(
            event_type="GOAL",
            evidence=_g1_evidence(WARM_LEVELS),
            game_hint="soccer",
            frames=[{"role": "full", "base64": "ZmFrZQ=="}],
            url=llama.url,
            audit_ctx={"sessionId": "s8120", "jobId": "job-8120", "groupKey": "g1", "frameCount": 1},
            asr_prefetched=True,
            asr_transcript=GOAL_SHOUT,
            asr_latency_s=0.4,
            compact=True,
        )
    finally:
        llama.stop()

    assert res["isHighlight"] is False
    assert res["contradictedBy"].startswith("goal_text_without_measurement:")
    assert res["contractGuard"]["outcome"] == "rejected"
    # the transcript reached the prompt (the claim the guard tested)
    texts = [
        p.get("text", "")
        for m in llama.requests[0]["messages"]
        for p in (m["content"] if isinstance(m["content"], list) else [{"text": m["content"]}])
    ]
    assert any("audio commentary transcript (ASR)" in t for t in texts)
    # AC-G5: the audit descriptor (-> the server's decide_audit.timings row)
    # carries the guard outcome and the refuting evidence.
    aud = res["audit"]
    assert aud is not None
    guard = aud["timings"]["contractGuard"]
    assert guard["outcome"] == "rejected"
    assert guard["contradictedBy"] == "goal_text_without_measurement"
    assert guard["attestation"]["attested"] is False
    assert guard["refutingEvidence"]


def test_highlight_route_returns_guard_fields(monkeypatch):
    """End-to-end through the accept path `/highlight` (AC-G1 served shape)."""
    llama = _MockLlama(WARM_COMPACT_REPLY)
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", llama.url)
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    try:
        r = client.post(
            "/highlight",
            json={
                "sessionId": "s8120r",
                "jobId": "job-8120r",
                "groupKey": "g1",
                "timestamp": 0,
                "eventType": "GOAL",
                "evidence": _g1_evidence(WARM_LEVELS),
                "frames": [{"role": "full", "base64": "ZmFrZQ=="}],
                "asrPrefetched": True,
                "asrTranscript": GOAL_SHOUT,
                "asrLatencyS": 0.4,
                "compact": True,
            },
        )
    finally:
        llama.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["isHighlight"] is False
    # ADAAAA-8370: the route emits the downgraded outcome, not the model's claim
    assert body["outcome"] == "not_highlight"
    assert body["contradictedBy"].startswith("goal_text_without_measurement:")
    assert body["contractGuard"]["outcome"] == "rejected"
    assert body["audit"]["timings"]["contractGuard"]["contradictedBy"] == "goal_text_without_measurement"


def test_highlight_route_keeps_an_attested_goal_accepted(monkeypatch):
    """The same reply + a measured score change stays an accepted GOAL."""
    llama = _MockLlama(WARM_COMPACT_REPLY)
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    monkeypatch.setenv("GEMMA_URL", llama.url)
    monkeypatch.delenv("DECIDE_CONFIRM_ENABLED", raising=False)
    evidence = _g1_evidence(WARM_LEVELS) | {"scoreBoardChanged": True}
    try:
        r = client.post(
            "/highlight",
            json={
                "sessionId": "s8120ok",
                "jobId": "job-8120ok",
                "groupKey": "g1",
                "timestamp": 0,
                "eventType": "GOAL",
                "evidence": evidence,
                "frames": [{"role": "full", "base64": "ZmFrZQ=="}],
                "asrPrefetched": True,
                "asrTranscript": GOAL_SHOUT,
                "compact": True,
            },
        )
    finally:
        llama.stop()

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["isHighlight"] is True
    assert body["score"] == 95
    assert body["contractGuard"]["outcome"] == "attested"
    assert body["contradictedBy"] is None
