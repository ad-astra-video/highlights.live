"""Decide step (stand-in for Gemma 4 12B on GPU hosts).

Deterministic, evidence-driven rule: scores a candidate from ACTUAL pipeline
outputs (track count, matched-track velocity, event type, OCR hits) and labels
a highlight when the score clears a threshold. Real Gemma 12B replaces this
behind the same /app/highlight contract on the decide GPU.
"""
from __future__ import annotations

from dataclasses import dataclass

HIGH_VALUE_EVENTS = {"KILL", "GOAL", "DUNK", "CLUTCH", "ACE", "PENTAKILL", "OVERTAKE", "KO"}
THRESHOLD = 60.0


@dataclass
class Decision:
    is_highlight: bool
    score: float
    reason: str


def decide(
    event_type: str,
    track_count: int = 0,
    max_velocity: float = 0.0,
    ocr_hits: int = 0,
) -> Decision:
    ev = event_type.upper()
    score = 0.0
    parts = []

    if ev in HIGH_VALUE_EVENTS:
        score += 50
        parts.append(f"high-value event {ev}")
    if track_count >= 1:
        score += min(track_count * 10, 20)
        parts.append(f"{track_count} track(s)")
    # sustained/near movement is the strongest visual evidence available
    score += min(max_velocity / 0.5 * 20, 20)
    if max_velocity >= 0.25:
        parts.append(f"fast move {max_velocity:.2f}")
    if ocr_hits:
        score += min(ocr_hits * 5, 10)
        parts.append(f"ocr {ocr_hits}")

    is_hl = score >= THRESHOLD
    reason = "; ".join(parts) if parts else "no strong evidence"
    return Decision(is_highlight=is_hl, score=round(score, 1), reason=reason)
