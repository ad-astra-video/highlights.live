from __future__ import annotations

import os

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field

from .decider import decide
from .gemma import decide_with_gemma

HIGH_VALUE_EVENTS = {"KILL", "GOAL", "DUNK", "CLUTCH", "ACE", "PENTAKILL"}


class Evidence(BaseModel):
    trackCount: int = Field(default=0, ge=0, le=2)
    maxVelocity: float = Field(default=0.0, ge=0.0)  # normalized units/frame
    ocrHits: int = Field(default=0, ge=0)


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
