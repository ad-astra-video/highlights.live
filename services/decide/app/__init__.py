from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, FastAPI, Request
from pydantic import BaseModel, ConfigDict, Field, model_serializer

log = logging.getLogger("highlights.decide")

from .logging_setup import configure_logging  # noqa: E402  (defines log above)

# Wire the decide log level from DECIDE_LOG_LEVEL (default INFO) at app load so
# the highlights.decide.* loggers actually emit. DEBUG adds per-candidate and
# full gemma invocation/result detail; the default logs a per-request summary.
configure_logging()

from .decider import apply_gate, decide, scoreboard_forces_goal
from .confirm import (  # noqa: F401
    ConfirmRequest,
    ConfirmDecision,
    confirm_enabled,
    run_confirmation_pass,
)
from .gemma import (  # noqa: F401
    apply_ball_outcome_gate,
    apply_contract_guard,
    apply_goal_attestation_gate,
    decide_group_with_gemma,
    decide_with_gemma,
    finalize_goal_acceptance,
    plan_tracking_with_gemma,
    title_with_gemma,
    _rule_outcome,
    _rule_summary,
    is_near_miss_ball_outcome,
    reconcile_outcome_with_ball_signal,
)
from .match_context_prompt import render_match_context_block, sanitize_match_context


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


class PerceiveTimelineRecord(BaseModel):
    """ADAAAA-8056 (lever B+e): ONE compact per-seed record in a decide window's
    perceive timeline.

    Perceive already emits this at 3 fps (tracks / objects / OCR scoreboard
    anchors / the additive goal-ball signal); the server folds 27-29 seeds into a
    handful of window scalars and used to drop *when* each was true. The server
    now forwards one compact record per seed instead, on the cheap text channel.

    Every field is clamped so a pathological payload can never 422 the live loop
    (ADAAAA-7022): `tracks` mirrors `Evidence.trackCount` (le=8), and the list
    fields are bounded. Scalars only — the bbox geometry stays in
    `Evidence.detections`.
    """

    model_config = ConfigDict(extra="ignore")
    ts: float = 0.0
    tracks: int = Field(default=0, ge=0, le=8)
    maxVelocity: float = Field(default=0.0, ge=0.0)
    objects: list[str] = Field(default_factory=list, max_length=8)
    trackIds: list[str] = Field(default_factory=list, max_length=8)
    ocr: list[str] = Field(default_factory=list, max_length=4)
    ballOutcome: Optional[str] = None
    possession: Optional[str] = None
    goalCrossed: Optional[bool] = None
    ballInNet: Optional[bool] = None
    scoreBoardChanged: Optional[bool] = None
    motionBurst: Optional[bool] = None


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
    # --- ADAAAA-8056 (lever B+e): the window's PERCEIVE TIMELINE ------------
    # One compact record per 3 fps perceive seed, ordered by ts. This is the
    # temporal density the scalar fold above (trackCount max / ocrHits sum /
    # <=16 detections) throws away — the model keeps "when" without the live
    # rail paying a frame per instant. Empty/absent == no timeline (VOD rail,
    # or a window with no seeds), so the prompt renders exactly as before.
    perceiveTimeline: list[PerceiveTimelineRecord] = Field(default_factory=list, max_length=32)


class ImageRef(BaseModel):
    role: str = "full"  # full | track0 | track1 | confirm
    base64: str = ""


class GroupCandidate(BaseModel):
    """One Stage-A candidate trigger inside a 3 s frame group (group mode).

    The server's live analyzer groups all Stage-A candidate triggers that fall
    inside one 3 s frame window and sends a single `/highlight` request carrying
    a ``candidates`` array plus the group's ``frames``. Each candidate has its
    own eventType / timestamp / evidence; the ONE merged gemma review returns a
    verdict PER candidate. ``extra=ignore`` so a newer upstream field never 422s
    the group call.
    """

    model_config = ConfigDict(extra="ignore")
    eventType: str
    timestamp: float = 0.0
    evidence: Evidence = Field(default_factory=Evidence)


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


class MatchContextTeam(BaseModel):
    """ADAAAA-7856: one side of the inferred match context.

    Additive and advisory: the resolver (ADAAAA-7855) persists this on the job
    and the server forwards the stored value on every window inspection. No
    numeric/string constraints here — a malformed context must NEVER 422 a
    decide request (constraint 4 of the spec); unusable fields are clipped by
    ``match_context_prompt.sanitize_match_context`` at render time instead.
    """

    model_config = ConfigDict(extra="ignore")
    name: str = ""
    side: str = "unknown"  # home | away | unknown
    kitColors: list = Field(default_factory=list)
    confidence: float = 0.0


class MatchContext(BaseModel):
    """ADAAAA-7856: the persisted per-job match context (sport + teams)."""

    model_config = ConfigDict(extra="ignore")
    sport: str = ""
    teams: list[MatchContextTeam] = Field(default_factory=list)
    ambiguous: bool = False


class HighlightRequest(BaseModel):
    sessionId: str
    eventType: str
    timestamp: float
    gameHint: str = ""
    # ADAAAA-7856: inferred teams + kit colours, read from the job's persisted
    # `matchContext` and rendered into the MATCH CONTEXT prompt block. Absent on
    # older/live/resolver-less jobs == today's prompt byte-for-byte (AC6).
    # `Any` on purpose: a shaped-but-wrong payload (teams as a string, a team
    # object missing a name, an out-of-range confidence) must degrade to "no
    # context", never to a 422 that drops the window.
    matchContext: Any = None
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
    # ADAAAA-6855: the job's requested highlight labels (e.g.
    # ["goals","saves","near-misses","red cards","counter-attacks"]). When a
    # non-goal class is requested, a correctly-detected instance of that class
    # is accepted and exported as a distinct highlight rather than being
    # swallowed by the scoring-only accept gate. Empty == default gate.
    preferLabels: list[str] = Field(default_factory=list)
    # Group mode: when the server's live analyzer groups all Stage-A candidate
    # triggers inside one 3 s frame window, it sends them here (one per
    # candidate, in order). Empty == the existing single-candidate call, whose
    # behavior is unchanged (byte-for-byte).
    candidates: list[GroupCandidate] = Field(default_factory=list)
    # ADAAAA-7028 Inc 2 audit identity (optional; the server forwards these so
    # the audit descriptor keys the durable index by (sessionId, groupKey)).
    jobId: Optional[str] = None
    groupKey: Optional[str] = None
    # ADAAAA-7111 (Increment D): the running video summary (story-so-far)
    # carried from the previous cadence observe tick so the model EXTENDS it
    # (not rewrite from scratch). Empty/absent on the first tick. Additive.
    storySoFar: Optional[str] = None
    # ADAAAA-7938 (Spec A): the compact prior-game-state block the VOD decide
    # pass forwards for every window after the first — running story-so-far,
    # the PREVIOUS window's ASR tail (where a goal call sits) and the structured
    # scoreboard-transition state. `Any` on purpose: a shaped-but-wrong payload
    # must degrade to "no block" (byte-identical prompt), never to a 422 that
    # drops the window.
    priorGameState: Any = None
    # ADAAAA-7781: ask for the COMPACT verdict contract (shorter prose fields, no
    # evidenceAttested list) and a 400-token completion cap. The live rail sets
    # it because its decide throughput is decode-bound and the cadence demand
    # (0.33 decides/s per stream) is set by output tokens per call. Absent/false
    # keeps the full contract byte-for-byte (VOD default).
    compact: bool = False
    # ADAAAA-8056 (AC-E1/E2): the LIVE window's coverage ledger. `perceiveWindow`
    # is {seeds, records, withFindings, centerTs} — what perceive aligned into the
    # window vs what the timeline actually carried — and `audioPresence` is where
    # the window's audio came from ({tapChunks, clipBytes, levels, spanFrom,
    # spanTo, pos, series}). `Any` on purpose: a shaped-but-wrong payload must
    # degrade to "no ledger", never to a 422 that drops the window.
    perceiveWindow: Any = None
    audioPresence: Any = None
    # ADAAAA-8081: the server's fire-time ASR side lane already transcribed this
    # window's audio clip. `asrPrefetched` + `asrTranscript` + `asrLatencyS` are
    # spread onto the request ONLY when ASR actually ran there (a failed timed-out
    # prefetch sends none of them), so an absent block means "transcribe inline
    # here", byte-identical to the pre-8081 request. `Any` for the same reason as
    # the ledgers above: a malformed block degrades to inline ASR, never a 422.
    asrPrefetched: Any = None
    asrTranscript: Any = None
    asrLatencyS: Any = None


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
    # ADAAAA-8081: `prefetch` when the server's fire-time side lane produced the
    # transcript (ASR ran OUTSIDE this decide call) or `inline` when this call
    # ran ASR itself. Additive; a rule-path verdict leaves it at "none".
    asrSource: str = "none"  # "prefetch" | "inline" | "none"
    # ADAAAA-8056 (AC-E2): whether this window carried ANY audio at all, and the
    # named reason when it did not. Without these a no-audio window is
    # indistinguishable from a transcribed one, which is exactly the inference
    # the ASR coverage AC forbids.
    windowAudioPresent: bool = False
    noAudioReason: str = ""  # "" | "no_audio_clip" | "retention_gap" | "asr_unavailable" | "audio_context_off"


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
    # ADAAAA-8325 (Inc 2): the footage phase from the VOD decide reply —
    # `live` action or a `replay` of earlier action. Additive metadata beside
    # `outcome`; None means UNKNOWN (absent/malformed/non-VOD rail), never a
    # silent "live". Declared here because the response model is extra="ignore"
    # (an undeclared field would be parsed and then dropped at the boundary).
    phase: Optional[Literal["live", "replay"]] = None
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
    # ADAAAA-8120: the deterministic contract guard's verdict. `contradictedBy`
    # is the machine-readable code + the evidence that refuted the claim (a
    # goal-type scoring_play accepted on commentary text alone); `contractGuard`
    # is the full guard record (outcome, measured attestation, missing channels,
    # refuting evidence) mirrored into `decide_audit.timings.contractGuard`.
    contradictedBy: Optional[str] = None
    contractGuard: Optional[dict] = None
    audioContext: Optional[AudioContext] = None
    # Group mode: one verdict dict per candidate, in the same order as the
    # request's `candidates` array. Empty for single-candidate calls, whose
    # behavior is unchanged.
    verdicts: list[dict] = Field(default_factory=list)
    # ADAAAA-7028 Inc 2: compact decide audit descriptor returned so the server
    # can index the exact request/response (one row per frame group). Contains
    # group identity, prompt text, media content hashes, model params, raw
    # reply, parsed verdicts, timings, fallback flag — never the media bytes.
    audit: Optional[Dict[str, Any]] = None
    # ADAAAA-7111 (Increment D): the updated running video summary (story-so-far)
    # after this window, so the server persists it and carries it into the next
    # cadence tick. Bounded (compacted). Empty when the path does not produce one.
    runningSummary: str = ""
    # ADAAAA-8318 (ADAAAA-8302 Option 2): the clip card's COPY TARGET — a short
    # post title (<60 chars / <10 words, one clause) the SAME reply produces
    # beside the announcer line. Declared here for the same reason
    # `runningSummary` is: `extra="ignore"` above silently DROPS an undeclared
    # field at the `/highlight` response boundary, so an undeclared title would
    # never reach the server. Empty on the VOD/full contract and the rule path;
    # the server write seam gates it and the read projection fills a
    # deterministic title when it is absent or refused.
    postTitle: str = ""
    # ADAAAA-7155 Increment A / ADAAAA-7221: the per-window LLM inspection block —
    # the exact prompt, the ordered dataItems, the frame/image refs, the audio/asr
    # context and the full model response (reasoning / verdict / evidenceAttested /
    # audioContext) for the decided window. Without a declared field here,
    # `extra="ignore"` above made FastAPI silently DROP it at the `/highlight`
    # response boundary, so the webapp never received it. Additive optional;
    # absent on rule-path verdicts that never built a prompt.
    analysis: Optional[dict] = None

    @model_serializer(mode="wrap")
    def _omit_unknown_phase(self, handler):
        """ADAAAA-8625: an UNKNOWN footage phase must not be stamped as
        ``"phase": null`` on the wire.

        ``phase`` is declared (ADAAAA-8325) because the response model is
        ``extra="ignore"``, so pydantic serializes the field even when it is
        None. The live compact contract never asks the model for a phase, so
        every live window came back with an explicit null; the server's
        ``AnalysisResponseSchema.phase`` (``.optional()``) rejects explicit null
        and dropped the whole window analysis. Absent = unknown (AC8 unchanged);
        a known phase is still emitted and serialized as before.
        """
        data = handler(self)
        if data.get("phase") is None:
            data.pop("phase", None)
        return data


def _is_gemma_mode() -> bool:
    return os.environ.get("DECIDE_MODE", "rule") == "gemma"


def _safe_float(value: object, default: float = 0.0) -> float:
    """ADAAAA-8081: coerce a wire value to float; anything non-numeric (a shaped
    but wrong prefetch block) degrades to `default` instead of raising."""
    try:
        out = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return out if out == out and abs(out) != float("inf") else default  # reject NaN/inf


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


class TitleRequest(BaseModel):
    """Compact summary for the text-only job-title call (ADAAAA-6798 Inc 1).

    Lightweight (no images/audio) — the one small Gemma inference per completed
    job. The server/worker sends gameHint + the job's eventTypes + the accepted
    highlight reasons + the accepted count; the decide brain returns a short
    human-readable title string."""

    model_config = ConfigDict(extra="ignore")
    gameHint: str = ""
    eventTypes: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    highlightCount: int = 0
    # ADAAAA-7856 (Stage 7 reuse): the job's persisted match context, so the
    # one title call names the real teams instead of inventing one. Absent ==
    # byte-identical title prompt to today.
    matchContext: Any = None


class TitleResponse(BaseModel):
    title: str


def _rule_title(req: TitleRequest) -> str:
    """Deterministic fallback title when Gemma is unavailable / in rule mode.
    Mirrors the server's own fallback shape so a completed job still has a
    sensible title even when the model is down (never blocks or fails the job)."""
    parts = []
    if req.gameHint:
        parts.append(req.gameHint)
    kinds = list(dict.fromkeys(req.eventTypes or []))
    if kinds:
        parts.append(", ".join(kinds[:3]))
    if req.highlightCount:
        parts.append(f"{req.highlightCount} highlight{'s' if req.highlightCount != 1 else ''}")
    if not parts:
        parts.append("Highlight reel")
    return " · ".join(parts)


def _postprocess_gemma_verdict(decision: dict, evidence: dict, event_type: str, prefer_labels: list[str]) -> dict:
    """Apply the DRY post-processing gates to ONE per-candidate gemma verdict
    (group mode), mirroring the single-candidate gemma path exactly:
    ball_outcome gate -> scoreboard force -> goal attestation -> notable-only ->
    finalize_goal_acceptance. Mutates and returns ``decision``."""
    ball_outcome = evidence.get("ballOutcome")
    if is_near_miss_ball_outcome(ball_outcome):
        decision = reconcile_outcome_with_ball_signal(decision, ball_outcome)
        gate_ok, gate_reason = True, None
    else:
        gate_ok, gate_reason = apply_ball_outcome_gate(evidence)
    if not gate_ok and decision.get("isHighlight"):
        decision["isHighlight"] = False
        decision["reason"] = (
            (decision.get("reason") or "") + "; " + (gate_reason or "")
        ).strip("; ")
    elif (
        scoreboard_forces_goal(
            bool(evidence.get("scoreBoardChanged", False)), decision.get("eventType") or event_type
        )
        and decision.get("outcome") != "not_highlight"
    ):
        # ADAAAA-7533: the scoreboard force must NOT override a model read that
        # EXPLICITLY refuted the goal (outcome=not_highlight). Mirror of the
        # single-candidate guard; the group-mode review path (_postprocess_gemma_verdict)
        # had the same unguarded I3 scoreboard_forces_goal override, so a group
        # verdict of "not_highlight" on a score_change-detected window could still
        # be resurrected to scoring_play. Only a goal-adjacent read (near_miss /
        # scoring_play) is rescued, preserving true-goal recall.
        decision["isHighlight"] = True
        decision["outcome"] = "scoring_play"
        decision["reason"] = (
            (decision.get("reason") or "") + "; scoreboard score change confirmed"
        ).strip("; ")
    att_ok, att_reason = apply_goal_attestation_gate(decision, evidence, event_type)
    if not att_ok and decision.get("isHighlight"):
        decision["isHighlight"] = False
        decision["reason"] = (
            (decision.get("reason") or "") + "; " + (att_reason or "")
        ).strip("; ")
    if decision.get("isHighlight"):
        ok, rejects = apply_gate(
            score=float(decision.get("score") or 0.0),
            event_type=decision.get("eventType") or event_type,
            track_count=evidence.get("trackCount", 0),
            max_velocity=evidence.get("maxVelocity", 0),
            ocr_hits=evidence.get("ocrHits", 0),
            reaction=evidence.get("reaction") or {},
            score_board_changed=evidence.get("scoreBoardChanged", False),
        )
        if not ok:
            decision["isHighlight"] = False
            decision["reason"] = (
                (decision.get("reason") or "")
                + "; rejected by notable-only bar: "
                + "; ".join(rejects)
            ).strip("; ")
    decision = finalize_goal_acceptance(decision, prefer_labels)
    # ADAAAA-8120: contract guard LAST, so it sees the final accept (group mode
    # carries no ASR transcript, so the claim is read off the decision's reason).
    decision, _guard = apply_contract_guard(
        decision, evidence, event_type, transcript="", perceive_window=None
    )
    return decision


def _rule_verdict(cand: "GroupCandidate", prefer_labels: list[str]) -> dict:
    """DRY per-candidate rule-path verdict (group mode), mirroring the
    single-candidate rule path: decide() -> ball_outcome gate -> near-miss
    reconcile -> finalize_goal_acceptance -> goal attestation guard."""
    evidence = cand.evidence.model_dump()
    d = decide(
        event_type=cand.eventType,
        track_count=cand.evidence.trackCount,
        max_velocity=cand.evidence.maxVelocity,
        ocr_hits=cand.evidence.ocrHits,
        reaction=cand.evidence.reaction.model_dump() if cand.evidence.reaction else None,
        score_board_changed=cand.evidence.scoreBoardChanged,
    )
    ball_outcome = evidence.get("ballOutcome")
    gate_ok, gate_reason = apply_ball_outcome_gate(evidence)
    if is_near_miss_ball_outcome(ball_outcome):
        d.is_highlight = True
    elif not gate_ok:
        d.is_highlight = False
        d.reason = ((d.reason or "") + "; " + (gate_reason or "")).strip("; ")
    dec = {
        "isHighlight": d.is_highlight,
        "score": d.score,
        "eventType": cand.eventType,
        "reason": d.reason,
        "source": "rule",
        "eventClass": d.event_class,
        "corroborated": d.corroborated,
        "outcome": _rule_outcome(d),
        "nearMiss": False,
    }
    if is_near_miss_ball_outcome(ball_outcome):
        dec = reconcile_outcome_with_ball_signal(dec, ball_outcome)
    dec = finalize_goal_acceptance(dec, prefer_labels)
    att_ok, att_reason = apply_goal_attestation_gate(dec, evidence, cand.eventType)
    if not att_ok and dec.get("isHighlight"):
        dec["isHighlight"] = False
        dec["reason"] = ((dec.get("reason") or "") + "; " + (att_reason or "")).strip("; ")
    # ADAAAA-8120: contract guard on the group rule path too (no transcript on
    # this path; the claim is read off the deterministic reason).
    dec, _guard = apply_contract_guard(dec, evidence, cand.eventType)
    return dec


async def _handle_group(req: "HighlightRequest") -> dict:
    """Group mode: ONE merged review for the whole 3 s frame group returns a
    verdict per candidate (same order as ``req.candidates``). The top-level
    response ``decision`` fields are taken from the FIRST verdict for backward
    compatibility; ``verdicts`` carries the full per-candidate list."""
    if _is_gemma_mode():
        raw = await asyncio.to_thread(
            decide_group_with_gemma,
            candidates=[c.model_dump() for c in req.candidates],
            game_hint=req.gameHint,
            images=[img.model_dump() for img in req.images],
            frames=[fr.model_dump() for fr in req.frames],
            audio_b64=req.audioB64,
            audio_sample_rate=req.audioSampleRate,
            reasoning_effort=req.reasoningEffort,
            url=os.environ.get("GEMMA_URL", "http://127.0.0.1:8088"),
            # ADAAAA-7856: the same stored match context every single-candidate
            # window carries, so a grouped live rail review also names the real
            # teams (absent == unchanged prompt, no extra inference).
            match_context=req.matchContext,
        )
        verdicts = [
            _postprocess_gemma_verdict(v, c.evidence.model_dump(), c.eventType, req.preferLabels)
            for v, c in zip(raw, req.candidates)
        ]
    else:
        verdicts = [_rule_verdict(c, req.preferLabels) for c in req.candidates]
    top = dict(verdicts[0])
    top["verdicts"] = verdicts
    _log_highlight("gemma" if _is_gemma_mode() else "rule", req, top)
    return top



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
    async def highlight(req: HighlightRequest, request: Request):
        # ADAAAA-8344: arrival -> parsed-body wall for this decide. The middleware
        # below stamps the request's arrival instant; everything between it and
        # this line is body transfer + pydantic validation, which is exactly the
        # `timings.requestParseMs` stage the decide-internal split reports. Best
        # effort: an unstamped request (a direct in-process call) reads None.
        arrived_at = getattr(request.state, "hl_arrived_at", None)
        request_parse_ms = max(0.0, (time.time() - arrived_at) * 1000.0) if arrived_at else None
        # Group mode (ADAAAA-6935): when the server's live analyzer grouped the
        # Stage-A candidates inside a 3 s frame window into a single merged call
        # (`candidates` non-empty), run ONE review for the whole group and return
        # a verdict per candidate. The existing single-candidate path (candidates
        # empty) is unchanged byte-for-byte below.
        if req.candidates:
            return await _handle_group(req)
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
                audit_ctx={
                    "sessionId": req.sessionId,
                    "jobId": req.jobId,
                    "groupKey": req.groupKey,
                    "frameCount": len(req.frames),
                    "candidateCount": 1,
                },
                story_so_far=req.storySoFar or "",
                compact=req.compact,
                # ADAAAA-7856: render the job's inferred teams + kit colours into
                # the window prompt (absent == byte-identical prompt to today).
                match_context=req.matchContext,
                # ADAAAA-7938 (Spec A): prior game state (absent == no block).
                prior_game_state=req.priorGameState,
                # ADAAAA-8056 (AC-E1/E2): the live window's perceive + ASR
                # coverage inputs. Absent on the VOD rail == unchanged payload.
                perceive_window=req.perceiveWindow,
                audio_presence=req.audioPresence,
                # ADAAAA-8081: the server's side-lane transcription of this
                # window's clip. Present => no inline ASR (the decide call is
                # gemma only); absent => inline ASR, exactly as before.
                asr_prefetched=bool(req.asrPrefetched),
                asr_transcript=(req.asrTranscript or "") if isinstance(req.asrTranscript, str) else "",
                asr_latency_s=_safe_float(req.asrLatencyS),
                request_parse_ms=request_parse_ms,
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
            # ADAAAA-7533: the scoreboard force must NOT override a model read
            # that EXPLICITLY refuted the goal (outcome=not_highlight). Perceive's
            # scoreBoardChanged flag is a 60s-rolling + transient-OCR delta
            # detector (scoreboard.py ScoreboardTracker), so it reports a "delta"
            # in no-goal windows (pre-match ceremony, free kick, anthem) long
            # after any real score change and on OCR misreads. Overriding a model
            # "no goal" read with that flag is exactly how the post-fix kids-soccer
            # run surfaced false GOALs (e.g. 570s anthem / free-kick windows). The
            # force is still allowed to rescue a goal-ADJACENT read (near_miss /
            # scoring_play) so true-goal recall is preserved — it may only be
            # skipped when the model already explicitly said "not a highlight".
            elif (
                scoreboard_forces_goal(
                    req.evidence.scoreBoardChanged, decision.get("eventType") or req.eventType
                )
                and decision.get("outcome") != "not_highlight"
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
            # ADAAAA-6855: a non-goal class explicitly requested in
            # preferLabels is accepted as a DISTINCT highlight (never a goal).
            decision = finalize_goal_acceptance(decision, req.preferLabels)
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
        # scoring_play; a near-miss read is rejected). ADAAAA-6855: a non-goal
        # class explicitly requested in preferLabels is accepted as a DISTINCT
        # highlight (never a goal).
        dec = finalize_goal_acceptance(dec, req.preferLabels)
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
        # ADAAAA-8120: contract guard on the rule path too (mirror of the gemma
        # path). The rule never confabulates a goal reason, so this is inert in
        # practice — it keeps the accept contract identical on both paths.
        dec, _guard = apply_contract_guard(
            dec,
            req.evidence.model_dump(),
            req.eventType,
            transcript=(req.asrTranscript or "") if isinstance(req.asrTranscript, str) else "",
        )
        # ADAAAA-7111 (Increment D): running video summary on the rule path too.
        dec["runningSummary"] = _rule_summary(
            req.storySoFar or "", dec.get("outcome") or _rule_outcome(d), req.eventType, dec.get("reason")
        )
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

    @router.post("/title", response_model=TitleResponse)
    async def title(req: TitleRequest):
        """Text-only job-title generation (ADAAAA-6798 Inc 1). One lightweight
        Gemma call per completed job: takes a compact summary (gameHint +
        eventTypes + accepted-highlight reasons + count) and returns a short
        human-readable title. Runs the inference in a worker thread (like the
        /highlight gemma branch, ADAAAA-6373) so /health stays responsive. On
        any failure (Gemma down / unparseable) returns a deterministic rule
        title so the caller never has to block the job on it."""
        if _is_gemma_mode():
            t = await asyncio.to_thread(
                title_with_gemma,
                game_hint=req.gameHint,
                event_types=req.eventTypes,
                reasons=req.reasons,
                highlight_count=req.highlightCount,
                url=os.environ.get("GEMMA_URL", "http://127.0.0.1:8088"),
                timeout_s=float(os.environ.get("TITLE_TIMEOUT_S", "5")),
                match_context=req.matchContext,
            )
            if t:
                return TitleResponse(title=t)
        # Rule / fallback path: Gemma unavailable, rule mode, or a null reply —
        # return a deterministic title; the caller still has its own fallback.
        return TitleResponse(title=_rule_title(req))

    @router.post("/confirm", response_model=ConfirmDecision)
    async def confirm(req: ConfirmRequest):
        """Stage-2 goal/near-miss confirmation pass (ADAAAA-6797).

        A deep frame dive that runs ONLY for goal-type candidates carrying no
        independent attestation. It presents the Stage-1 verdict + reason back,
        tests the contradictory hypothesis over denser frames / trajectory /
        optical-flow / audio context, and emits a structured ``goalConfirmed``
        verdict that is deterministically reconciled. The whole pass is gated by
        ``DECIDE_CONFIRM_ENABLED`` (default off, VOD-first); when disabled or on
        any model/parse failure it returns a passthrough that leaves the Stage-1
        verdict unchanged, so the server can call it safely. The gemma inference
        is a blocking sync call (httpx) — run it in a worker thread so /health
        stays responsive during inference (same pattern as /highlight)."""
        result = await asyncio.to_thread(
            run_confirmation_pass,
            req.model_dump(),
        )
        return ConfirmDecision(**result)

    app = FastAPI(title="highlights-decide", version="0.1.0")

    @app.middleware("http")
    async def _stamp_arrival(request: Request, call_next):
        """ADAAAA-8344: stamp the instant a decide request ARRIVES. The route
        handler runs after the body is transferred and validated, so
        `handler_entry - hl_arrived_at` is the request-parse/transfer stage the
        audit record reports as `timings.requestParseMs`. Cost: one clock read
        per request; no behavior change."""
        request.state.hl_arrived_at = time.time()
        return await call_next(request)
    # Canonical at root (go-livepeer strips `/app`); `/app/*` alias for direct calls.
    app.include_router(router)
    sub = FastAPI()
    sub.include_router(router)
    app.mount("/app", sub)
    return app


app = create_app()
