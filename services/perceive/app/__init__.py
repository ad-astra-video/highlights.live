from __future__ import annotations

import asyncio
import base64
import io
import json
import os
from time import monotonic

import numpy as np
from fastapi import APIRouter, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from .session import SessionRegistry
from .tracker import MAX_TRACKS, foreground_blobs
from .florence import capability, get_detector, record_analyze
from .sam_tracker import HybridTracker


class AnalyzeRequest(BaseModel):
    seq: int = Field(ge=0)
    timestamp: float = 0.0
    image: str = ""  # base64 JPEG
    stream_id: str = ""
    # Per-JOB full recorded stream this session should track against (SAM).
    clip_path: str = ""


class SessionCloseResponse(BaseModel):
    closed: str | None = None


def _read_session_id(
    livepeer_session_id: str | None = Header(default=None),
    x_session_id: str | None = Header(default=None),
) -> str:
    # Behind the orchestrator the Livepeer header is injected; direct (dev)
    # calls use X-Session-Id. Neither present -> refuse (no guessing).
    return livepeer_session_id or x_session_id


def process_frame(state, seq: int, timestamp: float, image_b64: str) -> tuple[dict, dict | None]:
    """Run one sampled frame through the shared perceive pipeline: Florence or
    background-diff detection -> tracker.step -> observation (+ candidate).

    The SAME function backs HTTP /analyze, control `analyze-still`, and (future)
    trickle `video-in` — one `session.step(frame)` per front door (plan §3.5).
    Returns (observation_dict, candidate_dict|None). Enqueues both onto any SSE
    subscribers bound to the session.
    """
    objects: list[dict] = []
    detector = get_detector()
    if detector is not None:
        # Real Florence-2: identify objects + bboxes and feed them to the tracker.
        try:
            _s = monotonic()
            objects = detector.detect(state.last_rgb)
            record_analyze(monotonic() - _s)
        except Exception as e:  # keep the pipeline alive if the GPU hiccups
            objects = [{"label": "error", "confidence": 0.0, "bbox": [0, 0, 0.001, 0.001]}]
            state.last_florence_error = str(e)
        boxes = [_norm_bbox(o["bbox"]) for o in objects if o.get("bbox")]
    else:
        # stub path: background-diff blobs from the grayscale frame
        gray = _decode_gray(image_b64)
        boxes = foreground_blobs(gray, state.prev_gray)
        state.prev_gray = gray

    if isinstance(state.tracker, HybridTracker) and state.last_rgb is not None:
        if state.tracker._detect is None:
            _d = detector
            state.tracker._detect = lambda rgb, _d=_d: [_norm_bbox(o["bbox"]) for o in (_d.detect(rgb) if _d else []) if o.get("bbox")]
        tracks = state.tracker.step_frame(state.last_rgb, timestamp, boxes)
    else:
        tracks = state.tracker.step(boxes, timestamp)
    state.seq = seq

    obs = {
        "type": "observation",
        "sessionId": state.session_id,
        "streamId": state.stream_id,
        "seq": seq,
        "timestamp": timestamp,
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
    state.recent_frames.append({"seq": seq, "timestamp": timestamp, "tracks": obs["tracks"]})

    events: list[dict] = [obs]
    cand = state.tracker.candidate(ts=timestamp)
    cand_dict = None
    if cand is not None:
        # Return a plain dict (JSON-serializable) so callers can embed it in a
        # response/ack without reaching into the dataclass.
        cand_dict = {"eventType": cand.event_type, "timestamp": cand.timestamp, "trackId": cand.track_id}
        events.append({"type": "candidate", "sessionId": state.session_id, **cand_dict, "seq": seq})
    for q in state.subscribers:
        for e in events:
            try:
                q.put_nowait(e)
            except Exception:
                pass
    return obs, cand_dict


def handle_control(state, msg: dict) -> dict:
    """Apply a ControlMessage (shared schema, plan §3.4) and return an ack
    object. Shared by the WebSocket control channel and (future) trickle control."""
    ctype = msg.get("type")
    if ctype == "ping":
        return {"type": "ack", "ok": True, "cmd": "ping", "pong": True}
    if ctype == "configure":
        if "preferLabels" in msg:
            state.prefer_labels = list(msg["preferLabels"])
        if "sampleFps" in msg and msg.get("sampleFps", 0) > 0:
            state.sample_fps = float(msg["sampleFps"])
        if msg.get("gameHint") is not None:
            state.game_hint = str(msg["gameHint"])
        return {"type": "ack", "ok": True, "cmd": "configure", "preferLabels": state.prefer_labels, "sampleFps": state.sample_fps}
    if ctype == "seed":
        bbox = msg.get("bbox")
        if not bbox or len(bbox) != 4:
            return {"type": "ack", "ok": False, "cmd": "seed", "error": "bbox required (4 numbers)"}
        slot = msg.get("slot")
        kind = msg.get("kind") or "unknown"
        label = msg.get("label") or ""
        tr = state.tracker.seed(tuple(bbox), kind=kind, label=label, slot=slot)
        return {"type": "ack", "ok": True, "cmd": "seed", "slot": tr.slot, "trackId": tr.track_id}
    if ctype == "evict":
        slot = msg.get("slot")
        if slot not in (0, 1):
            return {"type": "ack", "ok": False, "cmd": "evict", "error": "slot must be 0|1"}
        removed = state.tracker.evict(slot)
        return {"type": "ack", "ok": True, "cmd": "evict", "slot": slot, "removed": removed}
    if ctype == "lock":
        slot = msg.get("slot")
        if slot not in (0, 1):
            return {"type": "ack", "ok": False, "cmd": "lock", "error": "slot must be 0|1"}
        state.tracker.lock(slot)
        return {"type": "ack", "ok": True, "cmd": "lock", "slot": slot}
    if ctype == "analyze-still":
        if state.last_image_b64 and state.last_rgb is not None:
            obs, cand = process_frame(state, state.seq + 1, float(msg.get("timestamp", 0.0)), state.last_image_b64)
            return {"type": "ack", "ok": True, "cmd": "analyze-still", "observation": obs, "candidate": cand}
        return {"type": "ack", "ok": False, "cmd": "analyze-still", "error": "no frame sampled yet"}
    if ctype == "confirm":
        # Server-side confirm window (extract T±pre/post at 8fps). The runner
        # acknowledges; the worker decides when to request it. Full 8fps
        # confirm extraction is a worker-side concern (plan §0.3/§3.3).
        return {"type": "ack", "ok": True, "cmd": "confirm", "timestamp": msg.get("timestamp"), "pre": msg.get("pre"), "post": msg.get("post")}
    if ctype == "clip":
        # Clip cutting is CPU/worker-side (server ffmpeg); runner just acks.
        return {"type": "ack", "ok": True, "cmd": "clip", "start": msg.get("start"), "end": msg.get("end")}
    return {"type": "ack", "ok": False, "cmd": ctype or "?", "error": "unknown control type"}


def create_app() -> FastAPI:
    registry = SessionRegistry(max_sessions=int(os.environ.get("PERCEIVE_CAPACITY", "1")))
    router = APIRouter()

    @router.get("/health")
    async def health():
        # Healthy when the perceive process + tracker are up. Do NOT tie to the
        # decide GPU's state — an unhealthy check would release live sessions.
        mode = os.environ.get("PERCEIVE_MODE", "stub")
        cap = capability()
        return {
            "status": "ok",
            "model": "florence-2" if mode == "florence" else "stub-iou",
            "slots": MAX_TRACKS,
            **cap,
        }

    @router.post("/analyze")
    async def analyze(
        req: AnalyzeRequest,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id (Livepeer-Session-Id or X-Session-Id)")
        state = registry.get_or_create(sid, req.stream_id, req.clip_path)
        state.stream_id = req.stream_id or state.stream_id

        # Keep the latest raw frame so control `analyze-still` and any future
        # trickle video-in can re-run the exact same step() on it.
        if req.image:
            state.last_rgb = _decode_rgb(req.image)
            state.last_image_b64 = req.image

        obs, cand = process_frame(state, req.seq, req.timestamp, req.image)
        if cand is not None:
            return {"candidate": {"type": "candidate", "sessionId": sid, "eventType": cand["eventType"], "timestamp": cand["timestamp"], "seq": req.seq}, "observation": obs}
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

    @router.websocket("/ws")
    async def ws(websocket: WebSocket):
        # Bind to an EXISTING session (Livepeer-Session-Id injected by the
        # orchestrator proxy; X-Session-Id / ?session_id= for direct dev).
        # Per §3.9 reject a WS that tries to create a new session: an operator
        # console attaches to a session the worker already reserved.
        sid = (
            websocket.headers.get("livepeer-session-id")
            or websocket.headers.get("x-session-id")
            or websocket.query_params.get("session_id")
            or ""
        )
        if not sid or registry.get(sid) is None:
            await websocket.close(code=4001, reason="no such session (bind to a reserved perceive session)")
            return
        state = registry.get(sid)
        await websocket.accept()
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    await websocket.send_text(json.dumps({"type": "ack", "ok": False, "cmd": "?", "error": "invalid json"}))
                    continue
                ack = handle_control(state, msg)
                await websocket.send_text(json.dumps(ack))
        except WebSocketDisconnect:
            pass

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
