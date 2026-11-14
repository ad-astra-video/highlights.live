"""ADAAAA-8975: a printed-name match is a CONJUNCT for PRIOR-derived kit references.

ADAAAA-8952 gave each kit reference its own measured bar. That fixes the
over-covering at the BAR level, but it cannot close the red/pink precision hole
ADAAAA-8936 measured, because a genuine red plate reaches 0.3667 while the
saturated foreign fills sit BELOW it inside the same bar:

    reference  genuine worst  bar (1.15x)  foreign fills inside that bar
    red        0.3667         0.43          orange 0.2479, pink 0.3134, gold 0.3699
    pink       0.1714         0.20          purple 0.2323 (outside at 0.20)

So the closure is the OTHER channel. When the reference is a curated PRIOR
(`kitReference == "prior"` — a colour for a team NAME, not a measurement of this
match's kit), a swatch inside the bar is evidence only when the swatch reads as
that prior's own colour FAMILY (the population every measured bar was derived
from). A DIFFERENT-family fill inside the bar needs the printed name to match:

  * names read and unmatched -> `contradicted` (the named refusal; the only
    verdict that withholds a score change);
  * names unread -> `absent` (ADAAAA-8908's rule is not widened);
  * names match -> `consistent` (the name vouches, as before);
  * same-family swatch -> `consistent` (recall: the genuine-plate shape, which is
    what keeps the three ADAAAA-8927 Barcelona frames — their swatch reads `blue`
    while OCR mangles `BAR` into `BARSANT`/`BARAZENDA`).

OBSERVED `kitColors` references keep the bar-only rule: a measured colour IS this
match's kit.

Recall cost, measured not assumed (ADAAAA-8936 evidence, `hl8936_evidence.json`):
every genuine reading is same-family by construction, so 0 of 555 blue / 46 red /
41 pink / 187 navy genuine readings can move; the guard moves only foreign-fill
rows (118 of 1681 measured foreign readings against `red`, 0 against `blue`).
The served Barcelona census (ADAAAA-8922, 16 bursts / 192 frames) reads `BAR` on
16/16 bursts, so the arm that runs prior-derived in production keeps its recall.
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
from app.match_context import kit_prior_table, name_color
from app.scoreboard import ScoreboardRoi
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_BARS,
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    derive_surface_identity,
    demotion_note,
    kit_distance_bar,
    kit_reference_family,
    name_reference_rgb,
)

# --- the measured fills (ADAAAA-8936, shipped reference matrix) --------------
# Each is a SATURATED fill from the unchanged `name_reference_rgb` table, so these
# are the reference-space worst cases a foreign bug can hand the red arm.
ORANGE_FILL = [183.6, 102.05, 33.05]   # 0.2479 from `red`
PINK_FILL = [183.6, 33.05, 127.14]     # 0.3134 from `red`
GOLD_FILL = [183.6, 152.23, 33.05]     # 0.3699 from `red`
YELLOW_FILL = [179.84, 183.6, 33.05]   # 0.4372 from `red` -> outside 0.43 already
GREEN_FILL = [0.0, 180.0, 60.0]       # outside every bar

# A GENUINE washed-out red plate (reads `red`), 0.3745 from the red reference —
# ABOVE the measured genuine worst (0.3667) and inside the 0.43 bar: the recall
# case a name conjunct must not demote.
GENUINE_RED_PLATE = [200, 140, 125]
# Real measured genuine red readings from the ADAAAA-8936 sample.
MEASURED_RED_PLATES = [[125.4, 47.5, 59.1], [134.2, 56.7, 67.8], [135.5, 54.7, 65.5]]

FOREIGN_NAMES = ["LALIGA", "AL1"]  # printed, read, matched nothing
FOREIGN_LINE = "LALIGA 1-0 AL1"    # the served fixture's foreign bug, with a score

# The three frames ADAAAA-8927 measured: genuine Barcelona `blue` plates whose
# printed tokens are OCR mangles of `BAR`.
BARCELONA_FRAMES = [
    ("kids95_8483 f_0091", [102.5, 99.6, 149.6], 0.3796,
     ["ONARIOBMW", "RMA", "BARSANT", "BOLLOBREG"]),
    ("kids180_8123 f_0316", [101.7, 99.1, 148.8], 0.3793,
     ["ONARIOBMW", "RMA", "BARSANTA", "BOLLOBREG"]),
    ("qa8092_90s f_0120", [100.2, 100.7, 154.5], 0.3681, ["IRMA", "BARAZENDA"]),
]

# Portugal -> red and Barcelona -> blue are the curated priors ADAAAA-8908/8927
# ride on. `RMA` needs a team whose curated colour is red, so the RMA case uses an
# explicit prior table entry (Real Madrid) instead of inventing a fixture.
RED_PRIOR_TEAMS = [{"side": "away", "name": "Portugal", "kitColors": []}]
RMA_PRIOR_TABLE = {"Real Madrid": ("red", None)}
RMA_TEAMS = [{"side": "away", "name": "Real Madrid", "kitColors": []}]
BARCELONA_TEAMS = [{"side": "away", "name": "Barcelona", "kitColors": []}]
SOCCER_PRIORS = kit_prior_table("soccer")


def _verdict(plate, teams, names=None, *, priors=None, side="away", **kw):
    reading = {"kits": {side: list(plate)}, "names": list(names or [])}
    return derive_surface_identity(reading, teams, kit_priors=priors, **kw)


# --- the defect family: a foreign fill inside a prior's own bar --------------

def test_the_orange_fill_inside_the_red_bar_is_not_consistent():
    """ADAAAA-8936's 0.2479 orange fill: inside 0.43, refused by the name conjunct."""
    identity = _verdict(ORANGE_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS)
    assert identity["kitReference"] == "prior"
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_BARS["red"] == 0.43
    # The bar really does contain the fill: this is not a bar measurement.
    assert identity["kitsDiffer"] is False
    assert identity["kitDistance"] == pytest.approx(0.2479, abs=0.0005)
    assert identity["kitCorroborated"] is False
    assert identity["kitNameRefused"] is True
    assert identity["kitFillColor"] == "orange"
    assert identity["verdict"] == "contradicted"
    assert "contradicted score surface" in demotion_note(identity)


def test_the_pink_fill_inside_the_red_bar_is_refused_too():
    identity = _verdict(PINK_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS)
    assert identity["kitDistance"] == pytest.approx(0.3134, abs=0.0005)
    assert identity["kitsDiffer"] is False
    assert identity["verdict"] == "contradicted"
    assert identity["kitFillColor"] == "pink"


def test_the_gold_fill_inside_the_red_bar_is_refused_too():
    """0.3699 is inside 0.43 but above the measured genuine worst (0.3667)."""
    identity = _verdict(GOLD_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS)
    assert identity["kitDistance"] == pytest.approx(0.3699, abs=0.0005)
    assert identity["kitsDiffer"] is False
    assert identity["verdict"] == "contradicted"
    assert identity["kitFillColor"] == "gold"


def test_the_yellow_fill_is_already_outside_the_per_family_red_bar():
    """The per-family bar (increment 1) covers yellow; the conjunct is not needed."""
    identity = _verdict(YELLOW_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS)
    assert identity["kitDistance"] == pytest.approx(0.4372, abs=0.0005)
    assert identity["kitsDiffer"] is True
    assert identity["verdict"] == "contradicted"


def test_an_unread_name_leaves_the_refused_fill_absent():
    """ADAAAA-8908 is not widened: no name read -> absence, not contradiction."""
    identity = _verdict(ORANGE_FILL, RED_PRIOR_TEAMS, [], priors=SOCCER_PRIORS)
    assert identity["kitNameRefused"] is True
    assert identity["verdict"] == "absent"
    assert demotion_note(identity) == ""


def test_a_matching_printed_name_still_vouches_for_the_surface():
    identity = _verdict(ORANGE_FILL, RED_PRIOR_TEAMS, ["PORTUGAL"], priors=SOCCER_PRIORS)
    assert identity["namesMatch"] is True
    assert identity["verdict"] == "consistent"


def test_the_refusal_states_the_fill_and_not_a_false_bar_breach():
    """`Δ > bar` would be a lie here (0.25 < 0.43); the note names the fill."""
    note = demotion_note(_verdict(ORANGE_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS))
    assert "orange" in note
    assert "0.43" in note
    assert "> 0.43" not in note
    assert len(note) <= 240, "the events schema caps demotion at 240 chars"


# --- recall: the genuine-plate shapes the measured bars were derived from ----

def test_a_genuine_red_plate_with_rma_printed_stays_consistent():
    identity = _verdict(GENUINE_RED_PLATE, RMA_TEAMS, ["RMA"], priors=RMA_PRIOR_TABLE)
    assert identity["kitReference"] == "prior"
    assert identity["kitFillColor"] == "red"
    assert identity["namesMatched"] == ["Real Madrid"]
    assert identity["verdict"] == "consistent"
    assert demotion_note(identity) == ""


def test_a_genuine_red_plate_without_a_name_still_reads_consistent_by_family():
    """The measured population's own definition: swatch reads the prior's family.

    Demoting this would be the AC2.2 failure (a real goal dropped) — and it is what
    keeps the three ADAAAA-8927 frames consistent when OCR mangles `BAR`.
    """
    identity = _verdict(GENUINE_RED_PLATE, RED_PRIOR_TEAMS, [], priors=SOCCER_PRIORS)
    assert identity["kitCorroborated"] is True
    assert identity["kitNameRefused"] is False
    assert identity["verdict"] == "consistent"


@pytest.mark.parametrize("plate", MEASURED_RED_PLATES)
def test_the_measured_genuine_red_readings_never_change(plate):
    """ADAAAA-8936 genuine sample rows: all still `consistent`, none refused."""
    assert name_color(plate) == "red", "a genuine red reading by the shipped namer"
    identity = _verdict(plate, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS)
    assert identity["kitNameRefused"] is False
    assert identity["verdict"] == "consistent"


@pytest.mark.parametrize("label,plate,served_distance,names", BARCELONA_FRAMES)
def test_the_three_measured_barcelona_frames_still_read_consistent(
    label, plate, served_distance, names
):
    """The ADAAAA-8927 frames: blue 0.44 unchanged, prior + mangled names."""
    identity = _verdict(plate, BARCELONA_TEAMS, names, priors=SOCCER_PRIORS)
    assert identity["kitReference"] == "prior"
    assert identity["kitDistance"] == pytest.approx(served_distance, abs=0.0002), label
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD, label
    assert identity["kitCorroborated"] is True, label
    assert identity["verdict"] == "consistent", label
    assert demotion_note(identity) == "", label


# --- observed `kitColors` references keep the bar-only rule ------------------

def test_an_observed_reference_keeps_the_bar_only_rule():
    """A measured kit colour IS this match's kit: a different-family fill inside
    its bar still corroborates, exactly as before this increment."""
    teams = [{"side": "away", "name": "Team", "kitColors": [{"primary": "red"}]}]
    identity = _verdict(ORANGE_FILL, teams, FOREIGN_NAMES)
    assert identity["kitReference"] == "observed"
    assert identity["kitsDiffer"] is False
    assert identity["kitNameRefused"] is False
    assert identity["verdict"] == "consistent"


def test_an_observed_reference_outside_the_bar_still_contradicts():
    teams = [{"side": "away", "name": "Team", "kitColors": [{"primary": "red"}]}]
    identity = _verdict(GREEN_FILL, teams, FOREIGN_NAMES)
    assert identity["kitReference"] == "observed"
    assert identity["kitsDiffer"] is True
    assert identity["verdict"] == "contradicted"


# --- the guard is scoped to the REFERENCE, not to the bar value -------------

def test_an_explicit_threshold_overrides_still_apply_the_guard():
    """One-bar callers keep one bar AND keep the prior-name conjunct."""
    refused = _verdict(ORANGE_FILL, RED_PRIOR_TEAMS, FOREIGN_NAMES, priors=SOCCER_PRIORS,
                       threshold=0.44)
    assert refused["threshold"] == 0.44
    assert refused["kitsDiffer"] is False
    assert refused["verdict"] == "contradicted"
    genuine = _verdict(GENUINE_RED_PLATE, RED_PRIOR_TEAMS, [], priors=SOCCER_PRIORS,
                       threshold=0.44)
    assert genuine["verdict"] == "consistent"


def test_the_guard_does_not_move_the_bar_table():
    """Scope: increment 1's bars, the 1.15x arithmetic and the constant are untouched."""
    assert SURFACE_IDENTITY_KIT_DISTANCE_BARS == {
        "blue": 0.44, "navy": 0.51, "red": 0.43, "pink": 0.20,
    }
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44
    assert kit_distance_bar("red") == 0.43
    # ... and the reference the guard reads is the unchanged one.
    assert name_reference_rgb("red") == [183.6, 33.05, 33.05]


def test_the_family_grouping_is_the_one_the_bars_were_measured_in():
    """ADAAAA-8936 measured genuine populations per FAMILY, so the guard does too."""
    assert kit_reference_family("red") == kit_reference_family("maroon") == "red"
    assert kit_reference_family("blue") == kit_reference_family("navy") == "blue"
    assert kit_reference_family("sky blue") == "blue"
    assert kit_reference_family("gold") == kit_reference_family("orange") == "orange"
    assert kit_reference_family("white") == kit_reference_family("black") == "achromatic"
    assert kit_reference_family("purple") == "purple"
    assert kit_reference_family(None) == ""


def test_a_maroon_reading_against_a_red_prior_is_the_same_family():
    """Maroon folds into the measured `red` family, so it is not a foreign fill."""
    maroon = [120.0, 40.0, 40.0]
    assert name_color(maroon) in ("red", "maroon")
    identity = _verdict(maroon, RED_PRIOR_TEAMS, [], priors=SOCCER_PRIORS)
    assert identity["kitNameRefused"] is False
    assert identity["verdict"] == "consistent"


# --- `_incumbent_surface_kept` still uses the ONE constant -------------------

def _solid_frame(rgb, w=160, h=40):
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, :] = np.array(rgb, dtype=np.uint8)
    return arr


def _incumbent_state(plate_rgb):
    import types

    state = types.SimpleNamespace()
    state.session_id = "sess-prior-guard-8975"
    state.surface_identity_plate = {"rgb": list(plate_rgb), "color": "navy"}
    state.scoreboard_roi_proven = (0.0, 0.0, 1.0, 0.25)
    state.surface_identity_plates = {(0.0, 0.0, 1.0, 0.25): {"rgb": list(plate_rgb),
                                                             "color": "navy"}}
    state.scoreboard_roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    state.scoreboard_roi_source = None
    return state


def test_incumbent_surface_kept_still_reads_the_one_constant():
    """A white candidate plate is > 0.44 from the incumbent: incumbent kept.

    `_incumbent_surface_kept` compares two plates of the SAME surface; this
    increment reads references, priors and printed names, none of which it uses.
    """
    from app.surface_identity import chroma_distance

    navy_ref = name_reference_rgb("navy")
    assert navy_ref is not None
    green = [0.0, 180.0, 60.0]
    assert chroma_distance(green, navy_ref) > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    state = _incumbent_state(navy_ref)
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    assert _incumbent_surface_kept(state, _solid_frame(green), roi) is True
    assert state.scoreboard_roi_source == "incumbent_surface_kept"
    # The same surface (candidate plate == incumbent plate) is not defended.
    state = _incumbent_state(navy_ref)
    assert _incumbent_surface_kept(state, _solid_frame(navy_ref), roi) is False


# --- the served path: the refusal is reachable through POST /app/analyze -----

def _plate_frame(home_rgb, away_rgb, w=160, h=80) -> str:
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, : w // 2] = np.array(home_rgb, dtype=np.uint8)
    arr[:, w // 2:] = np.array(away_rgb, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, "RGB").save(buf, format="JPEG", quality=95)
    return base64.b64encode(buf.getvalue()).decode()


class ScriptedDet:
    def __init__(self, crop_lines):
        self.crop_lines = list(crop_lines)

    def detect(self, rgb, vocabulary=None):
        return []

    def ocr(self, rgb, roi=None):
        return list(self.crop_lines)

    def discover(self, image, task=None):
        return {"regions": []}


class ScriptedOcr:
    """The SECOND Florence copy (the OCR lane), scripted like ``ScriptedDet``."""

    def __init__(self, lines):
        self.lines = list(lines)

    def ocr(self, rgb, roi=None):
        return list(self.lines)


@pytest.fixture()
def client():
    return TestClient(app)


def _run_served(client, monkeypatch, frames, frame_b64, teams, *, ocr_reads=None):
    """Post ``frames`` through the served route and return the recorded state.

    The served identity pass runs on the frames the reader actually parses, so the
    fixture moves a score across the burst (`LALIGA 1-0 AL1` -> `LALIGA 2-0 AL1`),
    exactly as the ADAAAA-8919 served suite does. Without a score change there is
    no corroborated window to demote and the end-to-end clause is not exercised.

    ADAAAA-9015: script the OCR lane too, not only the detector. The served image
    runs `PERCEIVE_DUAL_FLORENCE=1`, so the scoreboard `<OCR>` read comes from
    `get_ocr_detector()` — a SECOND, REAL Florence copy. Patching only
    `get_detector` left the name channel to the real model, which reads nothing on
    a synthetic frame: `names=[]` and the window took ADAAAA-8908's documented
    `absent` branch, while the same tree passes on a CPU host where the lane is
    off and the primary (scripted) detector supplies the lines (measured 62/63
    in-container vs 63/63 on the host). Forcing the lane on and scripting it makes
    both environments run the production path AND read the fixture's printed
    name, so the verdict is a property of the rule, not of which copy of the OCR
    the box happens to have loaded. `ocr_reads` scripts what the lane reads:
    `None` follows ``frames`` (the refusal arm), `[]` reads nothing (the absence
    arm).
    """
    sid = f"sess-prior-guard-8975-{uuid.uuid4().hex[:8]}"
    det = ScriptedDet(frames[0][1])
    lane = ScriptedOcr(frames[0][1] if ocr_reads is None else ocr_reads)
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    monkeypatch.setattr(_app, "dual_florence_enabled", lambda: True)
    monkeypatch.setattr(_app, "get_ocr_detector", lambda: lane)
    obs = []
    for seq, (ts, lines) in enumerate(frames):
        det.crop_lines = list(lines)
        if ocr_reads is None:
            lane.lines = list(lines)
        r = client.post(
            "/app/analyze",
            json={"seq": seq, "timestamp": ts, "image": frame_b64,
                  "gameHint": "soccer", "matchContextTeams": teams},
            headers={"X-Session-Id": sid},
        )
        assert r.status_code == 200
        payload = r.json()
        obs.append(payload.get("observation", payload))
    return obs, app.state.registry.get(sid)


def test_the_served_analyze_path_refuses_an_orange_fill_on_a_red_prior(client, monkeypatch):
    """End to end through the served route: verdict + demotion note on the window."""
    frames = [(float(i), [FOREIGN_LINE] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    obs, state = _run_served(
        client,
        monkeypatch,
        frames,
        _plate_frame([240.0, 240.0, 240.0], ORANGE_FILL),
        RED_PRIOR_TEAMS,
    )
    identity = getattr(state, "surface_identity", None)
    assert identity is not None
    assert identity["kitReference"] == "prior"
    assert identity["kitNameRefused"] is True
    # ADAAAA-9015 guard: the pass must have READ the fixture's printed name. If a
    # future OCR lane bypasses the scripting again, this fails here (naming the
    # read) instead of drifting into the environment-appropriate `absent` branch.
    # (`printed_team_tokens` keeps `LALIGA` and drops the digit-bearing `1-0`/`AL1`.)
    assert identity["names"] == ["LALIGA"], identity["names"]
    assert identity["verdict"] == "contradicted"
    assert identity["kitFillColor"] == "orange"
    # The bar did NOT move: the fill is INSIDE the red bar, so the refusal is the
    # name conjunct and the note must say that instead of printing a false breach.
    assert identity["kitsDiffer"] is False
    assert identity["kitDistance"] <= identity["threshold"] == 0.43
    demotions = [o["scoreboardSurfaceDemoted"] for o in obs if o.get("scoreboardSurfaceDemoted")]
    assert demotions, "the demotion is published on the window"
    assert any("orange" in d for d in demotions), demotions
    assert not any("Δ=" in d and ">" in d.split("Δ=")[1] for d in demotions), demotions
    assert not any(o.get("scoreBoardChanged") for o in obs), "a refused surface must not attest"


def test_the_served_path_stays_absent_when_the_ocr_lane_reads_nothing(client, monkeypatch):
    """ADAAAA-8908 is not widened, and the refusal is not hardcoded.

    The same frame + teams, with the OCR lane reading NOTHING: no printed name, so
    the rule takes the documented `absent` branch and publishes no demotion. This
    is the branch the served GPU image took before the fixture scripted the lane
    (ADAAAA-9015), asserted here on purpose so the two arms are both pinned and
    the difference is the READ, not the environment.
    """
    frames = [(float(i), [FOREIGN_LINE] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    obs, state = _run_served(
        client,
        monkeypatch,
        frames,
        _plate_frame([240.0, 240.0, 240.0], ORANGE_FILL),
        RED_PRIOR_TEAMS,
        ocr_reads=[],
    )
    identity = getattr(state, "surface_identity", None)
    assert identity is not None
    assert identity["kitReference"] == "prior"
    assert identity["kitNameRefused"] is True
    assert identity["names"] == []
    assert identity["kitsDiffer"] is False
    assert identity["verdict"] == "absent"
    assert demotion_note(identity) == ""
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)
    assert not any(o.get("scoreBoardChanged") for o in obs)
