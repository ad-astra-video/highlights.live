from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import threading
from time import monotonic
from typing import Optional

log = logging.getLogger("highlights.perceive.trickle")

from .logging_setup import configure_logging  # noqa: E402  (defines log above)

# Wire the perceive log level from PERCEIVE_LOG_LEVEL (default INFO) at app
# load so the highlights.perceive.* loggers actually emit. DEBUG enables the
# per-frame detail in process_frame; the default logs lifecycle only.
configure_logging()

import numpy as np
from fastapi import APIRouter, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from . import preload  # noqa: E402  (startup model preload)
from .audio_gate import AudioEnergyGate
from .session import RECENT_FRAMES, SessionRegistry
from .tracker import MAX_TRACKS, foreground_blobs
from .florence import capability, get_detector, record_analyze, resolve_vocabulary
from .sam_tracker import HybridTracker
from .player_id import identify_player_by_number
from .trickle import TrickleError, TrickleRail, TrickleSession
from .ball_signal import BallSignalPipeline, is_ball_label
from .goal_plane import GoalLineDetector, GoalLineSpec
from .scoreboard import (
    ScoreboardLocator,
    ScoreboardRoi,
    ScoreboardTracker,
    explicit_scoreboard_roi,
    fallback_score_eligible,
    parse_ocr_score,
)
from .scoreboard_vision import (
    ScoreboardVerdict,
    enabled as scoreboard_vision_enabled,
    vision_scoreboard,
)
from .tracking_plan import (
    PLAN_VERSION,
    SAFE_DEFAULT_ROLE,
    VALID_ROLES,
    LIVE_MAX_TRACKS,
    VOD_MAX_TRACKS,
    MODE_MAX_TRACKS,
    DISCOVERY_METHODS,
    FLORENCE_TASKS,
    TrackingPlan,
    clamp_max_tracks,
    coerce_role,
    label_trackable,
    normalize,
    plan_vocabulary,
    validate,
)
from .discovery import discovery_block, run_discovery_pass  # noqa: E402  (increment C)

# One live trickle session per perceive session (plan §0.1 session rule).
_trickle: dict[str, TrickleSession] = {}
# Serialize detector/SAM passes: the event-loop's HTTP /analyze and the trickle
# subscriber's worker thread share one Florence detector / SAM backend.
_gpu_lock = threading.Lock()

# ADAAAA-6525: default-INFO heartbeat cadence for frame processing. The operator
# needs to see the pipeline is alive without per-frame spam, so every Nth frame
# (plus the first) logs a single salient heartbeat line at INFO; per-frame
# detail is emitted only at DEBUG.
HEARTBEAT_EVERY = 30

# ADAAAA-7086: re-attempt scoreboard region discovery only every Nth candidate
# while no scoreboard has been found (bounded region pass; recall preserved).
_SCOREBOARD_DETECT_BACKOFF = 5



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
    # Per-stream LoRA injection (ADAAAA-5324): optional ref to this stream's
    # merged Florence-2 model dir. Carried on every /analyze (like gameHint)
    # so a fresh or re-reserved session is configured before frames run.
    loraRef: str = ""
    # LLM TrackingPlan (ADAAAA-6463): optional plan dict (the plan §7 A/B
    # contract). When present on /analyze, perceive applies the closed roster +
    # zones + anchor to the session BEFORE the frame runs, so detect/seeding is
    # scoped to plan targets (off-plan objects dropped). Mirrors the WS
    # `configure` trackingPlan key.
    trackingPlan: Optional[dict] = None
    # Per-camera/per-clip pitch-homography calibration (ADAAAA-6489 / ADAAAA-7159
    # Gap 2): optional row-major 3x3 image->field homography (9 numbers). When
    # present on /analyze the server delivers a REAL per-clip calibration so the
    # ball's on-pitch field position (posXm/posYm) and the goal-line signal are
    # real, not a single static env value. Mirrors the WS `configure` homography
    # key. Absent -> ball signal falls back to image space (no field coords -> no
    # goal-line signal), never a fabricated one.
    homography: Optional[list] = None
    # Per-session goal-line plane spec (ADAAAA-6489 / ADAAAA-7159 Gap 2): the
    # goal-line plane in the calibration's field coords
    # `{axis, position, mouthMin, mouthMax}`. When present on /analyze the server
    # supplies it so the goal-line detector emits goalCrossed/ballOutcome (the
    # I2 ground-truth the decide goal-acceptance path needs). Mirrors the WS
    # `configure` goalLine key. Absent -> the candidate carries no ballOutcome
    # (reported as not_captured, never invented).
    goalLine: Optional[dict] = None


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


class EvidenceRequest(BaseModel):
    """On-demand perceive recall window (ADAAAA-7008 / ADAAAA-7012).

    Requests the per-frame derived context ALREADY computed by process_frame
    (tracks / detections / ocr) for a moment or window, WITHOUT re-running the
    detector. Time bounds are content seconds. At least one of ``centerTs`` /
    ``startTs``+``endTs`` should be set; ``centerTs`` + ``windowS`` forms a
    symmetric ``[center - windowS/2, center + windowS/2]`` band. When nothing is
    cached in range the endpoint returns ``seeds: []`` (an explicit no-op — a
    no-op recall must never regress a decision).
    """

    centerTs: float | None = None
    windowS: float | None = None
    startTs: float | None = None
    endTs: float | None = None


def _read_session_id(
    livepeer_session_id: str | None = Header(default=None),
    x_session_id: str | None = Header(default=None),
) -> str:
    # Behind the orchestrator the Livepeer header is injected; direct (dev)
    # calls use X-Session-Id. Neither present -> refuse (no guessing).
    return livepeer_session_id or x_session_id


def _env_goal_line() -> GoalLineSpec | None:
    """Optional global goal-line plane spec from env (Decide-leg I2).

    Expected as a JSON object ``{"axis": "y", "position": 0.0, "mouthMin": ..,
    "mouthMax": ..}`` in the calibration's field coords. Unparseable / absent ->
    None, so the candidate carries no goalCrossed/ballOutcome (graceful
    degradation, same pattern as an optional homography).
    """
    raw = os.environ.get("PERCEIVE_GOAL_LINE", "").strip()
    if not raw:
        return None
    try:
        return GoalLineSpec.from_dict(json.loads(raw))
    except Exception:  # noqa: BLE001
        log.warning("PERCEIVE_GOAL_LINE unparseable; ignoring")
        return None


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


def _ensure_goal_line_detector(state) -> GoalLineDetector | None:
    """Lazily build this session's goal-line / ball-outcome detector (I2).

    Uses the session's goal-line spec (control `configure`) else the env
    default. Returns the detector, or None when no spec is configured (then the
    candidate carries no goalCrossed/ballOutcome). Never raises.
    """
    if state.goal_line_spec is None:
        state.goal_line_spec = _env_goal_line()
    if state.goal_line_spec is None:
        return None
    if state.goal_line_detector is None:
        state.goal_line_detector = GoalLineDetector(state.goal_line_spec)
    return state.goal_line_detector


def _apply_calibration(state, homography, goal_line) -> None:
    """Apply a per-session goal-line calibration (ADAAAA-6489 / ADAAAA-7159 Gap 2):
    an image->field pitch homography + goal-line plane spec, supplied per
    camera/clip by the server path on every /analyze (and the WS `configure`
    key). A bad value is ignored (KEEP the existing calibration) and never
    fatal; absent -> image-space / no-goal-line-signal fallback (the candidate
    carries no ballOutcome -> reported not_captured, never a fabricated signal).
    """
    if homography is not None:
        try:
            h = np.asarray(homography, dtype=float).reshape(3, 3)
            state.homography = h
            # Rebuild the pipeline on the new calibration (drops stale velocity
            # samples so on-pitch velocity restarts clean).
            state.ball_signal = BallSignalPipeline(H=h)
        except Exception as e:  # noqa: BLE001
            log.warning("bad homography calibration: %s", e)
    if goal_line is not None:
        spec = GoalLineSpec.from_dict(goal_line)
        if spec is None:
            log.warning("bad goalLine calibration: %r", goal_line)
        else:
            state.goal_line_spec = spec
            state.goal_line_detector = GoalLineDetector(spec)


def _scoreboard_locator(state, detector):
    """The session's ``ScoreboardLocator`` (built lazily, ADAAAA-7086).

    Wraps the vision detector's region-discovery pass so the scoreboard region
    can be predicted per source (not calibrated per source). ``None`` when there
    is no region-capable detector (e.g. the stub/background path), which falls
    back to the static ROI / gate behaviour below.
    """
    locator = getattr(state, "scoreboard_locator", None)
    if locator is None and "scoreboard_locator" not in vars(state):
        if detector is not None and hasattr(detector, "discover"):
            locator = ScoreboardLocator(lambda img, task: detector.discover(img, task=task))
        state.scoreboard_locator = locator
    return locator


def _scoreboard_roi(state, detector=None) -> "ScoreboardRoi | None":
    """The session's active scoreboard region-of-interest (ADAAAA-7081/7086).

    Resolution order (first match wins, in priority order):

    1. **Explicit calibration** — ``PERCEIVE_SCOREBOARD_ROI`` set to a valid box
       (the operator has told us exactly where this source's scoreboard is). We
       trust it and treat a scoreboard as visible.
    2. **Auto-detected region** — predicted by ``ScoreboardLocator`` from the
       frame's content, so a scorebug in any corner is found without per-source
       calibration (ADAAAA-7086 recall). Cached on the session once found.
    3. **Visibility gate** — no scoreboard predicted/visible -> ``None``, and the
       caller runs no OCR at all (no score, no ``ocrHits``), so non-scoreboard
       text can never drive ``scoreBoardChanged`` / ``ocrHits``.

    Detection itself runs only while no region has been found (bounded — once a
    scoreboard is located it is cached and reused for the source), so it is not a
    per-frame billable pass beyond the ROI-scoped OCR. If detection is
    unavailable (stub detector, no ``discover``) and no explicit ROI is set, we
    fall back to the documented default top-band region (legacy behaviour) rather
    than silently dropping all score evidence. Never raises.
    """
    # 1. Already-located region (explicit or auto-detected) is cached on state.
    roi = getattr(state, "scoreboard_roi", None)
    if roi is not None:
        state.scoreboard_visible = True
        return roi

    # Explicit per-source calibration wins over auto-detection (operator has
    # pinned the scoreboard region). Invalid/unset -> None below.
    explicit = explicit_scoreboard_roi()
    if explicit is not None:
        state.scoreboard_roi = explicit
        state.scoreboard_visible = True
        return explicit

    # 2. Auto-detect the scoreboard region from the frame content.
    locator = _scoreboard_locator(state, detector)
    if locator is not None:
        # Re-attempt region discovery only every `_SCOREBOARD_DETECT_BACKOFF`
        # candidates. An always-no-scoreboard source must not pay a billable
        # region pass on every candidate frame (acceptance: no GPU pass beyond
        # the ROI-scoped OCR), yet a scoreboard that appears mid-stream is
        # still picked up after the backoff (recall preserved).
        misses = int(getattr(state, "scoreboard_miss_count", 0))
        if getattr(state, "last_rgb", None) is not None and misses % _SCOREBOARD_DETECT_BACKOFF == 0:
            try:
                located = locator.locate(state.last_rgb)
            except Exception:  # noqa: BLE001 - never crash the candidate path
                located = None
            if located is not None:
                state.scoreboard_roi = located
                state.scoreboard_visible = True
                return located
        # A region-capable detector ran but found no visible scoreboard. Count
        # the miss so the next region pass waits out the backoff; a scoreboard
        # that appears mid-stream is still picked up on the next attempt
        # (state.scoreboard_roi stays None until found).
        state.scoreboard_miss_count = misses + 1
        # ADAAAA-7190: the `<DENSE_REGION_CAPTION>` discovery pass is flaky and
        # frequently reports NO scoreboard region even when a numeric scorebug is
        # present and changing (observed live on job 5c886c12: every candidate
        # carried eventType SPORTING_EVENT but never a scoreBoardChanged /
        # ballOutcome, because a discovery miss gated the OCR pass off entirely
        # and dropped the independent scoreboard corroboration for a real goal).
        # Rather than gating the OCR off on a miss, fall back to the documented
        # default top-band prior for THIS frame so the scoreboard OCR can still
        # read a scorebug that discovery missed. This is the same prior already
        # used when no region-capable detector exists, it stays scoped to the
        # scoreboard band (not the whole frame), and it is deliberately NOT
        # cached as `state.scoreboard_roi` so a later discovery attempt can still
        # upgrade to a better box when one is found.
        state.scoreboard_visible = True
        return ScoreboardRoi.from_env()

    # No region-capable detector (stub path): fall back to the documented
    # default top-band prior rather than dropping all score evidence.
    default = ScoreboardRoi.from_env()
    state.scoreboard_roi = default
    state.scoreboard_visible = True
    return default


def _vision_box_roi(state) -> "ScoreboardRoi | None":
    """The vision-LLM scoreboard box for the current observed frame (ADAAAA-7084).

    When the opt-in vision-LLM path ran this frame and localized the scoreboard,
    the LLM's box is what the ``<OCR>`` pass should crop to (it tracks the
    graphic to wherever it actually sits, unlike the fixed prior ROI). Returns
    the box as a :class:`ScoreboardRoi`, or ``None`` when the gate is off, the
    LLM returned no usable box, or the box is too degenerate to crop (the caller
    then falls back to the configured ROI). Never raises.
    """
    verdict = getattr(state, "scoreboard_vision", None)
    if not isinstance(verdict, ScoreboardVerdict) or not verdict.box:
        return None
    try:
        roi = ScoreboardRoi(*verdict.box)
    except (TypeError, ValueError):
        return None
    if roi.pixel_box(1920, 1080) is None:  # sanity: a reachable, non-degenerate region
        return None
    return roi


def _apply_tracking_plan(state, raw_plan) -> "TrackingPlan":
    """Apply an LLM TrackingPlan to a session (ADAAAA-6463, plan-first).

    Never raises: TrackingPlan.from_dict normalizes/coerces malformed input. A
    plan with no trackable targets yields an empty roster — the per-frame path
    then degrades to the canned/safe-default roster via resolve_vocabulary. This
    also reserves the plan anchor's primary slot (tracker.set_anchor) and
    rebuilds the detection-in-zone trigger on the plan's zones.
    """
    plan = TrackingPlan.from_dict(raw_plan)
    state.tracking_plan = plan
    anchor = (plan.anchor or {}).get("label", "") if isinstance(plan.anchor, dict) else ""
    _tracker = getattr(state, "tracker", None)
    if _tracker is not None and hasattr(_tracker, "set_anchor"):
        _tracker.set_anchor(anchor)
    return plan


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


def _ball_label_for(vocabulary, tracker=None) -> str:
    """The ball label for the session's closed vocabulary (else the tracker's)."""
    for v in vocabulary or []:
        if is_ball_label(v):
            return str(v)
    return getattr(tracker, "ball_label", "") or "soccer ball"


def _recover_sam_ball(detector, state, tracker, vocabulary) -> bool:
    """Re-identify the ball on SAM loss via the bounded ROI recovery pass.

    ADAAAA-7217 (Increment A): once the ball SAM slot is live the ball is dropped
    from the per-frame full-frame `<OD>` pass; if SAM then reports sustained
    absence (`tracker.ball_needs_redetect()`), Florence re-identifies the ball
    WITH the ROI second pass (`_run_roi_pass`) so small/far balls are recovered,
    and re-seeds the locked ball SAM slot. Returns True when a ball was recovered
    and re-seeded. Never raises / never runs on GPU-less stub detector.
    """
    ball_vocab = [v for v in (vocabulary or []) if is_ball_label(v)]
    if not ball_vocab and getattr(tracker, "ball_label", None):
        ball_vocab = [tracker.ball_label]
    if not ball_vocab or detector is None or getattr(state, "last_rgb", None) is None:
        return False
    try:
        _s = monotonic()
        det = detector.detect(state.last_rgb, vocabulary=ball_vocab, roi_pass=True) or []
        record_analyze(monotonic() - _s)
    except Exception as e:  # noqa: BLE001
        log.warning("ball ROI re-detect failed session=%s: %s", state.session_id, e)
        return False
    ball = next((o for o in det if is_ball_label(o.get("label")) and o.get("bbox")), None)
    if ball is not None:
        tracker.seed_ball(_norm_bbox(ball["bbox"]))
        return True
    return False


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
    # DEBUG per-frame entry (ADAAAA-6525): one line per sampled frame with the
    # session + seq so it correlates to the rail/timeline. Only at DEBUG.
    log.debug(
        "frame enter session=%s seq=%s ts=%.2f stream=%s",
        state.session_id, seq, timestamp, state.stream_id,
    )
    # Per-stream LoRA injection (ADAAAA-5324): a session with an attached
    # adapter uses its own detector (base+LoRA-merged model); every other
    # session keeps the shared base detector.
    detector = get_detector(state.lora_ref or None)
    if detector is not None:
        # Real Florence-2: identify objects + bboxes and feed them to the tracker.
        # Scope the <OD> prompt to the session's closed vocabulary (plan roster /
        # preferLabels / gameHint) so boxes carry useful labels and weak/unlabeled
        # detection is gated out inside florence._parse (no more fake
        # 1.0-confidence boxes). Plan-first (ADAAAA-6463): when a TrackingPlan is
        # present its roster is the active vocabulary.
        vocabulary = resolve_vocabulary(state.game_hint, state.prefer_labels, plan=state.tracking_plan)
        # ADAAAA-7217 (Increment A): once the dedicated ball SAM slot is live,
        # SAM owns the ball — DROP the ball from the per-frame full-frame
        # Florence <OD> pass (no per-frame ball re-detection). Florence
        # re-identifies the ball ONLY when the SAM ball slot reports absence
        # (SAM loss), via the ROI recovery pass (see _recover_sam_ball below).
        # Increment B already makes the default soccer roster ball-first.
        is_hybrid = isinstance(state.tracker, HybridTracker)
        ball_live = is_hybrid and bool(getattr(state.tracker, "ball_live", False))
        # Enable the dedicated locked ball SAM slot for sessions whose closed
        # vocabulary includes a ball (e.g. soccer default ball-first roster).
        if is_hybrid and vocabulary and any(is_ball_label(v) for v in vocabulary):
            state.tracker.ball_label = _ball_label_for(vocabulary, state.tracker)
        perframe_vocab = vocabulary
        if ball_live and vocabulary and any(is_ball_label(v) for v in vocabulary):
            perframe_vocab = [v for v in vocabulary if not is_ball_label(v)]
        try:
            _s = monotonic()
            objects = detector.detect(state.last_rgb, vocabulary=perframe_vocab)
            record_analyze(monotonic() - _s)
        except Exception as e:  # keep the pipeline alive if the GPU hiccups
            objects = [{"label": "error", "confidence": 0.0, "bbox": [0, 0, 0.001, 0.001]}]
            state.last_florence_error = str(e)
            log.error("florence detect failed session=%s seq=%s: %s", state.session_id, seq, e)
        # Carry each detection's in-roster label alongside its bbox so the
        # tracker seeds tracks with the gated label (not a hard-coded
        # "unknown" the user then sees on the box) — ADAAAA-5056.
        boxes = [_norm_bbox(o["bbox"]) for o in objects if o.get("bbox")]
        labels = [str(o.get("label", "") or "") for o in objects if o.get("bbox")]
    else:
        # stub path: background-diff blobs from the grayscale frame
        gray = _decode_gray(image_b64)
        boxes = foreground_blobs(gray, state.prev_gray)
        labels = []
        state.prev_gray = gray

    if isinstance(state.tracker, HybridTracker):
        # HybridTracker has NO `.step()` — only `step_frame()`. The seed
        # /analyze that opens the live session can carry an empty image
        # (`image:""` when MEDIA_SEED_IMAGE_B64 is unset, ADAAAA-5488), which
        # leaves `state.last_rgb` None and previously fell into the else branch
        # calling the nonexistent `.step()` -> AttributeError at provision time.
        # Guard on the tracker type alone so a HybridTracker always routes to
        # the step_frame path; a missing/empty frame has no content to advance,
        # so ack it with empty tracks instead of crashing the live ingester.
        if state.last_rgb is None:
            tracks = []
        else:
            if state.tracker._detect is None:
                _d = detector
                _v = (
                    resolve_vocabulary(state.game_hint, state.prefer_labels, plan=state.tracking_plan)
                    if detector is not None
                    else None
                )
                state.tracker._detect = lambda rgb, _d=_d, _v=_v: [
                    {**o, "bbox": _norm_bbox(o["bbox"])}
                    for o in (_d.detect(rgb, vocabulary=_v, roi_pass=False) if _d else [])
                    if o.get("bbox")
                ]
            tracks = state.tracker.step_frame(state.last_rgb, timestamp, boxes, labels=labels)
    else:
        tracks = state.tracker.step(boxes, timestamp, labels=labels)
    state.seq = seq
    # ADAAAA-6525: default-INFO heartbeat — one salient line every Nth frame
    # (plus the first) so an operator sees the pipeline is alive, without the
    # per-frame spam that stays behind DEBUG.
    state.frames_processed = getattr(state, "frames_processed", 0) + 1
    if state.frames_processed == 1 or state.frames_processed % HEARTBEAT_EVERY == 0:
        log.info(
            "frame heartbeat session=%s frames=%d seq=%s ts=%.2f tracks=%d active=%s",
            state.session_id, state.frames_processed, seq, timestamp,
            len(tracks), len(state.subscribers),
        )

    # ADAAAA-7217 (Increment A): ball handoff. Once the ball SAM slot is live,
    # SAM owns the ball — feed its box to the ball-signal pipeline instead of
    # re-deriving it from the per-frame Florence pass (the ball is excluded from
    # that pass above). On SAM loss, re-identify the ball via the ROI recovery
    # pass and re-seed the locked SAM slot. Reflect the SAM ball box back into
    # `objects` so the detection-contract field still reports the ball.
    sam_ball_box = None
    if isinstance(state.tracker, HybridTracker):
        if getattr(state.tracker, "ball_live", False):
            if getattr(state.tracker, "ball_needs_redetect", lambda: False)():
                _recover_sam_ball(detector, state, state.tracker, vocabulary)
            sam_ball_box = state.tracker.ball_box() if hasattr(state.tracker, "ball_box") else None
            if sam_ball_box is not None and not any(is_ball_label(o.get("label")) for o in objects):
                objects.append(
                    {"label": _ball_label_for(vocabulary, state.tracker), "confidence": 1.0, "bbox": list(sam_ball_box)}
                )

    # Ball-centric candidate signal (INC-2b): per-frame ball track ->
    # homography velocity + nearest-player possession, attached to the
    # CandidateEvent as corroborating decide() context (NOT the highlight
    # arbiter). Fully optional and fault-tolerant: any failure drops the
    # signal for this frame, never the frame observation or the candidate.
    ball_signal_fields: dict = {}
    pipe = _ensure_ball_signal(state)
    if pipe is not None:
        try:
            _bf = pipe.step(objects, _player_tracks(tracks), timestamp, sam_ball_box=sam_ball_box)
            if _bf.velocity is not None:
                ball_signal_fields["ballVelocity"] = _bf.velocity
            if _bf.possession is not None:
                ball_signal_fields["ballPossession"] = _bf.possession
        except Exception as e:  # noqa: BLE001
            log.warning("ball signal skipped for frame %s: %s", seq, e)

    # Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth signal.
    # Feed the on-pitch ball position (INC-2b homography velocity) through the
    # goal-plane classifier and attach goalCrossed / ballOutcome to the
    # candidate as first-class evidence. Optional and fault-tolerant: no goal-
    # line spec (or no ball position) => no fields on the candidate.
    goal_signal_fields: dict = {}
    goal_det = _ensure_goal_line_detector(state)
    if goal_det is not None:
        try:
            _vel = ball_signal_fields.get("ballVelocity") or {}
            _pos = None
            if _vel.get("posXm") is not None and _vel.get("posYm") is not None:
                _pos = (float(_vel["posXm"]), float(_vel["posYm"]))
            _gl = goal_det.update(_pos, _vel.get("speedMps"), timestamp)
            if _gl is not None:
                goal_signal_fields["goalCrossed"] = bool(_gl.goalCrossed)
                goal_signal_fields["ballOutcome"] = _gl.ballOutcome
        except Exception as e:  # noqa: BLE001
            log.warning("goal-line signal skipped for frame %s: %s", seq, e)

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
                # ADAAAA-5700: normalize EVERY surfaced track bbox through the
                # same guard Florence detections get (_norm_bbox). The SAM path
                # feeds mask-derived boxes straight into the tracker without
                # that guard, so a degenerate/sliver mask can surface a sub-pixel
                # box that renders invisible while its label still draws — a
                # label "floating on nothing". Clamping to a minimum visible
                # area here guarantees every surfaced box is drawn, so each
                # label stays anchored to its detection box (no floating).
                "bbox": list(_norm_bbox(list(t.bbox))),
                "kind": t.kind,
                # In-roster detector label (ADAAAA-5056): the box a user sees
                # carries the gated label, never a bare "unknown".
                **({"label": t.label} if t.label else {}),
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
        # ADAAAA-7108: the GOAL / motion-burst candidate triggers are removed,
        # but the independently-computed goal-line + ball signals must still
        # reach decide as evidence so the goal-attestation gate can attest a
        # real scoring_play from what decide sees. Additive field — downstream
        # consumers that do not read `evidence` ignore it unchanged.
        **({"evidence": {**ball_signal_fields, **goal_signal_fields}} if (ball_signal_fields or goal_signal_fields) else {}),
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
    # ADAAAA-7108 (increments B & C): the detection-in-zone GOAL trigger and the
    # tracker fast-movement / motion-burst (KILL/MOVE) trigger are REMOVED from
    # perceive. Perceive does not have the knowledge to produce these kinds of
    # candidates; the decide/gemma observer is the PRIMARY timeline observer and
    # fires on a fixed ~3 s cadence (observe-loop.ts) regardless of any candidate,
    # so no candidate-gated decide path remains. The goal-line + ball signals
    # still reach decide as the additive `evidence` field on the observation
    # (kept above) so the goal-attestation gate can attest a real scoring_play.
    cand_dict = None
    # ADAAAA-7081/7084/7086/7094: scoreboard OCR scoped to a scoreboard region
    # of interest, on the observe cadence. The scoreboard graphic is cropped to
    # a stable region before the `<OCR>` pass so crowd / banner / jersey /
    # shot-clock text can never be read as a score. A concrete in-ROI score delta
    # across the window is an independent scoreboard-change corroboration for
    # decide's confirm gate. OCR/GPU failure degrades to [] (absent evidence,
    # never on its own a goal).
    #
    # ADAAAA-7086: the ROI is not a fixed per-source calibration. The vision
    # detector's region-discovery pass predicts the scoreboard region per source
    # (and assesses whether a scoreboard is even visible); when none is visible
    # the pass is gated off entirely (no OCR, no ocrHits), so non-scoreboard text
    # can never drive scoreBoardChanged / ocrHits, while a scorebug in any corner
    # is still found (recall no longer depends on a hand-tuned ROI).
    #
    # ADAAAA-7084 (opt-in PERCEIVE_SCOREBOARD_LLM): a vision LLM first assesses
    # whether a scoreboard is ACTUALLY visible and, when so, localizes it and may
    # read the score. When visible, the crop uses the LLM's box (tracks the
    # graphic wherever it actually sits); when not visible, the `<OCR>` pass is
    # skipped entirely. Any LLM failure degrades to None and runs the ROI path.
    #
    # ADAAAA-7094: the LLM score-text fallback (used when the cropped Florence
    # `<OCR>` is empty) is only trusted when the LLM-localized box actually
    # overlaps the configured scoreboard ROI — a hallucinated box/score off the
    # graphic can never forge a scoreBoardChanged delta.
    if detector is not None and state.last_rgb is not None:
        # ADAAAA-7084 (opt-in): vision-LLM scoreboard visibility verdict.
        verdict = vision_scoreboard(image_b64) if scoreboard_vision_enabled() else None
        state.scoreboard_vision = verdict
        # Crop region: prefer the vision-LLM box (when it ran and localized a
        # usable scoreboard), else the ADAAAA-7086-aware `_scoreboard_roi`.
        roi = _vision_box_roi(state) if verdict is not None else None
        if roi is None:
            roi = _scoreboard_roi(state, detector)
        # Visibility gate: the LLM says no scoreboard (7084) or the region
        # discovery found none (7086) -> skip the `<OCR>` pass entirely so
        # out-of-ROI / non-scoreboard text is never even read.
        visible = verdict.visible if verdict is not None else getattr(state, "scoreboard_visible", True)
        ocr_lines: list[str] = []
        if visible:
            try:
                ocr_lines = detector.ocr(state.last_rgb, roi=roi) or []
            except Exception as e:  # noqa: BLE001
                log.warning("scoreboard OCR skipped for frame %s: %s", seq, e)
            # ADAAAA-7094: the LLM score text only stands in for an empty crop
            # when its localizing box overlaps the configured scoreboard ROI.
            if (
                not ocr_lines
                and verdict is not None
                and verdict.visible
                and verdict.score_text
                and fallback_score_eligible(verdict.box, _scoreboard_roi(state, detector))
            ):
                ocr_lines = [verdict.score_text]
        obs["ocr"] = ocr_lines
        score = parse_ocr_score(ocr_lines, roi=roi)
        # ADAAAA-7190: the auto-discovered region-of-interest crop can miss a
        # numeric scorebug that sits just outside the tight region (observed live
        # on an El-Clasico-style score overlay where the ROI crop OCR read only
        # the "EL CLASICO" branding column while whole-frame OCR read
        # "REAL MADRID 3 - 4 FC BARCELONA"). When a scoreboard is known visible
        # but the ROI-scoped crop produced no parseable score, fall back to a
        # whole-frame OCR and parse the score from it, so a real score delta is
        # still detected instead of silently dropping the corroboration. Bounded
        # relaxation: only on frames where the visibility gate already deemed a
        # scoreboard visible, and `parse_ocr_score` still requires a clean
        # two-integer "N - M" line (a branding / non-score read never qualifies).
        if score is None and visible:
            try:
                full_ocr = detector.ocr(state.last_rgb) or []
                alt = parse_ocr_score(full_ocr)  # whole-frame, no ROI filter
            except Exception as e:  # noqa: BLE001
                log.warning("scoreboard whole-frame OCR fallback skipped frame %s: %s", seq, e)
            else:
                if alt is not None:
                    score = alt
                    obs["ocr"] = full_ocr
        state.scoreboard_tracker.record(timestamp, score)
        if state.scoreboard_tracker.changed(timestamp):
            obs["scoreBoardChanged"] = True
    # ADAAAA-7008 / ADAAAA-7012: cache this frame's derived context (the "data
    # seeder" contract) so the on-demand `/app/evidence` recall endpoint can serve
    # it WITHOUT re-running the detector. Compact seed (tracks / objects / ocr) —
    # the decide `seeds` vocabulary; captured AFTER the scoreboard OCR pass so
    # `ocr` is final. Bounded to RECENT_FRAMES so a long stream never grows it.
    state.frame_seeds[timestamp] = {
        "ts": timestamp,
        "tracks": obs["tracks"],
        "objects": obs.get("objects", []),
        "ocr": obs.get("ocr", []),
    }
    while len(state.frame_seeds) > RECENT_FRAMES:
        state.frame_seeds.pop(min(state.frame_seeds))
    for q in state.subscribers:
        for e in events:
            try:
                q.put_nowait(e)
            except Exception:
                pass
    # DEBUG per-frame summary (ADAAAA-6525): detection labels/scores, track
    # state, ball/goal outcome. Only at DEBUG.
    log.debug(
        "frame done session=%s seq=%s ts=%.2f detections=%s tracks=%s ball=%s goal=%s",
        state.session_id,
        seq,
        timestamp,
        [(o.get("label"), round(float(o.get("confidence", 0.0)), 2)) for o in objects[:12]],
        [(t.track_id, getattr(t, "kind", ""), getattr(t, "label", "")) for t in tracks[:MAX_TRACKS]],
        ball_signal_fields,
        goal_signal_fields,
    )
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
    log.info(
        "audio trigger fired session=%s seq=%s kind=%s peak=%.4f baseline=%.4f",
        state.session_id, state.audio_seq, audio.get("kind"), audio.get("peakEnergy", 0.0), audio.get("baselineEnergy", 0.0),
    )
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
            state.game_hint = str(msg["gameHint"])
        # Per-stream LoRA injection (ADAAAA-5324): reconfigure this session's
        # adapter (or clear to base with empty string).
        if "loraRef" in msg:
            state.lora_ref = str(msg["loraRef"])
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
        # Decide-leg I2 (ADAAAA-6359): optional goal-line plane spec (field
        # coords) so perceive can emit goalCrossed / ballOutcome. A bad value is
        # ignored (KEEP the existing spec) and reported, never fatal.
        if isinstance(msg.get("goalLine"), dict):
            spec = GoalLineSpec.from_dict(msg["goalLine"])
            if spec is None:
                return {"type": "ack", "ok": False, "cmd": "configure", "error": "bad goalLine: need {axis, position, mouthMin, mouthMax}"}
            state.goal_line_spec = spec
            state.goal_line_detector = GoalLineDetector(spec)
        # LLM TrackingPlan (ADAAAA-6463, plan-first): accept the decide brain's
        # plan under `trackingPlan`. normalize() never raises, and a plan with
        # no trackable targets degrades to the canned/safe-default roster (see
        # resolve_vocabulary) — the per-frame path never crashes or goes
        # open-domain. Applying the plan rebuilds the zone trigger (plan zones
        # win) and reserves the anchor's primary slot on the tracker.
        if msg.get("trackingPlan") is not None:
            plan = _apply_tracking_plan(state, msg["trackingPlan"])
            return {"type": "ack", "ok": True, "cmd": "configure", "preferLabels": state.prefer_labels, "sampleFps": state.sample_fps, "trackingPlan": {"roster": plan.vocabulary(), "anchor": plan.anchor, "zones": plan.zones}}
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
    if ctype in ("track-player", "track-player-by-number"):
        # ADAAAA-7218 (Increment C): player-by-number identification + SAM3
        # handoff. Gated behind an explicit user request ("track player #9");
        # it NEVER runs in the default per-frame path (one-shot vision cost).
        # Run one-shot player-by-number identification on the anchor frame and
        # seed THAT player's SAM slot (selected -> surfaced + accuracy tracked);
        # SAM propagates from there, player detection is not re-run per frame.
        number = msg.get("number", msg.get("playerNumber"))
        if number is None:
            return {"type": "ack", "ok": False, "cmd": ctype, "error": "number required (jersey number)"}
        if state.last_rgb is None:
            return {"type": "ack", "ok": False, "cmd": ctype, "error": "no frame sampled yet (anchor frame required)"}
        try:
            requested = int(number)
        except (TypeError, ValueError):
            return {"type": "ack", "ok": False, "cmd": ctype, "error": f"bad jersey number: {number!r}"}
        detector = get_detector(state.lora_ref or None)
        matched = identify_player_by_number(state.last_rgb, requested, detector)
        if matched is None:
            return {"type": "ack", "ok": False, "cmd": ctype, "error": f"no player with number {requested} identified on the anchor frame"}
        bbox = tuple(matched["bbox"])
        kind = "player"
        # Surface the matched player's identity on the box the operator sees:
        # request "track player #9" -> the track carries label "player #9".
        label = f"player #{requested}"
        tr = state.tracker.seed(bbox, kind=kind, label=label, selected=True)
        state.requested_player_number = requested
        return {
            "type": "ack",
            "ok": True,
            "cmd": ctype,
            "number": requested,
            "slot": tr.slot,
            "trackId": tr.track_id,
            "selected": True,
            "bbox": list(bbox),
        }
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
            state.game_hint = req.gameHint
        if req.preferLabels:
            state.prefer_labels = list(req.preferLabels)
        # Per-stream LoRA injection (ADAAAA-5324): an attached adapter selects
        # this stream's detector at frame time (florence.get_detector(lora_ref)).
        if req.loraRef:
            state.lora_ref = req.loraRef
        # LLM TrackingPlan (ADAAAA-6463, plan-first): when the worker carries a
        # plan on /analyze, apply it BEFORE the frame runs so detect/seeding is
        # scoped to plan targets (off-plan objects dropped). Same effect as the
        # WS `configure` trackingPlan key.
        if req.trackingPlan is not None:
            _apply_tracking_plan(state, req.trackingPlan)
        # Per-camera/per-clip goal-line calibration (ADAAAA-6489 / ADAAAA-7159
        # Gap 2). Mirrors the WS `configure` homography/goalLine keys: a REAL
        # per-clip calibration delivered on every /analyze so a fresh or
        # re-reserved session inherits it on its first frame. Bad values are
        # ignored (KEEP the existing calibration) and never fatal; absent ->
        # image-space / no-goal-line-signal fallback (not_captured, never
        # fabricated).
        _apply_calibration(state, req.homography, req.goalLine)
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
        log.info("subscription open session=%s subscribers=%d", sid, len(state.subscribers))

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

    @router.post("/evidence")
    async def evidence(
        req: EvidenceRequest,
        livepeer_session_id: str | None = Header(default=None),
        x_session_id: str | None = Header(default=None),
    ):
        """On-demand perceive recall (ADAAAA-7008 / ADAAAA-7012).

        Returns the per-frame derived context ALREADY computed by ``process_frame``
        (tracks / detections / ocr) for the requested moment or window, WITHOUT
        re-running the detector — this is the "decide calls perceive on demand"
        path. ``centerTs`` + ``windowS`` selects a symmetric band; ``startTs`` +
        ``endTs`` an explicit one. Frames with no cached evidence are simply
        absent; when nothing is cached in range ``seeds: []`` is returned (an
        explicit no-op — a no-op recall never regresses a decision). A missing /
        unknown session also returns ``seeds: []`` (no fabrication). Does NOT
        widen the live tracking cap (LIVE_MAX_TRACKS=3 stays).
        """
        sid = _read_session_id(livepeer_session_id, x_session_id)
        if not sid:
            raise HTTPException(status_code=400, detail="missing session id (Livepeer-Session-Id or X-Session-Id)")
        state = registry.get(sid)
        if state is None:
            return {"centerTs": req.centerTs, "seeds": []}
        lo = req.startTs
        hi = req.endTs
        if req.centerTs is not None:
            half = (req.windowS if req.windowS is not None else 10.0) / 2.0
            if lo is None:
                lo = req.centerTs - half
            if hi is None:
                hi = req.centerTs + half
        seeds = [
            s
            for ts, s in state.frame_seeds.items()
            if (lo is None or ts >= lo) and (hi is None or ts <= hi)
        ]
        seeds.sort(key=lambda s: float(s.get("ts", 0)))
        return {"centerTs": req.centerTs, "seeds": seeds}


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
