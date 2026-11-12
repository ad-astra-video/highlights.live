"""ADAAAA-8742 WP1 — the discrete HUD event reader (``hud-event`` Stage-A site).

Acceptance criteria this file covers, one test each:

1. per-band change score (a step reads as a change, a slow drift does not);
2. the dwell gate suppresses a two-frame flicker;
3. exactly ONE candidate per HUD transition (no re-fire while the new state
   persists, and a second transition after the re-arm is a second candidate);
3b. the re-arm is physical: a moving band that never returns to its latch-time
   picture re-arms on the ``max_latch_frames`` bound (ADAAAA-8767), and a
   never-resting band's volume stays bounded by that window;
4. a profile with no ``hudModel`` leaves the site inert — no crash, no fire;
5. the env flag OFF produces zero candidates (the site is opt-in, default off);
6. the reader's import graph does not reach ``build_stk_labels`` (A6) and has no
   florence/gemma edge (the GPU-free constraint);
7. A5 evidence: per-frame CPU cost over a synthetic 426x240 series, p95 <= 500 ms.

Every frame here is synthesised on CPU; no GPU, no network, no model call.
"""
import ast
import os
import sys
import time

import numpy as np
import pytest

from app import hud_reader, stage_a
from app.game_profile import (
    ALL_TRIGGERS,
    FRAME_TRIGGERS,
    SUPERTUXKART_PROFILE,
    TRIGGER_AUDIO,
    TRIGGER_HUD_EVENT,
    AudioThresholds,
    GameProfile,
    HudBand,
    HudModel,
    TrackingRoster,
    TriggerSubset,
    ZoneModel,
)
from app.hud_reader import (
    HUD_EVENT_ENV,
    HudEventReader,
    band_change_score,
    band_signature,
    hud_event_enabled,
    reader_for_profile,
)

FRAME_W, FRAME_H = 426, 240  # the native resolution the type was measured at

BANNER_RECT = (150, 90, 276, 130)
CLOCK_RECT = (20, 10, 140, 40)


def _model(**overrides) -> HudModel:
    kwargs = dict(
        bands=(
            HudBand(name="banner", rect=BANNER_RECT, kind="banner"),
            HudBand(name="clock", rect=CLOCK_RECT, kind="clock"),
        ),
        change_sensitivity=0.10,
        min_dwell_frames=3,
        quiet_frames=2,
        cell=8,
    )
    kwargs.update(overrides)
    return HudModel(**kwargs)


def _frame(active=(), *, fill: int = 30, bright: int = 220) -> np.ndarray:
    """A 426x240 frame; the bands in ``active`` are painted bright."""
    frame = np.full((FRAME_H, FRAME_W, 3), fill, dtype=np.uint8)
    rects = {"banner": BANNER_RECT, "clock": CLOCK_RECT}
    for name in active:
        x0, y0, x1, y1 = rects[name]
        frame[y0:y1, x0:x1, :] = bright
    return frame


def _profile(**overrides) -> GameProfile:
    kwargs = dict(
        key="hud-test",
        vocabulary=("kart",),
        zone_model=ZoneModel.no_zone(),
        corroboration_oracle=None,
        triggers=TriggerSubset.of(TRIGGER_HUD_EVENT),
        audio_thresholds=AudioThresholds(),
        tracking_roster=TrackingRoster(labels=("kart",)),
        eval_set=None,
        hud_model=_model(),
    )
    kwargs.update(overrides)
    return GameProfile(**kwargs)


@pytest.fixture(autouse=True)
def _flag_off(monkeypatch):
    """Every test starts with the shipped default: the site is OFF."""
    monkeypatch.delenv(HUD_EVENT_ENV, raising=False)


# --- 1. per-band change score ----------------------------------------------


def test_band_change_score_reads_a_step_and_not_a_drift():
    band = HudBand(name="banner", rect=BANNER_RECT, kind="banner")
    base = band_signature(_frame(), band, 8)
    assert base is not None and base.shape == (8, 8)

    step = band_change_score(_frame(("banner",)), band, base, 8)
    drift = band_change_score(_frame(fill=34), band, base, 8)

    assert step is not None and drift is not None
    assert step > 0.5  # a black -> white banner is a large step
    assert drift < 0.05  # 4/255 shading drift is not a state change
    assert drift < _model().change_sensitivity <= step


def test_band_change_score_is_none_for_an_unreadable_frame():
    band = HudBand(name="banner", rect=BANNER_RECT, kind="banner")
    assert band_signature(None, band, 8) is None
    assert band_change_score(_frame(), band, None, 8) is None
    # a band entirely outside the frame is unreadable, never a crash
    outside = HudBand(name="off-frame", rect=(900, 900, 940, 940), kind="banner")
    assert band_signature(_frame(), outside, 8) is None


# --- 2. the dwell gate ------------------------------------------------------


def test_two_frame_flicker_is_suppressed():
    reader = HudEventReader(_model(), enabled=True)
    out = []
    out += reader.observe(_frame(), 0.0)  # seed the resting signature
    out += reader.observe(_frame(), 1.0)
    out += reader.observe(_frame(("banner",)), 2.0)  # flicker frame 1
    out += reader.observe(_frame(("banner",)), 3.0)  # flicker frame 2
    out += reader.observe(_frame(), 4.0)  # back to rest before the dwell bar

    assert out == []
    assert reader.candidates_emitted == 0
    assert reader.flickers_suppressed == 1


def test_a_change_that_meets_the_dwell_bar_is_a_transition():
    reader = HudEventReader(_model(), enabled=True)
    reader.observe(_frame(), 0.0)  # seed
    assert reader.observe(_frame(("banner",)), 1.0) == []  # 1 changed frame
    assert reader.observe(_frame(("banner",)), 2.0) == []  # 2 changed frames
    fired = reader.observe(_frame(("banner",)), 3.0)  # 3rd = min_dwell_frames

    assert len(fired) == 1
    assert fired[0].band == "banner" and fired[0].kind == "banner"
    assert fired[0].score > 0.5
    assert reader.candidates_emitted == 1


# --- 3. one candidate per transition ---------------------------------------


def test_one_candidate_per_transition_and_the_settle_edge_does_not_refire():
    reader = HudEventReader(_model(), enabled=True)
    out = []
    out += reader.observe(_frame(), 0.0)  # seed
    # sustained banner: 8 changed frames at/after the dwell bar
    for i in range(1, 9):
        out += reader.observe(_frame(("banner",)), float(i))
    assert len(out) == 1, "a persistent HUD state must be exactly one candidate"
    assert reader.candidates_emitted == 1

    # settle back to rest: the clear edge re-arms and is NOT a candidate
    for i in range(9, 12):
        out += reader.observe(_frame(), float(i))
    assert len(out) == 1, "the settling edge must not emit a second candidate"
    assert reader.state_for("banner").latched is False

    # a genuinely NEW transition after the re-arm is one more candidate
    for i in range(12, 16):
        out += reader.observe(_frame(("banner",)), float(i))
    assert len(out) == 2
    assert reader.candidates_emitted == 2


def test_simultaneous_bands_coalesce_into_one_candidate():
    """Race start = clock reset + banner at once: one observable event."""
    reader = HudEventReader(_model(), enabled=True)
    out = []
    out += reader.observe(_frame(), 0.0)
    for i in range(1, 5):
        out += reader.observe(_frame(("banner", "clock")), float(i))
    assert len(out) == 1
    assert out[0].band in ("banner", "clock")
    assert len(out[0].coincident_bands) == 1
    assert set(out[0].coincident_bands) | {out[0].band} == {"banner", "clock"}


def test_a_quiet_hud_never_emits_and_tracks_drift():
    """The continuous-detector failure: a slowly drifting HUD must stay silent."""
    reader = HudEventReader(_model(), enabled=True)
    out = []
    for i in range(40):
        out += reader.observe(_frame(fill=30 + i), float(i))
    assert out == []  # no candidate anywhere in the drift
    assert reader.candidates_emitted == 0
    # ... and the score stays at rest, because the reference is the rolling
    # window and not the seed frame. Against the frozen seed the same drift is
    # a 40/255 step: that is the accumulator ADAAAA-8744 measured as a park.
    band = HudBand(name="banner", rect=BANNER_RECT, kind="banner")
    seed = band_signature(_frame(fill=30), band, 8)
    frozen = band_change_score(_frame(fill=69), band, seed, 8)
    assert frozen is not None and frozen > _model().change_sensitivity
    assert reader.state_for("banner").last_score < _model().change_sensitivity


# --- 3b. the physical re-arm (ADAAAA-8767) --------------------------------


def _level_frame(level: int) -> np.ndarray:
    """A frame whose clock band is a flat patch of ``level`` grayscale.

    A flat band makes the change score exactly ``|level - reference| / 255``, so
    the test can state the mechanism without fighting an 8x8 downsample: a
    counting clock moves a little every frame and never returns to the picture it
    was latched on, which is what the park measured.
    """
    frame = np.full((FRAME_H, FRAME_W, 3), 30, dtype=np.uint8)
    x0, y0, x1, y1 = CLOCK_RECT
    frame[y0:y1, x0:x1, :] = level
    return frame


def test_the_latch_releases_when_the_band_never_returns_to_its_latch_picture():
    """The park's mechanism: a moving band under a latch re-arms on the bound.

    Against the latch-time frame this band scores above sensitivity forever, so
    the old "quiet against the latch-time baseline" rule never released it — and
    14 of 15 labelled instants found the event band already latched.
    """
    model = _model(min_dwell_frames=2, max_latch_frames=8)
    reader = HudEventReader(model, enabled=True)
    out = []
    out += reader.observe(_level_frame(30), 0.0)  # seed: at rest
    out += reader.observe(_level_frame(30), 1.0)
    # the transition into the counting state: 30/255 = 0.118 >= 0.10 for 2 frames
    out += reader.observe(_level_frame(60), 2.0)
    out += reader.observe(_level_frame(60), 3.0)
    assert len(out) == 1 and out[0].kind == "clock"

    # the count runs: +3/255 a frame. That is a "quiet" frame by any per-frame
    # reading, but it never returns to the latch picture, so the old rule held
    # the latch until the end of the stream.
    level = 60
    for i in range(4, 12):
        level += 3
        out += reader.observe(_level_frame(level), float(i))
    assert reader.state_for("clock").latched is False, (
        "the latch must release on the max_latch_frames bound"
    )
    assert reader.forced_rearms == 1
    assert len(out) == 1, "releasing the latch manufactures no candidate"

    # counting on is not an event: the rolling reference tracks it (A4)
    for i in range(12, 20):
        level += 3
        out += reader.observe(_level_frame(level), float(i))
    assert reader.candidates_emitted == 1

    # a genuinely new state (the clock resets) is a second candidate
    for i in range(20, 23):
        out += reader.observe(_level_frame(30), float(i))
    assert len(out) == 2, "a new transition after the bounded re-arm must emit"
    assert reader.candidates_emitted == 2


def test_a_band_that_never_rests_is_bounded_by_max_latch_frames():
    """A4's structural bound: volume is bounded by the latch window, not frames."""
    model = _model(min_dwell_frames=2, max_latch_frames=10, quiet_frames=3)
    reader = HudEventReader(model, enabled=True)
    frames = 120
    emitted = 0
    for i in range(frames):
        # three levels cycling: every frame is a step, so the band never settles
        emitted += len(reader.observe(_level_frame((30, 90, 150)[i % 3]), float(i)))
    assert reader.forced_rearms >= 1
    assert emitted <= 1 + frames // model.max_latch_frames, (
        "a never-resting band must be bounded by the latch window, not by the frame count"
    )


# --- 4. no hudModel -> inert ----------------------------------------------


def test_profile_with_no_hud_model_leaves_the_site_inert():
    profile = _profile(hud_model=None)
    # the trigger is dropped at construction, exactly like `no-zone` drops
    # detection-in-zone: the profile itself declares the site inert
    assert not profile.allows(TRIGGER_HUD_EVENT)
    assert TRIGGER_HUD_EVENT not in profile.triggers.names()
    assert reader_for_profile(profile) is None
    assert profile.to_dict()["hudModel"] is None

    # and evaluating it (with a frame and even a reader) never fires or raises
    bogus = HudEventReader(_model(), enabled=True)
    fires = stage_a.evaluate_stage_a(
        profile, frame=_frame(("banner",)), hud_reader=bogus, timestamp=1.0, seq=1
    )
    assert fires == []


def test_hud_model_without_the_trigger_is_not_evaluated():
    """Declared geometry alone does not arm the site — the subset does."""
    profile = _profile(triggers=TriggerSubset.of(TRIGGER_AUDIO))
    assert profile.hud_model is not None
    assert not profile.allows(TRIGGER_HUD_EVENT)
    assert reader_for_profile(profile) is None
    fires = stage_a.evaluate_stage_a(
        profile, frame=_frame(("banner",)), timestamp=1.0, seq=1
    )
    assert fires == []


def test_hud_model_contract_rejects_unusable_geometry():
    with pytest.raises(ValueError):
        HudModel(bands=())
    with pytest.raises(ValueError):
        HudBand(name="tiny", rect=(0, 0, 1, 1))
    with pytest.raises(ValueError):
        HudBand(name="", rect=(0, 0, 10, 10))
    with pytest.raises(ValueError):
        _model(change_sensitivity=0.0)
    with pytest.raises(ValueError):
        _model(min_dwell_frames=0)
    with pytest.raises(ValueError):
        _model(bands=(HudBand("banner", BANNER_RECT), HudBand("banner", CLOCK_RECT)))


# --- 5. env flag OFF -> zero candidates -----------------------------------


def test_env_flag_off_produces_zero_candidates():
    assert hud_event_enabled() is False
    reader = HudEventReader(_model())  # enabled defaults to the env gate
    assert reader.enabled is False

    out = []
    for i in range(20):
        out += reader.observe(_frame(("banner", "clock")), float(i))
    assert out == []
    assert reader.candidates_emitted == 0
    assert reader.frames_observed == 0, "an unarmed reader must not even score"

    # and through the Stage-A site, with the trigger enabled on the profile
    profile = _profile()
    fires = []
    for i in range(20):
        fires += stage_a.evaluate_stage_a(
            profile,
            frame=_frame(("banner", "clock")),
            hud_reader=reader,
            timestamp=float(i),
            seq=i,
        )
    assert fires == []


def test_env_flag_on_arms_the_reader(monkeypatch):
    monkeypatch.setenv(HUD_EVENT_ENV, "1")
    assert hud_event_enabled() is True
    reader = HudEventReader(_model())
    assert reader.enabled is True
    assert reader_for_profile(_profile()) is not None
    # a profile with no declared geometry stays inert even when armed
    assert reader_for_profile(_profile(hud_model=None)) is None


def test_env_flag_reads_like_the_roi_gate(monkeypatch):
    for value in ("0", "false", "FALSE", "no", ""):
        monkeypatch.setenv(HUD_EVENT_ENV, value)
        assert hud_event_enabled() is False, value
    for value in ("1", "true", "yes", "on"):
        monkeypatch.setenv(HUD_EVENT_ENV, value)
        assert hud_event_enabled() is True, value


# --- the Stage-A registration ---------------------------------------------


def test_stage_a_registers_the_hud_event_site():
    profile = _profile()
    reader = HudEventReader(_model(), enabled=True)
    fires = []
    fires += stage_a.evaluate_stage_a(
        profile, frame=_frame(), hud_reader=reader, timestamp=0.0, seq=0
    )
    for i in range(1, 5):
        fires += stage_a.evaluate_stage_a(
            profile, frame=_frame(("banner",)), hud_reader=reader, timestamp=float(i), seq=i
        )
    assert len(fires) == 1
    assert fires[0].trigger == TRIGGER_HUD_EVENT
    assert fires[0].detail["band"] == "banner"
    assert fires[0].detail["direction"] == "enter"
    assert fires[0].detail["score"] > 0.5


def test_hud_event_site_is_never_consulted_when_the_trigger_is_off(monkeypatch):
    """Absence, not just harmlessness: the reader is never even called."""
    calls = []

    class _Spy:
        def observe(self, *a, **k):
            calls.append((a, k))
            return []

    profile = _profile(triggers=TriggerSubset.of(TRIGGER_AUDIO, "motion"))
    assert not profile.allows(TRIGGER_HUD_EVENT)
    stage_a.evaluate_stage_a(
        profile, frame=_frame(("banner",)), hud_reader=_Spy(), timestamp=1.0, seq=1
    )
    assert calls == []


def test_hud_event_is_a_profile_contract_token():
    assert TRIGGER_HUD_EVENT in ALL_TRIGGERS
    assert TRIGGER_HUD_EVENT in FRAME_TRIGGERS
    with pytest.raises(ValueError):
        TriggerSubset.of("hud-events")  # typos never become a silent no-op


def test_supertuxkart_stays_measured_certified_and_disabled():
    """A7: registering the site changes nothing about the shipped type."""
    profile = SUPERTUXKART_PROFILE
    assert profile.measured is True
    assert profile.certified is True
    assert not profile.allows(TRIGGER_HUD_EVENT)
    assert profile.hud_model is None
    assert TRIGGER_HUD_EVENT not in profile.triggers.names()


# --- 6. A6 independence: the import-graph guard ---------------------------

_APP_DIR = os.path.dirname(os.path.abspath(hud_reader.__file__))


def _module_file(root: str, module: str):
    parts = module.split(".")
    as_path = os.path.join(root, *parts)
    for candidate in (as_path + ".py", os.path.join(as_path, "__init__.py")):
        if os.path.isfile(candidate):
            return candidate
    return None


def _module_scope_imports(path: str):
    """Load-time import edges of one file: imports at module scope only.

    An import inside a function body is deliberately excluded — it is a deferred
    edge (``game_profile.profile_for`` imports ``florence`` lazily for exactly
    that reason) and it does not run when the reader is imported.
    """
    with open(path, "r", encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    edges = []

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(child, ast.Import):
                edges.extend((None, alias.name) for alias in child.names)
            elif isinstance(child, ast.ImportFrom):
                edges.append((child.level, child.module or ""))
            else:
                walk(child)

    walk(tree)
    return edges


def _import_graph(entry: str, root: str):
    """(module names, resolved files) reachable from ``entry`` at load time."""
    names: set = set()
    files: set = set()
    seen: set = set()
    stack = [os.path.abspath(entry)]
    while stack:
        path = stack.pop()
        if path in seen:
            continue
        seen.add(path)
        files.add(path)
        for level, module in _module_scope_imports(path):
            if level:
                names.add(f"{os.path.basename(root)}.{module}" if module else "")
                target = _module_file(root, module) if module else None
            else:
                names.add(module)
                target = None
            if target is not None:
                stack.append(target)
    return names, files


def test_reader_import_graph_does_not_reach_the_label_builder():
    graph, files = _import_graph(os.path.abspath(hud_reader.__file__), _APP_DIR)
    lowered = {name.lower() for name in graph if name}
    for forbidden in ("build_stk_labels", "supertuxkart_val", "evals"):
        assert not any(forbidden in name for name in lowered), sorted(lowered)
    # The measured reader family is stdlib + numpy + the profile contract only.
    assert lowered <= {
        "os",
        "dataclasses",
        "typing",
        "__future__",
        "numpy",
        "app.game_profile",
    }, sorted(lowered)
    # and the whole transitive load-time graph is two files in `app/`
    assert {os.path.basename(f) for f in files} == {"hud_reader.py", "game_profile.py"}
    # no model / OCR / GPU module is reachable at load time
    for forbidden in ("florence", "gemma", "scoreboard_vision", "torch", "transformers"):
        assert not any(forbidden in name for name in lowered), forbidden


def test_reader_has_no_runtime_edge_to_labels_or_models():
    import types

    import app.hud_reader as reader_module

    leaked = [
        name
        for name in sys.modules
        if "build_stk_labels" in name or "supertuxkart_val" in name
    ]
    assert leaked == []
    # GPU-free constraint: the reader's own namespace binds no model module. The
    # package `__init__` imports florence for the live path, which is why this is
    # asserted on the reader's globals rather than on the whole module table.
    bound = [
        value.__name__
        for value in vars(reader_module).values()
        if isinstance(value, types.ModuleType)
    ]
    for forbidden in ("florence", "gemma", "scoreboard_vision", "torch", "transformers"):
        assert not any(forbidden in name for name in bound), bound


# --- 7. A5 latency evidence -----------------------------------------------


def _p95(values):
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))
    return ordered[index]


def test_p95_per_frame_cpu_cost_is_within_the_stage_a_bar(capsys):
    """A5: measure per-frame CPU cost over a synthetic 426x240 series.

    CPU only (numpy on this container), no GPU, no network, no model call. The
    series includes real transitions so the emitter path is measured too, not
    just the idle path.
    """
    reader = HudEventReader(_model(), enabled=True)
    frames = 120
    costs = []
    transitions = 0
    for i in range(frames):
        # a transition every 15 frames: banner up for 5 frames, then at rest
        phase = i % 15
        active = ("banner",) if 5 <= phase < 10 else ()
        frame = _frame(active)
        started = time.perf_counter()
        transitions += len(reader.observe(frame, float(i), seq=i))
        costs.append((time.perf_counter() - started) * 1000.0)

    p50 = sorted(costs)[len(costs) // 2]
    p95 = _p95(costs)
    worst = max(costs)
    print(
        f"\nA5 hud-event reader: frames={frames} per-frame cpu "
        f"p50={p50:.3f}ms p95={p95:.3f}ms max={worst:.3f}ms "
        f"candidates={transitions}"
    )
    assert transitions == frames // 15, "each dwelled transition emits once"
    assert p95 <= 500.0, f"p95 per-frame CPU cost {p95:.3f}ms exceeds the 500ms bar"
