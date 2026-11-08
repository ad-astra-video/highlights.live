"""ADAAAA-8395 (LFR-1 AC-4) — the per-decide gemma token meter.

Locks the instrumentation contract that the LFR-1 640:360 cell was graded FAIL
against for lack of a stored number:

- IN-1: a decide whose upstream reply carries an OpenAI-compatible `usage` block
  stores `timings.usage.{prompt_tokens,completion_tokens,total_tokens}` with
  `usageSource: "vllm"`.
- IN-4: a decide whose reply has NO usage block stores `usageSource: "absent"`
  and NO zero-filled `usage` object (a persisted 0 would grade as token parity).
- IN-2: the meter changes nothing observable — the request body bytes and the
  verdict shape are identical to the un-metered reply, and exactly one billable
  call is made either way.
- the Stage-2 /confirm pass carries its own meter additively (`usage` /
  `usageSource`), including on a billed-but-unparseable reply.

Everything here is a local fixture: no GPU, no vLLM, no Livepeer spend.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from app import confirm as cf
from app.confirm import ConfirmDecision, run_confirmation_pass
from app.gemma import ask, usage_fields

REPLY = (
    '{"isHighlight":true,"score":80,"eventType":"GOAL","reason":"ball in net",'
    '"verdict":{"is_highlight":true},"evidenceAttested":true}'
)


class _Handler(BaseHTTPRequestHandler):
    """One chat/completions endpoint whose reply either carries a usage block or
    does not, and which records each request body it saw."""

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        self.server.posted.append(json.loads(body))
        if self.server.usage is None:
            payload = {"choices": [{"message": {"content": REPLY}}]}
        else:
            payload = {"choices": [{"message": {"content": REPLY}}], "usage": self.server.usage}
        content = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, *a):  # silence
        pass


def _server(usage=None):
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    srv.posted = []
    srv.usage = usage
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}"


# --- unit: the reply -> audit-keys mapping ---------------------------------


def test_usage_fields_reads_a_wellformed_block():
    keys = usage_fields(
        {"usage": {"prompt_tokens": 12737, "completion_tokens": 268, "total_tokens": 13005}}
    )
    assert keys["usageSource"] == "vllm"
    assert keys["usage"] == {
        "prompt_tokens": 12737,
        "completion_tokens": 268,
        "total_tokens": 13005,
    }


def test_usage_fields_derives_total_when_absent():
    keys = usage_fields({"usage": {"prompt_tokens": 900, "completion_tokens": 100}})
    assert keys["usageSource"] == "vllm"
    assert keys["usage"]["total_tokens"] == 1000


@pytest.mark.parametrize(
    "reply",
    [
        {},  # no usage key at all
        {"usage": None},
        {"usage": {}},  # empty block is not a measurement
        {"usage": {"prompt_tokens": 0, "completion_tokens": 0}},  # invented zero
        {"usage": {"prompt_tokens": "n/a", "completion_tokens": 5}},
        {"usage": {"completion_tokens": 5}},  # prompt side missing
        "not-a-dict",
    ],
)
def test_usage_fields_never_invents_a_zero(reply):
    assert usage_fields(reply) == {"usageSource": "absent"}


# --- IN-1 / IN-2: the decide row carries the meter, behaviour unchanged ----


def _ask(url):
    return ask(
        url,
        "GOAL",
        {"trackCount": 1, "maxVelocity": 0.5},
        game_hint="soccer",
        frames=[{"role": "t", "base64": "aGVsbG8="}],
        audit_ctx={"sessionId": "j-8395", "jobId": "j-8395", "groupKey": "g7", "frameCount": 1, "candidateCount": 1},
    )


def test_decide_audit_carries_vllm_usage():
    """IN-1: a decide row written from a usage-bearing reply stores a real
    meter under `timings`, additively beside the existing stage clocks."""
    srv, url = _server({"prompt_tokens": 12737, "completion_tokens": 268, "total_tokens": 13005})
    try:
        res = _ask(url)
    finally:
        srv.shutdown()
    assert res is not None and res["isHighlight"] is True
    timings = res["audit"]["timings"]
    assert timings["usageSource"] == "vllm"
    assert timings["usage"]["prompt_tokens"] == 12737
    assert timings["usage"]["completion_tokens"] == 268
    assert timings["usage"]["total_tokens"] == 13005
    # additive: the pre-existing keys are untouched
    assert "elapsedMs" in timings and "asrLatencyS" in timings
    assert "vllmMs" in timings and "promptBuildMs" in timings


def test_decide_audit_marks_absent_without_a_usage_block():
    """IN-4: no usage block upstream -> `usageSource: "absent"` and NO `usage`
    object. Never a zero-filled block that would grade as token parity."""
    srv, url = _server(None)
    try:
        res = _ask(url)
    finally:
        srv.shutdown()
    timings = res["audit"]["timings"]
    assert timings["usageSource"] == "absent"
    assert "usage" not in timings


def test_meter_is_additive_request_and_verdict_unchanged():
    """IN-2: the meter reads the reply only — the decide REQUEST body is
    byte-identical and the verdict shape is identical whether or not the reply
    carries a usage block; one billable call either way."""
    bare_srv, bare_url = _server(None)
    try:
        bare = _ask(bare_url)
        bare_posts = list(bare_srv.posted)
    finally:
        bare_srv.shutdown()
    metered_srv, metered_url = _server(
        {"prompt_tokens": 12737, "completion_tokens": 268, "total_tokens": 13005}
    )
    try:
        metered = _ask(metered_url)
        metered_posts = list(metered_srv.posted)
    finally:
        metered_srv.shutdown()

    # same number of billable calls (the probe + paid re-POST pair lives in the
    # adapter; at this layer exactly one POST per decide)
    assert len(bare_posts) == len(metered_posts) == 1
    # identical request bytes
    assert json.dumps(bare_posts[0], sort_keys=True) == json.dumps(metered_posts[0], sort_keys=True)
    assert "usage" not in json.dumps(bare_posts[0])
    # identical verdict contract: the same keys, the same values
    bare_verdict = {k: v for k, v in bare.items() if k not in ("audit", "analysis")}
    metered_verdict = {k: v for k, v in metered.items() if k not in ("audit", "analysis")}
    assert bare_verdict == metered_verdict
    # the ONLY difference is the additive meter under timings: `usageSource` is
    # stamped on BOTH (that is the IN-4 point — absence is readable), and only
    # the measured block is extra.
    assert bare["audit"]["timings"]["usageSource"] == "absent"
    assert metered["audit"]["timings"]["usageSource"] == "vllm"
    bare_timings = dict(bare["audit"]["timings"])
    metered_timings = dict(metered["audit"]["timings"])
    bare_timings.pop("elapsedMs", None)
    metered_timings.pop("elapsedMs", None)
    assert set(metered_timings) - set(bare_timings) == {"usage"}
    assert not set(bare_timings) - set(metered_timings)


# --- the Stage-2 /confirm pass carries its own meter -----------------------


def test_confirm_carries_its_own_usage(monkeypatch):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "ball in net", "evidence": {"ballInNet": true}}'
    )

    def _call(*a, **k):
        out = k.get("usage_out")
        if isinstance(out, dict):
            out.update(
                usage_fields({"usage": {"prompt_tokens": 2400, "completion_tokens": 61, "total_tokens": 2461}})
            )
        return canned

    monkeypatch.setattr(cf, "_call_gemma", _call)
    resp = run_confirmation_pass(
        {"stage1": {"outcome": "near_miss"}, "eventType": "GOAL", "frames": [{"base64": "x"}]}
    )
    assert resp["usageSource"] == "vllm"
    assert resp["usage"]["prompt_tokens"] == 2400
    assert resp["usage"]["completion_tokens"] == 61


def test_confirm_marks_absent_and_keeps_passthrough_contract(monkeypatch):
    """A monkeypatched call that returns only text (the pre-8395 contract) adds
    no key at all, so the /confirm response is byte-identical to today."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: "not json at all")
    resp = run_confirmation_pass(
        {"stage1": {"outcome": "near_miss"}, "eventType": "GOAL", "frames": [{"base64": "x"}]}
    )
    assert "usage" not in resp
    assert "usageSource" not in resp


def test_confirm_usage_survives_the_response_model():
    """The `/confirm` endpoint declares `response_model=ConfirmDecision`, so the
    meter must be a DECLARED field or it would be silently dropped on the wire."""
    d = ConfirmDecision(enabled=True, usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}, usageSource="vllm")
    assert d.usage["prompt_tokens"] == 1
    assert d.usageSource == "vllm"
