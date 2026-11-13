"""ADAAAA-8927: the kit-distance bar is measured on NATURAL TRAFFIC, not drift.

ADAAAA-8844 set `SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD = 0.35` as `1.15 x worst
same-surface DRIFT (0.3005)`. Drift is two readings of ONE surface; the rule
actually compares a plate read off a real broadcast crop to a SATURATED reference
(`name_reference_rgb("blue")` = [33.05, 33.05, 183.6]). A genuine plate is washed
out by exposure, so its reference distance is a different, larger quantity.

ADAAAA-8922 measured it at $0 on natural traffic (served build `58f51ad`, the
shipped `sample_scorebug_swatches` at each job's own ROI `[0, 0, 1, 0.25]`,
640x360 @ 3 fps, every frame of 5 broadcast clips): 555 genuine plate readings
(`name_color` == "blue") over 2263 frames, p50 0.349-0.353, p95 0.372-0.377,
worst 0.381, and 286 of 555 (52 %) sat outside 0.35. `1.15 x 0.381 = 0.438 -> 0.44`.

This suite pins both arms of that change:

  * RECALL: the three frames the served `/app/analyze` replay returned
    `contradicted` on (a genuine washed-out Barcelona plate) no longer demote,
    and no reading of the measured population sits outside the bar;
  * PRECISION: foreign green / red / white fills and a plate just outside the new
    bar still read `contradicted`. Purple (0.395) is the ONE documented in-set
    foreign colour and is deliberately excluded from the acceptance set.
"""
import base64
import io
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as _app
from app import app
from app.match_context import kit_prior_table
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    chroma_distance,
    derive_surface_identity,
    demotion_note,
    name_reference_rgb,
    surface_reading,
)

# --- the measurement (ADAAAA-8922, verbatim) ---------------------------------

# Point estimates of the measured bar, so a silent edit to the constant fails
# here with the arithmetic instead of only at 5 decimal places in one assertion.
WORST_GENUINE_PLATE = 0.381
MEASURED_READINGS = 555
MEASURED_CLIPS = 5
MARGIN = 1.15

# The three frames the served replay turned into `contradicted` (kitDistance from
# the served verdict, kits.away from the served sampler, printed names from the
# served OCR). Each is a GENUINE Barcelona plate that read blue.
GENUINE_CONTRADICTED_FRAMES = [
    ("kids95_8483 f_0091", [102.5, 99.6, 149.6], 0.3796,
     ["ONARIOBMW", "RMA", "BARSANT", "BOLLOBREG"]),
    ("kids180_8123 f_0316", [101.7, 99.1, 148.8], 0.3793,
     ["ONARIOBMW", "RMA", "BARSANTA", "BOLLOBREG"]),
    ("qa8092_90s f_0120", [100.2, 100.7, 154.5], 0.3681,
     ["IRMA", "BARAZENDA"]),
]

# Per-clip population (the ticket's table): frames, away readings, plate p50/p95/max.
MEASURED_CLIPS_TABLE = [
    ("kids95_8483.mp4", 287, 80, 0.349, 0.377, 0.380),
    ("kids180_8123.mp4", 542, 126, 0.353, 0.375, 0.379),
    ("kids300_7935.mp4", 902, 210, 0.350, 0.372, 0.381),
    ("qa8092_90s.mp4", 272, 71, 0.349, 0.377, 0.381),
    ("kids300_goals_7992b.mp4", 260, 68, 0.349, 0.377, 0.381),
]

# The served shape every natural job delivers: a name and `kitColors: []`.
BARCELONA_TEAMS = [{"side": "away", "name": "Barcelona", "kitColors": []}]
# A foreign bug's away plate fills, measured from the unchanged saturated reference.
FOREIGN_GREEN = [0.0, 180.0, 60.0]
FOREIGN_RED = [205.0, 30.0, 30.0]
FOREIGN_WHITE = [240.0, 240.0, 240.0]
# A fill 0.0161 OUTSIDE the new bar: the below-bar margin guard. A widened bar
# must still demote a surface it does not cover, not just the 0.8-away ones.
FOREIGN_CYAN = [0.0, 200.0, 200.0]
# The one colour the widened bar pulls IN. Excluded from the acceptance set.
PURPLE_REFERENCE = [127.14, 33.05, 183.6]

FOREIGN_TOKENS = ["LALIGA", "AL1"]


# --- helpers -----------------------------------------------------------------

def _plate_frame(home_rgb, away_rgb, w=160, h=80) -> str:
    """JPEG whose left half is the home plate and right half the away plate."""
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    arr[:, : w // 2] = np.array(home_rgb, dtype=np.uint8)
    arr[:, w // 2:] = np.array(away_rgb, dtype=np.uint8)
    img = Image.fromarray(arr, "RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
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


@pytest.fixture()
def client():
    return TestClient(app)


def _run(client, det, monkeypatch, frames, frame_b64, teams=None):
    sid = f"sess-natural-bar-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq, (ts, lines) in enumerate(frames):
        det.crop_lines = list(lines)
        body = {
            "seq": seq,
            "timestamp": ts,
            "image": frame_b64,
            "gameHint": "soccer",
        }
        if teams is not None:
            body["matchContextTeams"] = teams
        r = client.post("/app/analyze", json=body, headers={"X-Session-Id": sid})
        assert r.status_code == 200
        payload = r.json()
        out.append(payload.get("observation", payload))
    return sid, out, app.state.registry.get(sid)


def _blue() -> list:
    """The saturated `blue` reference the rule compares a plate against."""
    ref = name_reference_rgb("blue")
    assert ref is not None
    return ref


def _served_shape_verdict(away_plate, names):
    """The verdict a served job gets for a plate under the curated `blue` prior."""
    return derive_surface_identity(
        {"kits": {"away": away_plate}, "names": list(names)},
        BARCELONA_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )


# --- AC1: the bar is the measured natural-traffic value ----------------------

def test_the_bar_is_115x_the_worst_measured_genuine_plate():
    """AC1: `1.15 x 0.381 = 0.438 -> 0.44`, the same rule ADAAAA-8844 used.

    The margin stays on the WORST measured reading, not the typical one: demoting
    a genuine surface is the failure this increment must not cause (AC2.2).
    """
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44
    assert round(MARGIN * WORST_GENUINE_PLATE, 3) == 0.438
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD >= MARGIN * WORST_GENUINE_PLATE
    # ... and it is the ADAAAA-8844 drift bound, applied to the quantity the rule
    # actually compares; it never falls back to the drift-only 0.35.
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD > 0.35
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == round(
        MARGIN * WORST_GENUINE_PLATE + 0.00185, 2
    ), "0.44 is 1.15 x 0.381 rounded up to the nearest hundredth"


def test_the_reference_is_unchanged_and_still_the_separator():
    """Scope: `name_color` / `name_reference_rgb` are untouched by this change."""
    assert name_reference_rgb("blue") == [33.05, 33.05, 183.6]
    assert name_reference_rgb("purple") == PURPLE_REFERENCE


# --- AC2: the recall arm -----------------------------------------------------

@pytest.mark.parametrize("label,plate,served_distance,names", GENUINE_CONTRADICTED_FRAMES)
def test_a_measured_genuine_frame_is_no_longer_contradicted(label, plate, served_distance, names):
    """AC2: each of the three served `contradicted` frames now reads consistent.

    The distance is the frame's OWN served reading, so this pins the exact frames
    the ticket reproduced twice, not a synthetic plate near them.
    """
    assert abs(chroma_distance(plate, _blue()) - served_distance) <= 0.0002
    # At the OLD bar this genuine surface was demoted — that is the failure.
    assert served_distance > 0.35
    identity = _served_shape_verdict(plate, names)
    assert identity["verdict"] == "consistent", label
    assert identity["kitDistance"] == pytest.approx(served_distance, abs=0.0002)
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert "contradicted score surface" not in demotion_note(identity)


def test_no_reading_of_the_measured_population_is_outside_the_bar():
    """AC2: 0 of 555 genuine readings demoted (was 286 at 0.35).

    The per-clip MAX is the binding number: if every clip's worst reading is
    inside the bar, no reading of that clip can be demoted — so the population
    count is arithmetic, not a sample.
    """
    total_away = sum(row[2] for row in MEASURED_CLIPS_TABLE)
    assert len(MEASURED_CLIPS_TABLE) == MEASURED_CLIPS
    assert total_away == MEASURED_READINGS
    demoted = 0
    for clip, _frames, away, p50, p95, worst in MEASURED_CLIPS_TABLE:
        assert p50 <= p95 <= worst, clip
        assert worst <= SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD, clip
        # The genuine plate population straddles the OLD bar: p95 of every clip is
        # outside 0.35 (and p50 does on 2 of 5 clips), which is why 52 % of the
        # readings were demoted and why stabilising the reading (the rejected
        # alternative) could not fix it.
        assert p95 > 0.35, clip
        assert p50 >= 0.349, clip
        demoted += sum(
            1 for d in (p50, p95, worst) if d > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
        )
    assert demoted == 0


def test_the_widened_bar_keeps_a_margin_over_the_worst_reading():
    """The bar is not set ON the worst reading: 1.15 x worst leaves 0.059 spare."""
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD - WORST_GENUINE_PLATE >= 0.05


# --- AC3: the precision arm --------------------------------------------------

@pytest.mark.parametrize(
    "label,plate,measured_distance",
    [
        ("green repaint (ADAAAA-8919)", FOREIGN_GREEN, 0.797),
        ("red repaint", FOREIGN_RED, 0.894),
        ("white fill", FOREIGN_WHITE, 0.492),
    ],
)
def test_a_foreign_away_fill_is_still_contradicted(label, plate, measured_distance):
    """AC3: widening the bar must not turn a foreign surface into `consistent`."""
    measured = chroma_distance(plate, _blue())
    assert measured == pytest.approx(measured_distance, abs=0.001), label
    assert measured > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    identity = _served_shape_verdict(plate, FOREIGN_TOKENS)
    assert identity["verdict"] == "contradicted", label
    assert identity["kitsDiffer"] is True and identity["namesMatch"] is False
    assert "contradicted score surface" in demotion_note(identity)


def test_a_fill_just_outside_the_new_bar_is_still_contradicted():
    """AC3's below-bar margin guard: the bar demotes what it does not cover.

    CYAN sits 0.0161 outside 0.44 — the closest foreign fill in the measured set.
    The ticket's literal "plate at 0.40" clause cannot hold at a 0.44 bar (0.40 is
    INSIDE it by construction, exactly like purple), so the guard is pinned on the
    first measured distance OUTSIDE the bar instead.
    """
    measured = chroma_distance(FOREIGN_CYAN, _blue())
    assert measured == pytest.approx(0.4561, abs=0.0005)
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD < measured < 0.46
    identity = _served_shape_verdict(FOREIGN_CYAN, FOREIGN_TOKENS)
    assert identity["verdict"] == "contradicted"


def test_purple_is_the_documented_in_set_exception():
    """AC3: purple moves inside 0.44 — named in the PR, NOT part of acceptance.

    ADAAAA-8922 measured a purple PLATE fill at 0.395 from the `blue` reference
    (it was already only 0.045 outside 0.35); the saturated `purple` reference is
    0.313 from `blue`. Either form is in-set at 0.44, and the printed-name
    conjunct is what separates it from this match's surface. Pinned so nobody
    reads the widened bar as covering purple.
    """
    reference = chroma_distance(PURPLE_REFERENCE, _blue())
    assert reference == pytest.approx(0.3134, abs=0.0005)
    assert reference < SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    # The measured plate fill the ticket reports: 0.395, also inside, 0.045 out
    # of the old bar. Anything in the purple bucket is therefore in-set.
    assert 0.395 < SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert 0.395 - 0.35 <= 0.046
    assert _served_shape_verdict(PURPLE_REFERENCE, FOREIGN_TOKENS)["kitsDiffer"] is False


def test_the_red_direction_gains_gold_and_yellow_and_nothing_else():
    """Measured consequence of ONE global bar over every kit reference.

    The ticket's precision table is measured against the `blue` reference, so it
    cannot see the red direction. Against `red`, `pink` (0.313) and `orange`
    (0.248) were ALREADY inside 0.35; the widening to 0.44 adds `gold` (0.370)
    and a flat yellow fill (0.426). Purple travels the other way (in-set against
    `blue`, 0.313). Recorded so the precision envelope of the widened bar is an
    explicit, pinned fact rather than an unmeasured side effect — the served
    league this lab runs delivers a `blue` away prior only (`Real Madrid` is
    deliberately uncurated, so no served shape compares against `red`).
    """
    red = name_reference_rgb("red")
    assert red is not None
    # Already in-set at the old bar: the widening changes nothing for these.
    for fill, expected in (([183.6, 33.05, 127.14], 0.3134), ([183.6, 102.05, 33.05], 0.2479)):
        assert chroma_distance(fill, red) == pytest.approx(expected, abs=0.0005)
        assert chroma_distance(fill, red) < 0.35
    # The two pairs the widening adds, both below the new bar and above the old.
    for fill, expected in (([183.6, 152.23, 33.05], 0.3699), ([230.0, 220.0, 20.0], 0.4257)):
        assert chroma_distance(fill, red) == pytest.approx(expected, abs=0.0005)
        assert 0.35 < chroma_distance(fill, red) < SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


# --- the real frame path (the served shape a natural job takes) -------------

def test_the_served_frame_path_attests_on_a_washed_out_genuine_plate(client, monkeypatch):
    """AC2 through `POST /app/analyze`: a genuine plate no longer withholds a goal.

    RED before this change: the identity pass read the same plate at 0.3796,
    called the surface `contradicted`, and withheld `scoreBoardChanged` — so a
    real goal in that window was dropped (the AC4/AC2.2 recall failure).
    """
    # The measured frame's own plate (`kits.away` [102.5, 99.6, 149.6]); the bug
    # prints `BARSANT`, which is not a Barcelona token, so the names do NOT match
    # and the kit channel alone decides — exactly the frame the replay demoted.
    frames = [(i, (["BARAZENDA 1-0 RMA"] if i < 3 else ["BARAZENDA 2-0 RMA"])) for i in range(6)]
    plate = GENUINE_CONTRADICTED_FRAMES[0][1]
    det = ScriptedDet(["BARAZENDA 1-0 RMA"])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(FOREIGN_WHITE, plate),
        teams=BARCELONA_TEAMS,
    )

    identity = state.surface_identity
    assert identity is not None
    assert identity["verdict"] == "consistent"
    assert identity["threshold"] == SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert identity["kitDistance"] >= 0.35, "this is a washed-out plate, not a perfect one"
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)
    published = [o for o in obs if "scoreboardSurfaceIdentity" in o]
    assert published, "the verdict is published on the pass frame"
    assert published[0]["scoreboardSurfaceIdentity"]["verdict"] == "consistent"


def test_the_served_frame_path_still_demotes_a_foreign_plate(client, monkeypatch):
    """AC3 through the frame path: green repaint keeps the demotion reachable."""
    frames = [(i, ["LALIGA 1-0 AL1"] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    det = ScriptedDet(["LALIGA 1-0 AL1"])
    sid, obs, state = _run(
        client, det, monkeypatch, frames,
        _plate_frame(FOREIGN_WHITE, FOREIGN_GREEN), teams=BARCELONA_TEAMS,
    )

    assert state.surface_identity["verdict"] == "contradicted"
    assert not any(o.get("scoreBoardChanged") for o in obs)
    demoted = [o["scoreboardSurfaceDemoted"] for o in obs if o.get("scoreboardSurfaceDemoted")]
    assert demoted and "contradicted score surface" in demoted[0]
