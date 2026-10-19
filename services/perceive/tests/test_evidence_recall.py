"""ADAAAA-7008 / ADAAAA-7012 — on-demand perceive recall (`POST /app/evidence`).

The decide-observer contract lets decide recall perceive ON DEMAND for extra
evidence for a moment before finalizing. This locks the perceive side:

- returns the per-frame derived context ALREADY computed by ``process_frame``
  (tracks / objects / ocr) from the session's `frame_seeds` cache, WITHOUT
  re-running the detector — the seed cache is filled by the frame pipeline;
- honours a `centerTs` + `windowS` band and an explicit `startTs`/`endTs`;
- returns ``seeds: []`` (an explicit no-op) when nothing is cached in range or
  when the session is unknown — a no-op recall must NEVER regress a decision.

The endpoint never re-runs the detector, so the test seeds the cache directly
(rather than driving process_frame) to assert the recall-query semantics.
"""
import asyncio
import json

import httpx

from app import create_app


async def _post_evidence(app, sid, payload, expect_status=200):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=10.0) as client:
        r = await client.post(
            "/app/evidence", json=payload, headers={"X-Session-Id": sid}
        )
        assert r.status_code == expect_status, r.text
        return json.loads(r.content)


def test_evidence_returns_seeded_context_for_a_window():
    async def main():
        app = create_app()
        state = app.state.registry.get_or_create("s1", "stream-a")
        state.frame_seeds = {
            10.0: {"ts": 10.0, "tracks": [{"trackId": "t1", "label": "ball"}], "objects": [], "ocr": []},
            11.0: {"ts": 11.0, "tracks": [], "objects": [{"label": "ball"}], "ocr": ["2 - 0"]},
            15.0: {"ts": 15.0, "tracks": [{"trackId": "t2"}], "objects": [], "ocr": []},
        }
        res = await _post_evidence(app, "s1", {"centerTs": 10.5, "windowS": 3.0})
        # Band = [9.0, 12.0] -> ts 10.0 + 11.0 (15.0 excluded).
        seeds = res["seeds"]
        assert [s["ts"] for s in seeds] == [10.0, 11.0]
        assert seeds[0]["tracks"][0]["label"] == "ball"
        assert seeds[1]["ocr"] == ["2 - 0"]
        assert res["centerTs"] == 10.5

    asyncio.run(main())


def test_evidence_honours_explicit_start_end_band():
    async def main():
        app = create_app()
        state = app.state.registry.get_or_create("s2", "stream-b")
        state.frame_seeds = {
            5.0: {"ts": 5.0, "tracks": [], "objects": [], "ocr": []},
            8.0: {"ts": 8.0, "tracks": [], "objects": [], "ocr": ["1 - 0"]},
            12.0: {"ts": 12.0, "tracks": [], "objects": [], "ocr": []},
        }
        res = await _post_evidence(app, "s2", {"startTs": 6.0, "endTs": 10.0})
        assert [s["ts"] for s in res["seeds"]] == [8.0]

    asyncio.run(main())


def test_evidence_noop_when_nothing_cached():
    async def main():
        app = create_app()
        state = app.state.registry.get_or_create("s3", "stream-c")
        state.frame_seeds = {5.0: {"ts": 5.0, "tracks": [], "objects": [], "ocr": []}}
        # A window far from the only cached frame -> no seeds in range (no-op).
        res = await _post_evidence(app, "s3", {"centerTs": 100.0, "windowS": 10.0})
        assert res["seeds"] == []

    asyncio.run(main())


def test_evidence_noop_for_unknown_session():
    async def main():
        app = create_app()
        # No such session -> explicit no-op, never fabricate evidence.
        res = await _post_evidence(app, "no-such-session", {"centerTs": 0.0, "windowS": 10.0})
        assert res["seeds"] == []

    asyncio.run(main())
