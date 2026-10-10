# Discovery pass orchestration (increment C — ADAAAA-6464, child of ADAAAA-6441).
#
# The planner's caption/region DISCOVERY PASS runs here, where Florence-2
# physically executes on the GPU box. It runs ONE caption/region task on a
# representative frame at PLAN / RE-PLAN cadence ONLY — never from the
# per-frame hot path (caption/region tasks are slower than <OD> and would
# break the 1-5 s live budget; plan §4.2 / §7 C).
#
# The caller (worker / server) invokes `run_discovery_pass` when a plan is
# needed for a no-vocab or unfamiliar category, then hands the resulting
# `discovery` block to the decide planner, which folds it into the plan's
# `discovery` field (services/decide/app/planner.py `_fold_discovery`). The
# block records method + florenceTasks so QA can audit which task produced the
# track set and its latency.

from __future__ import annotations

from typing import Any, Optional

from . import florence
from .florence import DISCOVERY_TASKS, discovery_method_for_task, discovery_task

__all__ = ["DISCOVERY_TASKS", "run_discovery_pass", "discovery_block"]


def run_discovery_pass(
    task: str,
    image: "Any",
    lora_ref: Optional[str] = None,
) -> dict:
    """Run ONE discovery pass on a representative frame (plan cadence only).

    `task` is one of ``DISCOVERY_TASKS`` (``<DETAILED_CAPTION>`` /
    ``<MORE_DETAILED_CAPTION>`` / ``<DENSE_REGION_CAPTION>`` /
    ``<REGION_PROPOSAL>``). `image` is an HxWx3 RGB uint8 array. `lora_ref`
    selects the per-stream LoRA detector (finite-tune) when attached.

    Returns a `discovery` block ready to fold into a TrackingPlan::

        {"method": "caption|region", "florenceTasks": ["<...>"],
         "candidates": [...], "notes": "<provenance>"}

    Best-effort: an invalid task returns a ``method: mixed`` block with the
    task recorded; a detector/GPU failure returns an empty candidate set with
    a failing ``notes``. Never raises. Callers MUST invoke this only at plan /
    re-plan cadence — never per frame.
    """
    task_fmt = discovery_task(task) or "<DETAILED_CAPTION>"
    res = florence.discover_candidates(image, task=task_fmt, lora_ref=lora_ref)
    return discovery_block(res)


def discovery_block(res: dict) -> dict:
    """Normalize a Florence-2 discover result into a plan ``discovery`` block."""
    method = res.get("method") or discovery_method_for_task(res.get("task")) or "mixed"
    task = res.get("task") or ""
    tasks = [task] if task else []
    candidates = res.get("regions") or []
    notes = res.get("notes") or f"one {task} pass at plan cadence"
    block: dict[str, Any] = {
        "method": method,
        "florenceTasks": tasks,
        "candidates": candidates,
        "notes": notes,
    }
    return block
