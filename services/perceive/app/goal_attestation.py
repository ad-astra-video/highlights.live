"""Geometry-agnostic goal-attestation detector (ADAAAA-7044).

The INC-2b / decide-leg I2 ball-outcome signal (``ballOutcome``/``goalCrossed``)
requires a per-camera image->field homography to map the ball box to ground-plane
meters and then apply a standard-pitch goal-line plane. That geometry is
inapplicable to the product's true-goal content on small-sided cages / small
courts where no standard field-line geometry exists — and no honest per-camera
homography can be derived for them (no fabricated/eyeball calibration per the
no-fabrication guardrail).

This module supplies the geometry-AGNOSTIC attestation: a fine-tuned "ball-in-net"
detector that decides whether the ball is actually in the net on a candidate
anchor frame. It is an independent, *measured* visual signal — an additional
criterion the decide goal-attestation gate accepts — and it carries no
field-geometry / homography requirement at all.

Config-gated and honest:

- With neither ``PERCEIVE_GOAL_ATTESTATION_MODEL`` (a merged Florence-2 model
  dir) nor ``PERCEIVE_GOAL_ATTESTATION_LABELS`` (comma-separated positive label
  set) configured, ``GoalAttestationDetector.from_config()`` returns ``None`` and
  the candidate carries NO ``ballInNet`` field — the decide gate then falls back
  to the other criteria (or rejects an unattested accept, as before).
- No signal is ever fabricated: ``detect_ball_in_net`` returns True only when the
  configured detector actually emits a positive label on the frame (the fine-tune
  child supplies that model + label set). Any GPU/transport failure degrades to
  False/None (weak/absent evidence), never raises into the frame path.

The detector runs only on candidate anchor frames (bounded, like the scoreboard
OCR pass), never every frame.
"""
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Optional, Sequence

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .florence import FlorenceDetector

log = logging.getLogger("highlights.perceive.goal_attestation")

# Env knobs. Both must be set for the geometry-agnostic attestation to be active;
# an unconfigured attestation is a strict no-op (no ballInNet field).
_MODEL_ENV = "PERCEIVE_GOAL_ATTESTATION_MODEL"   # merged Florence-2 dir
_LABELS_ENV = "PERCEIVE_GOAL_ATTESTATION_LABELS"  # comma-separated positive labels


class GoalAttestationDetector:
    """Fine-tuned "ball-in-net" goal-attestation detector (geometry-agnostic).

    Wraps a merged Florence-2 detector (loaded from ``model_dir``) and reports
    whether the candidate anchor frame shows the ball in the net (any detection
    whose label is in the configured positive ``labels`` set). No homography,
    no pitch geometry.
    """

    def __init__(self, model_dir: str, labels: Sequence[str]):
        self.model_dir = model_dir
        self.labels = [str(l).strip().lower() for l in labels if str(l).strip()]
        self._detector: Optional[FlorenceDetector] = None

    @classmethod
    def from_config(cls) -> Optional["GoalAttestationDetector"]:
        """Build from env config, or None when not configured (attestation off)."""
        model = (os.environ.get(_MODEL_ENV) or "").strip()
        raw_labels = (os.environ.get(_LABELS_ENV) or "").strip()
        if not model or not raw_labels:
            log.info("goal attestation disabled (need %s + %s)", _MODEL_ENV, _LABELS_ENV)
            return None
        labels = [l.strip() for l in raw_labels.split(",") if l.strip()]
        if not labels:
            return None
        return cls(model_dir=model, labels=labels)

    def _ensure_detector(self) -> Optional[FlorenceDetector]:
        if self._detector is not None:
            return self._detector
        try:
            from .florence import FlorenceDetector

            det = FlorenceDetector(model_path=self.model_dir, device=os.environ.get("PERCEIVE_DEVICE", "auto"))
            det.load()
            self._detector = det
            return det
        except Exception as e:  # noqa: BLE001  (attestation must never kill the frame)
            log.warning("goal attestation detector failed to load: %s", e)
            return None

    def detect_ball_in_net(self, frame) -> bool:
        """True iff the configured detector positively finds a ball-in-net label
        on ``frame`` (HxWx3 RGB uint8). Never raises; any failure -> False."""
        det = self._ensure_detector()
        if det is None:
            return False
        try:
            objs = det.detect(frame, vocabulary=list(self.labels), roi_pass=False)
        except Exception as e:  # noqa: BLE001
            log.warning("ball-in-net detection skipped: %s", e)
            return False
        for o in objs or []:
            lab = str((o or {}).get("label") or "").strip().lower()
            if lab in self.labels:
                return True
        return False
