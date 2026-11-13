"""ADAAAA-8908: a curated kit REFERENCE makes identity=`contradicted` reachable.

The delivery fix (ADAAAA-8902) makes the identity pass run, but on the served jobs
the resolved team reference carries no kit colours at all:

    matchContext.teams = [{side: away, name: Barcelona, kitColors: []}]
    matchContextEvidence = {kitSamples: 0, scorebugSwatches: 60, ...}

The Stage-3 kit sampler produced ZERO player-crop samples, so `_side_kit_distance`
had no side to compare and `kitsPresent` was false on every served job — the
verdict could only be `consistent` (printed name matched) or `absent`. Therefore
`scoreboardSurface.demotion` and the `[data-scoreboard-surface-demotion]` chip
were unreachable no matter how foreign the surface was.

This suite pins the reference-only fallback (scope item 1 of ADAAAA-8908):

  * when the delivered team has a NAME and no observed kit colour, the crop
    swatch is compared against the curated prior for that team
    (`_SOCCER_KIT_PRIORS`, ADAAAA-7866) — the same table the resolver already
    uses as an attribution KEY;
  * the prior is a REFERENCE, never an observation: it is never published as a
    `kitColors`/caption colour, and the identity record says the distance came
    from the prior (`kitReference: "prior"`);
  * BOTH channels still have to disagree (`kits_differ AND not names_match`) and
    the shipped bar is unchanged (`SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD`);
  * the recall side is pinned too: a genuine surface with a matching printed name
    stays `consistent`, and a genuine surface whose plates match the prior is
    `consistent` even when no team name is printed.
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
from app.match_context import kit_prior_primary, kit_prior_table
from app.surface_identity import (
    SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
    derive_surface_identity,
    demotion_note,
    printed_team_tokens,
    surface_reading,
)

# The curated priors this fixture rides on (match_context._SOCCER_KIT_PRIORS:
# Portugal -> red, Spain -> white, both MEASURED on ADAAAA-7859 anchor frames).
RED_PLATE = [205.0, 30.0, 30.0]  # Portugal's curated primary
WHITE_PLATE = [240.0, 240.0, 240.0]  # Spain's curated primary
# A foreign bug's plates. Chosen OUTSIDE the bar from BOTH references so the kit
# channel genuinely disagrees: green sits 0.97 from red / 0.54 from white, and
# the blue sits 0.83 / 0.46 — every distance clears 0.35 with margin for JPEG.
FOREIGN_HOME = [0.0, 180.0, 60.0]
FOREIGN_AWAY = [40.0, 45.0, 205.0]

# The delivered match context of a job whose kit sampler read nothing: names only.
NAME_ONLY_TEAMS = [
    {"side": "home", "name": "Portugal", "kitColors": []},
    {"side": "away", "name": "Spain", "kitColors": []},
]
# A team with NO curated prior — the coverage gap this fix does not invent around.
# ADAAAA-8919 changed this fixture's team from `Barcelona` to `Liverpool`: the
# served league now HAS a measured `Barcelona` row (`blue`), so the original team
# no longer exercises the coverage gap. `Liverpool` is in the soccer lexicon and
# uncurated, which is the shape this test actually pins — no assertion changed.
NO_PRIOR_TEAMS = [{"side": "away", "name": "Liverpool", "kitColors": []}]

FOREIGN_LINE = "LALIGA 1-0 AL1"
GENUINE_LINE = "PORTUGAL 1-0 SPAIN"


def foreign_tokens() -> list[str]:
    """The tokens the foreign bug prints — read the way perceive reads them."""
    return printed_team_tokens([FOREIGN_LINE])


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


def _run(client, det, monkeypatch, frames, frame_b64, teams=None):
    sid = f"sess-kitref-{uuid.uuid4().hex[:8]}"
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


# --- the reference itself ----------------------------------------------------

def test_the_reference_is_the_curated_prior_and_never_a_guess():
    """Only the curated primary is a reference; an uncurated team has none."""
    soccer = kit_prior_table("soccer")
    assert kit_prior_primary("Portugal", soccer) == "red"
    assert kit_prior_primary("Spain", soccer) == "white"
    # Case/punctuation cannot change the lookup, but a near name never matches.
    assert kit_prior_primary(" portugal ", soccer) == "red"
    assert kit_prior_primary("Portuguese", soccer) is None
    # A sport with no curated table keeps the channel OFF.
    assert kit_prior_table("basketball") == {}
    assert kit_prior_primary("Portugal", kit_prior_table("basketball")) is None
    # The shipped bar, widened by ADAAAA-8927 to the natural-traffic measurement
    # (1.15 x 0.381 = 0.44); this fix is untouched by that value.
    assert SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD == 0.44


def test_prior_reference_reaches_contradicted_without_observed_kit_colours():
    """The served shape (`kitColors: []`) can now be contradicted.

    RED on the unpatched tree: with no observed kit colour `_side_kit_distance`
    returned no distance, so `kitsPresent` stayed false and the verdict was
    `absent` — the demotion was unreachable.
    """
    reading = {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": foreign_tokens()}
    identity = derive_surface_identity(
        reading, NAME_ONLY_TEAMS, kit_priors=kit_prior_table("soccer")
    )
    assert identity["verdict"] == "contradicted"
    assert identity["kitsPresent"] is True
    assert identity["kitsDiffer"] is True
    assert identity["namesMatch"] is False
    assert identity["kitDistance"] > SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD
    assert identity["kitReference"] == "prior"
    assert "contradicted score surface" in demotion_note(identity)


def test_the_prior_is_never_published_as_an_observed_kit_colour():
    """The record carries the OBSERVED swatches only; the prior is a reference."""
    reading = {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": foreign_tokens()}
    identity = derive_surface_identity(
        reading, NAME_ONLY_TEAMS, kit_priors=kit_prior_table("soccer")
    )
    # No invented kit observation sneaks onto the record.
    assert "kitColors" not in identity
    assert identity["kits"] == {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}
    portugal_red = [205.0, 30.0, 30.0]
    assert portugal_red not in identity["kits"].values()


def test_observed_kit_colours_still_win_over_the_prior():
    """A measured kit colour is the reference when the job carries one."""
    teams = [{"side": "home", "name": "Portugal", "kitColors": [{"primary": "green"}]}]
    reading = {"kits": {"home": FOREIGN_HOME}, "names": foreign_tokens()}
    identity = derive_surface_identity(reading, teams, kit_priors=kit_prior_table("soccer"))
    assert identity["kitReference"] == "observed"
    # GREEN observed: the green plate is this surface's own kit -> consistent.
    assert identity["verdict"] == "consistent"


# --- the recall side (the failure this fix must not cause) -------------------

def test_genuine_surface_with_a_matching_printed_name_stays_consistent():
    """Both channels must disagree: a matched printed name is the authority."""
    reference = derive_surface_identity(
        {"kits": {"home": RED_PLATE, "away": WHITE_PLATE},
         "names": ["PORTUGAL", "SPAIN"]},
        NAME_ONLY_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert reference["verdict"] == "consistent"
    assert reference["kitReference"] == "prior"

    # Even on plates the prior disagrees with, the printed name keeps it consistent.
    named = derive_surface_identity(
        {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": ["PORTUGAL", "SPAIN"]},
        NAME_ONLY_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert named["verdict"] == "consistent"
    assert named["kitsDiffer"] is True


def test_genuine_surface_matching_the_prior_stays_consistent_with_no_printable_name():
    """A silently-printed bug is still attested when its plates match the kits."""
    identity = derive_surface_identity(
        {"kits": {"home": RED_PLATE, "away": WHITE_PLATE}, "names": []},
        NAME_ONLY_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["verdict"] == "consistent"
    assert identity["namesMatch"] is False
    assert identity["kitsDiffer"] is False


def test_a_prior_only_reference_cannot_contradict_an_unreadable_surface():
    """RECALL guard: a curated colour is not a measurement, so the kit channel
    alone may not demote a surface whose text could not be read."""
    identity = derive_surface_identity(
        {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": []},
        NAME_ONLY_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["kitsDiffer"] is True
    assert identity["kitReference"] == "prior"
    assert identity["verdict"] == "absent"
    assert demotion_note(identity) == ""


def test_an_observed_kit_colour_keeps_the_shipped_kits_only_rule():
    """With a MEASURED reference the shipped rule is unchanged: kits that disagree
    with no readable name still contradict (today's precision behaviour)."""
    teams = [{"side": "home", "name": "Portugal", "kitColors": [{"primary": "green"}]}]
    identity = derive_surface_identity(
        {"kits": {"home": FOREIGN_HOME}, "names": []},
        teams,
        kit_priors=kit_prior_table("soccer"),
    )
    # The observed kit IS the plate colour, so this surface matches it.
    assert identity["verdict"] == "consistent"
    far = derive_surface_identity(
        {"kits": {"home": RED_PLATE}, "names": []},
        teams,
        kit_priors=kit_prior_table("soccer"),
    )
    assert far["kitsDiffer"] is True
    assert far["verdict"] == "contradicted"


def test_a_team_with_no_curated_prior_stays_absent_not_guessed():
    """Coverage is the prior table's, never an inferred colour (AC2.2 safety)."""
    identity = derive_surface_identity(
        {"kits": {"away": FOREIGN_AWAY}, "names": foreign_tokens()},
        NO_PRIOR_TEAMS,
        kit_priors=kit_prior_table("soccer"),
    )
    assert identity["verdict"] == "absent"
    # A plate WAS read off the bug, but no reference exists to compare it with.
    assert identity["kitsPresent"] is True
    assert identity["kitDistance"] is None
    assert identity["kitReference"] is None


def test_no_prior_table_keeps_the_old_rule_byte_for_byte():
    """A sport without a curated table cannot change any verdict."""
    reading = {"kits": {"home": FOREIGN_HOME, "away": FOREIGN_AWAY}, "names": foreign_tokens()}
    assert (
        derive_surface_identity(reading, NAME_ONLY_TEAMS, kit_priors=kit_prior_table("basketball"))[
            "verdict"
        ]
        == "absent"
    )


# --- the real frame path -----------------------------------------------------

def test_the_demotion_reaches_the_observation_on_a_name_only_reference(client, monkeypatch):
    """End to end: /app/analyze with `kitColors: []` now emits the demotion."""
    frames = [(i, [FOREIGN_LINE] if i < 3 else ["LALIGA 2-0 AL1"]) for i in range(6)]
    det = ScriptedDet([FOREIGN_LINE])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(FOREIGN_HOME, FOREIGN_AWAY), teams=NAME_ONLY_TEAMS
    )

    assert state.surface_identity["verdict"] == "contradicted"
    assert state.surface_identity["kitReference"] == "prior"
    assert not any(o.get("scoreBoardChanged") for o in obs), "a contradicted surface must not attest"
    demoted = [o["scoreboardSurfaceDemoted"] for o in obs if o.get("scoreboardSurfaceDemoted")]
    assert demoted, "the demotion must be named on the window"
    assert "contradicted score surface" in demoted[0]
    # The observation the board folds carries the prior provenance.
    reported = [o["scoreboardSurfaceIdentity"] for o in obs if "scoreboardSurfaceIdentity" in o]
    assert reported and reported[0]["kitReference"] == "prior"


def test_a_genuine_name_only_reference_still_attests_its_own_goal(client, monkeypatch):
    """Recall: the same served shape, on THIS match's surface, still attests."""
    frames = [(i, [GENUINE_LINE] if i < 3 else ["PORTUGAL 2-0 SPAIN"]) for i in range(6)]
    det = ScriptedDet([GENUINE_LINE])
    sid, obs, state = _run(
        client, det, monkeypatch, frames, _plate_frame(RED_PLATE, WHITE_PLATE), teams=NAME_ONLY_TEAMS
    )

    assert state.surface_identity["verdict"] == "consistent"
    assert any(o.get("scoreBoardChanged") for o in obs)
    assert not any(o.get("scoreboardSurfaceDemoted") for o in obs)


def test_surface_reading_is_unchanged_by_the_reference():
    """The reading still reports only what the crop printed, never a prior."""
    from app.scoreboard import ScoreboardRoi

    arr = np.zeros((40, 80, 3), dtype=np.uint8)
    arr[:, :40] = np.array(RED_PLATE, dtype=np.uint8)
    arr[:, 40:] = np.array(WHITE_PLATE, dtype=np.uint8)
    reading = surface_reading(arr, ScoreboardRoi(0, 0, 1, 1), ["PORTUGAL 1-0 SPAIN"])
    assert reading["kits"]["home"] == pytest.approx(RED_PLATE, abs=2.0)
    assert "prior" not in reading
