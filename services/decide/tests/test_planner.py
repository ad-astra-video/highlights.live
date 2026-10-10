"""Tests for the what-to-track planner call path (increment A — ADAAAA-6462,
child of ADAAAA-6441).

Locks increment A acceptance on the DECIDE side:
  * planner_prompt ships the FULL Florence-2 task table, the latency split,
    the Detector->Tracker dependency, the frame-watcher wording, and every
    supported category (plan §7 A capability-seed requirements);
  * planner_mod.plan_tracking is a single-shot (intent, category, representative frame,
    context) -> TrackingPlan call against a /v1/chat/completions-style model
    endpoint, validating the reply against the perceive contract;
  * the server-side maxTracks clamp (3 live / 8 VOD) is applied to the
    returned plan;
  * on ANY failure (unreachable model, non-JSON reply, invalid plan) the
    caller gets the fallback with source "planner-fallback" — never None,
    never an exception;
  * gemma.plan_tracking_with_gemma is the call path invoked alongside
    decide_with_gemma, exported from the decide app package.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from app import planner as planner_mod  # noqa: E402
from app import planner_prompt  # noqa: E402


# --- the capability seed (plan §7 A: the seed is the auditable deliverable) --


def test_seed_covers_full_florence_task_table():
    for token in (
        "<OD>",
        "<CAPTION>",
        "<DETAILED_CAPTION>",
        "<MORE_DETAILED_CAPTION>",
        "<DENSE_REGION_CAPTION>",
        "<REGION_PROPOSAL>",
        "<CAPTION_TO_PHRASE_GROUNDING>",
        "<REFERRING_EXPRESSION_SEGMENTATION>",
        "<OCR>",
    ):
        assert planner_prompt.seed_contains(token), f"seed missing {token}"


def test_seed_states_latency_split():
    seed = planner_prompt.PLANNER_SEED
    assert "5-10 fps" in seed  # OD fast
    assert "slower than OD" in seed or "SLOWER" in seed  # caption/region slower
    assert "NEVER in the per-frame" in seed or "per-frame" in seed


def test_seed_states_detector_tracker_dependency_and_frame_watcher():
    seed = planner_prompt.PLANNER_SEED
    assert "SAM3" in seed and "Florence-2" in seed
    assert "SEED" in seed  # SAM3 tracks what it is seeded with
    assert "frame-watcher" in seed.lower() or "Frame-watcher" in seed


def test_seed_covers_every_supported_category():
    seed = planner_prompt.PLANNER_SEED
    for cat in (
        "Soccer",
        "Football",
        "Basketball",
        "FPS",
        "Battle Royale",
        "MOBA",
        "Esports",
        "General",
    ):
        assert cat in seed, f"seed missing category guidance for {cat}"


def test_seed_forbids_ui_hud_and_abstract_targets():
    seed = planner_prompt.PLANNER_SEED
    assert "NEVER request UI/HUD" in seed
    assert "NEVER request abstract" in seed


def test_task_table_lines_render_all_tasks():
    lines = planner_prompt.task_table_lines()
    assert len(lines) == 2 + len(planner_prompt.FLORENCE_TASK_TABLE)
    joined = "\n".join(lines)
    assert "<OCR>" in joined and "<OD>" in joined


# --- parse / validate units ---------------------------------------------------


def test_parse_plan_plain_and_fenced():
    plan = {"planVersion": 1, "targets": [{"label": "soccer ball", "role": "ball"}]}
    assert planner_mod.parse_plan(json.dumps(plan)) == plan
    assert planner_mod.parse_plan(f"```json\n{json.dumps(plan)}\n```") == plan


def test_parse_plan_garbage_returns_none():
    assert planner_mod.parse_plan("no json here") is None
    assert planner_mod.parse_plan("[1, 2, 3]") is None  # not an object


def test_validate_plan_requires_trackable_targets():
    ok, _ = planner_mod.validate_plan({"targets": [{"label": "atmosphere", "role": "entity"}]})
    assert not ok
    ok, _ = planner_mod.validate_plan(
        {"anchor": {"label": "soccer ball", "role": "ball"}, "targets": [{"label": "soccer ball", "role": "ball"}]}
    )
    assert ok


def test_perceive_contract_is_importable_in_this_test_image():
    # The deployed topology shares the source tree; these tests run from the
    # same checkout, so the single-source-of-truth validator must be active.
    assert planner_mod._TRACKING_PLAN_AVAILABLE


# --- prompt building ------------------------------------------------------------


def test_build_planner_prompt_carries_seed_intent_and_context():
    p = planner_mod.build_planner_prompt(
        "highlight goals",
        "soccer",
        context={"mode": "live", "gameHint": "soccer"},
        max_tracks_proposal=3,
    )
    assert p.startswith(planner_prompt.PLANNER_SEED)
    assert "user intent: highlight goals" in p
    assert "video category: soccer" in p
    assert "session mode: live" in p
    assert "track slot cap 3" in p
    assert "game hint: soccer" in p
    assert "representative frame" in p.lower()


def test_build_planner_prompt_injects_fine_tune_manifest_and_prior_plan():
    p = planner_mod.build_planner_prompt(
        "track the ball",
        "soccer",
        context={
            "mode": "vod",
            "fineTuneManifest": {"classes": ["soccer ball", "player"]},
            "previousPlan": {"maxTracks": 3},
        },
    )
    assert "fine-tune manifest" in p and "soccer ball" in p
    assert "previous plan is active" in p
    assert "session mode: vod" in p


# --- the single-shot call path (fake model server) ------------------------------


class _FakePlannerHandler(BaseHTTPRequestHandler):
    reply = json.dumps(
        {
            "planVersion": 1,
            "category": "soccer",
            "intent": "highlight goals",
            "anchor": {"label": "soccer ball", "role": "ball"},
            "targets": [
                {"label": "soccer ball", "role": "ball", "slotPriority": 0, "track": True},
                {"label": "player", "role": "player", "slotPriority": 1, "track": True},
            ],
            "zones": [],
            "discovery": {"method": "od", "florenceTasks": ["<OD>"], "notes": "canned"},
            "maxTracks": 99,  # over-request: the clamp must enforce the cap
            "reason": "ball + players carry the intent",
        }
    )
    saw_payload: dict | None = None

    def do_POST(self):
        assert self.path == "/v1/chat/completions"
        body = self.rfile.read(int(self.headers["Content-Length"]))
        type(self).saw_payload = json.loads(body)
        data = json.dumps(
            {"choices": [{"message": {"content": self.reply}}]}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002
        pass


def _serve(handler):
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def test_plan_tracking_single_shot_returns_clamped_valid_plan():
    httpd, url = _serve(_FakePlannerHandler)
    try:
        plan = planner_mod.plan_tracking(
            "highlight goals",
            "soccer",
            frame={"base64": "aGk="},
            context={"gameHint": "soccer"},
            mode="live",
            url=url,
        )
        assert plan is not None
        assert plan["source"] == "planner"
        assert plan["maxTracks"] == 3  # 99 proposed, clamped to the live cap
        assert plan["anchor"]["label"] in {t["label"] for t in plan["targets"]}
        assert "plannedAt" in plan
        payload = _FakePlannerHandler.saw_payload
        assert payload is not None
        assert payload["stream"] is False and payload["temperature"] == 0.0
        assert payload["reasoning_effort"] == "none"
        # single representative frame, before the text (multimodal content list)
        content = payload["messages"][0]["content"]
        assert content[0]["type"] == "image_url"
        assert "data:image/jpeg;base64,aGk=" in content[0]["image_url"]["url"]
        assert content[-1]["type"] == "text"
        assert planner_prompt.PLANNER_SEED in content[-1]["text"]
    finally:
        httpd.shutdown()


def test_plan_tracking_vod_cap_allows_8():
    class VodHandler(_FakePlannerHandler):
        reply = "```json\n" + json.dumps(
            {
                "anchor": {"label": "basketball", "role": "ball"},
                "targets": [{"label": "basketball", "role": "ball"}, {"label": "player", "role": "player"}],
                "maxTracks": 8,
            }
        ) + "\n```"

    httpd, url = _serve(VodHandler)
    try:
        plan = planner_mod.plan_tracking("deep VOD", "basketball", mode="vod", url=url)
        assert plan is not None and plan["maxTracks"] == 8
    finally:
        httpd.shutdown()


def test_plan_tracking_invalid_reply_returns_none():
    class BadReplyHandler(_FakePlannerHandler):
        reply = json.dumps(
            {"anchor": {"label": "mood", "role": "zone"}, "targets": [{"label": "atmosphere", "role": "entity"}]}
        )

    httpd, url = _serve(BadReplyHandler)
    try:
        assert planner_mod.plan_tracking("x", "soccer", mode="live", url=url) is None
    finally:
        httpd.shutdown()


def test_plan_tracking_garbage_reply_returns_none():
    class GarbageHandler(_FakePlannerHandler):
        reply = "I cannot produce JSON right now."

    httpd, url = _serve(GarbageHandler)
    try:
        assert planner_mod.plan_tracking("x", "soccer", mode="live", url=url) is None
    finally:
        httpd.shutdown()


def test_plan_tracking_unreachable_model_returns_none():
    assert planner_mod.plan_tracking("x", "soccer", mode="live", url="http://127.0.0.1:1", timeout_s=0.2) is None


# --- fallback guarantee (never None / never kills the stream) -------------------


CANNED = {
    "planVersion": 1,
    "category": "soccer",
    "anchor": {"label": "soccer ball", "role": "ball"},
    "targets": [{"label": "soccer ball", "role": "ball"}, {"label": "player", "role": "player"}],
    "maxTracks": 3,
}


def test_plan_with_fallback_returns_fallback_on_unreachable_model():
    out = planner_mod.plan_with_fallback(
        "x", "soccer", mode="live", url="http://127.0.0.1:1", timeout_s=0.2, fallback=CANNED
    )
    assert out["source"] == "planner-fallback"
    assert out["maxTracks"] == 3
    assert out["targets"][0]["label"] == "soccer ball"
    assert "plannedAt" in out


def test_plan_with_fallback_no_fallback_gives_safe_empty_plan():
    out = planner_mod.plan_with_fallback("x", "soccer", mode="vod", url="http://127.0.0.1:1", timeout_s=0.2)
    assert out["source"] == "planner-fallback"
    assert out["targets"] == []
    assert out["maxTracks"] == 8  # vod cap
    assert out["anchor"]["label"] == ""


def test_plan_with_fallback_success_carries_planner_source():
    httpd, url = _serve(_FakePlannerHandler)
    try:
        out = planner_mod.plan_with_fallback("x", "soccer", mode="live", url=url, fallback=CANNED)
        assert out["source"] == "planner"
    finally:
        httpd.shutdown()


# --- the gemma call-path entry point --------------------------------------------


def test_gemma_exposes_plan_tracking_path_alongside_decide_with_gemma():
    import app as app_mod
    from app.gemma import decide_with_gemma, plan_tracking_with_gemma

    assert callable(plan_tracking_with_gemma) and callable(decide_with_gemma)
    assert app_mod.plan_tracking_with_gemma is plan_tracking_with_gemma


def test_plan_tracking_with_gemma_fallback_contract():
    from app.gemma import plan_tracking_with_gemma

    out = plan_tracking_with_gemma(
        "x",
        "soccer",
        mode="live",
        url="http://127.0.0.1:1",
        timeout_s=0.2,
        fallback=CANNED,
    )
    assert out["source"] == "planner-fallback"
    assert out["maxTracks"] == 3
    assert out["targets"]