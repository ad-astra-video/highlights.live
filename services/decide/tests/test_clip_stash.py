"""Gates for the decide-runner clip stash + build-or-discard (ADAAAA-6741 G4).

Covers the Part 3 stash/clip gates:
- a continuous 120 s frame+audio ring fed by the rail,
- pre-clip assembly of the 20 s-before / 10 s-after window from the stash,
- a clip built on the decide runner from the in-memory stash (no source re-read),
- build-or-discard on the confirm/refute verdict,
- local CPU encode (ffmpeg from JPEG sequence), no GPU.
"""
from __future__ import annotations

import base64
import os
import subprocess
import tempfile

import pytest

from app.clip_stash import ClipStash, StashConfig, StashFrame
from app.clip_upload import upload_clip, make_upload_client

FFMPEG = "ffmpeg"


def _jpeg(color: str = "red", size: str = "160x120") -> bytes:
    """Generate a tiny real JPEG with ffmpeg (works without PIL/GPU)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
        out = tf.name
    subprocess.run(
        [FFMPEG, "-y", "-loglevel", "error", "-f", "lavfi",
         "-i", f"color=c={color}:s={size}:d=0.1", "-frames:v", "1", out],
        check=True, capture_output=True,
    )
    with open(out, "rb") as fh:
        data = fh.read()
    os.unlink(out)
    return data


def _frames(ts_list, fps=3.0):
    return [StashFrame(ts=ts, seq=i, jpeg=_jpeg()) for i, ts in enumerate(ts_list)]


# --- ring -------------------------------------------------------------------
def test_ingest_evicts_older_than_ring_window():
    stash = ClipStash(StashConfig(ring_duration_s=120.0))
    # Feed frames spanning ~130 s; only the last 120 s should remain.
    for i in range(0, 131):
        stash.ingest(ts=float(i), seq=i, jpeg=_jpeg())
    s = stash.state()
    assert s["frameCount"] <= 120 + 2  # tolerance for boundary
    assert s["newestTs"] == pytest.approx(130.0)
    assert s["oldestTs"] >= 130.0 - 120.0 - 1.0


def test_window_returns_only_in_window():
    stash = ClipStash(StashConfig(ring_duration_s=120.0))
    for i in range(0, 61):
        stash.ingest(ts=float(i), seq=i, jpeg=_jpeg())
    video, audio = stash.window(20.0, 30.0)
    assert min(f.ts for f in video) >= 20.0
    assert max(f.ts for f in video) <= 30.0
    # 20..30 inclusive ~= 11 frames at 1 fps
    assert len(video) == 11


# --- pre-clip ---------------------------------------------------------------
def test_preclip_assembles_20_before_10_after():
    stash = ClipStash(StashConfig(clip_before_s=20.0, clip_after_s=10.0))
    for i in range(0, 61):
        stash.ingest(ts=float(i), seq=i, jpeg=_jpeg())
    video, audio, start, end = stash.preclip(trigger_ts=40.0)
    assert start == pytest.approx(20.0)   # 40 - 20
    assert end == pytest.approx(50.0)     # 40 + 10
    assert min(f.ts for f in video) >= 20.0
    assert max(f.ts for f in video) <= 50.0


# --- build clip (local CPU encode) -----------------------------------------
def test_build_clip_produces_valid_mp4_from_stash():
    stash = ClipStash(StashConfig())
    for i in range(0, 31):  # 30 frames at 3 fps => ~10 s clip
        stash.ingest(ts=round(i / 3.0, 3), seq=i, jpeg=_jpeg())
    video, _, start, end = stash.preclip(trigger_ts=10.0)
    assert len(video) >= 20
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "clip.mp4")
        stash.build_clip(video, out)
        assert os.path.exists(out) and os.path.getsize(out) > 0
        # Probe: must be a real h264 mp4 with a video stream and ~ window duration.
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
             "-show_entries", "format=duration", "-of", "json", out],
            capture_output=True, text=True,
        )
        import json
        info = json.loads(probe.stdout)
        types = [s["codec_type"] for s in info.get("streams", [])]
        assert "video" in types
        dur = float(info["format"]["duration"])
        assert 8.0 <= dur <= 12.0  # ~10 s window


# --- build-or-discard -------------------------------------------------------
def test_build_or_discard_confirmed_builds_and_uploads():
    stash = ClipStash(StashConfig())
    for i in range(0, 61):
        stash.ingest(ts=float(i), seq=i, jpeg=_jpeg())
    calls = []
    def upload(path, meta):
        calls.append((path, meta))
        return {"ok": True, "id": "c1", "clipUri": "/clips/c1.mp4"}
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "clip.mp4")
        res = stash.build_or_discard(30.0, is_highlight=True, discarded=False, out_path=out, upload=upload)
        assert res["action"] == "build_upload"
        assert res["start"] == pytest.approx(10.0)
        assert res["end"] == pytest.approx(40.0)
        assert calls and os.path.exists(calls[0][0])
        assert res["uploadResult"]["id"] == "c1"


def test_build_or_discard_refuted_frees_stash_no_clip():
    stash = ClipStash(StashConfig())
    for i in range(0, 61):
        stash.ingest(ts=float(i), seq=i, jpeg=_jpeg())
    calls = []
    def upload(path, meta):
        calls.append((path, meta))
        return {"ok": True}
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "clip.mp4")
        res = stash.build_or_discard(30.0, is_highlight=False, discarded=True, out_path=out, upload=upload)
        assert res["action"] == "discard"
        assert not calls            # no upload
        assert not os.path.exists(out)  # no clip produced
        assert stash.state()["frameCount"] == 0  # stash freed


# --- upload client ----------------------------------------------------------
def test_upload_clip_no_base_returns_error_without_raise():
    res = upload_clip("", "job1", "/tmp/nope.mp4", {"eventType": "GOAL"})
    assert res["ok"] is False
    assert "base" in res["error"].lower()


def test_upload_clip_posts_multipart_to_server(tmp_path):
    import httpx
    captured = {}
    def handler(request):
        captured["url"] = str(request.url)
        captured["body"] = request.content
        return httpx.Response(200, json={"ok": True, "id": "c1", "clipUri": "/clips/c1.mp4"})
    transport = httpx.MockTransport(handler)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"MP4DATA")
    with httpx.Client(transport=transport) as client:
        res = upload_clip("http://server", "job1", str(clip),
                          {"eventType": "GOAL", "score": 80, "outcome": "scoring_play"}, client=client)
    assert res["ok"] is True and res["id"] == "c1"
    # The client must POST exactly the server route the G4 upload contract uses.
    assert captured["url"] == "http://server/jobs/job1/clips"
    body = captured["body"]
    assert b'name="clip"' in body and b'name="metadata"' in body
    assert b"GOAL" in body and b"scoring_play" in body


# --- HTTP endpoints ---------------------------------------------------------
def _client(cfg=None):
    from fastapi.testclient import TestClient
    from app import create_app
    return TestClient(create_app())


def test_stash_endpoint_roundtrip():
    c = _client()
    r = c.post("/stash/start", json={"sessionId": "s1", "streamId": "st1", "jobId": "job1"})
    assert r.status_code == 200 and r.json()["ok"] is True
    # Ingest 31 frames at 3 fps (ts = i/3) so a 10 s trigger window has frames.
    for i in range(0, 91):
        jpeg = base64.b64encode(_jpeg()).decode()
        c.post("/stash/ingest", json={"ts": round(i / 3.0, 3), "seq": i, "jpeg": jpeg})
    s = c.get("/stash/state").json()
    assert s["active"] is True and s["frameCount"] > 0
    p = c.post("/stash/preclip", json={"triggerTs": 20.0}).json()
    assert p["window"]["start"] == 0.0
    assert p["window"]["end"] == 30.0
    assert p["frames"] > 0
    b = c.post("/stash/build", json={"triggerTs": 20.0, "isHighlight": True, "discarded": False, "upload": False}).json()
    assert b["action"] == "build"  # no CLIP_UPLOAD_BASE -> build locally
    assert os.path.exists(b["clipPath"])
    d = c.post("/stash/discard").json()
    assert d["ok"] is True and d["state"]["frameCount"] == 0


def test_stash_ingest_without_start_409():
    c = _client()
    r = c.post("/stash/ingest", json={"ts": 1.0, "seq": 1, "jpeg": ""})
    assert r.status_code == 409
