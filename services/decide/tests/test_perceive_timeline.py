"""ADAAAA-8056 (lever B+e) — the per-window perceive timeline + ASR coverage.

Pins three things the enrichment has to guarantee before the ladder in
ADAAAA-8049 is measured on it:

* AC-E1: one compact record per 3 fps perceive seed reaches the prompt, ordered
  by ts, and the same block is inspectable in the `analysis` dataItems with a
  per-window coverage ledger on `decide_audit.timings`.
* AC-E3: the block respects a token budget and is COMPACTED (scalars only) or
  THINNED rather than dropped when the budget binds.
* AC-E2: every decide reports `path` / `asrRan` / `asrLatencyS` plus whether the
  window carried audio at all, and a no-audio window is NAMED.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.gemma as G
from app import app as decide_app
from app import Evidence, PerceiveTimelineRecord
from app.gemma import (
    PERCEIVE_TIMELINE_MAX_CHARS,
    _build_data_items,
    build_prompt,
    decide_with_gemma,
    render_perceive_timeline,
)

client = TestClient(decide_app)

REPLY = json.dumps(
    {
        "isHighlight": True,
        "score": 82,
        "eventType": "GOAL",
        "reason": "ball in net, crowd erupts",
        "outcome": "scoring_play",
    }
)


class _MockLlama:
    def __init__(self, reply: str = REPLY):
        self.reply = reply
        self.requests: list = []
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._t.start()

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


def timeline(n: int = 29, center: float = 10.0) -> list:
    """A realistic ~10 s / 3 fps window: 29 seeds, one every ~0.34 s."""
    recs = []
    for i in range(n):
        ts = round(center - n / 2 / 3 + i / 3, 2)
        rec = {
            "ts": ts,
            "tracks": 3,
            "maxVelocity": round(0.1 + i / 100, 2),
            "objects": ["player", "ball"],
            "trackIds": ["t0", "ball"],
        }
        if i == 14:
            rec.update(
                {
                    "ocr": ["1-0"],
                    "ballOutcome": "goal",
                    "goalCrossed": True,
                    "ballInNet": True,
                    "scoreBoardChanged": True,
                    "possession": "p12",
                }
            )
        recs.append(rec)
    return recs


def test_evidence_accepts_a_full_live_window_and_clamps_its_fields():
    ev = Evidence(
        trackCount=8,
        perceiveTimeline=timeline(29),
        # adversarial: a track count over the schema cap is rejected, and an
        # oversized record list is rejected — the server clamps, so decide never
        # builds one (AC-E4).
    )
    assert len(ev.perceiveTimeline) == 29
    assert ev.perceiveTimeline[14].ballOutcome == "goal"
    assert ev.perceiveTimeline[14].goalCrossed is True
    with pytest.raises(ValidationError):
        PerceiveTimelineRecord(ts=1.0, tracks=9)
    with pytest.raises(ValidationError):
        PerceiveTimelineRecord(ts=1.0, maxVelocity=-1.0)
    with pytest.raises(ValidationError):
        Evidence(perceiveTimeline=timeline(33))
    # Unknown upstream fields degrade to ignore, never a 422.
    assert PerceiveTimelineRecord(**{"ts": 1.0, "tracks": 2, "futureField": 1}).tracks == 2


def test_ledger_carries_the_decide_image_budget():
    """ADAAAA-8074 (AC-CAP-1): the decide_audit row states what the payload
    carried and which image budget selected it, so a leg grades the payload
    instead of `printenv`. An absent budget leaves the key OFF the row (it must
    not claim `applied`), and a JSON-ish `False` must not read as True."""
    _block, ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(29)},
        {"seeds": 4, "withFindings": 4, "imageCount": 4, "imagesPerDecide": 4,
         "imageBudget": 4, "imageBudgetApplied": True},
    )
    assert ledger["imagesPerDecide"] == 4
    assert ledger["imageBudget"] == 4
    assert ledger["imageBudgetApplied"] is True

    # A row from a path that consulted no budget: no claim either way.
    _block, bare = render_perceive_timeline({"perceiveTimeline": timeline(29)}, {"seeds": 29})
    assert "imageBudgetApplied" not in bare
    assert "imagesPerDecide" not in bare

    # A false budget must survive as False, not be truthy-coerced.
    _block, off = render_perceive_timeline(
        {"perceiveTimeline": timeline(29)}, {"imageBudgetApplied": 0}
    )
    assert off["imageBudgetApplied"] is False


def test_ledger_carries_the_configured_span_and_cadence():
    """ADAAAA-8065 (AC-SPAN-1): the rev-7 cell is graded off the row, not off
    `printenv`. `spanSec` (seconds) and `cadenceMs` (ms) ride every live payload
    beside the image budget, so a 7 s / 5 s leg is provable from `decide_audit`
    alone. A payload that states neither (VOD / legacy) leaves both keys OFF the
    row instead of publishing a default it never ran."""
    _block, ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(21)},
        {"seeds": 4, "withFindings": 21, "imageCount": 4, "imagesPerDecide": 4,
         "imageBudget": 4, "imageBudgetApplied": True,
         "spanSec": 7, "cadenceMs": 5000},
    )
    assert ledger["spanSec"] == 7.0
    assert ledger["cadenceMs"] == 5000
    # The configured span and the measured span are separate numbers.
    assert "spanS" not in ledger or ledger["spanS"] != ledger["spanSec"]

    _block, bare = render_perceive_timeline({"perceiveTimeline": timeline(29)}, {"seeds": 29})
    assert "spanSec" not in bare
    assert "cadenceMs" not in bare


def test_ledger_carries_the_configured_content_fps():
    """ADAAAA-8102 (AC-8101-1): the live CONTENT consume rate rides the row next
    to `spanSec`/`cadenceMs`. The directive is "consume at 1 FPS", and a leg
    grades `contentFps == 1` on 100 % of payloads/rows instead of reading
    `printenv` — the shipped media rail consumed at the ingest rate while the
    analyzer pass read the knob (job `8024a341`: 833 frames / 300 s). A payload
    that states no rate (VOD / legacy) leaves the key OFF the row rather than
    publishing a default it never ran."""
    _block, ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(7)},
        {"seeds": 7, "withFindings": 7, "imageCount": 4, "imagesPerDecide": 4,
         "imageBudget": 4, "imageBudgetApplied": True,
         "spanSec": 7, "cadenceMs": 5000, "contentFps": 1},
    )
    assert ledger["contentFps"] == 1.0
    assert ledger["spanSec"] == 7.0

    _block, bare = render_perceive_timeline({"perceiveTimeline": timeline(29)}, {"seeds": 29})
    assert "contentFps" not in bare


def test_ledger_carries_the_enrichment_arm(monkeypatch=None):
    """ADAAAA-8108 (AC-E3): the ON/OFF arm rides the row next to the density keys.

    The arm is allocated per DECIDED window by the server (`alternate` starts OFF
    so the ON arm is never read through the warm image prefix). Without the
    passthrough a leg could only INFER the arm from `records == 0` or the prompt
    text; stamping it makes the split a column read. A payload that states no arm
    (VOD / legacy / the shipped `on` posture) leaves the key OFF the row rather
    than claiming an arm it never ran."""
    _block, ledger = render_perceive_timeline(
        {"perceiveTimeline": []},
        {"seeds": 21, "withFindings": 8, "timelineRecords": 21, "observationsInSpan": 21,
         "imageCount": 4, "spanSec": 7, "cadenceMs": 5000, "contentFps": 3,
         "enrichmentArm": "off"},
    )
    # The OFF arm renders NO block, but the window's density is still measured.
    assert _block == ""
    assert ledger["records"] == 0
    assert ledger["timelineRecords"] == 21
    assert ledger["enrichmentArm"] == "off"

    block, on_ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(21)}, {"seeds": 21, "enrichmentArm": "on"}
    )
    assert block.startswith("perceive timeline")
    assert on_ledger["enrichmentArm"] == "on"

    _block, bare = render_perceive_timeline({"perceiveTimeline": timeline(4)}, {"seeds": 4})
    assert "enrichmentArm" not in bare


def test_render_is_ordered_and_dense_with_a_ledger():
    block, ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(29)}, {"seeds": 29, "withFindings": 29, "centerTs": 10.0}
    )
    assert block.startswith("perceive timeline")
    # one line per record: the AC-E1 density claim, at 3 fps
    assert len([ln for ln in block.splitlines() if ln.startswith("  ")]) == 29
    span = timeline(29)[-1]["ts"] - timeline(29)[0]["ts"]
    assert ledger["records"] >= int(span) + 1
    # ADAAAA-8064: the block budget is sized for the full-rate live window, so a
    # 29-record span renders WHOLE — no record is thinned away and the labels /
    # OCR anchors reach the model (they are what makes the text channel dense).
    assert ledger == {
        "records": 29,
        "chars": len(block),
        "compacted": "none",
        "seeds": 29,
        "withFindings": 29,
    }
    assert ledger["chars"] <= PERCEIVE_TIMELINE_MAX_CHARS
    # <= ~120 chars/record keeps AC-E3's prefill budget (28-29 records < 3.4 KB).
    assert len(block) / 29 <= 120
    # Ordered oldest -> newest, with t relative to the stated window center.
    ts_lines = [ln.split()[0] for ln in block.splitlines() if ln.startswith("  ")]
    assert ts_lines == sorted(ts_lines, key=lambda t: float(t.rstrip("s")))
    # Labels and OCR anchors survive at full-rate density (the record is compact
    # enough that the block never has to compact them away).
    assert "objects=player,ball" in block
    assert 'ocr="1-0"' in block
    # The decisive scalars survive compaction: the goal record still names itself.
    assert "ball=goal" in block
    assert "flag=goal_line+in_net+score_delta" in block
    assert "poss=p12" in block


def test_a_short_window_keeps_the_full_record_including_labels_and_ocr():
    block, ledger = render_perceive_timeline(
        {"perceiveTimeline": timeline(5)}, {"seeds": 5, "withFindings": 5, "centerTs": 10.0}
    )
    assert ledger["compacted"] == "none"
    assert ledger["records"] == 5
    assert "objects=player,ball" in block
    # ADAAAA-8064: track ids stay on the evidence record (audit) but are not
    # rendered — 8 ids/record would blow the ~120 chars/record budget at the
    # full-rate 28-record window.
    assert "track_ids=" not in block


def test_no_timeline_keeps_the_prompt_byte_identical():
    with_none = build_prompt("GOAL", {"trackCount": 2}, game_hint="soccer")
    with_empty = build_prompt(
        "GOAL", {"trackCount": 2, "perceiveTimeline": []}, game_hint="soccer"
    )
    assert with_none == with_empty
    assert "perceive timeline" not in with_none
    assert "perceive timeline" in build_prompt(
        "GOAL", {"trackCount": 2, "perceiveTimeline": timeline(5)}, game_hint="soccer"
    )


def test_budget_binds_by_compacting_then_thinning_never_dropping():
    fat = []
    for i in range(60):
        fat.append(
            {
                "ts": float(i) / 3,
                "tracks": 8,
                "maxVelocity": 1.23,
                "objects": ["goalkeeper", "defender", "striker", "ball"],
                "trackIds": [f"player-{i}-{j}" for j in range(8)],
                "ocr": ["1-0 HOME 14:32:07", "0-0 AWAY 14:31:02"],
                "ballOutcome": "off_target",
                "possession": f"player-{i}",
            }
        )
    block, ledger = render_perceive_timeline(
        {"perceiveTimeline": fat}, {"seeds": 60, "withFindings": 60, "centerTs": 10.0}
    )
    assert ledger["compacted"] in ("scalars", "thinned")
    assert len(block) <= PERCEIVE_TIMELINE_MAX_CHARS
    assert ledger["records"] >= 1
    assert block.startswith("perceive timeline")
    # Scalars survive compaction: the decisive fields are never the ones dropped.
    assert "tracks=8" in block


def test_data_items_expose_the_timeline_for_inspection():
    items = _build_data_items(
        "GOAL",
        {"trackCount": 3, "perceiveTimeline": timeline(5)},
        "soccer",
        5,
        0,
        False,
        "",
        "",
        None,
        None,
        {"seeds": 5, "withFindings": 5, "centerTs": 10.0},
    )
    tl = [i for i in items if i["type"] == "perceive_timeline"]
    assert len(tl) == 1
    assert tl[0]["value"].startswith("perceive timeline")


@pytest.fixture()
def llama():
    srv = _MockLlama()
    yield srv
    srv.stop()


def test_decide_carries_timeline_ledger_and_asr_coverage(llama, monkeypatch):
    """End-to-end: the audit descriptor (which becomes the decide_audit row)
    carries the timeline ledger and the ASR coverage for the window."""
    monkeypatch.setenv("ASR_URL", "http://asr.test:8082")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("GEMMA_SEND_AUDIO", "0")
    monkeypatch.setattr(
        G, "transcribe_audio", lambda url, audio, sr=16000, **kw: ("and it's in the net", 0.7)
    )
    res = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=3, perceiveTimeline=timeline(28)).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="QUJD",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "g1", "frameCount": 4},
        perceive_window={
            "seeds": 4,
            "withFindings": 4,
            "centerTs": 10.0,
            # ADAAAA-8064: a 4-image call whose timeline carries the window's 28
            # perceived frames.
            "timelineRecords": 28,
            "observationsInSpan": 28,
            "imageCount": 4,
            "imageGapMaxMs": 3300,
            "recordsPerSecond": 2.8,
            "spanS": 10.0,
            "timelineSource": "observations",
        },
        audio_presence={"tapChunks": 4, "clipBytes": 6, "levels": 12, "series": 12},
    )
    tl = res["audit"]["timings"]["perceiveTimeline"]
    assert tl["records"] == 28
    assert tl["compacted"] in ("none", "scalars", "thinned")
    assert tl["seeds"] == 4 and tl["withFindings"] == 4
    # ADAAAA-8064 (AC-C1..C3): the density ledger rides the audit row...
    assert tl["timelineRecords"] == 28 and tl["observationsInSpan"] == 28
    assert tl["imageCount"] == 4 and tl["imageGapMaxMs"] == 3300
    assert tl["recordsPerSecond"] == 2.8 and tl["spanS"] == 10.0
    assert tl["timelineSource"] == "observations"
    # ...and is mirrored into the analysis block an inspector reads.
    assert res["analysis"]["perceiveTimeline"]["timelineRecords"] == 28
    assert res["analysis"]["perceiveTimeline"]["observationsInSpan"] == 28
    assert res["analysis"]["perceiveTimeline"]["imageCount"] == 4
    assert res["audit"]["timings"]["audioPath"] == "asr_text"
    assert res["audit"]["timings"]["asrRan"] is True
    assert res["audit"]["timings"]["asrLatencyS"] == 0.7
    assert res["audit"]["timings"]["windowAudioPresent"] is True
    assert res["audioContext"]["path"] == "asr_text"
    assert res["audioContext"]["windowAudioPresent"] is True
    assert res["audioContext"]["noAudioReason"] == ""
    types = [i["type"] for i in res["analysis"]["dataItems"]]
    assert "perceive_timeline" in types
    assert res["analysis"]["perceiveTimeline"]["records"] == 28
    # The prompt actually given to the model carried the records.
    sent = llama.requests[0]["messages"][-1]["content"]
    text = sent if isinstance(sent, str) else " ".join(p.get("text", "") for p in sent)
    assert "perceive timeline" in text


def test_no_audio_window_is_named_not_silently_transcribed(llama, monkeypatch):
    monkeypatch.setenv("ASR_URL", "http://asr.test:8082")
    monkeypatch.delenv("GEMMA_SEND_AUDIO", raising=False)
    res = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=1).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "g1", "frameCount": 1},
        audio_presence={"tapChunks": 0, "clipBytes": 0, "levels": 0, "series": 0},
    )
    assert res["audioContext"]["path"] == "none"
    assert res["audioContext"]["asrRan"] is False
    assert res["audioContext"]["windowAudioPresent"] is False
    assert res["audioContext"]["noAudioReason"] == "no_audio_clip"
    assert res["audit"]["timings"]["noAudioReason"] == "no_audio_clip"

    # A window the tap had banked chunks for but whose clip fell outside the
    # retained span is a RETENTION gap, not a silent stream.
    res2 = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=1).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "g2", "frameCount": 1},
        audio_presence={"tapChunks": 9, "clipBytes": 0, "levels": 0, "series": 0},
    )
    assert res2["audioContext"]["noAudioReason"] == "retention_gap"

    # The lever-B trim (LIVE_DECIDE_AUDIO_CLIP=0) gates the clip off the payload
    # while the tap is fed: a NAMED posture, never reported as retention.
    res3 = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=1).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "g3", "frameCount": 1},
        audio_presence={"tapChunks": 211, "clipBytes": 0, "levels": 48, "series": 132, "clipEnabled": False},
    )
    assert res3["audioContext"]["noAudioReason"] == "audio_clip_disabled"
    assert res3["audit"]["timings"]["noAudioReason"] == "audio_clip_disabled"


def test_emitted_audit_record_carries_the_audio_coverage(llama, monkeypatch, tmp_path):
    """AC-E2 regression: the coverage must reach the RECORD written to
    DECIDE_AUDIT_DIR, not just the response descriptor. The descriptor is built
    from the same dict, so an offline grade that reads the JSONL trail used to
    see zero audio fields on a leg that was fully transcribed."""
    monkeypatch.setenv("DECIDE_AUDIT_DIR", str(tmp_path))
    monkeypatch.setenv("ASR_URL", "http://asr.test:8082")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("GEMMA_SEND_AUDIO", "0")
    monkeypatch.setattr(
        G, "transcribe_audio", lambda url, audio, sr=16000, **kw: ("goal for the home side", 0.8)
    )
    res = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=3, perceiveTimeline=timeline(29)).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="QUJD",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "gAUD", "frameCount": 29},
        perceive_window={"seeds": 29, "withFindings": 29, "centerTs": 10.0},
        audio_presence={"tapChunks": 4, "clipBytes": 6, "levels": 12, "series": 12},
    )
    lines = (tmp_path / "decide-audit.jsonl").read_text().splitlines()
    assert lines, "no audit record emitted"
    rec = json.loads(lines[-1])
    assert rec["groupKey"] == "gAUD"
    t = rec["timings"]
    assert t["audioPath"] == "asr_text"
    assert t["asrRan"] is True
    assert t["asrLatencyS"] == 0.8
    assert t["windowAudioPresent"] is True
    assert t["noAudioReason"] == ""
    assert t["audioClipBytes"] == 6 and t["audioTapChunks"] == 4
    assert t["perceiveTimeline"]["records"] == 29
    # The file record and the descriptor agree field for field on coverage.
    d = res["audit"]["timings"]
    assert d["audioPath"] == t["audioPath"] and d["asrRan"] == t["asrRan"]
    assert d["noAudioReason"] == t["noAudioReason"]


def test_emitted_audit_record_names_a_no_audio_window(llama, monkeypatch, tmp_path):
    """AC-E2 wording: a window that carried NO audio must stay distinguishable
    from one that was transcribed to empty, and that has to be true of the
    on-disk RECORD too — not just of the descriptor the server indexes. The
    record carries `windowAudioPresent=false` plus a named `noAudioReason`."""
    monkeypatch.setenv("DECIDE_AUDIT_DIR", str(tmp_path))
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setenv("GEMMA_SEND_AUDIO", "0")
    monkeypatch.delenv("ASR_URL", raising=False)
    monkeypatch.setattr(G, "_asr_url", lambda: None)
    res = decide_with_gemma(
        "GOAL",
        Evidence(trackCount=1).model_dump(),
        game_hint="soccer",
        frames=[],
        audio_b64="",
        url=llama.url,
        audit_ctx={"sessionId": "s1", "jobId": "j1", "groupKey": "gNOAUD", "frameCount": 1},
        audio_presence={"tapChunks": 0, "clipBytes": 0, "levels": 0, "series": 0},
    )
    lines = (tmp_path / "decide-audit.jsonl").read_text().splitlines()
    rec = json.loads(lines[-1])
    assert rec["groupKey"] == "gNOAUD"
    t = rec["timings"]
    assert t["audioPath"] == "none" and t["asrRan"] is False
    assert t["windowAudioPresent"] is False
    assert t["noAudioReason"] == "no_audio_clip"
    assert t["audioTapChunks"] == 0 and t["audioClipBytes"] == 0
    # File record and the descriptor the server persists agree field for field.
    d = res["audit"]["timings"]
    assert d["windowAudioPresent"] is False and d["noAudioReason"] == "no_audio_clip"
    assert d["audioPath"] == t["audioPath"]


def test_enriched_request_never_422s_the_live_loop():
    """AC-E4: a 29-seed window with the timeline rides the real /highlight route
    (whose response is validated), and an oversized timeline is a clean 422 the
    server can never produce because it clamps first."""
    body = {
        "sessionId": "s1",
        "eventType": "GOAL",
        "timestamp": 0,
        "gameHint": "soccer",
        "evidence": {"trackCount": 8, "perceiveTimeline": timeline(29)},
        "frames": [],
        "jobId": "j1",
        "groupKey": "g1",
        "perceiveWindow": {"seeds": 29, "records": 29, "withFindings": 29, "centerTs": 10.0},
        "audioPresence": {"tapChunks": 4, "clipBytes": 6, "levels": 12, "series": 12},
    }
    r = client.post("/highlight", json=body)
    assert r.status_code == 200, r.text
    over = {**body, "evidence": {"trackCount": 8, "perceiveTimeline": timeline(33)}}
    assert client.post("/highlight", json=over).status_code == 422
