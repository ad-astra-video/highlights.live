import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from app.gemma import (
    SYSTEM_PROMPT,
    SYSTEM_PROMPT_VERSION,
    _audit_sha256,
    _content_ref,
    _emit_audit,
    _messages,
    _audit_record,
    ask,
    load_audit_records,
    rebuild_payload,
)

AUDIT_DIR = "/tmp/test-decide-audit-7028"


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(n)
        # echo what we saw payload-wise for the control assertion
        self.server.last_payload = json.loads(body)
        reply = (
            '{"isHighlight":true,"score":80,"eventType":"GOAL","reason":"ball in net",'
            '"verdict":{"is_highlight":true},"evidenceAttested":true}'
        )
        content = json.dumps({"choices": [{"message": {"content": reply}}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, *a):  # silence
        pass


def _start_server():
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    srv.last_payload = None
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f"http://127.0.0.1:{srv.server_port}"


def _clean():
    import shutil

    shutil.rmtree(AUDIT_DIR, ignore_errors=True)


def test_messages_has_versioned_system_prompt():
    msgs = _messages("single", [{"type": "text", "text": "hi"}])
    assert msgs[0]["role"] == "system"
    assert msgs[0]["content"] == SYSTEM_PROMPT
    assert msgs[1]["role"] == "user"
    assert msgs[1]["content"] == [{"type": "text", "text": "hi"}]


def test_system_prompt_versioned():
    assert SYSTEM_PROMPT_VERSION == "1"


def test_audit_sha256_and_content_ref():
    b64 = "aGVsbG8="  # base64("hello")
    h = _audit_sha256(b64)
    assert len(h) == 64
    ref = _content_ref({"base64": b64})
    assert ref["sha256"] == h
    assert ref["dataUrl"].startswith("data:image/jpeg;base64,")


def test_audit_record_shape():
    rec = _audit_record(
        audit_ctx={"sessionId": "job", "groupKey": "g1", "frameCount": 3, "candidateCount": 2},
        mode="single",
        content=[{"type": "text", "text": "prompt"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,aGk="}}],
        payload={"messages": [{"role": "system", "content": SYSTEM_PROMPT}], "temperature": 0.0},
        raw_reply='{"isHighlight":true}',
        parsed={"isHighlight": True},
        fallback=False,
        started_at=time.time() - 0.5,
    )
    assert rec["systemPromptVersion"] == "1"
    assert rec["sessionId"] == "job"
    assert rec["groupKey"] == "g1"
    assert rec["frameCount"] == 3
    assert rec["candidateCount"] == 2
    assert rec["rawReply"] == '{"isHighlight":true}'
    assert rec["parsed"] == {"isHighlight": True}
    assert rec["fallback"] is False
    assert rec["timings"]["elapsedMs"] >= 0
    # content refs: text kept verbatim, image ref has sha256
    kinds = [r["type"] for r in rec["contentRefs"]]
    assert kinds == ["text", "image"]
    assert rec["contentRefs"][1]["sha256"]


def test_unset_dir_is_noop():
    _clean()
    before = load_audit_records()
    _emit_audit({"any": "record"})  # DECIDE_AUDIT_DIR not set in this env
    assert load_audit_records() == before


def test_ask_emits_one_record_and_replay_byte_matches():
    _clean()
    old = os.environ.get("DECIDE_AUDIT_DIR")
    os.environ["DECIDE_AUDIT_DIR"] = AUDIT_DIR
    try:
        srv, url = _start_server()
        try:
            res = ask(
                url,
                "GOAL",
                {"trackCount": 1, "maxVelocity": 0.5},
                game_hint="soccer",
                frames=[{"role": "t", "base64": "aGVsbG8="}],
                audit_ctx={"sessionId": "job", "groupKey": "g1", "frameCount": 1, "candidateCount": 1},
            )
            assert res is not None and res["isHighlight"] is True
        finally:
            srv.shutdown()
        recs = load_audit_records()
        assert len(recs) == 1
        rec = recs[0]
        # the record holds the verbatim system + user messages
        assert rec["messages"][0]["role"] == "system"
        assert rec["messages"][1]["role"] == "user"
        # the control assertion: rebuilt payload byte-matches what was sent
        rebuilt = rebuild_payload(rec)
        assert rebuilt == srv.last_payload
        # raw reply + verdicts present, fallback flag false on the direct path
        assert '"isHighlight":true' in rec["rawReply"]
        assert rec["parsed"]["isHighlight"] is True
        assert rec["fallback"] is False
    finally:
        if old is None:
            os.environ.pop("DECIDE_AUDIT_DIR", None)
        else:
            os.environ["DECIDE_AUDIT_DIR"] = old
        _clean()


def test_audit_descriptor_emitted_compact_on_decision():
    """ADAAAA-7028 Inc 2: the decision returned by ask() carries a compact
    `audit` descriptor the server can index (group identity + prompt + media
    content hashes + raw reply + verdicts + params), NEVER the base64 media
    bytes, and it is replayable (messages+params present)."""
    _clean()
    old = os.environ.get("DECIDE_AUDIT_DIR")
    os.environ["DECIDE_AUDIT_DIR"] = AUDIT_DIR
    try:
        srv, url = _start_server()
        try:
            res = ask(
                url,
                "GOAL",
                {"trackCount": 2, "maxVelocity": 0.5},
                game_hint="soccer",
                frames=[{"role": "t", "base64": "aGVsbG8="}],
                audit_ctx={"sessionId": "job-1", "jobId": "job-1", "groupKey": "g5", "frameCount": 1, "candidateCount": 1},
            )
            assert res is not None
        finally:
            srv.shutdown()
        audit = res["audit"]
        # group identity preserved
        assert audit["sessionId"] == "job-1"
        assert audit["jobId"] == "job-1"
        assert audit["groupKey"] == "g5"
        assert audit["frameCount"] == 1
        assert audit["candidateCount"] == 1
        assert audit["systemPromptVersion"] == SYSTEM_PROMPT_VERSION
        # prompt text present (verbatim system + user)
        assert SYSTEM_PROMPT in audit["promptText"]
        # media represented by content hash refs only (no base64 bytes)
        img = [m for m in audit["mediaHashes"] if m["type"] == "image"]
        assert img and len(img[0]["sha256"]) == 64
        assert "data:image" not in json.dumps(audit)
        # raw reply + parsed verdicts + params + replayable marker
        assert '"isHighlight":true' in audit["rawReply"]
        assert audit["verdicts"]["isHighlight"] is True
        assert audit["params"]["temperature"] == 0.0
        assert audit["replayable"] is True
        assert audit["fallback"] is False
    finally:
        if old is None:
            os.environ.pop("DECIDE_AUDIT_DIR", None)
        else:
            os.environ["DECIDE_AUDIT_DIR"] = old
        _clean()
