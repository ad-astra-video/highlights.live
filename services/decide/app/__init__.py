from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

log = logging.getLogger("highlights.decide")

from .logging_setup import configure_logging  # noqa: E402  (defines log above)

# Wire the decide log level from DECIDE_LOG_LEVEL (default INFO) at app load so
# the highlights.decide.* loggers actually emit. DEBUG adds per-candidate and
# full gemma invocation/result detail; the default logs a per-request summary.
configure_logging()

from .decider import apply_gate, decide, scoreboard_forces_goal
from .watcher import Frame as WatcherFrame, WatcherConfig, WatcherSession
from .depth_router import DepthRouter, DepthRouterConfig
from .deep_investigation import DeepInvestigator, DeepInvestigationConfig
from .gemma import (  # noqa: F401
    apply_ball_outcome_gate,
    apply_goal_attestation_gate,
    decide_with_gemma,
    finalize_goal_acceptance,
    plan_tracking_with_gemma,
    _rule_outcome,
    is_near_miss_ball_outcome,
    reconcile_outcome_with_ball_signal,
)


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


class Detection(BaseModel):
    """One per-detection observation (I4 / ADAAAA-6361) forwarded so the decide
    prompt can cite concrete geometry instead of guessing it from vision alone.
    All optional with safe defaults so an absent detection block renders without
    regression. ``bbox`` is normalized [x1, y1, x2, y2] in 0..1 frame space."""

    label: str = Field(default="")
    bbox: list[float] = Field(default_factory=list, max_length=4)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    trackId: str = Field(default="")


class Evidence(BaseModel):
    # ADAAAA-4736/5231: previously le=2. Real multi-player tracking observes >2
    # objects; a larger count is legitimate evidence and must not 422 the whole
    # request. Defensive upper bound well above realistic multi-player counts
    # (server clamps its own send to [0,2]; this just tolerates a larger one).
    trackCount: int = Field(default=0, ge=0, le=8)
    maxVelocity: float = Field(default=0.0, ge=0.0)  # normalized units/frame
    ocrHits: int = Field(default=0, ge=0)
    # Decide-leg I2 (ADAAAA-6359): goal-line / ball-outcome ground-truth signal
    # from perceive's homography goal-plane classifier. Optional; when present
    # the decide leg treats ballOutcome as a HARD GATE — a non-"goal" outcome
    # forces rejection regardless of Gemma's verdict. Absent == no goal-line
    # calibration / no signal, which never gates.
    goalCrossed: Optional[bool] = None
    ballOutcome: Optional[str] = None
    # I3 (ADAAAA-6360): a scoreboard score change was detected across the
    # candidate window — a hard, independent goal-confirmation signal. Absent
    # (default False) == weak/absent evidence, never on its own a goal.
    scoreBoardChanged: bool = Field(default=False)
    # People-reaction context (INC-4). Optional; absent == no reaction signal,
    # so the prompt renders without it (no regression vs today).
    reaction: ReactionEvidence = Field(default_factory=ReactionEvidence)
    # --- I4 / ADAAAA-6361: per-detection geometry + audio-energy level curve ---
    # Rich detection context so Gemma reasons over where things actually ARE
    # (boxes, ball, distance-to-goal, goal-line-relative position) and the shape
    # of the crowd/commentary energy over the window, not just a single scalar.
    # All empty/absent == no signal, so the prompt renders without them.
    detections: list[Detection] = Field(default_factory=list, max_length=16)
    ballPosition: list[float] | None = Field(default=None, max_length=2)  # [x, y] normalized
    distanceToGoal: float = Field(default=0.0, ge=0.0, le=5.0)
    goalLineDelta: float = Field(default=0.0)  # signed normalized: <0 before the line, >=0 crossed
    audioLevels: list[float] = Field(default_factory=list, max_length=64)  # short RMS energy curve


class ImageRef(BaseModel):
    role: str = "full"  # full | track0 | track1 | confirm
    base64: str = ""


class PlanRequest(BaseModel):
    """Single-shot what-to-track planner request (plan §4.4 / §7 D).

    The server/worker fires this ONCE at stream-start warm-up and on the
    out-of-band re-check cadence — NEVER from the per-frame hot path. `frame`
    is ONE representative frame (base64 JPEG); `mode` selects the maxTracks
    cap (live 3 / vod 8); `context` may carry fineTuneManifest /
    previousPlan / recentDiscoveryNotes. The heavyweight planner / discovery
    run on the decide runner's Gemma, priced like a /highlight call."""

    model_config = ConfigDict(extra="ignore")
    sessionId: str = ""
    intent: str = ""
    category: str = ""
    gameHint: str = ""
    # live | vod — selects the maxTracks proposal cap (3 live / 8 VOD).
    mode: str = "live"
    # Optional per-session planner context (fine-tune manifest, prior plan,
    # discovery notes) folded into the seed before the frame.
    context: dict = Field(default_factory=dict)
    # ONE representative frame (base64 JPEG) so the plan is grounded in the
    # feed's actual content. Absent/empty -> the planner still returns a valid
    # fallback plan (never raises, never None).
    image: str = ""
    reasoningEffort: str = "none"


class TrackingPlanResponse(BaseModel):
    """The validated TrackingPlan the decide brain produced (plan §7 A/D).

    Mirrors the perceive TrackingPlan contract's shape; `source` reports
    "planner" (brain produced a valid plan) or "planner-fallback" (degraded to
    a canned/safe-default roster). Server/worker applies guardrails (maxTracks
    clamp, narrow-only) after this; perceive applies the roster."""

    model_config = ConfigDict(extra="ignore")
    planVersion: int = 1
    category: str = ""
    intent: str = ""
    # Added by the perceiver so the worker can audit which path produced it.
    source: str = "planner"
    plannedAt: float = 0.0
    anchor: dict = Field(default_factory=dict)
    targets: list = Field(default_factory=list)
    zones: list = Field(default_factory=list)
    discovery: Optional[dict] = None
    maxTracks: int = 3
    reason: str = ""


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


class WatcherStartRequest(BaseModel):
    """Open a decide watcher session (ADAAAA-6738 G1c). VOD-first: the caller
    drives the stream with ingest/step; config is optional (defaults are the
    Pass 1 gate values: 3 s tick, 10 s window, 3 fps, <=30 frames, >=50 % overlap)."""

    model_config = ConfigDict(extra="ignore")
    sessionId: str = ""
    streamId: str = ""
    # Optional: when set (with TRACE_BASE), the watcher POSTs each decide->
    # perceive tool call/result to the server's analysis-session trace route.
    traceJobId: str = ""
    config: dict = Field(default_factory=dict)


class WatcherIngestRequest(BaseModel):
    """One frame to ingest into the watcher's rolling buffer."""

    model_config = ConfigDict(extra="ignore")
    ts: float
    seq: int = 0
    players: list = Field(default_factory=list)
    objects: list = Field(default_factory=list)
    caption: str = ""
    audioPeak: float = 0.0
    audioBaseline: float = 0.0


class WatcherStepRequest(BaseModel):
    """Advance one 3 s tick, emitting a timestamped summary row for the rolling
    10 s window ending at ``tickTs`` (stream seconds)."""

    model_config = ConfigDict(extra="ignore")
    tickTs: float


class DeepInvestigateRequest(BaseModel):
    """Run a deep investigation over a flagged moment (ADAAAA-6740 G3).

    ``flagTs`` is the moment the depth router flagged; the deep window is
    ``[flagTs - deep_back_s, flagTs + deep_forward_s]``. When ``flagTs`` is
    omitted, the last flag emitted by the depth router is investigated."""

    model_config = ConfigDict(extra="ignore")
    flagTs: float | None = None


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
    # Increment F / ADAAAA-6465: outcome taxonomy member + near-miss flag. The
    # model picks one of scoring_play | near_miss | big_play | not_highlight; a
    # near miss is notable but NOT a scoring play, surfaced at a lower score and
    # flagged `nearMiss` so downstream highlight assembly labels it distinctly.
    outcome: str = "not_highlight"
    nearMiss: bool = False
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


def _is_corroborated(ev: "Evidence") -> bool:
    """Whether the candidate carries any corroborating evidence beyond the bare
    trigger (mirror of the decider's has_corroboration), for the INFO summary."""
    return bool(
        ev.trackCount > 0
        or ev.maxVelocity > 0
        or ev.ocrHits > 0
        or ev.scoreBoardChanged
        or (
            ev.reaction
            and (
                ev.reaction.crowdEnergy > 0
                or ev.reaction.humansInMotion > 0
                or ev.reaction.ballSpeedMps > 0
            )
        )
    )


def _log_highlight(mode: str, req: "HighlightRequest", decision: dict) -> None:
    """Decision summary (INFO) + candidate detail (DEBUG) for a /highlight call."""
    log.info(
        "highlight decision session=%s event=%s frames=%d mode=%s is_highlight=%s score=%s event_out=%s outcome=%s reason=%r corroborated=%s",
        req.sessionId,
        req.eventType,
        len(req.frames),
        mode,
        decision.get("isHighlight"),
        decision.get("score"),
        decision.get("eventType"),
        decision.get("outcome"),
        decision.get("reason"),
        _is_corroborated(req.evidence),
    )
    # ADAAAA-6524 board feedback: a highlight identified is a salient default
    # event (INFO), distinct from the per-candidate DEBUG detail.
    if decision.get("isHighlight"):
        log.info(
            "highlight identified session=%s event=%s score=%s outcome=%s event_out=%s",
            req.sessionId, req.eventType, decision.get("score"),
            decision.get("outcome"), decision.get("eventType"),
        )
    log.debug(
        "highlight context session=%s event=%s frames=%d track_count=%d max_velocity=%.3f ocr=%d scoreboard=%s ball_outcome=%s goal_crossed=%s detections=%d audio_levels=%d",
        req.sessionId,
        req.eventType,
        len(req.frames),
        req.evidence.trackCount,
        req.evidence.maxVelocity,
        req.evidence.ocrHits,
        req.evidence.scoreBoardChanged,
        req.evidence.ballOutcome,
        req.evidence.goalCrossed,
        len(req.evidence.detections),
        len(req.evidence.audioLevels),
    )


def _log_plan(mode: str, req: "PlanRequest", resp: "TrackingPlanResponse") -> None:
    """Plan summary (INFO) + candidate roster detail (DEBUG) for a /plan call."""
    log.info(
        "plan decision session=%s mode=%s source=%s max_tracks=%d targets=%d reason=%r",
        req.sessionId, mode, resp.source, resp.maxTracks, len(resp.targets), resp.reason,
    )
    labels = [t.get("label") if isinstance(t, dict) else t for t in resp.targets]
    log.debug(
        "plan roster session=%s mode=%s targets=%s zones=%s anchor=%s",
        req.sessionId, mode, labels, resp.zones, resp.anchor,
    )


def _make_perceive_client(session_id: str):
    """Return a decide->perceive windowed-tool callable bound to ``session_id``,
    or None when neither PERCEIVE_URL nor MEDIA_BROKER_URL is set (then the
    watcher brain uses the frames' own signals).

    ADAAAA-6739 G2: routes the tool query through the MEDIA SERVER broker (the
    media server provisions/fronts the active perceive session and owns the
    media session the call belongs to). When MEDIA_BROKER_URL is set the query
    is POSTed to ``{MEDIA_BROKER_URL}/sessions/{session_id}/analysis/query``;
    otherwise it falls back to a direct ``{PERCEIVE_URL}/analysis/{tool}`` call
    (VOD / no-broker topology). Returns the bounded envelope, or None on any
    failure (never fatal to a tick).
    """
    import httpx

    media = os.environ.get("MEDIA_BROKER_URL", "").strip().rstrip("/")
    perceive = os.environ.get("PERCEIVE_URL", "").strip().rstrip("/")
    if media:
        def call(tool: str, start: float, end: float, max_points: int) -> Optional[dict]:
            try:
                r = httpx.post(
                    f"{media}/sessions/{session_id}/analysis/query",
                    json={"tool": tool, "start": start, "end": end, "maxPoints": max_points},
                    headers={"X-Session-Id": session_id, "Livepeer-Session-Id": session_id},
                    timeout=12.0,
                )
                r.raise_for_status()
                body = r.json()
                # The broker wraps the perceive envelope in {ok, result, trace};
                # the trace is echoed to the webapp/server by the media server, so
                # decide only consumes the tool result. A visible broker error is
                # treated as a tool failure (None) — never drops a watcher tick.
                return body.get("result") if isinstance(body, dict) else body
            except Exception as e:  # noqa: BLE001  a perceive hiccup must not drop a tick
                log.debug("watcher perceive %s via broker failed: %s", tool, e)
                return None
        return call

    if not perceive:
        return None

    def call(tool: str, start: float, end: float, max_points: int) -> Optional[dict]:
        try:
            r = httpx.post(
                f"{perceive}/analysis/{tool}",
                params={"start": start, "end": end, "maxPoints": max_points},
                headers={"X-Session-Id": session_id, "Livepeer-Session-Id": session_id},
                timeout=10.0,
            )
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001  a perceive hiccup must not drop a tick
            log.debug("watcher perceive %s failed: %s", tool, e)
            return None

    return call


def _make_control_sender(session_id: str):
    """Return a decide->perceive control-instruction sender bound to
    ``session_id``, or None when no broker/perceive base is configured.

    ADAAAA-6739 G2: instructions (track new object / drop tracking / adjust
    sampling rate) are sent to the perceive session THROUGH the media server
    broker (``{MEDIA_BROKER_URL}/sessions/{session_id}/analysis/control``) and
    applied/confirmed there; the broker traces the request + confirmation. Falls
    back to a direct ``{PERCEIVE_URL}/control`` call. Returns the perceive ack,
    or None on any failure.
    """
    import httpx

    media = os.environ.get("MEDIA_BROKER_URL", "").strip().rstrip("/")
    perceive = os.environ.get("PERCEIVE_URL", "").strip().rstrip("/")

    def send(instruction: dict) -> Optional[dict]:
        try:
            if media:
                r = httpx.post(
                    f"{media}/sessions/{session_id}/analysis/control",
                    json={"instruction": instruction},
                    headers={"X-Session-Id": session_id, "Livepeer-Session-Id": session_id},
                    timeout=12.0,
                )
                r.raise_for_status()
                body = r.json()
                return body.get("result") if isinstance(body, dict) else body
            if perceive:
                r = httpx.post(
                    f"{perceive}/control",
                    json=instruction,
                    headers={"X-Session-Id": session_id, "Livepeer-Session-Id": session_id},
                    timeout=10.0,
                )
                r.raise_for_status()
                return r.json()
            return None
        except Exception as e:  # noqa: BLE001  a control hiccup must not break the flow
            log.debug("watcher control %s failed: %s", instruction, e)
            return None

    return send


def _make_trace_sink(trace_job_id: str):
    """Return an analysis_session_traces sink that POSTs each record to the
    server's ``POST /jobs/:id/analysis/trace`` route (ADAAAA-6738 G1). Returns
    None (records dropped, logged at DEBUG) when TRACE_BASE is unset."""
    base = os.environ.get("TRACE_BASE", "").strip().rstrip("/")
    if not base or not trace_job_id:
        return None
    import httpx

    def sink(record: dict) -> None:
        try:
            r = httpx.post(
                f"{base}/jobs/{trace_job_id}/analysis/trace",
                json={"trace": record},
                timeout=5.0,
            )
            if r.status_code >= 400:
                log.debug("watcher trace POST failed: %s", r.status_code)
        except Exception as e:  # noqa: BLE001
            log.debug("watcher trace POST error: %s", e)

    return sink


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
            # ADAAAA-6373: the gemma inference is a blocking sync call (httpx).
            # Called directly it stalls uvicorn's single event loop for the
            # whole inference, so the go-livepeer orchestrator's /health probe
            # (runners.json health_url=/health) times out and marks the decide
            # runner `unavailable` -> decide requests intermittently 404
            # "runner not found". Run it in a worker thread so /health stays
            # responsive during inference.
            decision = await asyncio.to_thread(
                decide_with_gemma,
                event_type=req.eventType,
                evidence=req.evidence.model_dump(),
                game_hint=req.gameHint,
                images=[img.model_dump() for img in req.images],
                frames=[fr.model_dump() for fr in req.frames],
                audio_b64=req.audioB64,
                audio_sample_rate=req.audioSampleRate,
                reasoning_effort=req.reasoningEffort,
                url=os.environ.get("GEMMA_URL", "http://127.0.0.1:8088"),
                score_board_changed=req.evidence.scoreBoardChanged,
            )
            # Decide-leg I2 (ADAAAA-6359): HARD GATE over the perceived
            # goal-line ground-truth signal. A non-"goal" ballOutcome forces
            # rejection regardless of Gemma's verdict (deterministic, before the
            # notable-only gate). ADAAAA-6481 near-miss reconciliation: a
            # goal-bound shot that did NOT convert (blocked / off_target) is a
            # NEAR-MISS, not a rejection — surface it (never as scoring_play).
            ball_outcome = req.evidence.model_dump().get("ballOutcome")
            if is_near_miss_ball_outcome(ball_outcome):
                decision = reconcile_outcome_with_ball_signal(decision, ball_outcome)
                gate_ok, gate_reason = True, None
            else:
                gate_ok, gate_reason = apply_ball_outcome_gate(req.evidence.model_dump())
            if not gate_ok and decision.get("isHighlight"):
                decision["isHighlight"] = False
                decision["reason"] = (
                    (decision.get("reason") or "")
                    + "; " + (gate_reason or "")
                ).strip("; ")
            # I3 (ADAAAA-6360): a detected scoreboard score change for a GOAL
            # event is a hard, independent confirmation — force isHighlight=true
            # regardless of the model's read (skipped when the I2 ball-outcome
            # gate already rejected). Absence is weak/absent evidence and never
            # forces a goal (scoreboard_forces_goal is false). ADAAAA-6598: a
            # scoreboard-confirmed goal is a REAL goal, so it is upgraded to
            # scoring_play so the single accept gate (finalize_goal_acceptance)
            # keeps it accepted even when the model leaned near_miss.
            elif scoreboard_forces_goal(
                req.evidence.scoreBoardChanged, decision.get("eventType") or req.eventType
            ):
                decision["isHighlight"] = True
                decision["outcome"] = "scoring_play"
                decision["reason"] = (
                    (decision.get("reason") or "")
                    + "; scoreboard score change confirmed"
                ).strip("; ")
            # Goal-verification attestation gate (ADAAAA-6610 / ADAAAA-6588
            # crit 2/3 residual): the model CONFABULATES templated
            # `scoring_play` on non-goal frames. Reject an ACCEPTED goal whose
            # reason is bare templated AND which carries no attested
            # independent goal criterion (ballOutcome=goal / goalCrossed /
            # scoreboard change). Deliberately narrow: an attested goal or a
            # specific frame-grounded reason always passes (ADAAAA-6543 recall
            # behavior preserved).
            att_ok, att_reason = apply_goal_attestation_gate(
                decision, req.evidence.model_dump(), req.eventType
            )
            if not att_ok and decision.get("isHighlight"):
                decision["isHighlight"] = False
                decision["reason"] = (
                    (decision.get("reason") or "")
                    + "; " + (att_reason or "")
                ).strip("; ")
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
                    score_board_changed=req.evidence.scoreBoardChanged,
                )
                if not ok:
                    decision["isHighlight"] = False
                    decision["reason"] = (
                        (decision.get("reason") or "")
                        + "; rejected by notable-only bar: "
                        + "; ".join(rejects)
                    ).strip("; ")
            # ADAAAA-6598: single accept gate — ONLY a scoring_play is a
            # board-accepted GOAL highlight. This overrides any earlier gate
            # (high-value waiver, model isHighlight) for a near_miss/big_play/
            # not_highlight read so no false positive reaches the board.
            decision = finalize_goal_acceptance(decision)
            _log_highlight("gemma", req, decision)
            return decision
        ev = req.evidence.reaction.model_dump() if req.evidence.reaction else None
        d = decide(
            event_type=req.eventType,
            track_count=req.evidence.trackCount,
            max_velocity=req.evidence.maxVelocity,
            ocr_hits=req.evidence.ocrHits,
            reaction=ev,
            score_board_changed=req.evidence.scoreBoardChanged,
        )
        # Decide-leg I2 (ADAAAA-6359): HARD GATE — a non-"goal" perceived
        # ballOutcome forces rejection even on the deterministic rule path.
        # ADAAAA-6481: a goal-bound-but-not-converted ballOutcome (blocked /
        # off_target) is a near-miss, surfaced not rejected.
        ball_outcome = req.evidence.model_dump().get("ballOutcome")
        gate_ok, gate_reason = apply_ball_outcome_gate(req.evidence.model_dump())
        if is_near_miss_ball_outcome(ball_outcome):
            d.is_highlight = True
        elif not gate_ok:
            d.is_highlight = False
            d.reason = ((d.reason or "") + "; " + (gate_reason or "")).strip("; ")
        dec = {
            "isHighlight": d.is_highlight,
            "score": d.score,
            "eventType": req.eventType,
            "reason": d.reason,
            "source": "rule",
            "eventClass": d.event_class,
            "corroborated": d.corroborated,
            # Increment F / ADAAAA-6465: outcome taxonomy on the rule path too.
            "outcome": _rule_outcome(d),
            "nearMiss": False,
        }
        if is_near_miss_ball_outcome(ball_outcome):
            dec = reconcile_outcome_with_ball_signal(dec, ball_outcome)
        # ADAAAA-6598: single accept gate — ONLY a scoring_play is a
        # board-accepted GOAL highlight (a rule-path highlight maps to
        # scoring_play; a near-miss read is rejected).
        dec = finalize_goal_acceptance(dec)
        # Goal-verification attestation gate (ADAAAA-6610) on the rule path too
        # (mirror of the gemma path): an accepted goal with a bare templated
        # reason and no attested goal criterion is rejected. On the rule path
        # the reason is deterministic (never templated), so this is a no-op
        # consistency guard.
        att_ok, att_reason = apply_goal_attestation_gate(
            dec, req.evidence.model_dump(), req.eventType
        )
        if not att_ok and dec.get("isHighlight"):
            dec["isHighlight"] = False
            dec["reason"] = ((dec.get("reason") or "") + "; " + (att_reason or "")).strip("; ")
        _log_highlight("rule", req, dec)
        return dec

    @router.post("/plan", response_model=TrackingPlanResponse)
    async def plan(req: PlanRequest):
        """Single-shot what-to-track planner (plan §4.4 / §7 D). The worker
        fires this at stream-start warm-up + out-of-band re-check; it is NEVER
        on the per-frame path. Runs the decide brain (or the rule fallback in
        rule mode) and returns a validated TrackingPlan; on ANY failure the
        caller gets a fallback plan (source "planner-fallback"), never an
        exception — so perceive degrades to the canned/safe-default roster."""
        if _is_gemma_mode():
            # The decide runner's Gemma produces the plan from (intent,
            # category, one representative frame, context). frame is the one
            # representative frame (never a per-frame sequence). fold the
            # request's gameHint into context so sport resolution tracks it.
            ctx = dict(req.context or {})
            if req.gameHint and "gameHint" not in ctx:
                ctx["gameHint"] = req.gameHint
            # ADAAAA-6709: the planner inference is a blocking sync call
            # (httpx to the vLLM server). Called directly it stalls uvicorn's
            # single event loop for the whole run (up to PLANNER_TIMEOUT_S),
            # so the go-livepeer orchestrator's /health probe (runners.json
            # health_url=/health) times out and marks the decide runner
            # `unavailable` -> decide requests intermittently 404 "runner not
            # found". Run it in a worker thread so /health stays responsive
            # during inference, exactly like the /highlight gemma branch
            # (ADAAAA-6373) does.
            plan = await asyncio.to_thread(
                plan_tracking_with_gemma,
                intent=req.intent,
                category=req.category,
                frame={"base64": req.image} if req.image else None,
                context=ctx,
                mode=req.mode,
                url=os.environ.get("GEMMA_URL", "http://127.0.0.1:8088"),
                timeout_s=float(os.environ.get("PLANNER_TIMEOUT_S", "180")),
            )
            resp = TrackingPlanResponse(**plan) if plan else TrackingPlanResponse(source="planner-fallback", reason="planner returned no plan")
            _log_plan("gemma", req, resp)
            return resp
        # Rule/stub mode: no Gemma; return a deterministic safe-default plan so
        # the worker still gets a valid, type-specific, non-empty-ish contract
        # (perceive degrades an empty roster to the canned gameHint map).
        resp = TrackingPlanResponse(
            category=req.category or "",
            intent=req.intent or "",
            source="planner-fallback",
            plannedAt=time.time(),
            maxTracks=3 if req.mode == "live" else 8,
            reason="rule mode: no gemma planner; perceive uses canned/safe-default roster",
        )
        _log_plan("rule", req, resp)
        return resp

    @router.get("/watcher/state")
    async def watcher_state():
        sess = getattr(app.state, "watcher", None)
        if sess is None:
            return {"active": False}
        return {"active": True, **sess.state()}

    @router.post("/watcher/start")
    async def watcher_start(req: WatcherStartRequest):
        perceive_client = _make_perceive_client(req.sessionId)
        trace_sink = _make_trace_sink(req.traceJobId)
        # watcher config is the pass-1 subset; depth/deep sub-configs are
        # extracted separately (ADAAAA-6740 G3) so an unknown key never 500s.
        base_config = {k: v for k, v in req.config.items() if k not in ("depth", "deep")}
        sess = WatcherSession(
            session_id=req.sessionId,
            stream_id=req.streamId,
            config=WatcherConfig(**base_config),
            perceive=perceive_client,
            trace=trace_sink,
        )
        app.state.watcher = sess
        # Pass 2 depth router (sole trigger authority) + deep investigator
        # share the same tool client and trace sink as pass 1 (ADAAAA-6740 G3).
        app.state.depth = DepthRouter(
            session_id=req.sessionId,
            stream_id=req.streamId,
            config=DepthRouterConfig(**req.config.get("depth", {})),
            perceive=perceive_client,
            trace=trace_sink,
        )
        app.state.deep = DeepInvestigator(
            session_id=req.sessionId,
            stream_id=req.streamId,
            config=DeepInvestigationConfig(**req.config.get("deep", {})),
            perceive=perceive_client,
            trace=trace_sink,
        )
        return {"ok": True, "state": sess.state()}

    @router.post("/watcher/ingest")
    async def watcher_ingest(req: WatcherIngestRequest):
        sess = getattr(app.state, "watcher", None)
        if sess is None:
            raise HTTPException(status_code=409, detail="no watcher session; call /watcher/start first")
        sess.ingest(WatcherFrame(
            ts=req.ts, seq=req.seq, players=req.players or [], objects=req.objects or [],
            caption=req.caption or "", audio_peak=req.audioPeak or 0.0, audio_baseline=req.audioBaseline or 0.0,
        ))
        return {"ok": True}

    @router.post("/watcher/step")
    async def watcher_step(req: WatcherStepRequest):
        sess = getattr(app.state, "watcher", None)
        if sess is None:
            raise HTTPException(status_code=409, detail="no watcher session; call /watcher/start first")
        row = sess.step(req.tickTs)
        # Feed pass 2 (depth router); it may flag a moment for deep investigation.
        depth = getattr(app.state, "depth", None)
        flag = None
        if depth is not None:
            depth.observe(row)
            flag = depth.step(req.tickTs)
        return {
            "summary": row.to_dict(),
            "context": sess.summaries_context_dicts(),
            "state": sess.state(),
            "flag": flag.to_dict() if flag else None,
        }

    @router.post("/watcher/step2")
    async def watcher_step2(req: WatcherStepRequest):
        """Advance pass 1 + pass 2 and auto-run deep investigation on any flag.

        Returned ``deepVerdicts`` lists the deep-investigation verdict(s) for any
        moment flagged this tick. The deep window is read from the watcher's
        frame buffer, so the caller must have ingested frames through
        ``flagTs + deep_forward_s`` for a full window (VOD pre-ingest)."""
        sess = getattr(app.state, "watcher", None)
        if sess is None:
            raise HTTPException(status_code=409, detail="no watcher session; call /watcher/start first")
        row = sess.step(req.tickTs)
        depth = getattr(app.state, "depth", None)
        deep = getattr(app.state, "deep", None)
        flag = None
        verdicts = []
        if depth is not None:
            depth.observe(row)
            flag = depth.step(req.tickTs)
        if flag is not None and deep is not None:
            if hasattr(sess, "_frames_in"):
                v = deep.investigate(flag, lambda start, end: sess._frames_in(start, end))
                verdicts.append(v.to_dict())
        return {
            "summary": row.to_dict(),
            "context": sess.summaries_context_dicts(),
            "state": sess.state(),
            "flag": flag.to_dict() if flag else None,
            "deepVerdicts": verdicts,
        }

    # --- Pass 2 / deep-investigation surface (ADAAAA-6740 G3) --------------
    @router.get("/depth/state")
    async def depth_state():
        depth = getattr(app.state, "depth", None)
        if depth is None:
            return {"active": False}
        return {"active": True, **depth.state()}

    @router.get("/depth/flags")
    async def depth_flags():
        depth = getattr(app.state, "depth", None)
        if depth is None:
            return {"flags": []}
        return {"flags": depth.flags_dicts()}

    @router.post("/deep/investigate")
    async def deep_investigate(req: DeepInvestigateRequest):
        sess = getattr(app.state, "watcher", None)
        depth = getattr(app.state, "depth", None)
        deep = getattr(app.state, "deep", None)
        if deep is None:
            raise HTTPException(status_code=409, detail="no deep-investigation session; call /watcher/start first")
        if req.flagTs is None:
            if depth is None or not depth.flags:
                raise HTTPException(status_code=422, detail="no flag to investigate (provide flagTs)")
            flag = depth.flags[-1]
        else:
            flag = next((f for f in (depth.flags if depth else []) if abs(f.ts - req.flagTs) < 1e-6), None)
            if flag is None:
                raise HTTPException(status_code=404, detail=f"no flag at ts {req.flagTs}")
        if sess is None or not hasattr(sess, "_frames_in"):
            raise HTTPException(status_code=409, detail="watcher session has no frame buffer")
        v = deep.investigate(flag, lambda start, end: sess._frames_in(start, end))
        return {"verdict": v.to_dict(), "state": deep.state()}

    @router.get("/deep/state")
    async def deep_state():
        deep = getattr(app.state, "deep", None)
        if deep is None:
            return {"active": False}
        return {"active": True, **deep.state()}

    @router.get("/deep/verdicts")
    async def deep_verdicts():
        deep = getattr(app.state, "deep", None)
        if deep is None:
            return {"verdicts": []}
        return {"verdicts": deep.verdicts_dicts()}

    @router.get("/watcher/summaries")
    async def watcher_summaries():
        sess = getattr(app.state, "watcher", None)
        if sess is None:
            return {"summaries": []}
        return {"summaries": sess.summaries_context_dicts()}

    app = FastAPI(title="highlights-decide", version="0.1.0")
    # Canonical at root (go-livepeer strips `/app`); `/app/*` alias for direct calls.
    app.include_router(router)
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)
    return app


app = create_app()
