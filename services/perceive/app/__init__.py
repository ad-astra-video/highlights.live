from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import threading
from time import monotonic

log = logging.getLogger("highlights.perceive.trickle")

import numpy as np
from fastapi import APIRouter, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from . import preload  # noqa: E402  (startup model preload)
from .audio_gate import AudioEnergyGate
from .session import SessionRegistry
from .tracker import MAX_TRACKS, foreground_blobs
from .florence import capability, get_detector, record_analyze, resolve_vocabulary, sport_specific_event_type
from .sam_tracker import HybridTracker
from .trickle import TrickleError, TrickleRail, TrickleSession
from .ball_signal import BallSignalPipeline, is_ball_label
from .zone_trigger import DetectionZoneTrigger, resolve_zones

# One live trickle session per perceive session (plan §0.1 session rule).
_trickle: dict[str, TrickleSession] = {}
# Serialize detector/SAM passes: the event-loop's HTTP /analyze and the trickle
# subscriber's worker thread share one Florence detector / SAM backend.
_gpu_lock = threading.Lock()


def _trickle_enabled() -> bool:
    return os.environ.get("PERCEIVE_TRICKLE", "1").lower() not in ("0", "false", "off")


async def _trickle_on_frame(state, seq: int, image_b64: str, timestamp: float) -> dict:
    """Feed a trickle video-in frame through the SAME session.step() used by
    HTTP /analyze (plan §3.5 — one front door per frame). Runs off the event
    loop and serialized on the shared detector so frame bursts don't block the
    rail's control subscriber nor race the GPU."""

    def _run() -> dict:
        with _gpu_lock:
            state.last_rgb = _decode_rgb(image_b64)
            state.last_image_b64 = image_b64
            obs, _cand = process_frame(state, seq, timestamp, image_b64)
        return obs

    return await asyncio.to_thread(_run)


async def _analyze_offloop(
    state, seq: int, timestamp: float, image_b64: str
) -> tuple[dict, dict | None]:
    """Run one HTTP /analyze through the same pipeline as trickle video-in —
    OFF the asyncio event loop and serialized on the shared GPU lock.

    Why this matters (VOD 404 "runner not found", ADAAAA-3305): starting a fresh
    SAM 3 backend builds the GPU predictor (`build_sam3_video_predictor`) and
    opens its clip session — a multi-second BLOCKING operation. If it runs on
    the event loop, the whole process (including /health) stalls for seconds.
    The orchestrator health-probes perceive every ~5s; a stall that long makes
    it mark the runner unavailable and RELEASE the live session mid-pass, so the
    next proxied app call returns 404 "runner not found" from go-livepeer. By
    running analyze off-loop (same as trickle already does), /health always
    answers and the live session stays reserved for the whole VOD pass."""

    def _run() -> tuple[dict, dict | None]:
        with _gpu_lock:
            return process_frame(state, seq, timestamp, image_b64)

    return await asyncio.to_thread(_run)


async def _ensure_trickle(
    state, control_url: str, token: str, route: str = ""
) -> TrickleSession | None:
    """Open + start this session's trickle rail when it has a control URL and
    trickle is enabled. Idempotent per session. On failure (e.g. no broker)
    the session simply stays on its HTTP front door — never fatal."""
    if not control_url or not _trickle_enabled():
        log.warning("trickle skip control_url=%r enabled=%s", control_url, _trickle_enabled())
        return None
    existing = _trickle.get(state.session_id)
    if existing is not None:
        return existing
    log.info("trickle open session=%s control=%s route=%r", state.session_id, control_url, route)
    rail = TrickleRail(
        control_url=control_url,
        session_id=state.session_id,
        token=token or "",
        route=route,
    )
    sess = TrickleSession(
        rail,
        on_frame=lambda seq, b64, ts: _trickle_on_frame(state, seq, b64, ts),
        on_control=lambda msg: handle_control(state, msg),
    )
    try:
        await sess.start()
    except TrickleError as e:
        log.warning("trickle open failed for session=%s: %s", state.session_id, e)
        await rail.aclose()
        return None
    except Exception as e:  # noqa: BLE001
        log.warning("trickle start threw for session=%s: %r", state.session_id, e)
        try:
            await rail.aclose()
        except Exception:
            pass
        return None
    _trickle[state.session_id] = sess
    return sess


async def _stop_trickle(session_id: str) -> None:
    sess = _trickle.pop(session_id, None)
    if sess is not None:
        await sess.close()


class AnalyzeRequest(BaseModel):
    seq: int = Field(ge=0)
    timestamp: float = 0.0
    image: str = ""  # base64 JPEG
    stream_id: str = ""
    # Per-JOB full recorded stream this session should track against (SAM).
    clip_path: str = ""
    # Closed-vocabulary delivery (ADAAAA-4109): the paid/orchestrator VOD worker
    # sends the job's gameHint/preferLabels on every /analyze so a fresh (or
    # re-reserved) session activates resolve_vocabulary() before frames run.
    # The worker includes them on every call so a session loss + re-reserve
    # carries the config automatically; perceive just re-applies them.
    # Field names are CAMEL case to match the over-the-wire contract the VOD
    # worker sends (mirrors handle_control's configure message keys).
    gameHint: str = ""
    # PreferLabels delivered as a JSON array; a valid empty array clears.
    preferLabels: list[str] = Field(default_factory=list)


class AudioChunkRequest(BaseModel):
    """One audio chunk for the Stage-A noise-change gate (INC-2 / ADAAAA-4325).

    The server's ffmpeg audio tap decodes the stream's audio track and POSTs
    short mono chunks (default ~100 ms at the gate's native cadence, so a
    burst/swell fires inside the live 1-5 s budget without waiting on the
    1 fps video /analyze). ``samples`` is base64 of planar mono int16
    little-endian PCM (ffmpeg ``-ac 1 -c:a pcm_s16le -f s16le``), which the
    gate's RMS energy normalizes — sample rate is not needed for the metric.
    """

    timestamp: float = 0.0  # seconds from stream start (this chunk's end)
    samples: str = ""       # base64 int16 mono LE PCM
    stream_id: str = ""
    seq: int = Field(default=-1)  # optional; <0 -> per-session auto counter


class SessionCloseResponse(BaseModel):
    closed: str | None = None


def _read_session_id(
    livepeer_session_id: str | None = Header(default=None),
    x_session_id: str | None = Header(default=None),
) -> str:
    # Behind the orchestrator the Livepeer header is injected; direct (dev)
    # calls use X-Session-Id. Neither present -> refuse (no guessing).
    return livepeer_session_id or x_session_id


def _env_homography() -> np.ndarray | None:
    """Optional global image->field pitch homography from env (3x3 JSON).

    A per-session calibration (control `configure` homography) wins over this.
    Expected as a JSON array of 9 floats (row-major). Unparseable / absent ->
    None, so the ball signal falls back to image space (homography: false).
    """
    raw = os.environ.get("PERCEIVE_PITCH_HOMOGRAPHY", "").strip()
    if not raw:
        return None
    try:
        arr = json.loads(raw)
        m = np.array(arr, dtype=float).reshape(3, 3)
        return m
    except Exception:  # noqa: BLE001
        log.warning("PERCEIVE_PITCH_HOMOGRAPHY unparseable; ignoring")
        return None


def _ensure_ball_signal(state) -> BallSignalPipeline | None:
    """Lazily build this session's ball-signal pipeline (idempotent).

    Uses the session's homography when set (control `configure`), else the env
    default. Returns the pipeline; it never raises -- a calibration problem
    degrades the signal, never the frame/candidate path.
    """
    if state.ball_signal is not None:
        return state.ball_signal
    H = state.homography if state.homography is not None else _env_homography()
    state.homography = H
    state.ball_signal = BallSignalPipeline(H=H)
    return state.ball_signal


def _ensure_zone_trigger(state) -> DetectionZoneTrigger | None:
    """Lazily build this session's detection-in-zone Stage-A trigger.

    Zones are resolved from the session's current gameHint (soccer -> goal
    mouths). Rebuilt on a gameHint change so the goal regions track the sport;
    an unknown/empty sport yields an inert trigger (no zones) — motion-burst
    + audio gates still generate candidates. Never raises.
    """
    if state.zone_trigger is not None:
        return state.zone_trigger
    tr = DetectionZoneTrigger(zones=resolve_zones(state.game_hint))
    state.zone_trigger = tr
    return tr


def _player_tracks(tracks) -> dict:
    """Build {track_id: bbox} for on-screen player tracks, excluding the ball.

    The tracker's max-2 slots can include the ball itself (a small, fast blob).
    The ball is never a possession candidate, so drop ball-kind / ball-labeled
    / ball-sized (tiny area) boxes; what remains is the player set for
    nearest-neighbor possession. Returns a plain dict keyed by track id.
    """
    out: dict = {}
    try:
        for t in tracks:
            if getattr(t, "kind", "") == "ball":
                continue
            if is_ball_label(getattr(t, "label", "")):
                continue
            b = getattr(t, "bbox", (0, 0, 0, 0))
            x1, y1, x2, y2 = (float(v) for v in b)
            area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            if area < 0.004:  # ball-sized
                continue
            out[t.track_id] = (x1, y1, x2, y2)
    except Exception:  # noqa: BLE001
        pass
    return out


def process_frame(state, seq: int, timestamp: float, image_b64: str) -> tuple[dict, dict | None]:
    """Run one sampled frame through the shared perceive pipeline: Florence or
    background-diff detection -> tracker.step -> observation (+ candidate).

    The SAME function backs HTTP /analyze, control `analyze-still`, and (future)
    trickle `video-in` — one `session.step(frame)` per front door (plan §3.5).
    Returns (observation_dict, candidate_dict|None). Enqueues both onto any SSE
    subscribers bound to the session.
    """
    objects: list[dict] = []
    vocabulary: list[str] | None = None
    detector = get_detector()
    if detector is not None:
        # Real Florence-2: identify objects + bboxes and feed them to the tracker.
        # Scope the <OD> prompt to the session's closed vocabulary (preferLabels /
        # gameHint) so boxes carry useful labels and weak/unlabeled detection is
        # gated out inside florence._parse (no more fake 1.0-confidence boxes).
        vocabulary = resolve_vocabulary(state.game_hint, state.prefer_labels)
        try:
            _s = monotonic()
            objects = detector.detect(state.last_rgb, vocabulary=vocabulary)
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
            _v = (
                resolve_vocabulary(state.game_hint, state.prefer_labels)
                if detector is not None
                else None
            )
            state.tracker._detect = lambda rgb, _d=_d, _v=_v: [
                _norm_bbox(o["bbox"])
                for o in (_d.detect(rgb, vocabulary=_v) if _d else [])
                if o.get("bbox")
            ]
        tracks = state.tracker.step_frame(state.last_rgb, timestamp, boxes)
    else:
        tracks = state.tracker.step(boxes, timestamp)
    state.seq = seq

    # Ball-centric candidate signal (INC-2b): per-frame ball track ->
    # homography velocity + nearest-player possession, attached to the
    # CandidateEvent as corroborating decide() context (NOT the highlight
    # arbiter). Fully optional and fault-tolerant: any failure drops the
    # signal for this frame, never the frame observation or the candidate.
    ball_signal_fields: dict = {}
    pipe = _ensure_ball_signal(state)
    if pipe is not None:
        try:
            _bf = pipe.step(objects, _player_tracks(tracks), timestamp)
            if _bf.velocity is not None:
                ball_signal_fields["ballVelocity"] = _bf.velocity
            if _bf.possession is not None:
                ball_signal_fields["ballPossession"] = _bf.possession
        except Exception as e:  # noqa: BLE001
            log.warning("ball signal skipped for frame %s: %s", seq, e)

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
                **(
                    # INC-6 tracked-object semantics: surface selection persistence
                    # + tracking accuracy so the UI can show "following object N".
                    {
                        "selected": True,
                        "onScreen": t.lost_frames == 0,
                        "ontoFrames": t.onto_frames,
                        **({"accuracy": round(t.accuracy, 4)} if t.accuracy is not None else {}),
                    }
                    if t.selected
                    else {}
                ),
            }
            for t in tracks
        ],
        "objects": objects,
        "ocr": [],
        # ADAAAA-3726: closed-vocab <OD> gating metrics (Unknown rate) so QA can
        # verify bboxes stay labelable on a real clip (target Unknown < ~10%).
        **(
            {"detector": {"vocabulary": bool(vocabulary), "stats": getattr(detector, "stats", None)}}
            if detector is not None
            else {}
        ),
    }
    state.recent_frames.append({"seq": seq, "timestamp": timestamp, "tracks": obs["tracks"]})

    events: list[dict] = [obs]
    # INC-3 / ADAAAA-4327: a detection-in-zone (or ball-velocity-spike) Stage-A
    # trigger can fire its own candidate independent of the motion-burst gate.
    # Both are cheap (no GPU), both mark a *candidate only* — the decide()
    # stage (Gemma) runs later on candidates. The zone trigger folds the INC-2b
    # ball velocity/possession signals in; each candidate carries them too.
    zone_trigger = _ensure_zone_trigger(state)
    zone_cand = None
    if zone_trigger is not None:
        try:
            zone_cand = zone_trigger.update(tracks, ball_signal_fields or None, timestamp)
        except Exception as e:  # noqa: BLE001  (a zone hiccup never drops a frame)
            log.warning("zone trigger skipped for frame %s: %s", seq, e)

    cand = state.tracker.candidate(ts=timestamp)
    cand_dict = None
    if cand is not None:
        # ADAAAA-4222/4193: the tracker anchors the strike but emits a generic
        # KILL/MOVE motion type. On a goal-scoring sport (soccer) that label
        # conflicts with the scene and the decide model hard-rejects it
        # ("this is soccer, not a KILL event"), so no GOAL clip is ever cut.
        # Classify the anchored candidate with the sport-specific event type
        # (GOAL) now that the session knows gameHint.
        event_type = sport_specific_event_type(state.game_hint, cand.event_type)
        # Return a plain dict (JSON-serializable) so callers can embed it in a
        # response/ack without reaching into the dataclass.
        cand_dict = {
            "eventType": event_type,
            "timestamp": cand.timestamp,
            "trackId": cand.track_id,
            **ball_signal_fields,
        }
        events.append({"type": "candidate", "sessionId": state.session_id, **cand_dict, "seq": seq})
    elif zone_cand is not None:
        # No motion burst this frame, but the detection-in-zone trigger fired.
        # Classify to the sport (GOAL on a goal-scoring sport) so decide() sees
        # a plausible event type; carry ball velocity/possession corroboration.
        event_type = sport_specific_event_type(state.game_hint, zone_cand["eventType"])
        cand_dict = {
            "eventType": event_type,
            "timestamp": zone_cand["timestamp"],
            "trigger": zone_cand["trigger"],
            **ball_signal_fields,
        }
        events.append({"type": "candidate", "sessionId": state.session_id, **cand_dict, "seq": seq})
    for q in state.subscribers:
        for e in events:
            try:
                q.put_nowait(e)
            except Exception:
                pass
    return obs, cand_dict


def _decode_audio(b64: str) -> np.ndarray:
    """Decode base64 int16 mono LE PCM into a float sample array for the gate."""
    if not b64:
        raise HTTPException(status_code=400, detail="empty samples")
    try:
        raw = base64.b64decode(b64.split(",")[-1])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad samples b64: {e}") from e
    if not raw:
        raise HTTPException(status_code=400, detail="empty samples payload")
    if len(raw) % 2:
        raise HTTPException(status_code=400, detail="samples not aligned to int16")
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


def process_audio(state, seq: int, timestamp: float, samples_b64: str) -> dict | None:
    """Run one audio chunk through the Stage-A noise-change gate (INC-2).

    Pure DSP — NEVER touches the detector / SAM / Gemma (no billed GPU on the
    gate path). When the gate fires it returns a *candidate* event carrying the
    AudioSignal evidence (kind, onset ts, firedAt, onsetLatencyS, peakEnergy,
    baselineEnergy) and enqueues it onto any SSE subscribers. It does NOT
    decide a highlight — the decide stage (Gemma) runs later, on candidates.
    """
    samples = _decode_audio(samples_b64)
    sig = state.audio_gate.update(samples, ts=timestamp)
    state.audio_seq = seq if seq >= 0 else state.audio_seq + 1
    if sig is None:
        return None
    # AudioSignalSchema (packages/events) camelCase keys.
    audio = {
        "kind": sig.kind,
        "ts": round(sig.ts, 3),
        "firedAt": round(sig.fired_at, 3),
        "onsetLatencyS": round(sig.onset_latency_s, 3),
        "peakEnergy": round(sig.peak_energy, 6),
        "baselineEnergy": round(sig.baseline_energy, 6),
    }
    cand = {
        "type": "candidate",
        "sessionId": state.session_id,
        "streamId": state.stream_id,
        # Audio gate does not classify the event (no vision here); the decide
        # stage (Gemma) assigns the real eventType from the anchored frame.
        "eventType": "AUDIO",
        "timestamp": audio["ts"],
        "seq": state.audio_seq,
        "audio": audio,
    }
    for q in state.subscribers:
        try:
            q.put_nowait(cand)
        except Exception:
            pass
    return cand


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
            changed = str(msg["gameHint"]) != state.game_hint
            state.game_hint = str(msg["gameHint"])
            # INC-3: a sport change rebuilds the detection-in-zone trigger so
            # the goal-mouth zones track the new sport.
            if changed:
                state.zone_trigger = None
                _ensure_zone_trigger(state)
        # Ball-signal calibration (INC-2b): optional image->field homography as
        # a 9-number (row-major 3x3) array. A bad value is ignored (KEEP the
        # existing calibration) and reported, never fatal.
        if isinstance(msg.get("homography"), list):
            try:
                h = np.array(msg["homography"], dtype=float).reshape(3, 3)
                state.homography = h
                # Rebuild the pipeline on the new calibration (drops stale
                # velocity samples + ball track so velocity restarts clean).
                state.ball_signal = BallSignalPipeline(H=h)
            except Exception as e:  # noqa: BLE001
                return {"type": "ack", "ok": False, "cmd": "configure", "error": f"bad homography: {e}"}
        return {"type": "ack", "ok": True, "cmd": "configure", "preferLabels": state.prefer_labels, "sampleFps": state.sample_fps}
    if ctype == "seed":
        bbox = msg.get("bbox")
        if not bbox or len(bbox) != 4:
            return {"type": "ack", "ok": False, "cmd": "seed", "error": "bbox required (4 numbers)"}
        slot = msg.get("slot")
        kind = msg.get("kind") or "unknown"
        label = msg.get("label") or ""
        # INC-6: a user find-and-track target marks the slot selected so the
        # observation carries persistence + accuracy and it is not auto-evicted.
        selected = bool(msg.get("selected"))
        tr = state.tracker.seed(tuple(bbox), kind=kind, label=label, slot=slot, selected=selected)
        return {"type": "ack", "ok": True, "cmd": "seed", "slot": tr.slot, "trackId": tr.track_id, "selected": tr.selected}
    if ctype in ("track", "find-track"):
        # INC-6 / ADAAAA-4330: on-demand find-and-track. The user selects an
        # object (bbox) and perceive follows it across frames while on screen.
        # This is the surfaced, company-bounded form of `seed`; it always marks
        # the slot as a selected tracked object. Without an explicit bbox we
        # fall back to the most recent frame's largest detection (Florence find)
        # so a bare "follow it" works from the last seen frame.
        bbox = msg.get("bbox")
        if bbox is None:
            cand = next((t for t in reversed(state.recent_frames) if t.get("tracks")), None)
            cand = cand["tracks"][0] if cand and cand["tracks"] else None
            if cand is None:
                return {"type": "ack", "ok": False, "cmd": ctype, "error": "no bbox and no prior track to follow"}
            bbox = cand["bbox"]
        if not bbox or len(bbox) != 4:
            return {"type": "ack", "ok": False, "cmd": ctype, "error": "bbox required (4 numbers)"}
        slot = msg.get("slot")
        kind = msg.get("kind") or "unknown"
        label = msg.get("label") or ""
        tr = state.tracker.seed(tuple(bbox), kind=kind, label=label, slot=slot, selected=True)
        return {"type": "ack", "ok": True, "cmd": ctype, "slot": tr.slot, "trackId": tr.track_id, "selected": True}
    if ctype == "evict":
        slot = msg.get("slot")
        capacity = getattr(state.tracker, "capacity", MAX_TRACKS)
        if slot is None or not (0 <= int(slot) < capacity):
            return {"type": "ack", "ok": False, "cmd": "evict", "error": f"slot must be 0..{capacity - 1}"}
        removed = state.tracker.evict(int(slot))
        return {"type": "ack", "ok": True, "cmd": "evict", "slot": slot, "removed": removed}
    if ctype == "lock":
        slot = msg.get("slot")
        capacity = getattr(state.tracker, "capacity", MAX_TRACKS)
        if slot is None or not (0 <= int(slot) < capacity):
            return {"type": "ack", "ok": False, "cmd": "lock", "error": f"slot must be 0..{capacity - 1}"}
        state.tracker.lock(int(slot))
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
        # Healthy when the perceive process + tracker are up. Do NOT tie the
        # upstream status to model-load state — an unhealthy check would release
        # live sessions. Models are preloaded asynchronously at startup (JIT
        # otherwise loads on first use); expose their progress under "models"
        # for diagnostics without ever flipping /health to a failing state.
        mode = os.environ.get("PERCEIVE_MODE", "stub")
        cap = capability()
        return {
            "status": "ok",
            "model": "florence-2" if mode == "florence" else "stub-iou",
            "slots": MAX_TRACKS,
            "models": preload.preload_status(),
            **cap,
        }

    @router.post("/analyze")
    async def analyze(
        req: AnalyzeRequest,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
        livepeer_session_control: str | None = Header(default=None),
        x_session_control: str | None = Header(default=None),
        livepeer_session_token: str | None = Header(default=None),
        x_session_token: str | None = Header(default=None),
        livepeer_runner_route: str | None = Header(default=None),
        x_runner_route: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id (Livepeer-Session-Id or X-Session-Id)")
        state = registry.get_or_create(sid, req.stream_id, req.clip_path)
        state.stream_id = req.stream_id or state.stream_id
        # Closed-vocabulary delivery (ADAAAA-4109): the paid VOD worker sends the
        # job's gameHint/preferLabels on every /analyze, so a fresh or re-reserved
        # session is configured BEFORE the frame is run. Same effect as a WS
        # `configure` — applies to resolve_vocabulary() inside process_frame.
        if req.gameHint:
            changed = str(req.gameHint) != state.game_hint
            state.game_hint = req.gameHint
            # INC-3: a sport change rebuilds the detection-in-zone trigger so
            # the goal-mouth zones track the new sport.
            if changed:
                state.zone_trigger = None
                _ensure_zone_trigger(state)
        if req.preferLabels:
            state.prefer_labels = list(req.preferLabels)
        # Live path: the worker reserved a session with a control URL, so this
        # first proxied call opens this session's trickle channels and the rail
        # starts consuming video-in frames (plan §3.2/§3.5). The orchestrator
        # injects the session control/token/route headers on every proxied call.
        await _ensure_trickle(
            state,
            livepeer_session_control or x_session_control or "",
            livepeer_session_token or x_session_token or "",
            livepeer_runner_route or x_runner_route or "",
        )

        # Keep the latest raw frame so control `analyze-still` and any future
        # trickle video-in can re-run the exact same step() on it.
        if req.image:
            state.last_rgb = _decode_rgb(req.image)
            state.last_image_b64 = req.image

        # Run the frame through the SAME off-loop, GPU-serialized path the
        # trickle rail uses — never block the event loop with model load /
        # inference, or /health stalls and the orchestrator releases the live
        # session mid-pass (ADAAAA-3305 VOD 404 "runner not found").
        obs, cand = await _analyze_offloop(state, req.seq, req.timestamp, req.image)
        if cand is not None:
            return {"candidate": {"type": "candidate", "sessionId": sid, **cand, "seq": req.seq}, "observation": obs}
        return obs

    @router.post("/audio")
    async def audio(
        req: AudioChunkRequest,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        """Feed one audio chunk to the Stage-A noise-change gate (INC-2).

        Pure DSP: decodes int16 mono PCM, runs the RMS energy gate, and when it
        fires returns the audio CandidateEvent (with the AudioSignal evidence).
        It NEVER runs the detector / SAM / Gemma, so this path bills no GPU.
        The gate does NOT decide a highlight — it only marks a candidate.
        """
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id (Livepeer-Session-Id or X-Session-Id)")
        state = registry.get_or_create(sid, req.stream_id)
        if req.stream_id:
            state.stream_id = req.stream_id
        cand = process_audio(state, req.seq, req.timestamp, req.samples)
        return {"candidate": cand}

    @router.get("/events")
    async def events(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
        livepeer_session_control: str | None = Header(default=None),
        x_session_control: str | None = Header(default=None),
        livepeer_session_token: str | None = Header(default=None),
        x_session_token: str | None = Header(default=None),
        livepeer_runner_route: str | None = Header(default=None),
        x_runner_route: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id")
        state = registry.get_or_create(sid)
        await _ensure_trickle(
            state,
            livepeer_session_control or x_session_control or "",
            livepeer_session_token or x_session_token or "",
            livepeer_runner_route or x_runner_route or "",
        )
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
        # Live path: an operator console attaching first can still bootstrap the
        # session's trickle rail if it passes the control URL.
        await _ensure_trickle(
            state,
            websocket.query_params.get("control_url", ""),
            websocket.query_params.get("token", ""),
            websocket.query_params.get("route", ""),
        )
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

    @router.post("/control")
    async def control(
        payload: dict,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        """HTTP control forward (INC-6 / ADAAAA-4330): lets the server / UI
        deliver a find-and-track intent (track/seed/evict/lock) to a reserved
        perceive session over HTTP instead of the WS control channel. Mirrors
        handle_control; returns the same ack object. Binds to an EXISTING
        session (same rule as /ws)."""
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid or registry.get(sid) is None:
            raise HTTPException(status_code=404, detail="no such session")
        return handle_control(registry.get(sid), payload)

    @router.get("/session/stats")
    async def stats(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        state = registry.get(sid) if sid else None
        tr = _trickle.get(sid)
        return {
            "sessionId": sid,
            "active": state is not None,
            "seq": state.seq if state else 0,
            "tracks": len(state.tracker.tracks) if state else 0,
            "subscribers": len(state.subscribers) if state else 0,
            "activeSessions": registry.count(),
            "trickle": {
                "active": tr is not None,
                "video_in": (tr.rail.endpoints.video_in if tr and tr.rail.endpoints else None),
                "events_out": (tr.rail.endpoints.events_out if tr and tr.rail.endpoints else None),
                "control": (tr.rail.endpoints.control if tr and tr.rail.endpoints else None),
            },
        }

    @router.post("/session/close")
    async def close(
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if sid:
            registry.drop(sid)
            await _stop_trickle(sid)
        return {"closed": sid}

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _lifespan(app: FastAPI):
        # On startup: kick off Florence-2 + SAM 3.1 model preload on a background
        # thread so the first live/VOD pass never pays the multi-second model
        # build mid-call (ADAAAA-3305 VOD 404 "runner not found"). This returns
        # immediately (worker is daemon) and never touches the event loop's
        # latency, so /health answers instantly and the orchestrator never sees a
        # stalled runner. Idempotent; no-op when the models aren't configured.
        preload.start_background_preload()
        try:
            yield
        finally:
            pass

    app = FastAPI(title="highlights-perceive", version="0.1.0", lifespan=_lifespan)
    app.state.registry = registry  # exposed for tests / admin tooling

    def _cancel_trickle(session_id: str) -> None:
        # Sync bridge: registry.drop() runs inside async handlers / eviction;
        # schedule the async trickle teardown on the running loop.
        try:
            asyncio.get_running_loop().create_task(_stop_trickle(session_id))
        except RuntimeError:
            pass

    registry.on_drop = _cancel_trickle

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
