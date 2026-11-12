"""Discrete HUD event reader — the GPU-free ``hud-event`` Stage-A site
(ADAAAA-8742 WP1, plan ADAAAA-7812 §2).

What this module is
-------------------
A Stage-A candidate reader, matching the layer's existing contract: it looks at
one frame, scores the profile's declared HUD bands, and emits candidates. It
never calls florence, gemma, OCR or any network path — that is what keeps the
bounded GPU job count at 4 for the esports R1 build (plan §2 constraint 2).

Why a DISCRETE transition detector, not a continuous change detector
--------------------------------------------------------------------
The audio gate is the reference failure for this type: 14.48 candidates/minute
against 1.08 real objective events/minute, in-window FP 0.9417. A continuous
"something changed" detector reproduces exactly that: every animated banner
frame is a candidate. So each band here runs a small state machine:

    armed (at rest)  --step--  pending (dwell)  -->  ONE candidate  -->  latched
       ^                                                                  |
       +--------------- quiet for ``quiet_frames`` ----------------------- +

- A step is ``|signature - reference| >= change_sensitivity``, where ``reference``
  is a **short rolling reference** (the mean of the last ``reference_frames``
  observed signatures) and not a frozen latch-time frame. A frozen frame is a
  drift accumulator: every later frame is scored against a picture the band left
  behind seconds ago, so a moving band reads as a permanent step.
- A step must persist ``min_dwell_frames`` consecutive frames before it is a
  transition; a shorter one is a flicker and emits nothing (the default of 3
  suppresses the 2-frame flicker this module is tested against). The reference is
  held at its pre-step value for the length of the run, so the last frame of the
  dwell run still measures the full step.
- Once emitted, the band LATCHES: while the new state persists no further
  candidate can come out of it, and the return to rest is the re-arm, not a
  second candidate. Emitting both edges would double the candidate volume for
  one event, which is the A4 failure mode, not a feature.
- The latch release is **physical**, not an exact return to the latch-time
  picture: the band re-arms after ``quiet_frames`` consecutive frames back below
  sensitivity against the reference it latched with, or after ``max_latch_frames``
  frames at the outside. On release the reference is reset to the band's *current*
  rolling reference, so the next transition is measured from where the band
  actually is. Requiring an exact return forever is what ADAAAA-8744 measured as
  the park: on a 1 fps HUD the race clock's digits change every frame and the
  banner band sits over animated gameplay, so the quiet run never accumulated and
  14 of 15 labelled instants found the event band already latched.
- At most ONE candidate per frame: bands that confirm on the same frame are the
  same observable event (a race start is clock-reset *and* banner at once), so
  the highest-scoring band carries the candidate and the rest are reported as
  ``coincidentBands``.

The A4 property (<= 1.5 candidates/minute in-window, <= 34 overall) follows from
the latch: candidates scale with transitions, not with frames.

Opt-in, default OFF
-------------------
Like the ``PERCEIVE_ROI_ENABLED`` handoff (``florence._roi_enabled``), the site
is gated by ``PERCEIVE_HUD_EVENT_ENABLED`` and is OFF unless it is explicitly
set to a truthy value. With the flag off ``observe`` returns ``[]`` and never
touches state, so a profile that declares a ``hudModel`` still produces zero
candidates on the served path until an operator arms it.

Independence (A6)
-----------------
This module imports stdlib + numpy + the profile contract only. It has no import
edge to ``evals/`` and in particular none to
``evals/supertuxkart_val/build_stk_labels.py``; ``test_hud_reader.py`` asserts
that by walking this file's import graph (static and at runtime).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Sequence, Tuple

import numpy as np

from .game_profile import TRIGGER_HUD_EVENT, HudBand, HudModel

# --- opt-in gate (the PERCEIVE_ROI_ENABLED idiom) ---------------------------

HUD_EVENT_ENV = "PERCEIVE_HUD_EVENT_ENABLED"  # "1"/"0", default OFF


def hud_event_enabled() -> bool:
    """True only when the operator explicitly armed the HUD event reader.

    Same reading as ``florence._roi_enabled``: unset/``0``/``false``/``no``/``""``
    all mean OFF, so an unset environment is the shipped default and flips
    nothing on the served path.
    """
    return os.environ.get(HUD_EVENT_ENV, "0").strip().lower() not in (
        "0",
        "false",
        "no",
        "",
    )


# --- per-band signature / change score -------------------------------------


def _clip_rect(
    band: HudBand, frame_h: int, frame_w: int
) -> Optional[Tuple[int, int, int, int]]:
    """The band rect clipped to the frame, or ``None`` when it is outside it."""
    try:
        x0, y0, x1, y1 = (int(v) for v in band.rect)
    except (TypeError, ValueError):
        return None
    x0 = max(0, min(frame_w, x0))
    y0 = max(0, min(frame_h, y0))
    x1 = max(0, min(frame_w, x1))
    y1 = max(0, min(frame_h, y1))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return x0, y0, x1, y1


def band_signature(
    frame: Any, band: HudBand, cell: int = 8
) -> Optional[np.ndarray]:
    """A ``cell`` x ``cell`` grayscale signature of one band, in [0, 255].

    Downsampling is a fixed index sample (no scipy, no resize dependency) so the
    cost is O(cell^2) regardless of band size. Returns ``None`` for a frame or
    rect that cannot be read (a short/absent frame is never fatal).
    """
    if frame is None:
        return None
    arr = np.asarray(frame)
    if arr.ndim < 2 or arr.size == 0:
        return None
    h, w = int(arr.shape[0]), int(arr.shape[1])
    rect = _clip_rect(band, h, w)
    if rect is None:
        return None
    x0, y0, x1, y1 = rect
    crop = arr[y0:y1, x0:x1]
    if crop.ndim == 3:
        # mean over channels; float32 keeps the arithmetic cheap and stable
        crop = crop.astype(np.float32).mean(axis=2)
    else:
        crop = crop.astype(np.float32)
    ch, cw = int(crop.shape[0]), int(crop.shape[1])
    ys = np.linspace(0, ch - 1, min(cell, ch)).round().astype(np.intp)
    xs = np.linspace(0, cw - 1, min(cell, cw)).round().astype(np.intp)
    return crop[np.ix_(ys, xs)]


def band_change_score(
    frame: Any, band: HudBand, baseline: Optional[np.ndarray], cell: int = 8
) -> Optional[float]:
    """Mean absolute signature delta for one band, normalized to [0, 1].

    ``None`` means "not readable this frame" (never scored as a change).
    """
    sig = band_signature(frame, band, cell)
    if sig is None or baseline is None:
        return None
    if sig.shape != baseline.shape:
        return None
    return float(np.abs(sig - baseline).mean() / 255.0)


def signature_change_score(
    sig: Optional[np.ndarray], reference: Optional[np.ndarray]
) -> Optional[float]:
    """The same score for an already-extracted signature and reference.

    The reader scores every frame against its rolling reference, so it has the
    signature in hand already; re-extracting it per band would double the cost.
    """
    if sig is None or reference is None or sig.shape != reference.shape:
        return None
    return float(np.abs(sig - reference).mean() / 255.0)


# --- the transition record -------------------------------------------------


@dataclass(frozen=True)
class HudTransition:
    """One discrete HUD state change, emitted once per transition."""

    band: str
    kind: str
    direction: str  # always "enter": the settling edge is the re-arm, not a candidate
    score: float
    timestamp: float
    seq: Optional[int] = None
    coincident_bands: Tuple[str, ...] = ()
    detail: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class BandState:
    """Per-band latch for the discrete transition detector.

    - ``recent`` — the trailing window of observed signatures; the rolling
      reference is their mean. It advances on every readable frame, which is what
      keeps a moving band from reading as a permanent step.
    - ``baseline`` — the reference the step is scored against. At rest it IS the
      rolling reference (so drift is followed); while a step run is in progress it
      is held at its pre-step value so the whole dwell run measures the same step.
    - ``latched`` / ``latch_frames`` — the new state, and how long it has held.
    """

    baseline: Optional[np.ndarray] = None
    recent: list = field(default_factory=list)
    changed_run: int = 0
    quiet_run: int = 0
    latched: bool = False
    latch_frames: int = 0
    in_run: bool = False
    pending_score: float = 0.0
    last_score: float = 0.0


class HudEventReader:
    """The ``hud-event`` Stage-A site: one candidate per HUD transition.

    Constructed with the profile's ``hudModel``. ``enabled`` defaults to the env
    gate, so a test (or an operator) arms it with
    ``PERCEIVE_HUD_EVENT_ENABLED=1`` and an unarmed reader is inert.
    """

    def __init__(
        self,
        model: HudModel,
        *,
        enabled: Optional[bool] = None,
        name: str = "hud",
    ) -> None:
        self.model = model
        self.name = name
        self.enabled = hud_event_enabled() if enabled is None else bool(enabled)
        self._states: dict[str, BandState] = {
            band.name: BandState() for band in model.bands
        }
        self.frames_observed = 0
        self.candidates_emitted = 0
        self.flickers_suppressed = 0
        self.forced_rearms = 0

    # -- internals -------------------------------------------------------

    def state_for(self, band_name: str) -> BandState:
        return self._states[band_name]

    def _rolling_reference(self, st: BandState) -> Optional[np.ndarray]:
        """The mean of the trailing window, excluding the frame being scored.

        ``None`` until the window holds at least one older frame: the first frame
        has nothing to be compared against and seeds the reference instead.
        """
        if not st.recent:
            return None
        return np.mean(np.stack(st.recent[-self.model.reference_frames:]), axis=0)

    def _push(self, st: BandState, sig: np.ndarray) -> None:
        st.recent.append(sig)
        keep = max(1, int(self.model.reference_frames))
        if len(st.recent) > keep:
            del st.recent[:-keep]

    def change_scores(self, frame: Any) -> dict[str, Optional[float]]:
        """Per-band change score against each band's CURRENT reference.

        A diagnostic/evidence read used by the tests and the measurement passes;
        it does not mutate the latch.
        """
        out: dict[str, Optional[float]] = {}
        for band in self.model.bands:
            out[band.name] = band_change_score(
                frame, band, self._states[band.name].baseline, self.model.cell
            )
        return out

    def reset(self) -> None:
        for st in self._states.values():
            st.baseline = None
            st.recent = []
            st.changed_run = 0
            st.quiet_run = 0
            st.latched = False
            st.latch_frames = 0
            st.in_run = False
            st.pending_score = 0.0
            st.last_score = 0.0
        self.frames_observed = 0
        self.candidates_emitted = 0
        self.flickers_suppressed = 0
        self.forced_rearms = 0

    # -- the frame entry point -------------------------------------------

    def observe(
        self, frame: Any, timestamp: float, *, seq: Optional[int] = None
    ) -> list[HudTransition]:
        """Score this frame and return at most ONE transition candidate.

        Unarmed (env flag off) returns ``[]`` without mutating any state, which
        is what makes "flag off -> zero candidates" a property of the reader
        rather than of its caller.
        """
        if not self.enabled:
            return []

        self.frames_observed += 1
        confirmed: list[tuple[HudBand, float]] = []

        for band in self.model.bands:
            st = self._states[band.name]
            sig = band_signature(frame, band, self.model.cell)
            if sig is None:
                continue
            live = self._rolling_reference(st)
            if live is None or live.shape != sig.shape:
                # Seed frame (or a band whose geometry changed): this signature IS
                # the resting state. A single sample is never a transition.
                st.recent = [sig]
                st.baseline = sig
                continue

            # --- latched: hold the new state until one of two releases --------
            if st.latched:
                st.latch_frames += 1
                score = signature_change_score(sig, st.baseline)
                if score is not None:
                    st.last_score = score
                if score is not None and score < self.model.change_sensitivity:
                    st.quiet_run += 1
                else:
                    st.quiet_run = 0
                bounded = False
                if st.quiet_run < self.model.quiet_frames:
                    if st.latch_frames < self.model.max_latch_frames:
                        self._push(st, sig)
                        continue
                    bounded = True
                # Two physical releases:
                #  * settled — the band came back to the pre-step state, which is
                #    the settling edge and is NOT a candidate (A4);
                #  * bounded — the band held some state for max_latch_frames, so
                #    the hold has outlived any single HUD display. Re-arm against
                #    where the band actually is; this emits nothing by itself.
                st.latched = False
                st.latch_frames = 0
                st.quiet_run = 0
                st.changed_run = 0
                st.in_run = False
                st.pending_score = 0.0
                # Adopt the state the band is IN, and rebuild the rolling window
                # from it: a window that still holds frames from before the change
                # would read as a step against itself on the next frame.
                st.baseline = sig
                st.recent = []
                if bounded:
                    self.forced_rearms += 1
                continue

            # --- armed: score the step against the rolling reference ---------
            if not st.in_run:
                # At rest the reference follows the band (that is the drift
                # tracking that keeps a slow HUD move from reading as a step).
                st.baseline = live
            score = signature_change_score(sig, st.baseline)
            if score is None:
                st.baseline = live
                self._push(st, sig)
                continue
            st.last_score = score

            if score >= self.model.change_sensitivity:
                st.changed_run += 1
                st.quiet_run = 0
                st.pending_score = max(st.pending_score, score)
                if not st.in_run:
                    # Freeze the pre-step reference for the run: every frame of the
                    # dwell run has to measure the same step, or a 4-frame dwell
                    # could never confirm against a reference that already rolled.
                    st.in_run = True
                if st.changed_run >= self.model.min_dwell_frames:
                    st.latched = True
                    st.latch_frames = 0
                    st.changed_run = 0
                    st.in_run = False
                    confirmed.append((band, st.pending_score))
                    st.pending_score = 0.0
            else:
                # below sensitivity: the band is at rest against its reference
                if st.in_run:
                    # A change that never reached the dwell bar was a flicker.
                    self.flickers_suppressed += 1
                    st.changed_run = 0
                    st.in_run = False
                    st.pending_score = 0.0
                    st.baseline = sig
                    st.recent = []
                else:
                    st.baseline = live
            self._push(st, sig)

        if not confirmed:
            return []

        # One candidate per frame: bands confirming together are one observable
        # event, so the highest score carries it and the others ride along.
        confirmed.sort(key=lambda item: item[1], reverse=True)
        lead_band, lead_score = confirmed[0]
        others = tuple(b.name for b, _ in confirmed[1:])
        self.candidates_emitted += 1
        return [
            HudTransition(
                band=lead_band.name,
                kind=lead_band.kind,
                direction="enter",
                score=lead_score,
                timestamp=float(timestamp),
                seq=seq,
                coincident_bands=others,
                detail={
                    "trigger": TRIGGER_HUD_EVENT,
                    "dwellFrames": self.model.min_dwell_frames,
                },
            )
        ]


def reader_for_profile(profile: Any, *, enabled: Optional[bool] = None) -> Optional["HudEventReader"]:
    """Build the reader a profile declares, or ``None`` when it declares none.

    A profile with no ``hudModel`` yields no reader and the site stays inert —
    there is no default geometry to fall back to, and inventing one would let a
    type fire on bands nobody measured.
    """
    model = getattr(profile, "hud_model", None)
    if model is None:
        return None
    if not profile.allows(TRIGGER_HUD_EVENT):
        return None
    return HudEventReader(model, enabled=enabled)


__all__ = [
    "HUD_EVENT_ENV",
    "hud_event_enabled",
    "band_signature",
    "band_change_score",
    "HudTransition",
    "BandState",
    "HudEventReader",
    "reader_for_profile",
]
