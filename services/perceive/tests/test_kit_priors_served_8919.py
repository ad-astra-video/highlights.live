"""ADAAAA-8919: the served league's kit priors, curated from a measurement.

ADAAAA-8908 made `contradicted` reachable from a team that carries a name and no
observed kit colour, and proved on the served build that both channels are
present on real pixels of job `493b55ff` (`kitsPresent: true`,
`namesMatch: false`) while `kitReference`/`kitDistance` stayed `null`: the curated
table held Portugal and Spain only, and every served job delivers the La Liga
bug. This suite pins the DATA change that closes that gap:

  * `Barcelona` is the away side of 36 stored jobs. Its plate was MEASURED on
    those jobs' own frames (see the cited burst in `_SOCCER_KIT_PRIORS`): the
    shipped `sample_scorebug_swatches` + `stable_swatch_by_side` read BLUE, and
    the served `/app/analyze` replay of `493b55ff` reads away
    `[93.9, 98.0, 195.7]`. The row is `("blue", None)` — primary only.
  * `Real Madrid` is NOT curated: its plate could not be measured (the home half
    stabilised once and read "red", not white), and this table is also the
    attribution KEY, so an unmeasured row would mis-link clusters.
  * The rule is untouched: `contradicted` still needs `kits_differ AND not
    names_match`. The bar is 0.44 since ADAAAA-8927 measured the genuine-plate
    population on natural traffic (1.15 x 0.381); this row is unchanged by it.
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
from app.match_context import (
    KitCluster,
    associate_kits,
    kit_prior_primary,
    kit_prior_table,
)
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    chroma_distance,
    derive_surface_identity,
    demotion_note,
    name_reference_rgb,
)

# The MEASURED away plate of the served bug, verbatim from the served replay of
# job 493b55ff's own frames (ADAAAA-8908's output, re-read in this ticket).
MEASURED_AWAY_PLATE = [93.9, 98.0, 195.7]
# The stable per-burst readings behind the row: job 796e202d (kids95_8483.mp4)
# and job a0e60cc2 (kids300_goals_7992b.mp4), both `blue` by `name_color`.
MEASURED_STABLE_B1 = [98.9, 102.1, 181.8]
MEASURED_STABLE_C1 = [103.3, 105.9, 166.9]

# A FOREIGN bug's away plate: green sits 0.80 from the curated blue reference.
FOREIGN_AWAY_PLATE = [0.0, 180.0, 60.0]
# The plates the broadcast prints beside each side on the real crop.
HOME_PLATE = [240.0, 240.0, 240.0]

# The delivered match context of the served jobs: a name and `kitColors: []`.
BARCELONA_TEAMS = [{"side": "away", "name": "Barcelona", "kitColors": []}]
# The tokens the served bug actually prints (job 493b55ff's own replay output):
# `BAR` is glued to a sponsor, so the printed names do NOT match Barcelona —
# which is what makes the precision arm reachable at all.
SERVED_BUG_LINE = "RMA 1-1 BAR"
SERVED_BUG_TOKENS = ["RMA", "BARVITALDENTTHE", "ONE", "ARCON", "CATALINA"]
# A foreign bug's own text: its tokens name no delivered team.
FOREIGN_LINE = "LALIGA 1-0 AL1"


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
    sid = f"sess-served-priors-{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(_app, "get_detector", lambda lora_ref=None: det)
    out = []
    for seq, (ts, lines) in enumerate(frames):
        det.crop_lines = list(lines)
        body = {"seq": seq, "timestamp": ts, "image": frame_b64, "gameHint": "soccer"}
        if teams is not None:
            body["matchContextTeams"] = teams
        r = client.post("/app/analyze", json=body, headers={"X-Session-Id": sid})
        assert r.status_code == 200
        payload = r.json()
        out.append(payload.get("observation", payload))
    return sid, out, app.state.registry.get(sid)


# --- AC1: the row is the measurement ----------------------------------------

def test_the_served_league_row_is_the_measured_blue():
    table = kit_prior_table("soccer")
    # RED before ADAAAA-8919: `kit_prior_primary("Barcelona")` was None, which is
    # exactly the `kitReference: null` the served replay of 493b55ff reported.
    assert kit_prior_primary("Barcelona", table) == "blue"
    assert table["Barcelona"] == ("blue", None), "primary only: the trim is not measured"
    # Case/punctuation never changes the lookup, and the pre-existing rows stand.
    assert kit_prior_primary(" barcelona ", table) == "blue"
    assert kit_prior_primary("F.C. Barcelona", table) is None, "no near-name match"
    assert kit_prior_primary("Portugal", table) == "red"
    assert kit_prior_primary("Spain", table) == "white"
    # Deliberately NOT curated: no measurement backs a Real Madrid row.
    assert kit_prior_primary("Real Madrid", table) is None


def test_the_measured_plate_sits_inside_the_shipped_bar():
    """The measurement, not a guess, has to clear the bar the rule uses."""
    blue = name_reference_rgb("blue")
    assert blue is not None
    # ADAAAA-8927: the bar moved from 0.35 to the natural-traffic measurement
    # (1.15 x worst genuine plate 0.381 = 0.44); this row is untouched by it.
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44
    for plate in (MEASURED_AWAY_PLATE, MEASURED_STABLE_B1):
        assert chroma_distance(plate, blue) <= SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD


# --- AC2: the reference resolves on the served shape ------------------------

def test_the_served_replay_shape_now_carries_a_prior_reference():
    """`kitReference: "prior"` + a non-null distance on 493b55ff's own reading.

    RED before this ticket: the same input returned `absent` with
    `kitDistance: null` and `kitReference: null` (ADAAAA-8908's served output).
    """
    identity = derive_surface_identity(
        {"kits": {"away": MEASURED_AWAY_PLATE}, "names": SERVED_BUG_TOKENS},
        BARCELONA_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["kitReference"] == "prior"
    assert identity["kitDistance"] is not None
    assert identity["kitsPresent"] is True
    assert identity["kitDistance"] <= SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    # AC4's recall half: the genuine surface of that match attests.
    assert identity["verdict"] == "consistent"
    assert demotion_note(identity) == ""
    # The prior is a REFERENCE: it is never published as an observed colour.
    assert identity["kits"] == {"away": MEASURED_AWAY_PLATE}
    assert "kitColors" not in identity


# --- AC3: the precision arm is reachable on the served league ---------------

def test_a_foreign_plate_on_the_served_league_contradicts():
    identity = derive_surface_identity(
        {"kits": {"away": FOREIGN_AWAY_PLATE}, "names": SERVED_BUG_TOKENS},
        BARCELONA_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["verdict"] == "contradicted"
    assert identity["kitReference"] == "prior"
    assert identity["kitDistance"] > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert identity["namesMatch"] is False
    note = demotion_note(identity)
    assert "contradicted score surface" in note
    # ADAAAA-8927: the note prints the bar the reading failed, which is now 0.44.
    assert str(SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD) in note, (
        "the demotion names the bar it failed"
    )


def test_the_served_league_demotion_reaches_the_observation(client, monkeypatch):
    """End to end: a foreign bug on the served shape emits `scoreboardSurfaceDemoted`.

    The foreign bug prints ITS OWN teams (`LALIGA`/`AL1`), not the served league's
    tokens — a genuine bug prints `RMA ... BAR`, whose `BAR` token matches
    Barcelona and keeps the surface `consistent` (the recall arm below).
    """
    frames = [(i, [FOREIGN_LINE] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    det = ScriptedDet([FOREIGN_LINE])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(HOME_PLATE, FOREIGN_AWAY_PLATE), teams=BARCELONA_TEAMS
    )
    assert state.surface_identity["verdict"] == "contradicted"
    assert state.surface_identity["kitReference"] == "prior"
    assert not any(o.get("scoreBoardChanged") for o in obs), "a contradicted surface must not attest"
    demoted = [o["scoreboardSurfaceDemoted"] for o in obs if o.get("scoreboardSurfaceDemoted")]
    assert demoted, "the demotion must be named on the window"
    assert "contradicted score surface" in demoted[0]
    reported = [o["scoreboardSurfaceIdentity"] for o in obs if "scoreboardSurfaceIdentity" in o]
    assert reported and reported[0]["kitReference"] == "prior"


# --- AC4: the recall arm holds ---------------------------------------------

def test_a_genuine_served_surface_still_attests(client, monkeypatch):
    frames = [(i, [SERVED_BUG_LINE] if i < 3 else ["RMA 2-1 BAR"]) for i in range(6)]
    det = ScriptedDet([SERVED_BUG_LINE])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(HOME_PLATE, MEASURED_AWAY_PLATE), teams=BARCELONA_TEAMS
    )
    assert state.surface_identity["verdict"] == "consistent"
    assert state.surface_identity["kitDistance"] <= SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert any(o.get("scoreBoardChanged") for o in obs)
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)


def test_an_unreadable_served_surface_stays_absent_never_contradicted():
    """A curated colour is not a measurement: no printed text means no demotion."""
    identity = derive_surface_identity(
        {"kits": {"away": FOREIGN_AWAY_PLATE}, "names": []},
        BARCELONA_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["kitsDiffer"] is True
    assert identity["kitReference"] == "prior"
    assert identity["verdict"] == "absent"
    assert demotion_note(identity) == ""


# --- AC5: the table is also the attribution KEY ----------------------------

def _served_clusters():
    """Two observed clusters from the served broadcast: blue shirt, red board."""
    return [
        KitCluster(primary="blue", secondary=None, rgb=MEASURED_STABLE_B1, frames=112, count=140),
        KitCluster(primary="red", secondary=None, rgb=[139.0, 27.0, 34.0], frames=112, count=112),
    ]


def test_the_served_row_links_an_observed_blue_cluster_to_barcelona():
    """Adding the row gives `associate_kits` its first key on served traffic."""
    status: dict = {}
    kits, ambiguous = associate_kits(
        BARCELONA_TEAMS, _served_clusters(), kit_prior=kit_prior_table("soccer"), status=status
    )
    assert kits["away"] == [{"primary": "blue"}]
    assert ambiguous is False
    assert status["kitPriorUsed"] == ["away"]
    assert status["kitPriorMiss"] == []


def test_a_barcelona_swatch_that_contradicts_the_row_is_vetoed():
    """NAMED ATTRIBUTION CHANGE: the row now vetoes a contradicting swatch.

    Before ADAAAA-8919 the table held no key for Barcelona, so a red score-bug
    half published `red` for a shirt whose plate measures blue. The scoped
    ADAAAA-8076 exception now withholds that reading and resolves the side from
    the observed blue cluster instead. This is the shipped behaviour for a
    curated team (Portugal/Spain), applied to the served league.
    """
    status: dict = {}
    kits, _ambiguous = associate_kits(
        BARCELONA_TEAMS,
        _served_clusters(),
        scorebug_swatches=[{"side": "away", "rgb": [205.0, 30.0, 30.0], "color": "red"}],
        kit_prior=kit_prior_table("soccer"),
        status=status,
    )
    assert kits["away"] == [{"primary": "blue"}]  # the cluster's own colour, never the prior's
    assert status["kitSwatchVetoed"] == [{"side": "away", "swatch": "red", "curated": "blue"}]


def test_a_swatch_in_the_curated_family_still_publishes_as_read():
    status: dict = {}
    kits, _ambiguous = associate_kits(
        BARCELONA_TEAMS,
        _served_clusters(),
        scorebug_swatches=[{"side": "away", "rgb": MEASURED_STABLE_B1, "color": "blue"}],
        kit_prior=kit_prior_table("soccer"),
        status=status,
    )
    assert kits["away"] == [{"primary": "blue"}]
    assert "kitSwatchVetoed" not in status
    assert status["kitPriorUsed"] == []


def test_an_uncurated_side_is_still_a_miss_not_a_guess():
    status: dict = {}
    kits, ambiguous = associate_kits(
        [{"name": "Liverpool", "side": "away"}],
        _served_clusters(),
        kit_prior=kit_prior_table("soccer"),
        status=status,
    )
    assert kits == {}
    assert ambiguous is False
    assert status["kitPriorMiss"] == ["away"]
