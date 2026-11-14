"""ADAAAA-8952: the kit-distance bar is PER FAMILY, measured at a VERIFIED ROI.

ADAAAA-8936 measured the genuine-plate spread against every kit reference the
served corpus can produce and found that ONE global bar cannot carry every
reference direction: the genuine floors span 2.6x, so 0.44 is at once too wide for
`red`/`pink` (it admits foreign fills the printed-name conjunct then has to reject)
and too narrow for `navy`.

Step 0 of this increment re-measured the three rows that were PROVISIONAL (those
clips stored no verified `scoreboardSurface.roi`) by replaying each clip's own
frames through the served `highlights-perceive` build, with the served
`matchContextTeams` on every body, and taking the box the served region selector
itself PROVED by parsing a score (`scoreboardRoiVerified: true`):

  clip                                     verified box          readings  worst   floor
  adaaa7912-Portugal_vs_Spain_90s (red)    [0, 0, 1, 0.25]       15        0.3667  0.4217
  adaaa7914_af_110s (pink)                 [0, 0.78, 1, 0.94]    41        0.1714  0.1971
  bb_q1_1100_1190_90s (navy)               [0, 0.78, 1, 0.94]    187       0.4426  0.5090

(`blue` is unchanged: ADAAAA-8922 measured it at the same verified box on the 5
clips the served natural traffic replays, 555 readings, worst 0.3811 -> 0.438.)

This suite pins:

  * the 1.15x arithmetic per family, including the round-UP to two decimals;
  * each family's boundary, inside and outside;
  * the documented fallback: an unmeasured reference keeps
    `SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD` (0.44) and does not move;
  * the served Barcelona shape unchanged — blue stays 0.44 and the three measured
    frames from ADAAAA-8927 still read `consistent`, on the direct path and
    through `POST /app/analyze`;
  * `_incumbent_surface_kept` keeps ONE bar (it compares two plates of the SAME
    surface across boxes — a different quantity from plate-vs-kit-reference).

The precision closure for the red/pink arms is NOT a bar value: a genuine red plate
reaches 0.3667, so any red bar >= 0.3667 also contains the saturated orange (0.2479)
and pink (0.3134) fills. That closure is the printed-name conjunct for
prior-derived references, filed as ADAAAA-8975, and it is deliberately absent here.
"""
import math
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import app, _incumbent_surface_kept
from app.match_context import kit_prior_table
from app.scoreboard import ScoreboardRoi
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_BARS,
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    KitDistance,
    _side_kit_distance,
    chroma_distance,
    derive_surface_identity,
    demotion_note,
    kit_distance_bar,
    name_reference_rgb,
)

MARGIN = 1.15
PURPLE_REFERENCE = [127.14, 33.05, 183.6]

# --- step 0: the measured rows (this increment's replay) ---------------------
# (family, clip, verified box, readings, worst genuine reading, bar)
MEASURED_ROWS = [
    ("blue", "5 natural Barcelona clips (ADAAAA-8922)", [0.0, 0.0, 1.0, 0.25],
     555, 0.3811, 0.44),
    ("red", "adaaa7912-Portugal_vs_Spain_90s away", [0.0, 0.0, 1.0, 0.25],
     15, 0.3667, 0.43),
    ("pink", "adaaa7914_af_110s home", [0.0, 0.78, 1.0, 0.94],
     41, 0.1714, 0.20),
    ("navy", "bb_q1_1100_1190_90s away", [0.0, 0.78, 1.0, 0.94],
     187, 0.4426, 0.51),
]

# Every reference name the served rule can compare against that was NOT measured.
UNMEASURED = [
    "orange", "gold", "yellow", "green", "cyan", "sky blue", "purple", "maroon",
    "white", "grey", "black", "",
]


# --- helpers -----------------------------------------------------------------

def _round_up_2(value: float) -> float:
    """Round UP to two decimals, the convention every measured bar used."""
    return math.ceil(round(value * 100.0, 6)) / 100.0


def _plate_at_distance(reference_name: str, target: float) -> list[float]:
    """An RGB plate whose chromaticity sits exactly ``target`` from the reference.

    Walks out from the reference chromaticity toward the first anchor that can
    reach the target, then converts back to RGB (chromaticity is `rgb / sum`, so
    scaling the target chromaticity by 255 reproduces it exactly). Purely
    synthetic: this is the metric's own space, not a claim about a broadcast.
    """
    ref = name_reference_rgb(reference_name)
    assert ref is not None, reference_name
    total = float(sum(ref))
    base = [float(v) / total for v in ref]
    anchors = [[1 / 3.0, 1 / 3.0, 1 / 3.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0],
               [0.0, 1.0, 0.0], [0.0, 0.0, 0.0]]
    for anchor in anchors:
        vec = [anchor[i] - base[i] for i in range(3)]
        norm = math.sqrt(sum(v * v for v in vec))
        if norm <= 0.0 or norm < target:
            continue
        point = [base[i] + (target / norm) * vec[i] for i in range(3)]
        rgb = [round(max(0.5, v * 255.0), 1) for v in point]
        if min(rgb) <= 0.5:
            continue
        if abs(chroma_distance(rgb, ref) - target) <= 0.002:
            return rgb
    raise AssertionError(f"no plate at {target} from {reference_name}")


def _teams(family: str, side: str = "away", observed: bool = True) -> list[dict]:
    """A job that declares one kit colour (observed) or only a name (prior)."""
    if observed:
        return [{"side": side, "name": "Team", "kitColors": [{"primary": family}]}]
    return [{"side": side, "name": "Team", "kitColors": []}]


def _verdict(plate, family: str, names=None, *, observed=True, side="away", **kw):
    reading = {"kits": {side: list(plate)}, "names": list(names or [])}
    return derive_surface_identity(
        reading,
        _teams(family, side=side, observed=observed),
        kit_priors=kit_prior_table("soccer") if not observed else None,
        **kw,
    )


# --- the table ---------------------------------------------------------------

def test_the_table_carries_exactly_the_measured_families():
    """Only measured directions get their own bar; everything else is the default."""
    assert SURFACE_IDENTITY_KIT_DISTANCE_BARS == {
        "blue": 0.44, "navy": 0.51, "red": 0.43, "pink": 0.20,
    }


def test_the_blue_arm_is_unchanged_and_still_the_documented_default():
    """Blue already carried every reference direction at 0.44; it does not move."""
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44
    assert SURFACE_IDENTITY_KIT_DISTANCE_BARS["blue"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert kit_distance_bar("blue") == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


@pytest.mark.parametrize("family,clip,box,readings,worst,bar", MEASURED_ROWS)
def test_each_bar_is_115x_its_worst_genuine_reading(
    family, clip, box, readings, worst, bar
):
    """`bar == 1.15 x worst measured genuine plate`, rounded UP to 2 decimals."""
    assert kit_distance_bar(family) == bar, f"{family} ({clip})"
    assert readings > 0, clip
    assert kit_distance_bar(family) >= MARGIN * worst, clip
    assert kit_distance_bar(family) == _round_up_2(MARGIN * worst), clip
    # Not set ON the worst reading: the margin is the rule's whole point.
    assert kit_distance_bar(family) - worst >= 0.02, clip


def test_the_floors_span_2_6x_which_is_why_one_bar_cannot_carry_them():
    """The design fact the increment rests on: pink 0.197 -> navy 0.509."""
    floors = [_round_up_2(MARGIN * row[4]) for row in MEASURED_ROWS]
    assert min(floors) == 0.20 and max(floors) == 0.51
    assert max(floors) / min(floors) >= 2.5


@pytest.mark.parametrize("name", UNMEASURED)
def test_an_unmeasured_reference_keeps_the_documented_default(name):
    """No measured row -> no behaviour change for that reference."""
    assert kit_distance_bar(name) == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


def test_a_missing_reference_is_the_default_too():
    assert kit_distance_bar(None) == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


def test_the_reference_table_is_untouched():
    """Scope: `name_color` / `name_reference_rgb` are not part of this change."""
    assert name_reference_rgb("blue") == [33.05, 33.05, 183.6]
    assert name_reference_rgb("purple") == PURPLE_REFERENCE


# --- per-family boundaries ---------------------------------------------------

@pytest.mark.parametrize("family,clip,box,readings,worst,bar", MEASURED_ROWS)
def test_a_plate_just_inside_the_family_bar_is_inside_the_kit_channel(
    family, clip, box, readings, worst, bar
):
    """One hundredth inside the bar: `kitsDiffer` False, verdict not contradicted."""
    plate = _plate_at_distance(family, bar - 0.01)
    assert chroma_distance(plate, name_reference_rgb(family)) == pytest.approx(
        bar - 0.01, abs=0.003
    )
    kit = _side_kit_distance({"away": plate}, _teams(family))
    assert isinstance(kit, KitDistance)
    assert kit.best_bar == bar, clip
    assert kit.any_inside is True, clip
    identity = _verdict(plate, family)
    assert identity["kitsDiffer"] is False, clip
    assert identity["verdict"] == "consistent", clip
    assert identity["threshold"] == bar, clip
    assert demotion_note(identity) == ""


@pytest.mark.parametrize("family,clip,box,readings,worst,bar", MEASURED_ROWS)
def test_a_plate_just_outside_the_family_bar_leaves_the_kit_channel(
    family, clip, box, readings, worst, bar
):
    """One hundredth outside the bar: `kitsDiffer` True and a read foreign name demotes."""
    plate = _plate_at_distance(family, bar + 0.01)
    identity = _verdict(plate, family, names=["LALIGA", "AL1"])
    assert identity["kitsDiffer"] is True, clip
    assert identity["namesMatch"] is False, clip
    assert identity["verdict"] == "contradicted", clip
    assert identity["threshold"] == bar, clip
    assert "contradicted score surface" in demotion_note(identity)


def test_the_family_bar_moves_the_boundary_not_just_the_report():
    """The same plate is inside `navy` and outside the global 0.44 — the bar is used."""
    plate = _plate_at_distance("navy", 0.47)
    assert 0.44 < chroma_distance(plate, name_reference_rgb("navy")) < 0.51
    navy = _verdict(plate, "navy")
    assert navy["kitsDiffer"] is False and navy["verdict"] == "consistent"
    assert navy["threshold"] == 0.51
    # The pre-8952 one-bar reading of the SAME plate is a demotion.
    legacy = _verdict(plate, "navy", names=["LALIGA", "AL1"], threshold=0.44)
    assert legacy["kitsDiffer"] is True and legacy["verdict"] == "contradicted"
    assert legacy["threshold"] == 0.44


def test_the_navy_row_admits_the_two_readings_that_sat_outside_044():
    """The measured navy worst (0.4426) is INSIDE 0.51 and OUTSIDE 0.44 — 2/187."""
    worst = [r for r in MEASURED_ROWS if r[0] == "navy"][0][4]
    assert 0.44 < worst < 0.51
    plate = _plate_at_distance("navy", worst)
    identity = _verdict(plate, "navy")
    assert identity["kitsDiffer"] is False
    assert identity["verdict"] == "consistent"
    assert identity["threshold"] == 0.51


def test_an_explicit_threshold_replaces_the_table_for_every_reference():
    """A caller asking for one bar gets one bar — the pre-8952 contract."""
    inside_navy = _plate_at_distance("navy", 0.47)
    loose = _verdict(inside_navy, "navy", threshold=0.52)
    assert loose["kitsDiffer"] is False and loose["threshold"] == 0.52
    tight = _verdict(inside_navy, "navy", threshold=0.44)
    assert tight["kitsDiffer"] is True and tight["threshold"] == 0.44


def test_the_reported_threshold_is_the_bar_the_reading_was_judged_at():
    """`threshold` on the verdict is no longer a constant echo."""
    assert _verdict(_plate_at_distance("navy", 0.30), "navy")["threshold"] == 0.51
    assert _verdict(_plate_at_distance("red", 0.20), "red")["threshold"] == 0.43
    assert _verdict(_plate_at_distance("pink", 0.10), "pink")["threshold"] == 0.20
    assert _verdict(_plate_at_distance("orange", 0.20), "orange")["threshold"] == 0.44
    # No comparable swatch at all -> the documented default, not `None`.
    bare = derive_surface_identity({"kits": {}, "names": []}, _teams("navy"))
    assert bare["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert bare["kitDistance"] is None


def test_the_red_bar_cannot_close_the_precision_hole_by_itself():
    """Documented limit: orange (0.2479) and pink (0.3134) are inside ANY usable red bar.

    A genuine red plate reaches 0.3667, so a red bar wide enough for recall also
    contains both foreign fills. That is why the precision closure is the
    printed-name conjunct in ADAAAA-8975 and not a smaller number here.
    """
    red = name_reference_rgb("red")
    orange_fill = [183.6, 102.05, 33.05]
    pink_fill = [183.6, 33.05, 127.14]
    assert chroma_distance(orange_fill, red) == pytest.approx(0.2479, abs=0.0005)
    assert chroma_distance(pink_fill, red) == pytest.approx(0.3134, abs=0.0005)
    for fill in (orange_fill, pink_fill):
        assert chroma_distance(fill, red) < 0.3667, "inside any usable red bar"
        assert chroma_distance(fill, red) < kit_distance_bar("red")


# --- the served Barcelona shape is unchanged --------------------------------

# The three frames the served replay turned into `contradicted` (ADAAAA-8927).
GENUINE_CONTRADICTED_FRAMES = [
    ("kids95_8483 f_0091", [102.5, 99.6, 149.6], 0.3796,
     ["ONARIOBMW", "RMA", "BARSANT", "BOLLOBREG"]),
    ("kids180_8123 f_0316", [101.7, 99.1, 148.8], 0.3793,
     ["ONARIOBMW", "RMA", "BARSANTA", "BOLLOBREG"]),
    ("qa8092_90s f_0120", [100.2, 100.7, 154.5], 0.3681,
     ["IRMA", "BARAZENDA"]),
]
BARCELONA_TEAMS = [{"side": "away", "name": "Barcelona", "kitColors": []}]


@pytest.mark.parametrize("label,plate,served_distance,names", GENUINE_CONTRADICTED_FRAMES)
def test_the_three_measured_frames_still_read_consistent_at_blue_044(
    label, plate, served_distance, names
):
    identity = derive_surface_identity(
        {"kits": {"away": plate}, "names": names},
        BARCELONA_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["verdict"] == "consistent", label
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD, label
    assert identity["kitDistance"] == pytest.approx(served_distance, abs=0.0002), label
    assert demotion_note(identity) == "", label


def _plate_frame(home_rgb, away_rgb, w=160, h=80) -> str:
    import base64
    import io

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


def _run(client, det, monkeypatch, frames, frame_b64, teams):
    sid = f"sess-kit-bars-8952-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq, (ts, lines) in enumerate(frames):
        det.crop_lines = list(lines)
        r = client.post(
            "/app/analyze",
            json={"seq": seq, "timestamp": ts, "image": frame_b64,
                  "gameHint": "soccer", "matchContextTeams": teams},
            headers={"X-Session-Id": sid},
        )
        assert r.status_code == 200
        payload = r.json()
        out.append(payload.get("observation", payload))
    return sid, out, app.state.registry.get(sid)


def test_the_served_frame_path_is_unchanged_for_a_genuine_plate(client, monkeypatch):
    """Through `POST /app/analyze` a washed-out genuine plate still attests at 0.44."""
    frames = [(i, (["BARAZENDA 1-0 RMA"] if i < 3 else ["BARAZENDA 2-0 RMA"]))
              for i in range(6)]
    det = ScriptedDet(["BARAZENDA 1-0 RMA"])
    _sid, obs, state = _run(
        client, det, monkeypatch, frames,
        _plate_frame([240.0, 240.0, 240.0], GENUINE_CONTRADICTED_FRAMES[0][1]),
        BARCELONA_TEAMS,
    )
    identity = state.surface_identity
    assert identity is not None
    assert identity["verdict"] == "consistent"
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)


@pytest.fixture()
def client():
    return TestClient(app)


# --- `_incumbent_surface_kept` keeps ONE bar --------------------------------

def _incumbent_state(plate_rgb):
    import types

    state = types.SimpleNamespace()
    state.session_id = "sess-incumbent-8952"
    state.surface_identity_plate = {"rgb": list(plate_rgb), "color": "navy"}
    state.scoreboard_roi_proven = (0.0, 0.0, 1.0, 0.25)
    state.surface_identity_plates = {(0.0, 0.0, 1.0, 0.25): {"rgb": list(plate_rgb),
                                                             "color": "navy"}}
    state.scoreboard_roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    state.scoreboard_roi_source = None
    return state


def _solid_frame(rgb, w=160, h=40):
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, :] = np.array(rgb, dtype=np.uint8)
    return arr


def test_incumbent_surface_kept_uses_the_constant_not_a_family_bar():
    """A 0.47 plate gap is inside navy's 0.51 and outside 0.44: the incumbent is kept.

    `_incumbent_surface_kept` compares two plates of the SAME surface across boxes;
    the per-family table is plate-vs-kit-REFERENCE. If the table leaked in here, a
    navy-adjacent second bug would take over the proven region at 0.47 < 0.51.
    """
    incumbent = _plate_at_distance("navy", 0.47)
    state = _incumbent_state(incumbent)
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    # The candidate box's own plate is the frame's dominant colour.
    candidate = _plate_at_distance("navy", 0.0)  # exactly on the reference
    kept = _incumbent_surface_kept(state, _solid_frame(candidate), roi)
    assert kept is True, "0.47 > 0.44 keeps the incumbent"
    assert state.scoreboard_roi_source == "incumbent_surface_kept"


def test_incumbent_surface_kept_still_allows_the_same_surface():
    """Below 0.44 the candidate IS the same surface, so the incumbent check does not fire."""
    incumbent = _plate_at_distance("navy", 0.40)
    state = _incumbent_state(incumbent)
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    candidate = _plate_at_distance("navy", 0.0)
    assert _incumbent_surface_kept(state, _solid_frame(candidate), roi) is False
