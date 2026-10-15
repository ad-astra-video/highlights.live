"""Tests for the increment-D /plan HTTP route (ADAAAA-6467).

The decide runner exposes the single-shot what-to-track planner over HTTP
(planogram 4.4 / 7 D) so the server/worker can fire it at stream-start
warm-up + out-of-band re-check — NEVER from the per-frame path.

Rule/stub mode (DECIDE_MODE unset -> "rule") returns a deterministic
safe-default plan so the worker always gets a valid, type-specific,
non-empty-ish contract; the gemma mode path is covered by test_planner /
test_planner_finetune (the planner module's own unit tests), so this file
locks the HTTP contract + mode cap + degrade-to-safe-default behaviour.
"""

from fastapi.testclient import TestClient

from app import create_app, TrackingPlanResponse


def _client():
    return TestClient(create_app())


def test_plan_route_live_mode_clamps_to_3():
    c = _client()
    r = c.post(
        "/plan",
        json={"intent": "goal scoring", "category": "soccer", "mode": "live", "image": "aGk="},
    )
    assert r.status_code == 200
    plan = r.json()
    # Valid, type-specific contract with the LIVE cap (3) applied.
    assert plan["planVersion"] == 1
    assert plan["maxTracks"] == 3
    assert plan["source"] == "planner-fallback"  # rule mode, no gemma
    assert plan["category"] == "soccer"
    assert plan["intent"] == "goal scoring"


def test_plan_route_vod_mode_clamps_to_8():
    c = _client()
    r = c.post("/plan", json={"intent": "plays", "category": "basketball", "mode": "vod"})
    assert r.status_code == 200
    plan = r.json()
    assert plan["maxTracks"] == 8
    assert plan["source"] in ("planner", "planner-fallback")


def test_plan_route_response_schema_is_valid():
    c = _client()
    r = c.post("/plan", json={"intent": "", "category": "", "mode": "live"})
    plan = r.json()
    # Validate against the response model (extra=ignore should tolerate future fields).
    parsed = TrackingPlanResponse.model_validate(plan)
    assert parsed.source in ("planner", "planner-fallback")
    assert parsed.maxTracks in (3, 8)


# --- ADAAAA-6709: /health must stay responsive during a gemma /plan inference ---


def test_health_responds_during_plan_inference(monkeypatch):
    """ADAAAA-6709: a slow /plan gemma inference must NOT block /health.

    Root cause of the decide 404 loop (ADAAAA-6707): the /plan handler called
    ``plan_tracking_with_gemma`` synchronously, stalling uvicorn's single event
    loop for the whole planner inference (up to PLANNER_TIMEOUT_S), so the
    go-livepeer health probe (health_url=/health) timed out and marked the decide
    runner unavailable -> later decide calls 404 "runner not found". The fix
    wraps the planner in ``asyncio.to_thread`` (mirroring the /highlight branch),
    so this test asserts /health returns 200 ok well within the probe timeout
    while a long planner inference is genuinely in-flight.
    """
    import json
    import threading
    import time
    from http.server import BaseHTTPRequestHandler, HTTPServer

    PLAN_SLEEP_S = 5.0  # planner inference duration the fake model "takes"

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            n = int(self.headers.get("content-length", 0))
            self.rfile.read(n)
            # Simulate the long planner inference.
            time.sleep(PLAN_SLEEP_S)
            plan = json.dumps(
                {"maxTracks": 3, "targets": [{"label": "player0", "zone": "mid"}], "reason": "ok"}
            )
            body = json.dumps({"choices": [{"message": {"content": plan}}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        monkeypatch.setenv("DECIDE_MODE", "gemma")
        monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{port}")
        client = TestClient(create_app())

        result = {}

        def do_plan():
            st = time.time()
            r = client.post(
                "/plan",
                json={"intent": "goal scoring", "category": "soccer", "mode": "live", "image": "aGk="},
            )
            result["plan_status"] = r.status_code
            result["plan_elapsed"] = time.time() - st

        th = threading.Thread(target=do_plan, daemon=True)
        th.start()
        # Give the /plan request time to reach the planner and start its sleep.
        time.sleep(1.0)
        # /health must answer fast while the inference is in flight.
        hst = time.time()
        hr = client.get("/health")
        h_elapsed = time.time() - hst
        th.join(timeout=30)
        assert hr.status_code == 200
        assert hr.json().get("status") == "ok"
        assert h_elapsed < 1.0, f"/health took {h_elapsed:.3f}s during plan inference"
        assert result.get("plan_status") == 200
        assert result.get("plan_elapsed", 0) >= PLAN_SLEEP_S  # inference really ran
    finally:
        srv.shutdown()

