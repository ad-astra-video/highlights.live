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
    _KIT_COLOR_NAMES,
    _KIT_PRIORS,
    _SOCCER_KIT_PRIORS,
    apply_monotonic_guard,
    associate_kits,
    build_match_context,
    cluster_kit_colors,
    fold_confidence,
    is_plausible_player_box,
    name_color,
    parse_metadata_hints,
    parse_ocr_teams,
    resolve_match_context,
    resolve_token,
    sample_track_colors,
    scan_commentary,
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
