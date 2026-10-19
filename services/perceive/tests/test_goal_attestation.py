"""ADAAAA-7044 — geometry-agnostic goal-attestation detector unit tests.

Locks the honest no-op contract: the ball-in-net attestation is a *measured*
signal produced only by a configured fine-tuned detector. With no env config the
detector is absent (from_config -> None) and the candidate carries no ballInNet
field — it is never fabricated. A configured detector that reports no positive
label (or errors) returns False, never a fabricated True.
"""
import os

from app.goal_attestation import GoalAttestationDetector


def test_from_config_absent_when_unconfigured(monkeypatch):
    # No env config -> attestation is off (strict no-op).
    monkeypatch.delenv("PERCEIVE_GOAL_ATTESTATION_MODEL", raising=False)
    monkeypatch.delenv("PERCEIVE_GOAL_ATTESTATION_LABELS", raising=False)
    assert GoalAttestationDetector.from_config() is None


def test_from_config_absent_when_only_model_set(monkeypatch):
    monkeypatch.setenv("PERCEIVE_GOAL_ATTESTATION_MODEL", "/runs/some-model")
    monkeypatch.delenv("PERCEIVE_GOAL_ATTESTATION_LABELS", raising=False)
    assert GoalAttestationDetector.from_config() is None


def test_from_config_absent_when_only_labels_set(monkeypatch):
    monkeypatch.delenv("PERCEIVE_GOAL_ATTESTATION_MODEL", raising=False)
    monkeypatch.setenv("PERCEIVE_GOAL_ATTESTATION_LABELS", "ball in net")
    assert GoalAttestationDetector.from_config() is None


def test_from_config_present_when_both_set(monkeypatch):
    monkeypatch.setenv("PERCEIVE_GOAL_ATTESTATION_MODEL", "/runs/some-model")
    monkeypatch.setenv("PERCEIVE_GOAL_ATTESTATION_LABELS", "ball in net, goal net")
    det = GoalAttestationDetector.from_config()
    assert det is not None
    assert det.model_dir == "/runs/some-model"
    assert det.labels == ["ball in net", "goal net"]


def test_detect_requires_positive_label():
    # Without a loaded detector (no model dir available in unit env), it must
    # degrade to False, never raise / never fabricate a True.
    det = GoalAttestationDetector(model_dir="/nonexistent", labels=["ball in net"])
    assert det.detect_ball_in_net(None) is False
