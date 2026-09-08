from __future__ import annotations

import asyncio
import base64
import io
import json
import os

import numpy as np
from fastapi import APIRouter, FastAPI, Header, HTTPException
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .session import SessionRegistry
from .tracker import MAX_TRACKS, foreground_blobs
from .florence import get_detector


class AnalyzeRequest(BaseModel):
    seq: int = Field(ge=0)
    timestamp: float = 0.0
    image: str = ""  # base64 JPEG
    stream_id: str = ""


class SessionCloseResponse(BaseModel):
    closed: str | None = None


def _read_session_id(
    livepeer_session_id: str | None = Header(default=None),
    x_session_id: str | None = Header(default=None),
) -> str:
    # Behind the orchestrator the Livepeer header is injected; direct (dev)
    # calls use X-Session-Id. Neither present -> refuse (no guessing).
    return livepeer_session_id or x_session_id


def create_app() -> FastAPI:
    registry = SessionRegistry(max_sessions=int(os.environ.get("PERCEIVE_CAPACITY", "1")))
    router = APIRouter()

    @router.get("/health")
    async def health():
        # Healthy when the perceive process + tracker are up. Do NOT tie to the
        # decide GPU's state — an unhealthy check would release live sessions.
        mode = os.environ.get("PERCEIVE_MODE", "stub")
        return {"status": "ok", "model": "florence-2" if mode == "florence" else "stub-iou", "slots": MAX_TRACKS}

    @router.post("/analyze")
    async def analyze(
        req: AnalyzeRequest,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id (Livepeer-Session-Id or X-Session-Id)")
        state = registry.get_or_create(sid, req.stream_id)

        objects: list[dict] = []
        detector = get_detector()
        if detector is not None:
            # Real Florence-2: identify objects + bboxes on the frame and feed
            # those into the tracker (instead of background-diff blobs).
            rgb = _decode_rgb(req.image)
            try:
                objects = detector.detect(rgb)
            except Exception as e:  # keep the pipeline alive if the GPU hiccups
                objects = [{"label": "error", "confidence": 0.0, "bbox": [0, 0, 0.001, 0.001]}]
                state.last_florence_error = str(e)
            boxes = [_norm_bbox(o["bbox"]) for o in objects if o.get("bbox")]
        else:
            gray = _decode_gray(req.image)
            boxes = foreground_blobs(gray, state.prev_gray)
            state.prev_gray = gray
            objects = []

        tracks = state.tracker.step(boxes, ts=req.timestamp)
        state.seq = req.seq

        obs = {
            "type": "observation",
            "sessionId": sid,
            "streamId": req.stream_id or state.stream_id,
            "seq": req.seq,
            "timestamp": req.timestamp,
            "tracks": [
                {
                    "trackId": t.track_id,
                    "slot": t.slot,
                    "bbox": list(t.bbox),
                    "kind": t.kind,
                    "lostFrames": t.lost_frames,
                }
                for t in tracks
            ],
            "objects": objects,
            "ocr": [],
        }
        state.recent_frames.append({"seq": req.seq, "timestamp": req.timestamp, "tracks": obs["tracks"]})

        events: list[dict] = [obs]

        cand = state.tracker.candidate(ts=req.timestamp)
        if cand is not None:
            events.append(
                {"type": "candidate", "sessionId": sid, "eventType": cand.event_type, "timestamp": cand.timestamp, "seq": req.seq}
            )

        for q in state.subscribers:
            for e in events:
                try:
                    q.put_nowait(e)
                except Exception:
                    pass
        if cand is not None:
            events = [e for e in events if e["type"] != "observation"]
            return {"candidate": events[0], "observation": obs}
        return obs

    @router.get("/events")
    async def events(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id")
        state = registry.get_or_create(sid)
        q: asyncio.Queue = asyncio.Queue()
        state.subscribers.append(q)

        async def gen():
            try:
                yield {"event": "health", "data": json.dumps({"type": "health", "sessionId": sid, "slots": MAX_TRACKS})}
                while True:
                    item = await q.get()
                    if item is None:
                        break
                    yield {"event": item.get("type", "event"), "data": json.dumps(item)}
            finally:
                if q in state.subscribers:
                    state.subscribers.remove(q)

        return EventSourceResponse(gen())

    @router.get("/session/stats")
    async def stats(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        state = registry.get(sid) if sid else None
        return {
            "sessionId": sid,
            "active": state is not None,
            "seq": state.seq if state else 0,
            "tracks": len(state.tracker.tracks) if state else 0,
            "subscribers": len(state.subscribers) if state else 0,
            "activeSessions": registry.count(),
        }

    @router.post("/session/close")
    async def close(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if sid:
            registry.drop(sid)
        return {"closed": sid}

    app = FastAPI(title="highlights-perceive", version="0.1.0")
    app.state.registry = registry  # exposed for tests / admin tooling

    # Canonical paths at root: go-livepeer strips the `/app` prefix when it
    # proxies `/apps/<runner>/session/<id>/app/<path>` -> forwards `/<path>`.
    app.include_router(router)
    # `/app/*` aliases: direct (non-orchestrator) calls use the `/app` prefix.
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)

    return app


def _decode_rgb(b64: str) -> np.ndarray:
    if not b64:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        raw = base64.b64decode(b64.split(",")[-1])
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        return np.asarray(img, dtype=np.uint8)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad image: {e}") from e


def _norm_bbox(b: list) -> list:
    """Florence-2 bboxes come as 0-999 coordinates; normalize to 0..1 and clamp."""
    try:
        v = [float(x) for x in b][:4]
    except Exception:
        return [0, 0, 0.001, 0.001]
    scale = 1000.0 if max(v) > 1 else 1.0
    out = [min(max(x / scale, 0.0), 1.0) for x in v]
    if out[2] - out[0] < 0.005 or out[3] - out[1] < 0.005:
        # degenerate box -> keep a tiny positive area so the tracker can match
        out[2] = min(out[0] + 0.01, 1.0)
        out[3] = min(out[1] + 0.01, 1.0)
    return out


def _decode_gray(b64: str) -> np.ndarray:
    if not b64:
        raise HTTPException(status_code=400, detail="empty image")
    try:
        raw = base64.b64decode(b64.split(",")[-1])
        img = Image.open(io.BytesIO(raw)).convert("L")
        arr = np.asarray(img, dtype=np.float32)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad image: {e}") from e
    return arr


app = create_app()
