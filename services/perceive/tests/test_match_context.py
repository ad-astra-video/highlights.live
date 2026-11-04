"""Unit tests for the match-context resolver (ADAAAA-7855).

Pure, GPU-free and network-free: the parser / lexicon / fold / guard / colour
naming functions are imported directly. The suite also pins the ADAAAA-7855
separation guarantee: ``parse_ocr_teams`` never produces a score and the
existing ``parse_ocr_score`` behaviour is unchanged on the same lines (AC7).
"""
from __future__ import annotations

import random

from app.match_context import (
    FLIP_MARGIN,
    RESOLVER_VERSION,
    SINGLE_SOURCE_CAP,
    SPORT_UNKNOWN,
    TEAM_LEXICON,
    USABLE_CONFIDENCE,
    KitCluster,
    TeamText,
    _KIT_COLOR_NAMES,
    _KIT_PRIORS,
    _SOCCER_KIT_PRIORS,
    _generic_name_key,
    _levenshtein_le,
    apply_monotonic_guard,
    associate_kits,
    build_match_context,
    cluster_kit_colors,
    fold_confidence,
    generic_scorebug_sides,
    is_plausible_player_box,
    name_color,
    parse_metadata_hints,
    esports_hud_sides,
    parse_generic_scorebug_names,
    printed_name_pair,
    printed_plate_sides,
    parse_ocr_teams,
    resolve_match_context,
    resolve_token,
    sample_track_colors,
    scan_commentary,
    scorebug_lines_have_team_text,
    scorebug_lines_sides,
    sport_key,
)
from app.scoreboard import ScoreboardRoi, parse_ocr_score

# Fixtures ----------------------------------------------------------------


def _red(n=30, ts=None):
    return {"rgb": [190.0, 30.0, 32.0], "ts": ts}


def kit_samples(colors, frames=3):
    """Build samples: ``colors`` list of RGB triples, ``frames`` per colour."""
    out = []
    for i, rgb in enumerate(colors):
        for f in range(frames):
            out.append({"rgb": list(rgb), "ts": 10.0 + f, "trackId": f"t{i}", "frameSeq": f})
    return out


RED = [185.0, 34.0, 38.0]
WHITE = [236.0, 236.0, 232.0]
NAVY = [26.0, 40.0, 96.0]
GREEN_PITCH = [52.0, 120.0, 48.0]


# Sport resolution --------------------------------------------------------


def test_sport_key_accepts_florence_canonical_tokens_and_raw_hints():
    assert sport_key("soccer") == "soccer"
    assert sport_key("american football") == "american_football"
    assert sport_key("basketball") == "basketball"
    assert sport_key("nhl") == "ice_hockey"
    assert sport_key("MLB") == "baseball"
    assert sport_key("valorant") == "team_esports"


def test_sport_key_never_guesses_unmapped_sports():
    # An unmapped sport must fall back to unknown, never to another team list.
    assert sport_key("tennis") == SPORT_UNKNOWN
    assert sport_key("") == SPORT_UNKNOWN
    assert sport_key(None) == SPORT_UNKNOWN


# Team-text parser (Stage 1) ---------------------------------------------


def test_parse_ocr_teams_score_line_gives_home_and_away_sides():
    teams = parse_ocr_teams(["POR 1 - 0 ESP"], "soccer")
    assert [(t.name, t.side) for t in teams] == [("Portugal", "home"), ("Spain", "away")]


def test_parse_ocr_teams_full_names_and_both_sides_of_separator():
    teams = parse_ocr_teams(["PORTUGAL 2 - 1 SPAIN"], "soccer")
    assert [(t.name, t.side) for t in teams] == [("Portugal", "home"), ("Spain", "away")]


def test_parse_ocr_teams_nameplate_with_two_teams_uses_reading_order():
    teams = parse_ocr_teams(["Portugal Spain"], "soccer")
    assert [(t.name, t.side) for t in teams] == [("Portugal", "home"), ("Spain", "away")]


def test_parse_ocr_teams_single_team_stays_side_unknown():
    teams = parse_ocr_teams(["PORTUGAL"], "soccer")
    assert [(t.name, t.side) for t in teams] == [("Portugal", "unknown")]


def test_parse_ocr_teams_ignores_unreadable_and_out_of_roi_lines():
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)
    lines = ["POR 1 - 0 ESP", "SALE ON NOW", "SUBWAY"]
    boxes = [[0.1, 0.1, 0.6, 0.2], [0.1, 0.8, 0.9, 0.9], [0.2, 0.9, 0.5, 0.99]]
    teams = parse_ocr_teams(lines, "soccer", roi=roi, ocr_boxes=boxes)
    assert [(t.name, t.side) for t in teams] == [("Portugal", "home"), ("Spain", "away")]


def test_parse_ocr_teams_unmapped_sport_yields_nothing():
    assert parse_ocr_teams(["POR 1 - 0 ESP"], SPORT_UNKNOWN) == []
    assert parse_ocr_teams(["POR 1 - 0 ESP"], "tennis") == []


def test_parse_ocr_teams_per_sport_codes():
    assert [t.name for t in parse_ocr_teams(["LAL 98 - 104 BOS"], "basketball")] == [
        "Los Angeles Lakers",
        "Boston Celtics",
    ]
    assert [t.name for t in parse_ocr_teams(["KC 21 - 17 BUF"], "american_football")] == [
        "Kansas City Chiefs",
        "Buffalo Bills",
    ]
    assert [t.name for t in parse_ocr_teams(["VGK 2 - 3 NYR"], "ice_hockey")] == [
        "Vegas Golden Knights",
        "New York Rangers",
    ]
    assert [t.name for t in parse_ocr_teams(["NYY 4 - 2 BOS"], "baseball")] == [
        "New York Yankees",
        "Boston Red Sox",
    ]
    assert [t.name for t in parse_ocr_teams(["SEN 13 - 9 FNC"], "team_esports")] == [
        "Sentinels",
        "Fnatic",
    ]


# Separation guarantee (AC7) --------------------------------------------


def test_team_parser_never_produces_a_score():
    # A team name must never contribute to a score: there is no code path from
    # parse_ocr_teams to a score tuple.
    teams = parse_ocr_teams(["POR 1 - 0 ESP"], "soccer")
    assert teams and not hasattr(teams[0], "score")
    assert parse_ocr_score(["POR 1 - 0 ESP"]) == (1, 0)


def test_parse_ocr_score_behaviour_is_unchanged_on_team_lines():
    # Regression pin: the score parser ignores team text exactly as before.
    assert parse_ocr_score(["PORTUGAL"]) is None
    assert parse_ocr_score(["Spain in the white shirts"]) is None
    assert parse_ocr_score(["Chelsea 2 - 1 Arsenal"]) == (2, 1)
    assert parse_ocr_score(["45-42"]) == (45, 42)
    assert parse_ocr_score(["90:00"]) is None  # clock, not a score
    # A score line is still parsed from the same OCR lines the team parser reads.
    lines = ["POR 1 - 0 ESP"]
    assert parse_ocr_score(lines) == (1, 0)
    assert [t.name for t in parse_ocr_teams(lines, "soccer")] == ["Portugal", "Spain"]


# Sport-generic scorebug names (ADAAAA-7898) -------------------------------

# The real basketball clip prints "Denizli Basket 11 - 8 Samsunspor" with the
# league branding above it and the period marker after it. Neither club is in the
# NBA-only lexicon, so the closed-lexicon pass yields nothing.
BB_LINE = "Denizli Basket 11 - 8 Samsunspor"
BB_LINES = ["TÜRKİYE BASKETBOL LİGİ", BB_LINE, "1.Ç"]


def bb_frames(n=30, line=BB_LINE, extra=None):
    return [{"ts": float(i), "lines": [line] + list(extra or [])} for i in range(n)]


def test_generic_names_resolve_a_non_lexicon_basketball_scorebug():
    # The shipped defect: a clean OCR read of two non-NBA clubs produced no
    # candidate at all (`parse_ocr_teams` -> []).
    assert parse_ocr_teams([BB_LINE], "basketball") == []

    teams, status = parse_generic_scorebug_names(bb_frames(30), "basketball")
    assert [(t.name, t.side, t.generic) for t in teams] == [
        ("Denizli Basket", "home", True),
        ("Samsunspor", "away", True),
    ]
    assert status["scoreFrames"] == 30
    # ADAAAA-7909: the per-side record also names the printed variants that voted
    # for the published spelling, so an OCR-noise rejection is inspectable.
    assert status["names"]["home"]["name"] == "Denizli Basket"
    assert status["names"]["home"]["frames"] == 30
    assert status["names"]["home"]["share"] == 1.0
    assert status["names"]["home"]["variants"] == {"Denizli Basket": 30}
    assert status["names"]["away"]["name"] == "Samsunspor"
    assert status["names"]["away"]["frames"] == 30
    assert status["names"]["away"]["share"] == 1.0


def test_generic_names_ignore_branding_and_period_tokens():
    # The league banner and the quarter marker share the graphic; neither may
    # join a name or become one.
    teams, _ = parse_generic_scorebug_names(bb_frames(30, extra=["TÜRKİYE BASKETBOL LİGİ", "1.Ç"]), "basketball")
    assert [t.name for t in teams] == ["Denizli Basket", "Samsunspor"]
    banner, _ = parse_generic_scorebug_names(bb_frames(30, line="TÜRKİYE BASKETBOL LİGİ 11 - 8 1.Ç"), "basketball")
    assert banner == []


def test_generic_names_need_frames_not_a_single_read():
    # Parent AC6: an over-eager wrong club is worse than `unknown`. One or two
    # frames of a score-shaped line is not corroboration.
    for n in (1, 2):
        teams, status = parse_generic_scorebug_names(bb_frames(n), "basketball")
        assert teams == []
        assert any("unstable" in r for r in status["rejected"])


def test_generic_names_need_both_sides():
    # A cropped / partially-read scorebug must not publish a half pair.
    teams, status = parse_generic_scorebug_names(bb_frames(30, line="12 - 8 Samsunspor"), "basketball")
    assert teams == []
    assert status["rejected"] == ["home:no-text"]
    teams, status = parse_generic_scorebug_names(bb_frames(30, line="Denizli Basket 12 - 8"), "basketball")
    assert teams == []


def test_generic_names_are_voided_when_the_text_is_unstable():
    # No single printed string holds the frame majority: an OCR/adboard drift is
    # not a scorebug name plate (share < GENERIC_NAME_MIN_SHARE).
    names = ["Denizli Basket", "Merkezefendi", "Belediye Spor"]
    frames = [
        {"lines": [f"{names[i % 3]} 11 - 8 Samsunspor" if i % 2 else f"{names[i % 3]} 11 - 8 Bursa"]}
        for i in range(30)
    ]
    teams, status = parse_generic_scorebug_names(frames, "basketball")
    assert teams == []
    assert any("unstable" in r for r in status["rejected"])


def test_generic_names_take_the_frame_majority_when_one_read_dominates():
    # A minority of misreads is normal OCR noise as long as one printed form
    # holds the majority: 24/30 reads of the same plate, 6 garbage frames.
    frames = bb_frames(30)
    for i in range(6):
        frames[i]["lines"] = [f"Garbled{i} 11 - 8 Nonsense"]
    teams, _ = parse_generic_scorebug_names(frames, "basketball")
    assert [t.name for t in teams] == ["Denizli Basket", "Samsunspor"]


def test_generic_names_do_not_apply_when_the_lexicon_named_a_side():
    # The channel only runs where the closed lexicon resolved NOTHING, so the
    # Portugal v Spain class keeps its exact shipped behaviour.
    frames = [{"ts": 1.0, "lines": ["POR 0 - 0 ESP"]} for _ in range(30)]
    out = resolve_match_context(sport_hint="soccer", ocr_frames=frames)
    ctx = out["matchContext"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [("Portugal", "home"), ("Spain", "away")]
    assert "genericNameCandidates" not in out["evidenceStatus"]

    # Mixed: one canonical side + generic text on the other stays strict (the
    # free side is not filled from an unlexiconed read).
    mixed = [{"ts": 1.0, "lines": ["POR 0 - 0 Samsunspor"]} for _ in range(30)]
    out = resolve_match_context(sport_hint="soccer", ocr_frames=mixed)
    names = [(t["name"], t["side"]) for t in out["matchContext"]["teams"]]
    assert ("Samsunspor", "away") not in names
    assert "genericNameCandidates" not in out["evidenceStatus"]


def test_resolver_publishes_generic_basketball_names_with_sides():
    out = resolve_match_context(sport_hint="basketball", ocr_frames=bb_frames(30, extra=BB_LINES[0:1] + ["1.Ç"]))
    ctx = out["matchContext"]
    assert ctx["sport"] == "basketball"
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [("Denizli Basket", "home"), ("Samsunspor", "away")]
    assert ctx["ambiguous"] is False
    # No threshold was lowered: a single (scorebug) source stays capped.
    assert all(t["confidence"] <= SINGLE_SOURCE_CAP for t in ctx["teams"])
    assert ctx["teams"][0]["evidence"][0]["source"] == "scorebug_ocr"
    assert out["evidenceStatus"]["genericNameCandidates"]["scoreFrames"] == 30


def test_resolver_keeps_unknown_when_generic_gate_fails():
    out = resolve_match_context(sport_hint="basketball", ocr_frames=bb_frames(2))
    ctx = out["matchContext"]
    assert [t["name"] for t in ctx["teams"]] == ["unknown", "unknown"]
    assert ctx["ambiguous"] is True
    assert out["evidenceStatus"]["genericNameCandidates"]["rejected"]


# Lexicon normalisation ---------------------------------------------------


def test_resolve_token_codes_aliases_and_demonyms():
    assert resolve_token("POR", "soccer")[0].name == "Portugal"
    assert resolve_token("spanish", "soccer")[0].name == "Spain"
    assert resolve_token("the Germans", "soccer")[0].name == "Germany"
    assert resolve_token("madrid", "soccer")[0].name == "Real Madrid"
    assert resolve_token("barca", "soccer")[0].name == "Barcelona"
    assert resolve_token("LAL", "basketball")[0].name == "Los Angeles Lakers"
    assert resolve_token("warriors", "basketball")[0].name == "Golden State Warriors"


def test_resolve_token_rejects_ambiguity_and_short_fuzzy_matches():
    # 'giants' exists in NFL and MLB but the lexicon is sport-scoped, so within
    # one sport it stays unique; a genuinely ambiguous alias is dropped.
    assert resolve_token("giants", "american_football")[0].name == "New York Giants"
    assert resolve_token("giants", "baseball")[0].name == "San Francisco Giants"
    # Too short to fuzzy-match: never a guess.
    assert resolve_token("PORL", "soccer") is None
    assert resolve_token("zzzz", "soccer") is None


def test_resolve_token_fuzzy_match_is_unique_and_flagged():
    hit = resolve_token("Portgual", "soccer")
    assert hit is not None
    assert hit[0].name == "Portugal"
    assert hit[1] is True


# Commentary probe (Stage 2) ---------------------------------------------


def test_scan_commentary_attaches_kit_colour_to_a_single_named_team():
    mentions = scan_commentary("Spain in the white shirts are pressing high.", "soccer")
    assert [(m.name, m.kit_color) for m in mentions] == [("Spain", "white")]


def test_scan_commentary_resolves_demonyms():
    mentions = scan_commentary("The Germans counter quickly through midfield.", "soccer")
    assert [m.name for m in mentions] == ["Germany"]


def test_scan_commentary_does_not_attribute_a_colour_with_two_teams_in_clause():
    mentions = scan_commentary("Portugal in red and Spain in white trade chances.", "soccer")
    assert {m.name for m in mentions} == {"Portugal", "Spain"}
    assert all(m.kit_color is None for m in mentions)


def test_scan_commentary_empty_and_unmapped_sport():
    assert scan_commentary("", "soccer") == []
    assert scan_commentary("Spain in white", SPORT_UNKNOWN) == []


# Metadata hint (Stage 0) -------------------------------------------------


def test_parse_metadata_hints_normalizes_filename_separators():
    hints = {"filename": "Portugal_vs_Spain_2018_goal1_1-0_Ronaldo_pen.mp4"}
    teams = parse_metadata_hints(hints, "soccer")
    assert [(t.name, t.side) for t in teams][:2] == [("Portugal", "home"), ("Spain", "away")]


def test_parse_metadata_hints_vs_shape_gives_sides_but_cannot_carry_alone():
    hints = {"title": "Portugal vs Spain", "gameHint": "soccer"}
    teams = parse_metadata_hints(hints, "soccer")
    assert [(t.name, t.side) for t in teams][:2] == [("Portugal", "home"), ("Spain", "away")]
    cands = fold_confidence([], [], teams)
    assert all(c.confidence <= SINGLE_SOURCE_CAP for c in cands)
    assert all(c.confidence < USABLE_CONFIDENCE for c in cands)


# Kit colours (Stage 3) ---------------------------------------------------


def test_name_color_human_vocabulary():
    assert name_color(RED) == "red"
    assert name_color(WHITE) == "white"
    assert name_color(NAVY) == "navy"
    assert name_color([250.0, 240.0, 40.0]) == "yellow"
    assert name_color([250.0, 200.0, 40.0]) == "gold"
    assert name_color([10.0, 10.0, 10.0]) == "black"
    assert name_color([128.0, 128.0, 130.0]) == "grey"


def test_cluster_kit_colors_two_distinct_kits_need_two_frames():
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    assert {c.primary for c in clusters} == {"red", "white"}
    assert all(c.frames >= 2 for c in clusters)


def test_cluster_kit_colors_single_frame_is_not_a_kit():
    assert cluster_kit_colors(kit_samples([RED], frames=1)) == []


def test_cluster_kit_colors_filters_pitch_green():
    samples = kit_samples([RED, GREEN_PITCH], frames=3)
    clusters = cluster_kit_colors(samples)
    assert {c.primary for c in clusters} == {"red"}


def test_cluster_kit_colors_names_the_centroid_not_the_noisiest_crop():
    # Measured on the cited job: distant crops inside one kit cluster read
    # "orange" (skin/warm shading) 94 times against "red" 46, so a majority vote
    # named the cluster WRONG. The centroid of the same shirts is red.
    samples = []
    for i, rgb in enumerate(
        [[83.0, 60.0, 47.0]] * 4 + [[83.0, 40.0, 47.0]] * 2 + [[236.0, 236.0, 232.0]] * 3
    ):
        samples.append({"rgb": rgb, "ts": 10.0 + i, "trackId": f"t{i}", "frameSeq": i})
    clusters = cluster_kit_colors(samples)
    assert "red" in {c.primary for c in clusters}
    assert "orange" not in {c.primary for c in clusters}


def test_cluster_kit_colors_reports_secondary_trim():
    samples = kit_samples([RED, WHITE], frames=3)
    clusters = cluster_kit_colors(samples)
    red = next(c for c in clusters if c.primary == "red")
    # The white cluster is a separate kit, not red's secondary; a lone colour
    # cluster has no secondary.
    assert red.secondary is None


def test_sample_track_colors_averages_torso_and_skips_non_players():
    # 12x12 frame: left half red-ish shirt, right half pitch green.
    frame = []
    for y in range(12):
        row = []
        for x in range(12):
            row.append(RED[:] if x < 6 and 4 <= y <= 8 else GREEN_PITCH[:])
        frame.append(row)
    tracks = [
        {"trackId": 1, "label": "player", "box": [0.05, 0.2, 0.45, 0.9], "ts": 3.0},
        {"trackId": 2, "label": "soccer ball", "box": [0.6, 0.6, 0.7, 0.7], "ts": 3.0},
    ]
    samples = sample_track_colors(frame, tracks)
    assert len(samples) == 1
    assert samples[0]["trackId"] == 1
    assert name_color(samples[0]["rgb"]) == "red"


def test_is_plausible_player_box_rejects_junk_sam3_seeds():
    # A standing player box: taller than wide, modest area.
    assert is_plausible_player_box((0.40, 0.30, 0.46, 0.55)) is True
    # Measured junk seed on the cited Portugal vs Spain job: a 0.997-wide
    # advertising band across the top of the frame.
    assert is_plausible_player_box((0.0, 0.0, 0.997, 0.242)) is False
    # A near-full-frame "player" crop (close-up / banner) is not a torso.
    assert is_plausible_player_box((0.02, 0.02, 0.98, 0.98)) is False
    # A boot / leg crop: wider than tall.
    assert is_plausible_player_box((0.50, 0.80, 0.62, 0.83)) is False
    # Degenerate boxes never qualify.
    assert is_plausible_player_box(None) is False
    assert is_plausible_player_box([0.1, 0.1]) is False
    assert is_plausible_player_box((0.4, 0.4, 0.4, 0.6)) is False


def test_sample_track_colors_never_samples_a_junk_seed():
    # Frame is entirely jersey-red; the ONLY track is the measured ad-board band.
    # Before ADAAAA-7859 the sampler read that band and made "red" a kit colour
    # from a non-player crop; now the frame yields no sample at all.
    frame = [[RED[:] for _ in range(12)] for _ in range(12)]
    tracks = [{"trackId": "band", "label": "player", "box": [0.0, 0.0, 0.997, 0.242], "ts": 3.0}]
    assert sample_track_colors(frame, tracks) == []


def test_sample_track_colors_skips_the_band_and_keeps_the_player():
    # 40x40 frame: pitch green everywhere, a WHITE advertising band across the
    # top (the measured junk seed), and a RED-shirted player box below it. Only
    # the player contributes, so white never enters the kit evidence.
    frame = [[GREEN_PITCH[:] for _ in range(40)] for _ in range(40)]
    for y in range(0, 10):
        for x in range(40):
            frame[y][x] = WHITE[:]
    for y in range(8, 29):
        for x in range(14, 27):
            frame[y][x] = RED[:]
    tracks = [
        {"trackId": "band", "label": "player", "box": [0.0, 0.0, 0.997, 0.242], "ts": 3.0},
        {"trackId": "p1", "label": "player", "box": [0.35, 0.20, 0.65, 0.70], "ts": 3.0},
    ]
    samples = sample_track_colors(frame, tracks)
    assert [s["trackId"] for s in samples] == ["p1"]
    assert samples[0]["color"] == "red"


def test_associate_kits_prefers_scorebug_swatch_then_commentary():
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    teams = [{"name": "Portugal", "side": "home"}, {"name": "Spain", "side": "away"}]
    kits, ambiguous = associate_kits(
        teams,
        clusters,
        scorebug_swatches=[{"side": "home", "rgb": RED}, {"side": "away", "rgb": WHITE}],
    )
    assert kits["home"][0]["primary"] == "red"
    assert kits["away"][0]["primary"] == "white"
    assert ambiguous is False

    mentions = scan_commentary("Spain are wearing white today.", "soccer")
    kits2, _ = associate_kits(teams, clusters, scorebug_swatches=None, commentary=mentions)
    assert kits2["away"][0]["primary"] == "white"


def test_associate_kits_same_colour_away_kits_are_ambiguous():
    clusters = cluster_kit_colors(kit_samples([RED, [200.0, 40.0, 44.0]], frames=3))
    teams = [{"name": "Portugal", "side": "home"}, {"name": "Spain", "side": "away"}]
    kits, ambiguous = associate_kits(
        teams,
        clusters,
        scorebug_swatches=[{"side": "home", "rgb": RED}, {"side": "away", "rgb": WHITE}],
    )
    assert ambiguous is True


def test_associate_kits_drops_an_unstable_swatch_instead_of_a_wrong_colour():
    # Measured on the cited Portugal vs Spain job: a swatch half repeatedly reads
    # the LED advertising boards behind the bug. Pre-fix the LAST reading won, so
    # one unstable frame could paint a team with an ad-board colour. Here the home
    # half splits 2x red / 2x white (50 % modal share) while the away half stably
    # reads white: the unstable home side must yield NOTHING, and the stable away
    # side must still link, instead of the home side stealing the white kit.
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    teams = [{"name": "Portugal", "side": "home"}, {"name": "Spain", "side": "away"}]
    swatches = [
        {"side": "home", "rgb": RED, "color": "red"},
        {"side": "home", "rgb": RED, "color": "red"},
        {"side": "home", "rgb": WHITE, "color": "white"},
        {"side": "home", "rgb": WHITE, "color": "white"},
    ] + [{"side": "away", "rgb": WHITE, "color": "white"} for _ in range(3)]
    kits, _ = associate_kits(teams, clusters, scorebug_swatches=swatches)
    # RED at the pre-fix parent: `kits["home"][0]["primary"] == "white"` — the
    # unstable half's last reading painted Portugal with Spain's kit.
    assert "home" not in kits
    assert kits["away"][0]["primary"] == "white"


def test_stable_swatch_by_side_needs_agreement_once_a_side_repeats():
    from app.match_context import stable_swatch_by_side

    # A single reading is used as-is (nothing to disagree with).
    assert stable_swatch_by_side([{"side": "home", "rgb": RED}])["home"]["color"] == "red"
    # Two agreeing readings are stable; two disagreeing ones are not.
    assert set(stable_swatch_by_side([{"side": "home", "rgb": RED}] * 2)) == {"home"}
    assert stable_swatch_by_side([{"side": "home", "rgb": RED}, {"side": "home", "rgb": WHITE}]) == {}
    # 60 % share: 3 of 5 holds; a modal colour under 60 % does not.
    three = [{"side": "away", "rgb": NAVY}] * 3 + [{"side": "away", "rgb": WHITE}] * 2
    assert stable_swatch_by_side(three)["away"]["color"] == "navy"
    split = (
        [{"side": "away", "rgb": NAVY}] * 2
        + [{"side": "away", "rgb": WHITE}] * 2
        + [{"side": "away", "rgb": [200.0, 110.0, 40.0]}] * 1
    )
    assert stable_swatch_by_side(split) == {}


def test_associate_kits_never_assigns_one_cluster_to_both_sides():
    # Both scorebug swatches land nearest the SAME cluster (measured on the cited
    # job where both halves carried the same red flag): the second side must stay
    # unattributed instead of getting the other team's kit.
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    teams = [{"name": "Portugal", "side": "home"}, {"name": "Spain", "side": "away"}]
    kits, _ = associate_kits(
        teams,
        clusters,
        # Different swatch COLOUR NAMES (so the shared-graphic guard does not fire)
        # but both land nearest the same red cluster.
        scorebug_swatches=[
            {"side": "home", "rgb": RED, "color": "red"},
            {"side": "away", "rgb": [160.0, 25.0, 30.0], "color": "maroon"},
        ],
    )
    assert list(kits) == ["home"]


def test_associate_kits_ignores_shared_graphics_from_identical_swatch_colours():
    # A score bug over grass resolves both halves to the same "orange"/"green"
    # pixel average; that is a shared graphic, never a pair of kit colours.
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    teams = [{"name": "Portugal", "side": "home"}, {"name": "Spain", "side": "away"}]
    kits, _ = associate_kits(
        teams,
        clusters,
        scorebug_swatches=[
            {"side": "home", "rgb": [121.9, 98.2, 71.9], "color": "orange"},
            {"side": "away", "rgb": [121.6, 98.8, 70.1], "color": "orange"},
        ],
    )
    assert kits == {}


def test_associate_kits_no_evidence_leaves_kit_empty_never_a_guess():
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    teams = [{"name": "Portugal", "side": "home"}]
    kits, ambiguous = associate_kits(teams, clusters, scorebug_swatches=None, commentary=[])
    assert kits == {}
    assert ambiguous is False


# Confidence fold (Stage 4) -----------------------------------------------


def test_fold_confidence_single_source_stays_below_usable():
    cands = fold_confidence(parse_ocr_teams(["POR 1 - 0 ESP"], "soccer"), [], [])
    assert all(c.confidence == 0.5 for c in cands)
    assert all(c.confidence < USABLE_CONFIDENCE for c in cands)


def test_fold_confidence_two_sources_cross_the_usable_threshold():
    scorebug = parse_ocr_teams(["POR 1 - 0 ESP"], "soccer")
    metadata = parse_metadata_hints({"title": "Portugal vs Spain"}, "soccer")
    cands = fold_confidence(scorebug, [], metadata)
    by_name = {c.name: c for c in cands}
    assert by_name["Portugal"].confidence == 0.65  # 0.5 + 0.15
    assert by_name["Portugal"].confidence >= USABLE_CONFIDENCE
    assert by_name["Portugal"].independent_sources == 2


def test_fold_confidence_all_three_sources_and_repeat_does_not_double_count():
    scorebug = parse_ocr_teams(["POR 1 - 0 ESP"], "soccer")
    commentary = scan_commentary("Portugal and Spain trade chances.", "soccer")
    metadata = parse_metadata_hints({"title": "Portugal vs Spain"}, "soccer")
    cands = fold_confidence(scorebug, commentary, metadata)
    by_name = {c.name: c for c in cands}
    assert by_name["Portugal"].confidence == 0.95  # capped
    assert by_name["Portugal"].independent_sources == 3


def test_fold_confidence_fuzzy_only_source_is_discounted():
    fuzzy = parse_ocr_teams(["Portgual 1 - 0 Spian"], "soccer")
    assert fuzzy, "fuzzy tokens should still resolve"
    cands = fold_confidence(fuzzy, [], [])
    assert all(c.confidence < 0.5 for c in cands)


# Monotonic guard (AC4) ---------------------------------------------------


def _ctx(names_and_conf, sport="soccer"):
    teams = []
    for side, name, conf, sources in names_and_conf:
        teams.append(
            {
                "name": name,
                "side": side,
                "kitColors": [],
                "confidence": conf,
                "evidence": [{"source": s, "snippet": s} for s in sources],
            }
        )
    return {"sport": sport, "teams": teams, "trail": [], "ambiguous": False}


def test_monotonic_guard_keeps_a_confident_team_against_weak_contradiction():
    previous = _ctx([("home", "Portugal", 0.65, ["scorebug_ocr", "metadata"])])
    weak = fold_confidence(parse_ocr_teams(["ESP 1 - 0 POR"], "soccer"), [], [])
    merged = apply_monotonic_guard(previous, weak, progress_pct=25.0)
    home = next(t for t in merged["teams"] if t["side"] == "home")
    assert home["name"] == "Portugal"
    assert merged["trail"][-1]["action"] == ["kept Portugal at home"]


def test_monotonic_guard_allows_a_flip_only_with_margin_and_two_sources():
    previous = _ctx([("home", "Portugal", 0.65, ["scorebug_ocr", "metadata"])])
    scorebug = parse_ocr_teams(["ESP 1 - 0 POR"], "soccer")
    commentary = scan_commentary("Spain are dominating this half.", "soccer")
    metadata = parse_metadata_hints({"title": "Spain vs Portugal"}, "soccer")
    strong = fold_confidence(scorebug, commentary, metadata)
    merged = apply_monotonic_guard(previous, strong, progress_pct=50.0)
    home = next(t for t in merged["teams"] if t["side"] == "home")
    assert home["name"] == "Spain"
    assert home["confidence"] >= 0.65 + FLIP_MARGIN
    assert any("flipped Portugal -> Spain" in a for a in merged["trail"][-1]["action"])


def test_monotonic_guard_does_not_paint_the_kept_team_with_the_rival_kit():
    # A reversed scorebug read ("ESP 1-0 POR") makes Spain the home candidate with
    # Spain's kit colours; the guard keeps Portugal at home and must NOT give it
    # the candidate's colour.
    previous = _ctx([("home", "Portugal", 0.65, ["scorebug_ocr", "metadata"])])
    scorebug = parse_ocr_teams(["ESP 1 - 0 POR"], "soccer")
    cands = fold_confidence(scorebug, [], parse_metadata_hints({"title": "Portugal vs Spain"}, "soccer"))
    merged = apply_monotonic_guard(previous, cands, kits={"home": [{"primary": "white"}]}, progress_pct=50.0)
    home = next(t for t in merged["teams"] if t["side"] == "home")
    assert home["name"] == "Portugal"
    assert home["kitColors"] == []


def test_monotonic_guard_drops_a_stored_colour_the_new_pass_did_not_observe():
    # Measured on e397b7e7: the record stored home `black`/away `orange` from the
    # pre-fix sampler. A re-check that now observes `red`/`green` must DROP the
    # stored away colour instead of carrying it forward — otherwise a wrong colour
    # survives every later re-check forever. A stored colour the pass DOES observe
    # is still preserved (a thinner re-check must not erase measured evidence).
    previous = _ctx([("away", "Spain", 0.95, ["scorebug_ocr", "asr", "metadata"])])
    previous["teams"][0]["kitColors"] = [{"primary": "orange", "secondary": "black"}]
    cands = fold_confidence(
        parse_ocr_teams(["POR 1 - 0 ESP"], "soccer"), [], parse_metadata_hints({"title": "Portugal vs Spain"}, "soccer")
    )
    merged = apply_monotonic_guard(previous, cands, observed_clusters=["red", "green"], progress_pct=50.0)
    away = next(t for t in merged["teams"] if t["side"] == "away")
    assert away["kitColors"] == []
    # The same stored colour observed again survives the re-check.
    previous["teams"][0]["kitColors"] = [{"primary": "white"}]
    merged2 = apply_monotonic_guard(previous, cands, observed_clusters=["red", "white"], progress_pct=50.0)
    away2 = next(t for t in merged2["teams"] if t["side"] == "away")
    assert away2["kitColors"] == [{"primary": "white"}]


def test_monotonic_guard_raises_confidence_without_changing_the_name():
    previous = _ctx([("home", "Portugal", 0.65, ["scorebug_ocr", "metadata"])])
    scorebug = parse_ocr_teams(["POR 1 - 0 ESP"], "soccer")
    commentary = scan_commentary("Portugal are pressing.", "soccer")
    merged = apply_monotonic_guard(previous, fold_confidence(scorebug, commentary, []), progress_pct=25.0)
    home = next(t for t in merged["teams"] if t["side"] == "home")
    assert home["name"] == "Portugal"
    assert home["confidence"] > 0.65


def test_trail_is_bounded():
    previous = _ctx([("home", "Portugal", 0.65, ["scorebug_ocr"])])
    previous["trail"] = [{"at": "x", "progressPct": i, "names": [], "action": []} for i in range(50)]
    merged = apply_monotonic_guard(
        previous, fold_confidence(parse_ocr_teams(["POR 1 - 0 ESP"], "soccer"), [], []), progress_pct=10.0
    )
    assert len(merged["trail"]) <= 12


# End-to-end resolver -----------------------------------------------------


def test_resolve_match_context_portugal_spain_with_kit_colours():
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 12.0, "lines": ["POR 1 - 0 ESP"]}],
        transcript="Spain in the white shirts are pressing; Portugal break quickly.",
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
        scorebug_swatches=[{"side": "home", "rgb": RED}, {"side": "away", "rgb": WHITE}],
        progress_pct=0.0,
    )
    ctx = out["matchContext"]
    assert ctx["sport"] == "soccer"
    assert ctx["resolverVersion"] == RESOLVER_VERSION
    by_side = {t["side"]: t for t in ctx["teams"]}
    assert by_side["home"]["name"] == "Portugal"
    assert by_side["away"]["name"] == "Spain"
    assert by_side["home"]["kitColors"][0]["primary"] == "red"
    assert by_side["away"]["kitColors"][0]["primary"] == "white"
    assert by_side["home"]["confidence"] >= USABLE_CONFIDENCE
    assert ctx["ambiguous"] is False
    assert ctx["trail"] and ctx["trail"][-1]["progressPct"] == 0.0
    assert all(t["evidence"] for t in ctx["teams"])


def test_resolve_match_context_suppresses_unattributed_candidates():
    # Commentary mentions a club and a stray fuzzy token; they must not become
    # teams on the record once the scorebug gives a concrete home/away pair.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["POR 1 - 0 ESP"]}],
        transcript="Real Madrid's new coach watches on. Portugal press.",
        hints={"title": "Portugal vs Spain"},
    )
    ctx = out["matchContext"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [("Portugal", "home"), ("Spain", "away")]
    assert "Real Madrid" in out["evidenceStatus"]["suppressedCandidates"]
    assert ctx["ambiguous"] is False


def test_resolve_match_context_reports_unattributed_kit_colours():
    # Only a red cluster is observed, so the away side's white shirt has no
    # cluster to link to: the curated prior misses (ADAAAA-7866) and the resolver
    # keeps reporting the unattributed side instead of guessing a colour.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["POR 1 - 0 ESP"]}],
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([RED], frames=3),
        scorebug_swatches=[{"side": "home", "rgb": RED, "color": "red"}],
    )
    assert out["matchContext"]["teams"][0]["kitColors"][0]["primary"] == "red"
    assert out["evidenceStatus"]["kitColorsUnattributed"] == ["away"]
    assert out["evidenceStatus"]["kitPriorMiss"] == ["away"]


def test_resolve_match_context_reports_observed_clusters_without_a_side_channel():
    # The ADAAAA-7859 evidence shape: two kit colours OBSERVED, no MEASURED side
    # channel (no swatch, no kit phrase) to link either to a team. The record must
    # keep both teams' kitColors empty and report what was seen instead of guessing.
    #
    # The teams are France / Italy on purpose: the curated prior table
    # (ADAAAA-7866) IS a third side channel, and it only carries Portugal and
    # Spain. Using two teams the table cannot resolve keeps this guard about the
    # evidenceStatus report rather than about the prior.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["FRA 1 - 0 ITA"]}],
        hints={"title": "France vs Italy"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
    )
    status = out["evidenceStatus"]
    assert set(status["kitClusterColors"]) == {"red", "white"}
    assert status["kitSampleFrames"] == 3
    assert status["kitSampleTracks"] == 2
    assert status["kitColorsUnattributed"] == ["home", "away"]
    assert status["kitPriorMiss"] == ["home", "away"]
    assert all(t["kitColors"] == [] for t in out["matchContext"]["teams"])


def test_resolve_match_context_no_evidence_is_unknown_not_fabricated():
    out = resolve_match_context(game_hint="soccer", progress_pct=0.0)
    ctx = out["matchContext"]
    assert {t["name"] for t in ctx["teams"]} == {"unknown"}
    assert {t["confidence"] for t in ctx["teams"]} == {0.0}
    assert ctx["ambiguous"] is True
    assert "scorebug_ocr:not_captured" in out["evidenceStatus"]["sources"]
    assert "asr:not_captured" in out["evidenceStatus"]["sources"]


def test_resolve_match_context_unmapped_sport_keeps_unknown_sport():
    out = resolve_match_context(game_hint="tennis", ocr_frames=[{"ts": 1.0, "lines": ["POR 1 - 0 ESP"]}])
    assert out["matchContext"]["sport"] == SPORT_UNKNOWN
    assert {t["name"] for t in out["matchContext"]["teams"]} == {"unknown"}


def test_resolve_match_context_recheck_does_not_flip_a_confident_team():
    first = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["POR 1 - 0 ESP"]}],
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
        scorebug_swatches=[{"side": "home", "rgb": RED}, {"side": "away", "rgb": WHITE}],
    )["matchContext"]
    assert first["teams"][0]["confidence"] >= USABLE_CONFIDENCE

    second = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 30.0, "lines": ["ESP 0 - 0 POR"]}],
        hints={"title": "Portugal vs Spain"},
        previous=first,
        progress_pct=25.0,
    )["matchContext"]
    names = {(t["side"], t["name"]) for t in second["teams"]}
    assert ("home", "Portugal") in names and ("away", "Spain") in names
    assert len(second["trail"]) == 2
    assert "kept Portugal at home" in second["trail"][-1]["action"]


def test_build_match_context_contract_shape():
    ctx = build_match_context(
        "soccer",
        [
            {
                "name": "Portugal",
                "side": "home",
                "kitColors": [{"primary": "red", "secondary": "green"}],
                "confidence": 0.82,
                "evidence": [{"source": "scorebug_ocr", "snippet": "POR 1 - 0 ESP"}],
            }
        ],
        ambiguous=False,
        trail=[],
    )
    assert set(ctx) == {"sport", "teams", "inferredAt", "resolverVersion", "ambiguous", "trail"}
    assert set(ctx["teams"][0]) == {"name", "side", "kitColors", "confidence", "evidence"}
    assert ctx["teams"][0]["kitColors"] == [{"primary": "red", "secondary": "green"}]
    assert ctx["inferredAt"].endswith("Z")


# Kit-colour prior, third side-attribution channel (ADAAAA-7866) ----------

# The stored evidence of job dee44c2f both measured channels left unanswered
# (ADAAAA-7859 artifact): clusters ["white", "red"], only the home scorebug
# swatch is stable (red, 91 % modal share), zero commentary kit phrases.
_PALETTE_RGB = {
    "red": RED,
    "white": WHITE,
    "navy": NAVY,
    "black": [18.0, 18.0, 18.0],
    "green": [30.0, 110.0, 40.0],
    "yellow": [230.0, 220.0, 40.0],
    "maroon": [110.0, 24.0, 30.0],
    "sky blue": [120.0, 190.0, 230.0],
}
_PRIOR_TEAMS = [
    {"name": "Portugal", "side": "home"},
    {"name": "Spain", "side": "away"},
]


def _mk_clusters(colors):
    """Clusters with palette RGB support (no sampling, no GPU)."""
    return [
        KitCluster(
            primary=c,
            secondary=None,
            rgb=list(_PALETTE_RGB.get(c, [0.0, 0.0, 0.0])),
            frames=4,
            count=40 - 2 * i,
        )
        for i, c in enumerate(colors)
    ]


def test_kit_prior_completes_ac3_on_the_cited_job_stored_evidence():
    # AC-P1: replay of dee44c2f from its own stored evidence — swatch decides
    # home, the prior links the observed white cluster to away. The RGB of the
    # white cluster is inert here (no swatch reads it); the published colour is
    # the CLUSTER's stored name, never a value the prior supplies.
    clusters = [
        KitCluster(primary="white", secondary=None, rgb=[236.0, 236.0, 232.0], frames=112, count=140),
        KitCluster(primary="red", secondary="orange", rgb=[138.9, 27.2, 34.4], frames=112, count=112),
    ]
    status: dict = {}
    kits, ambiguous = associate_kits(
        _PRIOR_TEAMS,
        clusters,
        scorebug_swatches=[{"side": "home", "rgb": [138.9, 27.2, 34.4], "color": "red"}],
        commentary=None,
        kit_prior=_SOCCER_KIT_PRIORS,
        status=status,
    )
    assert kits["home"] == [{"primary": "red", "secondary": "orange"}]
    assert kits["away"] == [{"primary": "white"}]
    assert ambiguous is False
    assert status["kitPriorUsed"] == ["away"]
    assert status["kitPriorMiss"] == []
    assert status["kitPriorConflict"] == []

    # The table alone (no measured channel) also separates this job's clusters.
    solo, solo_ambiguous = associate_kits(_PRIOR_TEAMS, clusters, kit_prior=_SOCCER_KIT_PRIORS, status={})
    assert solo["home"][0]["primary"] == "red"
    assert solo["away"][0]["primary"] == "white"
    assert solo_ambiguous is False


def test_resolve_match_context_prior_fills_the_unattributed_side():
    # AC-P1/AC-P8 through the shipped resolver path: status carries the three
    # prior fields beside kitColorsUnattributed.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["POR 1 - 0 ESP"]}],
        transcript="Portugal and Spain trade chances in a tense first half.",
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
        scorebug_swatches=[{"side": "home", "rgb": RED, "color": "red"}],
    )
    ctx = out["matchContext"]
    by_side = {t["side"]: t for t in ctx["teams"]}
    assert by_side["home"]["kitColors"][0]["primary"] == "red"
    assert by_side["away"]["kitColors"][0]["primary"] == "white"
    assert ctx["ambiguous"] is False
    status = out["evidenceStatus"]
    assert status["kitPriorUsed"] == ["away"]
    assert status["kitPriorMiss"] == []
    assert status["kitPriorConflict"] == []
    assert status["kitColorsUnattributed"] == []


def test_kit_prior_never_matches_on_the_secondary_trim():
    # R1: Spain's navy trim is not Spain's shirt. Matching it would hand Spain a
    # navy away shirt that belongs to the other side.
    clusters = _mk_clusters(["red", "navy"])
    priors = {"Portugal": ("red", "green"), "Spain": ("white", "navy")}
    status: dict = {}
    kits, ambiguous = associate_kits(_PRIOR_TEAMS, clusters, kit_prior=priors, status=status)
    assert kits == {}
    assert status["kitPriorMiss"] == ["away"]
    assert ambiguous is False


def test_kit_prior_never_invents_a_colour():
    # AC-P2: 1 200 randomised cluster/prior sets — every published colour is a
    # colour an observed cluster carries, no cluster is shared by two sides, and
    # a miss publishes nothing.
    rng = random.Random(7866)
    vocab = sorted(_KIT_COLOR_NAMES)
    names = ["Portugal", "Spain", "Real Madrid", "Liverpool"]
    priors = {
        "Portugal": ("red", "green"),
        "Spain": ("white", "navy"),
        "Real Madrid": ("white", "gold"),
    }
    checked = 0
    for _ in range(1200):
        colors = [rng.choice(vocab) for _ in range(rng.randint(0, 3))]
        clusters = _mk_clusters(colors)
        teams = [
            {"name": rng.choice(names), "side": "home"},
            {"name": rng.choice(names), "side": "away"},
        ]
        status: dict = {}
        kits, _ambiguous = associate_kits(teams, clusters, kit_prior=priors, status=status)
        observed = {c.primary for c in clusters}
        published = {kit[0]["primary"] for kit in kits.values()}
        assert published <= observed
        assert len(kits) <= len(clusters)
        # every published side is a side the prior actually decided
        assert set(kits) == set(status["kitPriorUsed"])
        # a miss (or a conflict) voids the pass: nothing published at all
        if status["kitPriorMiss"] or status["kitPriorConflict"]:
            assert kits == {}
        checked += 1
    assert checked == 1200


def test_kit_prior_only_adds_never_overrides_a_measured_channel():
    # AC-P3: differential sweep, prior disabled vs enabled.
    rng = random.Random(7859)
    vocab = sorted(_KIT_COLOR_NAMES)
    diffs = 0
    for _ in range(1200):
        colors = [rng.choice(vocab) for _ in range(rng.randint(1, 2))]
        clusters = _mk_clusters(colors)
        teams = [
            {"name": rng.choice(["Portugal", "Spain", "Real Madrid"]), "side": "home"},
            {"name": rng.choice(["Portugal", "Spain", "Liverpool"]), "side": "away"},
        ]
        swatches = []
        if rng.random() < 0.4:
            side = rng.choice(["home", "away"])
            idx = rng.randrange(len(clusters))
            swatches.append({"side": side, "rgb": list(clusters[idx].rgb), "color": clusters[idx].primary})
        off, off_ambiguous = associate_kits(teams, clusters, scorebug_swatches=swatches)
        status: dict = {}
        on, on_ambiguous = associate_kits(teams, clusters, scorebug_swatches=swatches, kit_prior=_SOCCER_KIT_PRIORS, status=status)
        for side, kit in off.items():
            assert on[side] == kit
        # disabling the prior reproduces the shipped behaviour exactly
        assert off_ambiguous is on_ambiguous or on_ambiguous is True
        if set(on) != set(off):
            diffs += 1
    assert diffs > 0  # the channel does add attributions where the record was empty


def test_kit_prior_does_not_redecide_a_swatch_attributed_side():
    # AC-P4, ordering case 1: stable scorebug swatch wins, the prior only plants
    # the side the swatch did not decide.
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    status: dict = {}
    kits, _ambiguous = associate_kits(
        _PRIOR_TEAMS,
        clusters,
        scorebug_swatches=[{"side": "home", "rgb": RED, "color": "red"}],
        kit_prior=_SOCCER_KIT_PRIORS,
        status=status,
    )
    assert kits["home"] == [{"primary": "red"}]
    assert kits["away"] == [{"primary": "white"}]
    assert status["kitPriorUsed"] == ["away"]


def test_kit_prior_does_not_redecide_a_commentary_attributed_side():
    # AC-P4, ordering case 2: the commentary phrase wins; the prior fills home.
    clusters = cluster_kit_colors(kit_samples([RED, WHITE], frames=3))
    mentions = scan_commentary("Spain are wearing white today.", "soccer")
    status: dict = {}
    kits, _ambiguous = associate_kits(
        _PRIOR_TEAMS,
        clusters,
        commentary=mentions,
        kit_prior=_SOCCER_KIT_PRIORS,
        status=status,
    )
    assert kits["away"] == [{"primary": "white"}]
    assert kits["home"] == [{"primary": "red"}]
    assert status["kitPriorUsed"] == ["home"]


def test_kit_prior_two_priors_on_one_cluster_is_a_conflict_not_a_guess():
    # AC-P5a: separation failed -> nothing published, ambiguous true, both sides
    # named. `ambiguous` keeps its shipped meaning (separation flag).
    clusters = _mk_clusters(["red"])
    priors = {"Portugal": ("red", None), "Liverpool": ("red", None)}
    status: dict = {}
    kits, ambiguous = associate_kits(
        [{"name": "Portugal", "side": "home"}, {"name": "Liverpool", "side": "away"}],
        clusters,
        kit_prior=priors,
        status=status,
    )
    assert kits == {}
    assert ambiguous is True
    assert status["kitPriorConflict"] == ["home", "away"]
    assert status["kitPriorMiss"] == []


def test_kit_prior_miss_names_every_unresolved_side():
    # AC-P5b: a miss publishes nothing for the unresolved sides and reports EVERY
    # side without a usable hit (not just the first). A miss is not ambiguity.
    clusters = _mk_clusters(["black"])
    status: dict = {}
    kits, ambiguous = associate_kits(_PRIOR_TEAMS, clusters, kit_prior=_SOCCER_KIT_PRIORS, status=status)
    assert kits == {}
    assert ambiguous is False
    assert status["kitPriorMiss"] == ["home", "away"]
    assert status["kitPriorConflict"] == []


def test_kit_prior_miss_leaves_kitColorsUnattributed_untouched():
    # AC-P5c through the resolver: a miss keeps the existing unattributed report
    # and does not flip `ambiguous`.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 5.0, "lines": ["POR 1 - 0 ESP"]}],
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([[24.0, 24.0, 26.0]], frames=3),
    )
    status = out["evidenceStatus"]
    assert out["matchContext"]["ambiguous"] is False
    assert status["kitPriorMiss"] == ["home", "away"]
    assert status["kitColorsUnattributed"] == ["home", "away"]
    assert all(t["kitColors"] == [] for t in out["matchContext"]["teams"])


def test_kit_prior_table_integrity():
    # AC-P6: canonical keys, name_color vocabulary, <= 2 colours per team.
    canonical = {row["name"] for row in TEAM_LEXICON["soccer"]}
    assert set(_SOCCER_KIT_PRIORS) <= canonical
    for entry in _SOCCER_KIT_PRIORS.values():
        assert isinstance(entry, tuple) and len(entry) == 2
        colours = [c for c in entry if c]
        assert len(colours) <= 2
        assert all(c in _KIT_COLOR_NAMES for c in colours)
    for sport, table in _KIT_PRIORS.items():
        assert sport in TEAM_LEXICON
        assert set(table) <= {row["name"] for row in TEAM_LEXICON[sport]}


def test_kit_prior_missing_entry_never_raises():
    # AC-P6: an unlisted team (a corpus club the table does not seed) is a miss,
    # not an exception and not a guess.
    clusters = _mk_clusters(["red"])
    status: dict = {}
    kits, ambiguous = associate_kits(
        [{"name": "Real Madrid", "side": "home"}],
        clusters,
        kit_prior=_SOCCER_KIT_PRIORS,
        status=status,
    )
    assert kits == {}
    assert ambiguous is False
    assert status["kitPriorMiss"] == ["home"]


def test_kit_prior_disabled_leaves_status_untouched():
    # The channel is opt-in per sport: without a table no prior field is written.
    clusters = _mk_clusters(["red", "white"])
    status = {"scorebugSwatches": 0}
    kits, ambiguous = associate_kits(_PRIOR_TEAMS, clusters, kit_prior=None, status=status)
    assert kits == {}
    assert ambiguous is False
    assert status == {"scorebugSwatches": 0}


# AC2 per-channel evidence (ADAAAA-7889) ----------------------------------
#
# The cited fresh job (a50a803e on /data/real_goal_3080.mp4) folded to
# `unknown` and the stored record could not say why: it reported 30 OCR frames
# and 3 suppressed candidates, but not that those 30 frames held ZERO team text
# (the crop read advertising boards), not the commentary snippets, and not the
# per-side folded confidence. These tests pin the diagnosis surface.

_MAN_CITY_OCR = [
    {"ts": 0.0, "lines": ["ETIHAD", "Fly to 100+ destinations."]},
    {"ts": 5.0, "lines": ["QNET TOGETHER WE RISE"]},
]
_MAN_CITY_TRANSCRIPT = (
    "The ball is played forward for Manchester City. Liverpool press high. "
    "Real Madrid come into the comparison."
)


def test_evidence_status_names_every_channel_on_an_unknown_job():
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=_MAN_CITY_OCR,
        transcript=_MAN_CITY_TRANSCRIPT,
        hints={"title": "Clinical finish and celebration", "filename": "real_goal_3080.mp4"},
        progress_pct=0.0,
    )
    ctx = out["matchContext"]
    status = out["evidenceStatus"]
    # Still honest: no invented team, no invented side.
    assert [(t["name"], t["confidence"]) for t in ctx["teams"]] == [("unknown", 0.0), ("unknown", 0.0)]
    assert ctx["ambiguous"] is True

    ocr = status["channelOutcomes"]["scorebug_ocr"]
    assert ocr["frames"] == 2
    assert ocr["lines"] == 3
    assert ocr["teamLines"] == 0, "ad-board text carries no team token"
    assert ocr["teams"] == []
    assert ocr["rawLines"][0] == "ETIHAD", "the raw OCR line must be inspectable"

    asr = status["channelOutcomes"]["asr"]
    assert asr["chars"] == len(_MAN_CITY_TRANSCRIPT)
    names = [m["name"] for m in asr["mentions"]]
    assert names == ["Manchester City", "Liverpool", "Real Madrid"]
    for mention in asr["mentions"]:
        assert mention["snippet"]
        assert isinstance(mention["start"], int) and isinstance(mention["end"], int)
        assert (_MAN_CITY_TRANSCRIPT[mention["start"] : mention["end"]]).strip() == mention["snippet"]

    meta = status["channelOutcomes"]["metadata"]
    # No Finland: "finish" is one edit from the demonym "Finnish". ("Real Madrid"
    # from the filename token "real" is a pre-existing lexicon alias, reported
    # with its field so its weight is inspectable.)
    meta_names = [c["name"] for c in meta["candidates"]]
    assert "Finland" not in meta_names
    assert all(c["field"] in ("title", "filename", "gameHint") for c in meta["candidates"])

    fold = status["channelOutcomes"]["fold"]
    assert fold["usableConfidence"] == USABLE_CONFIDENCE
    assert fold["home"] is None and fold["away"] is None
    assert "3 mentions" in status["unknownReason"]
    assert "2 frames" in status["unknownReason"] and "3 OCR lines" in status["unknownReason"]
    assert "usable 0.6" in status["unknownReason"]


def test_evidence_status_names_the_scorebug_line_that_did_resolve():
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 12.0, "lines": ["POR 1 - 1 ESP25:13FIFA.com/soccer"]}],
        transcript="Portugal break quickly.",
        hints={"title": "Portugal vs Spain"},
        progress_pct=0.0,
    )
    teams = {t["side"]: t["name"] for t in out["matchContext"]["teams"]}
    assert teams == {"home": "Portugal", "away": "Spain"}
    ocr = out["evidenceStatus"]["channelOutcomes"]["scorebug_ocr"]
    assert ocr["lines"] == 1 and ocr["teamLines"] == 1
    assert ocr["rawLines"] == ["POR 1 - 1 ESP25:13FIFA.com/soccer"]
    assert {"name": "Portugal", "side": "home"} in ocr["teams"]
    assert "unknownReason" not in out["evidenceStatus"]


def test_metadata_hint_never_fuzzy_matches_an_english_word():
    # Measured false positive (ADAAAA-7889): the auto-generated title
    # "Clinical finish and celebration" fuzzy-resolved to Finland through the
    # demonym "finnish". Metadata is typed text, so it resolves EXACT tokens only.
    assert parse_metadata_hints({"title": "Clinical finish and celebration"}, "soccer") == []
    assert parse_metadata_hints({"title": "A clinical finish and a final whistle"}, "soccer") == []
    # ...while exact names in any field still resolve, with the field recorded.
    exact = parse_metadata_hints({"title": "Haaland scores against Liverpool"}, "soccer")
    assert [(t.name, t.side, t.field) for t in exact] == [("Liverpool", "away", "title")]


def test_metadata_cannot_pair_complete_onto_a_wrong_finland_team():
    # The wrong-team path the FP could reach: one concrete scorebug side plus a
    # fuzzy metadata candidate for the free side. The exact-only metadata rule
    # means "finish" never creates the candidate, so the pass cannot publish it.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 1.0, "lines": ["POR 0 - 0"]}],
        hints={"title": "Clinical finish and celebration"},
    )
    assert [(t["name"], t["side"]) for t in out["matchContext"]["teams"]] == [("Portugal", "home")]
    assert "Finland" not in (out["evidenceStatus"].get("suppressedCandidates") or [])
    assert "Finland" not in [c["name"] for c in out["evidenceStatus"]["channelOutcomes"]["metadata"]["candidates"]]


def test_fold_would_pair_complete_a_stray_single_side_candidate():
    # Guard demonstration (not a resolver call): pair completion hands a stranded
    # `unknown`-side candidate the free side, so a stray fuzzy name WOULD be
    # published as a team. This is why metadata resolves exact tokens only.
    scorebug = parse_ocr_teams(["POR 0 - 0"], "soccer")
    stray = [TeamText("Finland", "unknown", "finish", "Clinical finish", True)]
    by_name = {c.name: c.side for c in fold_confidence(scorebug, [], stray)}
    assert by_name == {"Portugal": "home", "Finland": "away"}


def test_kit_clusters_reported_when_no_team_resolved():
    # ADAAAA-7889 (AC2 / PO scope split on ADAAAA-7890): a job with observed
    # clusters but no team candidate used to report `kitColorsUnattributed: []`,
    # which reads as "no colours seen". The observed clusters must be named.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 0.0, "lines": ["ETIHAD"]}],
        hints={"title": "Clinical finish and celebration"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
    )
    status = out["evidenceStatus"]
    assert {t["name"] for t in out["matchContext"]["teams"]} == {"unknown"}
    assert status["kitColorsUnattributed"] == []
    assert set(status["kitClustersUnattributed"]) == {"red", "white"}


def test_kit_clusters_omitted_when_every_cluster_is_attributed():
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=[{"ts": 12.0, "lines": ["POR 1 - 0 ESP"]}],
        transcript="Spain in the white shirts are pressing; Portugal break quickly.",
        hints={"title": "Portugal vs Spain"},
        kit_samples=kit_samples([RED, WHITE], frames=3),
        scorebug_swatches=[{"side": "home", "rgb": RED}, {"side": "away", "rgb": WHITE}],
    )
    assert out["matchContext"]["ambiguous"] is False
    assert "kitClustersUnattributed" not in out["evidenceStatus"]


# Glued-OCR team parse + whole-frame fallback gate (ADAAAA-7909) ---------------
#
# Every line below is a VERBATIM read from the running perceive model on the 11
# labelled anchor frames of the bounded basketball clip (`bb_q1_1100_1190_90s`,
# attachment `65a5054e` on ADAAAA-7898), so these tests pin the shapes the real
# broadcast produces rather than a cleaned-up guess.

# Native ROI crop: the league banner and the score digits only, no club text.
BB_CROP_GARBAGE = ["1515K", "1515K15K", "15K", "13.8", "138"]
# Upstream print, glued the way the model returns it (no separator glyph).
BB_GLUED = "TURKIYEBASKETBOLMBDentizi Basket11 8Samsungpor 1.6"
# The 11 anchor frames as read from the same crop PADDED to a 4:3 canvas and 2x
# upscaled (exactly what `florence.prepare_ocr_crop` now feeds `<OCR>`).
BB_ANCHOR_READS = [
    "TURKIYEBASKETBOLLIGITURKITOCDenizi Basketball11 8Samsunspor1.C",
    "TURKIYEBASKETBOLTURKIVEMB11 8Samsunspor1.6Denizi Basketball",
    "TORKIYE.BASKETBOLIGITURYTE.MBDenizi Basketball13 8Samsunspor1.C",
    "TORKIYEBASKETBOLTURKEYMB13 8Samsunspor1.GDenizi Basket",
    "TURKEYMBBASKETOCDenizil Basketball13 8Samsunspor1.C",
    "TURKEYEMBBASKETOCDenizil Basketball13 8Samsunspor1.C",
    "TURNYEMBBASKETOCDenizi Basketball13 8Samsunspor1.C",
    "TURKEYTBASKETBOCDenizi Basketball13 8Samsunspor1.C",
    "TURNITEMBBASKETOCDenizil Basketball13 8Samsunspor1.C",
    "TURKEYTBASKETBOCDenizi Basketball14 8Samsunspor1.C",
    "TURKIYEBASKETBOTURKIYEMB15 18Samsungpor 1.6Denizi Basketball",
]


def test_generic_names_split_on_the_score_digit_run_without_a_dash():
    # The score separator on this graphic is a drawn divider, so `N - M` never
    # appears and the shipped channel reported `no-score-line` on every frame.
    teams, status = parse_generic_scorebug_names(bb_frames(30, line=BB_GLUED), "basketball")
    assert [(t.name, t.side, t.generic) for t in teams] == [
        ("Dentizi Basket", "home", True),
        ("Samsungpor", "away", True),
    ]
    assert status["scoreFrames"] == 30


def test_generic_names_strip_a_glued_competition_prefix():
    # "BASKETBOLDenizli" -> "Denizli": the league token is glued to the club plate
    # and must not ride into the published name. The glued run is longer than the
    # lexicon's 24-character token cap, which used to cut it to "Dentiz".
    assert generic_scorebug_sides("BASKETBOLDenizli Basket13 8Samsunspor") == ("Denizli Basket", "Samsunspor")
    assert generic_scorebug_sides(
        "TURKIYEBASKETBOLLIGITURKEYMBDenizli Basket13 8Samsunspor1.C"
    ) == ("Denizli Basket", "Samsunspor")
    assert generic_scorebug_sides(BB_GLUED) == ("Dentizi Basket", "Samsungpor")


def test_generic_names_read_the_home_plate_printed_after_the_away_one():
    # Measured OCR reordering: the model sometimes prints the away club first and
    # the home plate after the period marker. The left side is branding only, so
    # the second run is the home name — dropping it loses a whole anchor frame.
    assert generic_scorebug_sides("TURYYEMB13 8Samsunspor1.GDenizi Basket") == ("Denizi Basket", "Samsunspor")
    assert generic_scorebug_sides(
        "TURKIVELIGI KETBOLTURKEYMB13 8Samsunspor1.GDenizli Basket"
    ) == ("Denizli Basket", "Samsunspor")


def test_generic_names_fold_ocr_spellings_into_one_vote():
    # The binding test on this clip is the AWAY name: the model returns
    # "Samsungpor" / "Samsungspor" / "Samsunspor" interchangeably. One printed
    # club read three ways is ONE name, not three sub-threshold minorities.
    spellings = ["Samsungpor", "Samsungspor", "Samsunspor"]
    frames = [
        {"lines": ["TURKIYEBASKETBOLMBDentizi Basket13 8%s1.C" % spellings[i % 3]]} for i in range(30)
    ]
    teams, status = parse_generic_scorebug_names(frames, "basketball")
    # A three-way tie publishes one of the printed spellings (the tie breaks on
    # the printed form so the choice never depends on frame order); all three are
    # one OCR edit of the labelled club.
    assert [(t.side) for t in teams] == ["home", "away"]
    assert teams[0].name == "Dentizi Basket"
    assert teams[1].name in set(spellings)
    assert status["names"]["away"]["frames"] == 30
    assert set(status["names"]["away"]["variants"]) == {"Samsungpor", "Samsungspor", "Samsunspor"}
    # No confidence gate moved: the published pair still sits at the scorebug
    # source weight, capped by SINGLE_SOURCE_CAP.
    out = resolve_match_context(sport_hint="basketball", ocr_frames=frames)
    assert all(t["confidence"] <= SINGLE_SOURCE_CAP for t in out["matchContext"]["teams"])
    assert out["matchContext"]["ambiguous"] is False


def test_generic_names_still_reject_two_genuinely_different_clubs():
    # The one-edit vote tolerance must NOT merge different clubs: an even split
    # between two real names leaves no majority (parent AC6).
    frames = [
        {"lines": ["Denizli Basket13 8%s1.C" % ("Samsunspor" if i % 2 else "Bursaspor")]} for i in range(30)
    ]
    teams, status = parse_generic_scorebug_names(frames, "basketball")
    assert teams == []
    assert any("unstable" in r for r in status["rejected"])


def test_generic_names_do_not_publish_from_a_banner_only_read():
    # The banner-only read names one club but no home plate: the all-or-nothing
    # pair gate keeps the job `unknown` instead of publishing half a match.
    teams, status = parse_generic_scorebug_names(
        bb_frames(30, line="TURKIYEBASKETBOLIGI KETBOTURKIYEMB15 8Samsungpor1.C"), "basketball"
    )
    assert teams == []
    assert status["rejected"] == ["home:no-text"]


def test_scorebug_team_text_predicate_gates_the_whole_frame_fallback():
    # The measured crop read: digits and banner fragments only — exactly the case
    # that used to suppress the whole-frame read (the ADAAAA-7190 fallback was
    # gated on the SCORE, which the crop did produce).
    assert scorebug_lines_have_team_text(BB_CROP_GARBAGE, "basketball") is False
    assert scorebug_lines_have_team_text(["POR 1 - 0 ESP"], "soccer") is True
    assert scorebug_lines_have_team_text([BB_GLUED], "basketball") is True
    assert scorebug_lines_have_team_text(BB_ANCHOR_READS, "basketball") is True
    assert scorebug_lines_have_team_text([], "basketball") is False


def test_resolver_publishes_both_clubs_from_the_11_measured_anchor_frames():
    # End to end over the real read set: home plate on 10 of 11 frames (the 11th
    # has it after the away club), away on 11 of 11 — the channel publishes a
    # sided pair, and the away name is the measured bound (~1 edit of
    # "Samsunspor", never the "Samsungpor" misread alone).
    frames = [{"ts": float(i), "lines": [BB_ANCHOR_READS[i]]} for i in range(len(BB_ANCHOR_READS))]
    out = resolve_match_context(sport_hint="basketball", ocr_frames=frames)
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert [(t["side"]) for t in ctx["teams"]] == ["home", "away"]
    home, away = ctx["teams"][0]["name"], ctx["teams"][1]["name"]
    # Published spellings are one OCR edit of the labelled clubs: "Denizi
    # Basketball" (fold -> "denizi basket", 1 edit of "denizli basket") and
    # "Samsunspor" (or the "Samsungpor" misread, also 1 edit).
    assert _levenshtein_le(_generic_name_key(home), "denizli basket", 1)
    assert _levenshtein_le(_generic_name_key(away), "samsunspor", 1)
    assert ctx["ambiguous"] is False
    assert status["genericNameCandidates"]["scoreFrames"] == 11
    assert status["genericNameCandidates"]["names"]["home"]["frames"] == 11
    assert status["genericNameCandidates"]["names"]["away"]["frames"] == 11


def test_scorebug_lines_sides_counts_what_a_read_actually_covers():
    # ADAAAA-7909: the measured basketball job read the away club on 27/30 frames
    # and the home plate on 10, so "team text present" was true while the region
    # was clipping half the graphic — the repair trigger keys on this count.
    assert scorebug_lines_sides(["TURKEYMBDentizi Basket13 8Samsungpor1.C"], "basketball") == {"home", "away"}
    assert scorebug_lines_sides(["TURKEYMB13 8Samsungpor1.C"], "basketball") == {"away"}
    assert scorebug_lines_sides(BB_CROP_GARBAGE, "basketball") == set()
    assert scorebug_lines_sides(["POR 1 - 0 ESP"], "soccer") == {"home", "away"}
    assert scorebug_lines_sides([], "basketball") == set()


def test_generic_names_vote_does_not_depend_on_frame_order():
    # ADAAAA-7909 measured this split: ONE home club printed three ways
    # ("Dentizi" 5, "Denizi" 9, "Denizli" 7) over the job's 50 % fold. A greedy
    # first-seen grouping put "Dentizi" and "Denizi" in one group (14) and
    # "Denizli" — two edits from "Dentizi" — in another (7), so the side read as
    # unstable(14/30) while 21 frames actually named it. The same one-edit
    # tolerance applied to every variant against the best-supported one is
    # order-independent and still rejects two genuinely different clubs.
    spellings = ["Dentizi Basket"] * 5 + ["Denizi Basketball"] * 9 + ["Denizli Basket"] * 7
    frames = [{"lines": ["TURKEYMB13 8Samsungpor1.C%s" % s]} for s in spellings]
    # 9 further score frames whose crop clipped the home plate away entirely.
    frames += [{"lines": ["TURKEYMB13 8Samsungpor1.C"]} for _ in range(9)]
    teams, status = parse_generic_scorebug_names(frames, "basketball")
    assert [t.side for t in teams] == ["home", "away"]
    # Published spelling is the best-supported printed variant; the SUPPORT is
    # what the gate reads, and it no longer depends on which one was seen first.
    assert _levenshtein_le(_generic_name_key(teams[0].name), "denizli basket", 1)
    assert teams[1].name == "Samsungpor"
    assert status["names"]["home"]["frames"] == 21
    assert status["names"]["home"]["share"] == 0.7
    # Same frames, shuffled: the published pair and its support must not change.
    for order in (frames[::-1], frames[::2] + frames[1::2]):
        teams2, status2 = parse_generic_scorebug_names(order, "basketball")
        assert [(t.side, t.name) for t in teams2] == [(t.side, t.name) for t in teams]
        assert status2["names"]["home"]["frames"] == status["names"]["home"]["frames"]


def test_generic_names_drop_an_ad_board_host_token():
    # "Wykes.com Denizil Basketball" was read off one frame of the bounded job:
    # the ad-board host rides into the home run and votes a name nothing else
    # shares. A token carrying a dot/slash/handle is branding, never a club.
    assert generic_scorebug_sides("WIKYSTELISHEANOMBTURYTEBASKETOBENZI BASKETty.com Denizil Basketball13 8Samsungspor1.g") == (
        "Denizil Basketball",
        "Samsungspor",
    )
    assert generic_scorebug_sides("Wykes.com Denizli Basket13 8Samsunspor") == ("Denizli Basket", "Samsunspor")


# --- ADAAAA-7944: printed plates + esports HUD stat split --------------------


def _sport_frames(line: str, n: int = 12, ts: bool = True) -> list[dict]:
    return [{"ts": float(i), "lines": [line]} for i in range(n)] if ts else [{"lines": [line]} for _ in range(n)]


AF_BAND = "BELMONT 6 WESTFORD 6 1st0:211st & 10Commentators: Todd Bloniarz & Aram Parnagian"
HK_BUG = "Watertown1Cohasset Middle HS1st Period"
BB_BUG = "Watertown2 Wayland0A2nd2 Outs"
ES_HUD = "PSG0 10.4K1 0.9%V312:5512:57BOSEKONGYUE"


def test_printed_plates_split_the_band_and_corner_bug_glue():
    # The measured reads: the score separator is a graphic divider, so each line
    # is one glued run. Two plates either side of one digit are the two clubs.
    assert printed_plate_sides(AF_BAND) == ("BELMONT", "WESTFORD")
    assert printed_plate_sides("BELMONT 6 WESTFORD 6 1st 0:21") == ("BELMONT", "WESTFORD")
    assert printed_plate_sides(HK_BUG) == ("Watertown", "Cohasset Middle HS")
    assert printed_plate_sides("Watertown-Cohasset Middle HS0 1st Period") == ("Watertown", "Cohasset Middle HS")
    assert printed_plate_sides(BB_BUG) == ("Watertown", "Wayland")
    assert printed_plate_sides("Watertown2Wayland0V2nd0 Outs") == ("Watertown", "Wayland")
    # Broadcast copy beside the plate never rides into the away name.
    assert printed_plate_sides("BELMONT 6WESTFORDCommentators: Todd Bloniarz") == ("BELMONT", "WESTFORD")
    # A banner / ad board is not a pair.
    assert printed_plate_sides("CHAMPIONS2014") is None
    assert printed_plate_sides("www.cambridgecambridge.com") is None
    assert printed_plate_sides("COURTESY") is None


def test_american_football_band_resolves_both_clubs():
    out = resolve_match_context(sport_hint="american_football", ocr_frames=_sport_frames(AF_BAND))
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [("BELMONT", "home"), ("WESTFORD", "away")]
    assert ctx["ambiguous"] is False
    assert all(t["confidence"] <= SINGLE_SOURCE_CAP for t in ctx["teams"])
    assert status["genericNameCandidates"]["scoreFrames"] == 12


def test_ice_hockey_corner_bug_resolves_both_clubs():
    # Two of the measured frames glue the score digit away; the hyphen boundary
    # still names both sides, so the vote has 12/12 support.
    lines = [
        HK_BUG,
        "WatertownColhasset Middle HS1st Period",
        "Watertown-Cohasset Middle HS0 1st Period",
        "Watertown1Cohasset Middle H",
    ]
    frames = [{"lines": [lines[i % len(lines)]]} for i in range(12)]
    out = resolve_match_context(sport_hint="ice_hockey", ocr_frames=frames)
    ctx = out["matchContext"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [
        ("Watertown", "home"),
        ("Cohasset Middle HS", "away"),
    ]
    assert ctx["ambiguous"] is False
    assert all(t["confidence"] <= SINGLE_SOURCE_CAP for t in ctx["teams"])


def test_baseball_corner_bug_resolves_both_clubs():
    out = resolve_match_context(sport_hint="baseball", ocr_frames=_sport_frames(BB_BUG))
    ctx = out["matchContext"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [
        ("Watertown", "home"),
        ("Wayland", "away"),
    ]
    assert ctx["ambiguous"] is False


def test_esports_hud_splits_the_stat_glued_team_tokens():
    assert esports_hud_sides(ES_HUD) == ("PSG", "V3")
    assert esports_hud_sides("PSG0 11.1K11.1k10.5%V312:3112:21:23") == ("PSG", "V3")
    assert esports_hud_sides("PSG12.1K11.8KV311:47") == ("PSG", "V3")
    assert esports_hud_sides("PSG+0 13.1k2 t0 12.1h 0V311:52-1") == ("PSG", "V3")
    # Stat strip / replay copy carries no team plate.
    assert esports_hud_sides("00:00 5145 00:00BOSEKONGYUE") is None
    assert esports_hud_sides("0/0 511/0/0 36BOSE0/1 520/O/047KONGYUE") is None


def test_team_esports_hud_resolves_home_and_away_across_frames():
    hud = [
        ES_HUD,
        "PSG0 11.1K11.1k10.5%V312:3112:21:23",
        "PSG11.5K11.0 11.0V312:02:21:21",
        "PSG12.1K11.8KV311:47",
        "PSG+0 13.1k2 t0 12.1h 0V311:52-1",
    ]
    frames = [{"ts": float(i), "lines": [hud[i % len(hud)]]} for i in range(24)]
    out = resolve_match_context(sport_hint="team_esports", ocr_frames=frames)
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert [(t["name"], t["side"]) for t in ctx["teams"]] == [("PSG", "home"), ("V3", "away")]
    assert ctx["ambiguous"] is False
    assert all(t["confidence"] <= SINGLE_SOURCE_CAP for t in ctx["teams"])
    assert status["genericNameCandidates"]["scoreFrames"] == 24


def test_esports_hud_never_invents_a_team_when_one_side_is_missing():
    # Only the home plate is readable; the pair gate keeps the job unknown
    # instead of publishing half a match or lowering the confidence bar.
    frames = _sport_frames("PSG0 10.4K1 0.9%")
    teams, status = parse_generic_scorebug_names(frames, "team_esports")
    assert teams == []
    assert status["rejected"] == ["away:no-text"]
    out = resolve_match_context(sport_hint="team_esports", ocr_frames=frames)
    ctx = out["matchContext"]
    assert [t["name"] for t in ctx["teams"]] == ["unknown", "unknown"]
    assert ctx["ambiguous"] is True


def test_printed_name_pair_is_the_selector_seam_for_every_sport():
    assert printed_name_pair([AF_BAND], "american_football") == ("BELMONT", "WESTFORD")
    assert printed_name_pair([HK_BUG], "ice_hockey") == ("Watertown", "Cohasset Middle HS")
    assert printed_name_pair([BB_BUG], "baseball") == ("Watertown", "Wayland")
    assert printed_name_pair([ES_HUD], "team_esports") == ("PSG", "V3")
    assert printed_name_pair(["CHAMPIONS2014"], "ice_hockey") is None
