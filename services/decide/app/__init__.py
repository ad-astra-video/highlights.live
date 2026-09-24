from __future__ import annotations

import os

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field

from .decider import decide
from .gemma import decide_with_gemma

HIGH_VALUE_EVENTS = {"KILL", "GOAL", "DUNK", "CLUTCH", "ACE", "PENTAKILL"}


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

    crowdEnergy: float = Field(default=0.0, ge=0.0, le=1.0)
    audioKind: str = Field(default="")
    humansInMotion: int = Field(default=0, ge=0)
    ballSpeedMps: float = Field(default=0.0, ge=0.0)
    ballPossessionId: str = Field(default="")


class Evidence(BaseModel):
    trackCount: int = Field(default=0, ge=0, le=2)
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

    @router.post("/highlight")
    async def highlight(req: HighlightRequest):
        if _is_gemma_mode():
            return decide_with_gemma(
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
        d = decide(
            event_type=req.eventType,
            track_count=req.evidence.trackCount,
            max_velocity=req.evidence.maxVelocity,
            ocr_hits=req.evidence.ocrHits,
        )
        return {
            "isHighlight": d.is_highlight,
            "score": d.score,
            "eventType": req.eventType,
            "reason": d.reason,
            "source": "rule",
        }

    app = FastAPI(title="highlights-decide", version="0.1.0")
    # Canonical at root (go-livepeer strips `/app`); `/app/*` alias for direct calls.
    app.include_router(router)
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)
    return app


app = create_app()
