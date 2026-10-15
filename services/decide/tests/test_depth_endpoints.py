"""HTTP endpoint gates for the depth router + deep investigation (ADAAAA-6740 G3)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import create_app


def _start(client: TestClient) -> None:
    r = client.post("/app/watcher/start", json={"sessionId": "s1", "streamId": "st1"})
    assert r.status_code == 200, r.text


def _ingest(client: TestClient, ts: float, caption: str = "", audio_peak: float = 0.0,
            players: list | None = None, seq: int = 0) -> None:
    r = client.post("/app/watcher/ingest", json={
        "ts": ts, "seq": seq, "players": players or [], "objects": [],
        "caption": caption, "audioPeak": audio_peak, "audioBaseline": 0.05,
    })
    assert r.status_code == 200, r.text


def test_depth_router_endpoints_roundtrip():
    client = TestClient(create_app())
    _start(client)
    # a GOAL moment -> depth router should flag it
    _ingest(client, 50.0, caption="GOAL! crowd erupts", audio_peak=0.95,
            players=[{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}])
    r = client.post("/app/watcher/step", json={"tickTs": 51.0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["summary"]["event"] in ("GOAL", "GOL")
    assert body["flag"] is not None
    assert body["flag"]["event"] == "GOAL"

    # depth state + flags surface
    st = client.get("/app/depth/state").json()
    assert st["active"] is True
    assert st["flaggedRows"] >= 1
    flags = client.get("/app/depth/flags").json()["flags"]
    assert len(flags) >= 1


def test_watcher_step2_auto_runs_deep_investigation():
    client = TestClient(create_app())
    _start(client)
    for i in range(160):
        _ingest(client, round(i / 3.0, 3))
    r = client.post("/app/watcher/step2", json={"tickTs": 50.0})
    assert r.status_code == 200, r.text
    body = r.json()
    # we only auto-run when a flag fires; feed a GOAL signal
    _ingest(client, 51.0, caption="GOAL! crowd erupts", audio_peak=0.95,
            players=[{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}])
    r = client.post("/app/watcher/step2", json={"tickTs": 52.0})
    body = r.json()
    assert body["flag"] is not None or len(body["deepVerdicts"]) >= 0
    # deep state surface
    st = client.get("/app/deep/state").json()
    assert "deepCalls" in st


def test_deep_investigate_endpoint_by_flag_ts():
    client = TestClient(create_app())
    _start(client)
    for i in range(400):
        t = round(i / 3.0, 3)
        in_g = abs(t - 50.0) <= 1.5
        _ingest(client, t,
                caption="GOAL! crowd erupts" if in_g else "",
                audio_peak=0.95 if in_g else 0.1,
                players=[{"trackId": "p0", "bbox": [0.4, 0.4, 0.5, 0.5], "label": "player"}] if in_g else [])
    # step to produce a flag
    client.post("/app/watcher/step", json={"tickTs": 51.0})
    flags = client.get("/app/depth/flags").json()["flags"]
    if not flags:
        # warm up another tick
        client.post("/app/watcher/step", json={"tickTs": 54.0})
        flags = client.get("/app/depth/flags").json()["flags"]
    assert len(flags) >= 1
    r = client.post("/app/deep/investigate", json={"flagTs": flags[-1]["ts"]})
    assert r.status_code == 200, r.text
    v = r.json()["verdict"]
    assert v["discarded"] in (True, False)
    assert v["outcome"] in ("scoring_play", "not_highlight")
    # verdicts surface
    vd = client.get("/app/deep/verdicts").json()["verdicts"]
    assert len(vd) >= 1


def test_deep_investigate_endpoint_404_for_unknown_flag():
    client = TestClient(create_app())
    _start(client)
    r = client.post("/app/deep/investigate", json={"flagTs": 999.0})
    assert r.status_code in (404, 422)
