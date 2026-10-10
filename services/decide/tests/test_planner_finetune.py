"""Tests for planner increment C — ADAAAA-6464 (child of ADAAAA-6441).

Locks the increment C acceptance on the DECIDE side:
  * the planner injects the fine-tune manifest (detectedClasses + supportedTasks)
    when `loraRef` (or `fineTuneManifest`) is present, reflecting the supported
    task set in the seed;
  * a plan generated with a fine-tune manifest attached is NARROWED so it only
    requests classes the fine-tune actually detects (detected-class manifest);
  * a discovery-pass result is folded into the plan's `discovery` field
    (method + florenceTasks + candidates);
  * manifest loading is robust (missing/bad manifest -> None, never raises).
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from app import planner as planner_mod


# --- manifest loading ----------------------------------------------------------


def test_normalize_finetune_manifest_core_and_alias_keys():
    m = planner_mod.normalize_finetune_manifest(
        {"detectedClasses": ["soccer ball", " player ", "player"], "supportedTasks": ["<OD>", "<OD>"]}
    )
    assert m["detectedClasses"] == ["soccer ball", "player"]  # trimmed + deduped
    assert m["supportedTasks"] == ["<OD>"]
    # backward-compat shorthand
    m2 = planner_mod.normalize_finetune_manifest({"classes": ["ball"], "tasks": ["<OD>"]})
    assert m2["detectedClasses"] == ["ball"] and m2["supportedTasks"] == ["<OD>"]


def test_normalize_finetune_manifest_empty_returns_none():
    assert planner_mod.normalize_finetune_manifest(None) is None
    assert planner_mod.normalize_finetune_manifest({}) is None
    assert planner_mod.normalize_finetune_manifest({"bogus": 1}) is None


def test_load_finetune_manifest_reads_from_lora_ref_dir(tmp_path):
    merged = tmp_path / "lora-model"
    merged.mkdir()
    (merged / "finetune.json").write_text(
        json.dumps({"detectedClasses": ["soccer ball", "player"], "supportedTasks": ["<OD>"]})
    )
    m = planner_mod.load_finetune_manifest(str(merged))
    assert m is not None
    assert "soccer ball" in m["detectedClasses"]
    assert "<OD>" in m["supportedTasks"]


def test_load_finetune_manifest_reads_parent_dir(tmp_path):
    out = tmp_path / "runs"
    out.mkdir()
    lora = out / "Florence-2-base-finetuned-run"
    lora.mkdir()
    (out / "finetune.json").write_text(json.dumps({"detectedClasses": ["player"]}))
    m = planner_mod.load_finetune_manifest(str(lora))
    assert m is not None and m["detectedClasses"] == ["player"]


def test_load_finetune_manifest_missing_returns_none(tmp_path):
    assert planner_mod.load_finetune_manifest(str(tmp_path / "nope")) is None
    assert planner_mod.load_finetune_manifest(None) is None
    assert planner_mod.load_finetune_manifest("") is None


# --- prompt injection ----------------------------------------------------------


def test_build_planner_prompt_injects_finetune_from_lora_ref(tmp_path):
    merged = tmp_path / "lora-model"
    merged.mkdir()
    (merged / "finetune.json").write_text(
        json.dumps(
            {
                "detectedClasses": ["soccer ball", "player"],
                "supportedTasks": ["<OD>", "<DETAILED_CAPTION>"],
            }
        )
    )
    p = planner_mod.build_planner_prompt(
        "track the ball", "soccer", context={"loraRef": str(merged)}
    )
    assert "attached fine-tune manifest" in p
    assert "soccer ball" in p and "player" in p
    assert "FINE-TUNE CONSTRAINT: request ONLY these detected classes" in p
    assert "fine-tune supported tasks:" in p and "<DETAILED_CAPTION>" in p


def test_build_planner_prompt_finetune_manifest_dict_still_works():
    p = planner_mod.build_planner_prompt(
        "track the ball",
        "soccer",
        context={"fineTuneManifest": {"classes": ["soccer ball", "player"]}},
    )
    assert "attached fine-tune manifest" in p and "soccer ball" in p


# --- plan narrowing (only request detected classes) ----------------------------


def test_finetune_narrow_plan_drops_out_of_manifest_classes():
    plan = {
        "targets": [
            {"label": "soccer ball", "role": "ball", "slotPriority": 0},
            {"label": "player", "role": "player", "slotPriority": 1},
            {"label": "hoop", "role": "entity", "slotPriority": 2},
        ],
        "anchor": {"label": "soccer ball", "role": "ball"},
    }
    ft = {"detectedClasses": ["soccer ball", "player"]}
    narrowed = planner_mod._finetune_narrow_plan(plan, ft)
    labels = {t["label"] for t in narrowed["targets"]}
    assert labels == {"soccer ball", "player"}  # "hoop" not in manifest -> dropped
    assert "narrowed to fine-tune detected-class manifest" in (narrowed.get("discovery") or {}).get("notes", "")


def test_finetune_narrow_plan_with_no_detected_classes_keeps_plan():
    plan = {"targets": [{"label": "player", "role": "player"}]}
    narrowed = planner_mod._finetune_narrow_plan(plan, {"supportedTasks": ["<OD>"]})
    assert len(narrowed["targets"]) == 1


def test_fold_discovery_records_method_tasks_candidates():
    plan = {"targets": [{"label": "player", "role": "player"}]}
    disc = {"method": "region", "florenceTasks": ["<REGION_PROPOSAL>"], "candidates": [{"bbox": [0, 0, 1, 1]}], "notes": "one <REGION_PROPOSAL> pass"}
    folded = planner_mod._fold_discovery(plan, disc)
    assert folded["discovery"]["method"] == "region"
    assert folded["discovery"]["florenceTasks"] == ["<REGION_PROPOSAL>"]
    assert folded["discovery"]["candidates"] == [{"bbox": [0, 0, 1, 1]}]


def test_fold_discovery_bad_input_keeps_plan():
    plan = {"targets": [{"label": "player", "role": "player"}]}
    assert planner_mod._fold_discovery(plan, None) == plan
    assert planner_mod._fold_discovery(plan, "junk") == plan


# --- end-to-end single-shot narrowing (fake model server) ----------------------


class _NarrowHandler(BaseHTTPRequestHandler):
    reply = json.dumps(
        {
            "planVersion": 1,
            "category": "soccer",
            "anchor": {"label": "soccer ball", "role": "ball"},
            "targets": [
                {"label": "soccer ball", "role": "ball"},
                {"label": "hoop", "role": "entity"},
            ],
            "discovery": {"method": "od", "florenceTasks": ["<OD>"], "notes": "canned"},
            "maxTracks": 3,
        }
    )

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        data = json.dumps({"choices": [{"message": {"content": self.reply}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # noqa: A002
        pass


def _serve(handler):
    httpd = HTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def test_plan_tracking_narrows_to_finetune_manifest(tmp_path):
    merged = tmp_path / "lora-model"
    merged.mkdir()
    (merged / "finetune.json").write_text(
        json.dumps({"detectedClasses": ["soccer ball"], "supportedTasks": ["<OD>"]})
    )
    httpd, url = _serve(_NarrowHandler)
    try:
        plan = planner_mod.plan_tracking(
            "track the ball",
            "soccer",
            frame={"base64": "aGk="},
            context={"loraRef": str(merged)},
            mode="live",
            url=url,
        )
        assert plan is not None
        labels = {t["label"] for t in plan["targets"]}
        assert labels == {"soccer ball"}  # "hoop" outside manifest dropped
    finally:
        httpd.shutdown()


def test_plan_with_discovery_runs_runner_once_and_folds(tmp_path):
    calls = []

    def runner():
        calls.append(1)
        return {"method": "caption", "florenceTasks": ["<DETAILED_CAPTION>"], "candidates": [{"bbox": [0, 0, 1, 1]}], "notes": "one pass"}

    httpd, url = _serve(_NarrowHandler)
    try:
        plan = planner_mod.plan_with_discovery(
            "track the ball",
            "soccer",
            frame={"base64": "aGk="},
            context={"loraRef": str(tmp_path)},
            mode="live",
            url=url,
            discovery_runner=runner,
        )
        assert len(calls) == 1  # exactly ONE discovery pass at plan cadence
        assert plan["discovery"]["florenceTasks"] == ["<DETAILED_CAPTION>"]
        assert plan["discovery"]["candidates"] == [{"bbox": [0, 0, 1, 1]}]
    finally:
        httpd.shutdown()


def test_plan_with_discovery_failure_degrades_but_plans(tmp_path):
    def runner():
        raise RuntimeError("discovery down")

    httpd, url = _serve(_NarrowHandler)
    try:
        plan = planner_mod.plan_with_discovery(
            "track the ball",
            "soccer",
            mode="live",
            url=url,
            discovery_runner=runner,
        )
        assert plan is not None and plan["source"] == "planner"
    finally:
        httpd.shutdown()


def test_plan_with_discovery_no_runner_plans_without_discovery(tmp_path):
    httpd, url = _serve(_NarrowHandler)
    try:
        plan = planner_mod.plan_with_discovery("x", "soccer", mode="live", url=url, discovery_runner=None)
        assert plan is not None
    finally:
        httpd.shutdown()

