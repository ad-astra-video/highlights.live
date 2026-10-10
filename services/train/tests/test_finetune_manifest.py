"""Tests for the fine-tune manifest (increment C — ADAAAA-6464).

Locks that services/train produces `finetune.json` next to the LoRA artifact
with the fine-tune's detected classes + supported task set, so the planner can
inject it when `loraRef` is present (plan §7 C).
"""
import json

import fine_tune_od as ft


def test_write_finetune_manifest_writes_detected_classes_and_tasks(tmp_path):
    out = tmp_path / "runs"
    merged = out / "Florence-2-base-finetuned-run"
    merged.mkdir(parents=True, exist_ok=True)
    vocab = ["player", "soccer ball", "goalkeeper"]
    p = ft.write_finetune_manifest(
        out, merged, vocab, "microsoft/Florence-2-base", "run1", 16, 32
    )
    # Written in both the out dir (next to the named adapter) and the merged dir
    # (the dir loraRef points at) so the planner can find it deterministically.
    assert p == out / "finetune.json"
    assert (merged / "finetune.json").exists()
    manifest = json.loads((merged / "finetune.json").read_text())
    assert manifest["detectedClasses"] == vocab
    assert manifest["supportedTasks"] == ft.SUPPORTED_TASKS
    assert manifest["trainedTasks"] == ["<OD>"]
    assert manifest["lora"] == {"rank": 16, "alpha": 32}
    assert manifest["baseModel"] == "microsoft/Florence-2-base"


def test_write_finetune_manifest_drops_empty_vocab_entries(tmp_path):
    out = tmp_path / "runs"
    merged = out / "m"
    merged.mkdir(parents=True, exist_ok=True)
    ft.write_finetune_manifest(out, merged, ["player", "", "  "], "base", "r", 16, 32)
    manifest = json.loads((out / "finetune.json").read_text())
    assert manifest["detectedClasses"] == ["player"]
