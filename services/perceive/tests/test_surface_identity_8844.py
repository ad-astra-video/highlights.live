"""ADAAAA-8844 (Inc 2): the score surface must be THIS match's to attest a goal.

A live stream carried a PIP of another game with its own score bug. Inc 1 pinned
the bug per job; a pin cannot cover an un-pinned job, a second bug that appears
mid-stream, or a pin placed on the wrong surface. These tests drive the real
frame path (`POST /app/analyze`) and the identity module directly:

  * the verdict is three-way — consistent / contradicted / absent — and only
    `contradicted` demotes a score change (AC2.3: absence keeps today's
    behaviour);
  * a contradicted surface withholds `scoreBoardChanged`, so no force-goal path
    can fire, and names the reason (`scoreboardSurfaceDemoted`);
  * the identity pass is a bounded one-off (AC2.4): <= 2 passes per session and
    zero extra OCR calls, because the kits and the names ride the crop/lines the
    pass already paid for;
  * a second score bug cannot replace a proven incumbent region.
"""
import base64
import io
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import app, _incumbent_surface_kept
from app.scoreboard import ScoreboardRoi
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    SURFACE_IDENTITY_MAX_PASSES,
    chroma_distance,
    derive_surface_identity,
    demotion_note,
    printed_team_tokens,
    surface_reading,
    token_matches_team,
)

RED = [205.0, 30.0, 30.0]
BLUE = [40.0, 45.0, 205.0]
# A foreign bug's plates: a green/cyan bug, i.e. NOT a red or a blue kit. Chosen
# OUTSIDE the measured bar on purpose (green is 0.814 from `red`, cyan 0.456 from
# `blue`). ADAAAA-8927 moved the bar to 0.44 on the natural-traffic measurement,
# which pulls a YELLOW fill (0.426 from `red`) inside it — so this fixture uses
# fills outside 0.44 of BOTH delivered references: that is what "the foreign bug
# must not attest" requires, and the yellow/red pair is pinned as an in-set
# consequence in `test_surface_identity_natural_bar_8927.py`.
FOREIGN_HOME = [0.0, 180.0, 60.0]
FOREIGN_AWAY = [0.0, 200.0, 200.0]

TEAMS = [
    {"side": "home", "name": "Real Madrid", "kitColors": [{"primary": "red"}]},
    {"side": "away", "name": "FC Barcelona", "kitColors": [{"primary": "blue"}]},
]
# The foreign game's bug prints ITS teams, and wears other kits.
FOREIGN_LINE = "LALIGA 05-40 AL1"
FOREIGN_TEAMS = TEAMS  # the job's reference stays the same; the bug is foreign


def _plate_frame(home_rgb, away_rgb, w=160, h=80) -> str:
    """JPEG whose left half is the home plate and right half the away plate."""
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, : w // 2] = np.array(home_rgb, dtype=np.uint8)
    arr[:, w // 2 :] = np.array(away_rgb, dtype=np.uint8)
    img = Image.fromarray(arr, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


class ScriptedDet:
    """Crop reads the scripted lines; counts every OCR call it is asked for."""

    def __init__(self, crop_lines):
        self.crop_lines = list(crop_lines)
        self.ocr_calls = []

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        return list(self.crop_lines)

    def discover(self, image, task=None):
        return {"regions": []}


@pytest.fixture()
def client():
    return TestClient(app)


def _run(client, det, monkeypatch, frames, frame_b64, teams=None, roi=None, hint="soccer"):
    sid = f"sess-surface-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq, (ts, lines) in enumerate(frames):
        det.crop_lines = list(lines)
        body = {
            "seq": seq,
            "timestamp": ts,
            "image": frame_b64,
            "gameHint": hint,
        }
        if roi is not None:
            body["scoreboardRoi"] = roi
        if teams is not None:
            body["matchContextTeams"] = teams
        r = client.post("/app/analyze", json=body, headers={"X-Session-Id": sid})
        assert r.status_code == 200
        payload = r.json()
        # `/app/analyze` returns the observation itself, or `{observation,
        # candidate}` when perceive emitted a candidate on that frame.
        out.append(payload.get("observation", payload))
    return sid, out, app.state.registry.get(sid)


# --- the measured bar (AC2.5) -------------------------------------------------

def test_threshold_is_the_value_measured_on_the_truth_set():
    """AC2.5 (ADAAAA-8844) + AC1 (ADAAAA-8927): 0.44 is measured, not a guess.

    TWO measurements, both pinned here. ADAAAA-8844 measured same-surface
    chromaticity drift on the labelled crop truth set (ADAAAA-8577 crops /
    ADAAAA-8578 truth): p50 0.0156 / p95 0.0349 / max 0.3005, and `1.15 x max`
    gives 0.35. ADAAAA-8922 then measured the distance the rule ACTUALLY compares
    — a genuine (washed-out) plate against the saturated `blue` reference — on
    natural traffic: 555 genuine plate readings over 5 broadcast clips, worst
    0.381, so `1.15 x worst` = 0.438 -> 0.44 (ADAAAA-8927). A change to the
    constant must move one of those measurements, so this test pins both bounds.
    """
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44
    assert SURFACE_IDENTITY_MAX_PASSES == 2
    # Recall: the bar clears the worst measured same-surface drift (8844) AND the
    # worst measured genuine plate on natural traffic (8922: 0.381, x1.15 = 0.438).
    assert 0.3005 < SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD >= round(1.15 * 0.381, 2)
    # Precision: it stays far below the distance between two different kit families.
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD < 0.6


def test_chroma_distance_is_exposure_invariant():
    """The metric ignores brightness: a washed-out reading of the same hue is near."""
    dark_red = [120.0, 20.0, 18.0]
    bright_red = [235.0, 40.0, 36.0]
    assert chroma_distance(dark_red, bright_red) < SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert chroma_distance(RED, BLUE) > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


def test_printed_names_read_codes_as_well_as_words():
    """The truth set prints `RMA 0 - 0 BAR`: a 3-letter code must name its team."""
    tokens = printed_team_tokens(["RMA 0 - 0 BAR"])
    assert tokens == ["RMA", "BAR"]
    assert token_matches_team("RMA", "Real Madrid")
    assert token_matches_team("BAR", "FC Barcelona")
    assert token_matches_team("REAL", "Real Madrid")
    assert not token_matches_team("RMA", "FC Barcelona")
    # Nothing shorter than 3 letters can name a team (no 2-letter false match).
    assert not token_matches_team("RM", "Real Madrid")


def test_verdict_is_three_way_and_only_contradiction_demotes():
    """AC2.3: consistent / contradicted / absent, and absent keeps today's rule."""
    consistent = derive_surface_identity(
        {"kits": {"home": RED, "away": BLUE}, "names": ["RMA", "BAR"]}, TEAMS
    )
    assert consistent["verdict"] == "consistent"

    contradicted = derive_surface_identity(
        {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": ["LALIGA", "AL1"]}, TEAMS
    )
    assert contradicted["verdict"] == "contradicted"
    assert contradicted["kitsDiffer"] is True
    assert contradicted["namesMatch"] is False
    assert contradicted["kitDistance"] > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    note = demotion_note(contradicted)
    assert "contradicted score surface" in note and "ignored" in note

    # Unreadable surface: no plates and no names -> absent, NOT contradicted.
    absent = derive_surface_identity({"kits": {}, "names": []}, TEAMS)
    assert absent["verdict"] == "absent"
    assert demotion_note(absent) == ""

    # Plates that differ but names that DO match this match -> consistent: the
    # printed name is the authority, and that direction is recall-safe.
    named = derive_surface_identity(
        {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": ["MADRID", "BARCELONA"]}, TEAMS
    )
    assert named["verdict"] == "consistent"


def test_no_team_reference_is_absent_not_a_guess():
    """A job with no matchContext cannot contradict anything (today's behaviour)."""
    reading = surface_reading(np.zeros((40, 80, 3)), ScoreboardRoi(0, 0, 1, 1), ["RMA 1-0 BAR"])
    assert derive_surface_identity(reading, [])["verdict"] == "absent"


# --- the real frame path ------------------------------------------------------

def test_identity_pass_is_bounded_and_costs_no_extra_reads(client, monkeypatch):
    """AC2.4: <= 2 identity passes per session, and zero added OCR calls."""
    # The real score moves 1-0 -> 2-0 halfway, so the run HAS a score change to
    # attest; the surface it happens on is this match's (red/blue plates, RMA/BAR).
    frames = [(i, ["RMA 1-0 BAR"] if i < 3 else ["RMA 2-0 BAR"]) for i in range(6)]
    frame = _plate_frame(RED, BLUE)
    baseline_det = ScriptedDet(["RMA 1-0 BAR"])
    _, baseline_obs, baseline_state = _run(client, baseline_det, monkeypatch, frames, frame)
    det = ScriptedDet(["RMA 1-0 BAR"])
    sid, obs, state = _run(client, det, monkeypatch, frames, frame, teams=TEAMS)

    # No extra OCR: the identity pass reads the crop and the lines already paid for.
    assert len(det.ocr_calls) == len(baseline_det.ocr_calls)
    assert state.surface_identity_passes <= SURFACE_IDENTITY_MAX_PASSES
    # Published on the pass frame only, never per frame.
    published = [o for o in obs if "scoreboardSurfaceIdentity" in o]
    assert 1 <= len(published) <= SURFACE_IDENTITY_MAX_PASSES
    assert published[0]["scoreboardSurfaceIdentity"]["verdict"] == "consistent"
    assert state.surface_identity["verdict"] == "consistent"
    # The clean match still attests its real score change.
    assert any(o.get("scoreBoardChanged") for o in obs)
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)


def test_contradicted_surface_withholds_scoreboardchanged(client, monkeypatch):
    """AC2.1/AC2.3: a foreign bug's score change produces no attestation."""
    # The foreign bug prints its own teams on a different-coloured plate and its
    # score moves 1-0 -> 2-0 across the session.
    frames = [(i, ["LALIGA 1-0 AL1"] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    det = ScriptedDet(["LALIGA 1-0 AL1"])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(FOREIGN_HOME, FOREIGN_AWAY), teams=TEAMS
    )

    assert state.surface_identity["verdict"] == "contradicted"
    assert not any(o.get("scoreBoardChanged") for o in obs), "a contradicted surface must not attest"
    demoted = [o["scoreboardSurfaceDemoted"] for o in obs if o.get("scoreboardSurfaceDemoted")]
    assert demoted, "the demotion must be named on the window (scope item 5)"
    assert "contradicted score surface" in demoted[0]


def test_same_score_change_attests_when_no_reference_was_delivered(client, monkeypatch):
    """AC2.3: absence is not contradiction — an un-pinned/unknown surface keeps
    today's behaviour, so real goals are not lost."""
    frames = [(i, ["RMA 1-0 BAR"] if i < 3 else ["RMA 2-0 BAR"]) for i in range(6)]
    det = ScriptedDet(["RMA 1-0 BAR"])
    sid, obs, state = _run(client, det, monkeypatch, frames, _plate_frame(FOREIGN_HOME, FOREIGN_AWAY))

    assert any(o.get("scoreBoardChanged") for o in obs)
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)


def test_a_second_bug_cannot_take_a_proven_incumbent(client, monkeypatch):
    """Scope item 4: the incumbent stays when a different surface appears."""
    frame = _plate_frame(RED, BLUE)
    det = ScriptedDet(["RMA 1-0 BAR"])
    # The box is only PROVEN once the region selector has resolved (a few frames)
    # and the crop has parsed the score twice — that is the incumbent we defend.
    sid, obs, state = _run(
        client, det, monkeypatch, [(i, ["RMA 1-0 BAR"]) for i in range(6)], frame, teams=TEAMS
    )
    assert state.scoreboard_roi_proven is not None

    # A discovered box over a foreign plate: the incumbent must win.
    foreign_rgb = np.asarray(Image.open(io.BytesIO(base64.b64decode(_plate_frame(FOREIGN_HOME, FOREIGN_AWAY)))), dtype=float)
    kept = _incumbent_surface_kept(state, foreign_rgb, ScoreboardRoi(0.5, 0.5, 1.0, 1.0), seq=9)
    assert kept is True
    assert state.scoreboard_roi_source == "incumbent_surface_kept"
    assert state.scoreboard_roi == ScoreboardRoi(*state.scoreboard_roi_proven)


# --- AC2.1: the PIP repro, un-pinned and identity-verified -------------------

# The parent defect: a live stream carried a PIP of ANOTHER game with its own
# score bug. Inc 1's pin stops it when the operator pins the right box; this
# fixture is the case the pin cannot cover — an UNPINNED session whose proven
# incumbent is the primary bug, with a foreign bug arriving mid-stream on a box
# of its own. Geometry: the primary plate is the top band, the PIP plate is the
# bottom-right quadrant, so the two surfaces are separable in the frame itself.
PRIMARY_PIN = [0.0, 0.0, 1.0, 0.25]
PIP_BOX = (0.6, 0.7, 0.95, 0.9)
# Green, not yellow: at the ADAAAA-8927 bar a yellow fill reads inside the `red`
# reference's 0.44 (0.426), which would make the foreign surface `consistent`.
FOREGIGN_PLATE = [0.0, 180.0, 60.0]


def _pip_frame(w=160, h=80) -> str:
    """Primary plate in the top band (red|blue) + a green PIP bug bottom-right."""
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[: h // 4, : w // 2] = np.array(RED, dtype=np.uint8)
    arr[: h // 4, w // 2 :] = np.array(BLUE, dtype=np.uint8)
    y0, y1 = int(PIP_BOX[1] * h), int(PIP_BOX[3] * h)
    x0, x1 = int(PIP_BOX[0] * w), int(PIP_BOX[2] * w)
    xm = (x0 + x1) // 2
    # The foreign bug prints TWO kit plates (home|away), like a real score bug —
    # a single flat colour has no per-side swatch and would read as absent.
    arr[y0:y1, x0:xm] = np.array(FOREGIGN_PLATE, dtype=np.uint8)
    arr[y0:y1, xm:x1] = np.array([0.0, 200.0, 200.0], dtype=np.uint8)
    img = Image.fromarray(arr, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


def _overlaps(roi, box) -> bool:
    if roi is None:
        return False
    cx = (float(roi.x0) + float(roi.x1)) / 2.0
    cy = (float(roi.y0) + float(roi.y1)) / 2.0
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]


class PipDet:
    """Two bugs on one frame: the crop returns the FOREIGN bug's lines only when
    the session crops the PIP box, exactly like the geometry-separated repro."""

    def __init__(self, primary_lines):
        self.primary_lines = list(primary_lines)
        self.foreign_line = ""
        self.pip_visible = False
        self.ocr_calls = []

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        self.ocr_calls.append(roi)
        if roi is not None and _overlaps(roi, PIP_BOX):
            return [self.foreign_line]
        return list(self.primary_lines)

    def discover(self, image, task=None):
        # The PIP bug only appears mid-stream, so discovery has nothing to offer
        # on the frames where the primary bug settles (the shipped top-band prior
        # + selector prove the primary box), then proposes the foreign one.
        if not self.pip_visible:
            return {"regions": []}
        return {"regions": [{"caption": "scoreboard 0-0", "bbox": list(PIP_BOX)}]}


def test_ac2_1_pip_repro_foreign_bug_cannot_attest_and_primary_goal_still_does(client, monkeypatch):
    """AC2.1: 0 attestations from the foreign bug's score change, and the primary
    bug's real goal in the SAME session is still accepted."""
    frame = _pip_frame()
    det = PipDet(["RMA 1-0 BAR"])
    sid = f"sess-pip8844-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)

    obs = []

    def frame_at(seq, ts, lines, roi=None):
        det.primary_lines = list(lines)
        body = {"seq": seq, "timestamp": ts, "image": frame, "gameHint": "soccer",
                "matchContextTeams": TEAMS}
        if roi is not None:
            body["scoreboardRoi"] = roi
        r = client.post("/app/analyze", json=body, headers={"X-Session-Id": sid})
        assert r.status_code == 200
        payload = r.json()
        obs.append(payload.get("observation", payload))

    # 1) The primary bug settles as the proven incumbent (un-pinned: the region
    #    selector resolves over a few frames, then the crop is learned).
    for seq in range(6):
        frame_at(seq, seq, ["RMA 1-0 BAR"])
    state = app.state.registry.get(sid)
    assert state.scoreboard_roi_proven is not None, "fixture did not settle a proven incumbent"
    assert state.surface_identity["verdict"] == "consistent"

    # 2) Mid-stream, the crop is directed at the FOREIGN bug (the pin-on-the-
    #    wrong-surface / second-bug case). Its score moves 1-0 -> 2-0 and it
    #    prints ITS teams on a yellow plate.
    det.pip_visible = True
    det.foreign_line = "LALIGA 1-0 AL1"
    frame_at(6, 6, ["RMA 2-0 BAR"], roi=PIP_BOX)
    det.foreign_line = "LALIGA 2-0 AL1"
    frame_at(7, 7, ["RMA 2-0 BAR"], roi=PIP_BOX)
    foreign_obs = obs[6:]
    assert all(o.get("scoreBoardChanged") is not True for o in foreign_obs), (
        "the foreign bug's score change attested a goal"
    )
    # 0 clips: the foreign read is discarded, so no candidate is produced off it
    # and no measured delta reaches the tracker.
    assert all("candidate" not in o for o in foreign_obs)
    assert all(o.get("scoreboardDelta") is None for o in foreign_obs)
    # The surface that WAS measured on the foreign box is contradicted, and the
    # session keeps its proven incumbent box.
    assert state.surface_identity["verdict"] in ("contradicted", "absent")
    assert state.scoreboard_roi_source == "incumbent_surface_kept"

    # 3) The primary bug's own real goal (1-0 -> 2-0) is still accepted: recall
    #    is not spent on the correct surface.
    frame_at(8, 8, ["RMA 2-0 BAR"], roi=PRIMARY_PIN)
    frame_at(9, 9, ["RMA 2-0 BAR"], roi=PRIMARY_PIN)
    frame_at(10, 10, ["RMA 2-0 BAR"], roi=PRIMARY_PIN)
    assert any(o.get("scoreBoardChanged") is True for o in obs[8:]), (
        "the primary bug's real goal was not accepted"
    )
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs[8:])
