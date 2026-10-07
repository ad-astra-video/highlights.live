from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, ConfigDict, Field

from .decider import apply_gate, decide
from .gemma import decide_with_gemma


class ReactionEvidence(BaseModel):
    """People-reaction context (INC-4 / ADAAAA-4328) folded into the decide()
    prompt so Gemma can reason about the humans' reaction. This is corroborating
    evidence for the verdict — it never replaces the arbiter (Gemma's multimodal
    read of the frames + audio). All fields default to 'no signal'.

    - crowdEnergy 0..1: peak crowd/commentary energy of the INC-2 audio gate
      (burst/swell) that fired the candidate.
    - audioKind: kind of audio reaction, "burst" | "swell" | "" when none.
    - humansInMotion: cheap visual celebration cue — tracked humans/players in
      high motion around the candidate (proxy; Gemma reasons over the frames).
    - ballSpeedMps / ballPossessionId: optional INC-2b ball context for sharper
      reasons (ball moving fast toward goal, possessor celebrating).
    """

    # ADAAAA-4736/5231: previously le=1.0. Real media (audio gate peakEnergy) can
    # observe >1.0; treat it as evidence, never reject the whole request. The
    # server already clamps its own send to [0,1]; this bound is defensive so a
    # legitimately larger reading is accepted (keep ge=0 only).
    crowdEnergy: float = Field(default=0.0, ge=0.0, le=2.0)
    audioKind: str = Field(default="")
    humansInMotion: int = Field(default=0, ge=0)
    ballSpeedMps: float = Field(default=0.0, ge=0.0)
    ballPossessionId: str = Field(default="")


class Evidence(BaseModel):
    # ADAAAA-4736/5231: previously le=2. Real multi-player tracking observes >2
    # objects; a larger count is legitimate evidence and must not 422 the whole
    # request. Defensive upper bound well above realistic multi-player counts
    # (server clamps its own send to [0,2]; this just tolerates a larger one).
    trackCount: int = Field(default=0, ge=0, le=8)
    maxVelocity: float = Field(default=0.0, ge=0.0)  # normalized units/frame
    ocrHits: int = Field(default=0, ge=0)
    # People-reaction context (INC-4). Optional; absent == no reaction signal,
    # so the prompt renders without it (no regression vs today).
    reaction: ReactionEvidence = Field(default_factory=ReactionEvidence)


class ImageRef(BaseModel):
    role: str = "full"  # full | track0 | track1 | confirm
    base64: str = ""


class HighlightRequest(BaseModel):
    sessionId: str
    eventType: str
    timestamp: float
    gameHint: str = ""
    evidence: Evidence = Field(default_factory=Evidence)
    # JPEGs passed as base64 (full frame + track crops) so the Gemma vision
    # projector can actually see the moment (plan §3.7). Rule mode ignores them.
    images: list[ImageRef] = Field(default_factory=list)
    # Temporal frame window (1 FPS) around the candidate, so Gemma 4 12B reasons
    # across a SEQUENCE (video understand), not a single still. All images are
    # placed BEFORE the text prompt per Gemma 4 12B modality-order guidance.
    frames: list[ImageRef] = Field(default_factory=list)
    # Accompanying audio (mono 16 kHz float32 WAV, base64; <=30s). Placed AFTER
    # the text prompt per Gemma 4 12B guidance. 25 tokens/sec of audio.
    audioB64: str = Field(default="", description="mono 16kHz float32 WAV, base64")
    audioSampleRate: int = Field(default=16000, ge=8000, le=48000)
    # Frontend-selectable; defaults to "none" (thinking off = fast single-shot
    # JSON). Other values (low/medium/high) are passed to llama.cpp verbatim.
    reasoningEffort: str = Field(default="none")


# --- Response contract ------------------------------------------------------
# ADAAAA-6358 (I1): the decide response now carries a reviewer-facing rationale
# on top of the verdict so a board/CTO reviewer can see *why* a clip was kept or
# dropped. All rationale fields are additive and optional on the wire — the
# model populates them, but a pre-I1 / fallback reply still satisfies the model
# (defaults keep the response shape stable). `model_config` is extra-ignore so a
# newer upstream field never 500s the endpoint.


class VerdictCriteria(BaseModel):
    """The explicit goal criteria the model was asked to verify (I1). Each is a
    strict tri-state on the wire: True (seen), False (plainly contradicted),
    None (unverifiable). ``model_dump`` renders the None as JSON null so a
    reviewer can see exactly which criterion could not be confirmed."""

    model_config = ConfigDict(extra="ignore")
    ballCrossedLineBetweenPosts: Optional[bool] = None
    ballInNet: Optional[bool] = None
    scoreboardChanged: Optional[bool] = None
    crowdErupted: Optional[bool] = None


class Verdict(BaseModel):
    """Reviewer-facing rationale (I1): the hypothesis the candidate type
    represented, what the model independently observed *before* considering it,
    the goal criteria it checked, and the evidence that contradicted it."""

    model_config = ConfigDict(extra="ignore")
    hypothesis: Optional[str] = None
    independentlyObserved: Optional[str] = None
    criteria: Optional[VerdictCriteria] = None
    contradictedBy: Optional[str] = None


class AudioContext(BaseModel):
    model_config = ConfigDict(extra="ignore")
    path: str = "none"  # "input_audio" | "asr_text" | "none"
    transcribed: bool = False
    asrRan: bool = False
    asrLatencyS: float = 0.0


class HighlightDecision(BaseModel):
    """The canonical decide response. The verdict fields (isHighlight/score/
    eventType/reason) predate I1; the rationale fields (reasoning/verdict/
    evidenceAttested) are the I1 additions that make a reject explainable
    (off-target shot / warm-up rejected with the contradicting evidence named)."""

    model_config = ConfigDict(extra="ignore")
    isHighlight: bool
    score: float = Field(default=0.0, ge=0.0, le=100.0)
    eventType: Optional[str] = None
    reason: Optional[str] = None
    source: str = "rule"  # "rule" | "gemma" | "rule-fallback"
    # Rule-path classifiers (pre-I1; returned by the deterministic rule so the
    # response contract stays backward compatible now that /highlight declares a
    # response_model — without them `extra=ignore` would silently drop them).
    eventClass: Optional[str] = None
    corroborated: bool = False
    # I1 reviewer-facing rationale (additive).
    reasoning: str = ""
    verdict: Optional[Verdict] = None
    evidenceAttested: list[str] = Field(default_factory=list)
    audioContext: Optional[AudioContext] = None


def _is_gemma_mode() -> bool:
    return os.environ.get("DECIDE_MODE", "rule") == "gemma"


def create_app() -> FastAPI:
    router = APIRouter()

    @router.get("/health")
    async def health():
        # Ready when the process is up. On GPU the llama-server is a separate
        # process (GEMMA_URL); an unhealthy Gemma must not take this runner
        # down/flap — the worker falls back to the rule (plan §3.1 health rule).
        return {
            "status": "ok",
            "model": "gemma-4-12b-it-qat-q4_0" if _is_gemma_mode() else "stub-rule",
        }

    @router.post("/highlight", response_model=HighlightDecision)
    async def highlight(req: HighlightRequest):
        if _is_gemma_mode():
            decision = decide_with_gemma(
                event_type=req.eventType,
                evidence=req.evidence.model_dump(),
                game_hint=req.gameHint,
                images=[img.model_dump() for img in req.images],
                frames=[fr.model_dump() for fr in req.frames],
                audio_b64=req.audioB64,
                audio_sample_rate=req.audioSampleRate,
                reasoning_effort=req.reasoningEffort,
                url=os.environ.get("GEMMA_URL", "http://127.0.0.1:8088"),
            )
            # Notable-only gate on the Gemma verdict (ADAAAA-5778). Pure
            # post-process over signals we already have — isHighlight, score,
            # classified eventType, evidence — so it adds NO inference (same
            # Gemma decide call budget; stricter gate only ever REJECTS). A
            # bare trigger (audio gate / scene change) with no corroborating
            # evidence or a low notability score is refused even when Gemma
            # leaned 'yes'.
            if decision.get("isHighlight"):
                ok, rejects = apply_gate(
                    score=float(decision.get("score") or 0.0),
                    event_type=decision.get("eventType") or req.eventType,
                    track_count=req.evidence.trackCount,
                    max_velocity=req.evidence.maxVelocity,
                    ocr_hits=req.evidence.ocrHits,
                    reaction=req.evidence.reaction.model_dump(),
                )
                if not ok:
                    decision["isHighlight"] = False
                    decision["reason"] = (
                        (decision.get("reason") or "")
                        + "; rejected by notable-only bar: "
                        + "; ".join(rejects)
                    ).strip("; ")
            return decision
        ev = req.evidence.reaction.model_dump() if req.evidence.reaction else None
        d = decide(
            event_type=req.eventType,
            track_count=req.evidence.trackCount,
            max_velocity=req.evidence.maxVelocity,
            ocr_hits=req.evidence.ocrHits,
            reaction=ev,
        )
        return {
            "isHighlight": d.is_highlight,
            "score": d.score,
            "eventType": req.eventType,
            "reason": d.reason,
            "source": "rule",
            "eventClass": d.event_class,
            "corroborated": d.corroborated,
        }

    app = FastAPI(title="highlights-decide", version="0.1.0")
    # Canonical at root (go-livepeer strips `/app`); `/app/*` alias for direct calls.
    app.include_router(router)
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)
    return app


app = create_app()
