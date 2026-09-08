from __future__ import annotations

import os

from fastapi import APIRouter, FastAPI
from pydantic import BaseModel, Field

from .decider import decide

HIGH_VALUE_EVENTS = {"KILL", "GOAL", "DUNK", "CLUTCH", "ACE", "PENTAKILL"}


class Evidence(BaseModel):
    trackCount: int = Field(default=0, ge=0, le=2)
    maxVelocity: float = Field(default=0.0, ge=0.0)  # normalized units/frame
    ocrHits: int = Field(default=0, ge=0)


class HighlightRequest(BaseModel):
    sessionId: str
    eventType: str
    timestamp: float
    evidence: Evidence = Field(default_factory=Evidence)
    # up to 4 JPEGs passed out-of-band (multipart) in production; stub ignores.
    images: list = Field(default_factory=list)


def create_app() -> FastAPI:
    router = APIRouter()

    @router.get("/health")
    async def health():
        # For the local stub we're always ready. On GPU the llama-server health
        # gates this. Never tie whether the box can answer to the perceive GPU.
        return {"status": "ok", "model": os.environ.get("DECIDE_MODEL", "stub-rule")}

    @router.post("/highlight")
    async def highlight(req: HighlightRequest):
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
        }

    app = FastAPI(title="highlights-decide", version="0.1.0")
    # Canonical at root (go-livepeer strips `/app`); `/app/*` alias for direct calls.
    app.include_router(router)
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)
    return app


app = create_app()
