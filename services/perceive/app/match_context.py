"""Match-context resolver: who is playing, in which kit colour (ADAAAA-7855).

One bounded, once-per-job pass that turns cheap, already-billed evidence into a
persisted ``matchContext`` on the job record, so every later LLM call can name
the teams instead of inventing them (a Portugal vs Spain VOD job produced
"German defender" — ADAAAA-7849 §1).

Design (parent plan ``ADAAAA-7849`` §3, Stages 0-5):

- **Stage 0 — metadata hint**: job ``gameHint`` / stored title / source filename.
  Produces *candidate* strings only; a metadata mention alone never becomes an
  accepted attribution (single-source attributions are capped at
  ``SINGLE_SOURCE_CAP`` = 0.55, below ``USABLE_CONFIDENCE`` = 0.60).
- **Stage 1 — scorebug team text**: this module parses the SAME ROI-gated OCR
  lines the score parser sees (``parse_ocr_score`` in ``scoreboard.py``), and
  keeps the two parsers strictly separate: team text can never produce a score
  and score text can never produce a team claim. ``parse_ocr_teams`` therefore
  lives here, not in ``scoreboard.py``, and the score parser is untouched.
- **Stage 2 — commentary probe**: the caller hands in one bounded transcript
  (server-side ASR prefix, CPU-only). ``scan_commentary`` resolves team
  mentions, demonyms ("the Germans counter") and kit phrases ("Spain in the
  white shirts") against the per-sport lexicon.
- **Stage 3 — kit colours**: ``sample_track_colors`` samples the torso of the
  tracked player crops the perception pass already produces (CPU, a few pixels
  per tracking box, no GPU). ``cluster_kit_colors`` folds the samples into two
  colour clusters that need >= ``KIT_MIN_FRAMES`` agreeing frames.
  Side -> team association is scorebug-swatch-first (``associate_kits``:
  the scoreboard ROI halves carry the side's kit swatch), ASR phrase second,
  and a curated per-team kit-colour prior last (``_SOCCER_KIT_PRIORS``, the
  additive channel of ADAAAA-7866). The prior is only an attribution KEY: a
  published colour is always the observed cluster's own colour, and it never
  overrides a measured channel.
  Away kits in the same colour report ``ambiguous: true`` rather than a wrong
  colour.
- **Stage 4 — confidence fold + monotonic guard**: source weights are
  scorebug OCR 0.5 / ASR 0.35 / metadata 0.15; ``apply_monotonic_guard`` lets a
  re-check raise confidence but never flip an attributed team (confidence
  >= 0.6) unless the new claim beats the stored confidence by >= 0.2 with >= 2
  agreeing sources. Every decision lands in a bounded ``trail`` on the persisted
  context, which is the AC4 audit surface ("no flip-flop after 0.6").
- **Stage 5 — the contract** (``build_match_context``) matches the plan doc
  exactly: ``{sport, teams[{name, side, kitColors[{primary, secondary}],
  confidence, evidence[{source, snippet}]}], inferredAt, resolverVersion,
  ambiguous}`` plus the additive ``trail`` for the recompute audit.

Everything here is pure and torch-free on purpose: the unit tests import this
module directly (no Florence/torch), and an offline replay of a real job's
stored evidence can call ``resolve_match_context`` without a GPU. Sports that
the lexicon does not cover resolve to ``"unknown"`` — never a guess.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional, Sequence

RESOLVER_VERSION = 1

# Confidence policy (plan §3 Stage 4). A single source can never reach the
# usable threshold: the whole point is that a guess without corroboration is not
# an attribution (over-eager attribution is worse than none — plan §7).
USABLE_CONFIDENCE = 0.60
SINGLE_SOURCE_CAP = 0.55
# A fuzzy OCR read contributes at a discount; it can corroborate but never
# carry an attribution on its own above the single-source cap.
FUZZY_EVIDENCE_FACTOR = 0.75
SOURCE_WEIGHTS: dict[str, float] = {
    "scorebug_ocr": 0.50,
    "asr": 0.35,
    "metadata": 0.15,
}
# A re-check may only FLIP an attributed team (stored confidence >= 0.6) when
# the replacement beats the stored confidence by this margin AND has this many
# independent agreeing sources (plan §3 Stage 4 monotonic guard).
FLIP_MARGIN = 0.20
FLIP_MIN_SOURCES = 2
# Kit colours need >= 2 consistent frames before they count (plan §3 Stage 3).
KIT_MIN_FRAMES = 2
# Bound the persisted recompute trail so a long job cannot grow the record.
MAX_TRAIL = 12
# Bounds on the AC2 per-channel diagnosis (ADAAAA-7889). A stored job must be
# able to explain an `unknown` from `GET /jobs/:id` alone, without a box shell,
# so the evidence status carries what each channel actually SAW — bounded so a
# long stream can never grow the record.
MAX_STATUS_OCR_LINES = 5
MAX_STATUS_TEAMS = 8
MAX_STATUS_MENTIONS = 12

# --- tracked-box plausibility (kit sampling) --------------------------------
# The tracking pass emits BOTH real player boxes and SAM3 seeds that propagate
# onto whatever is near the seed: a 0.997-wide advertising band, a boot, a leg, a
# strip of grass. Measured on the cited Portugal vs Spain job
# (dee44c2f-d962-400d-ad62-6cf9dc53fd91): 1114 of 1287 player-labelled track boxes
# were implausible, and sampling them put "black" (the ad board) and a grass
# "grey" on the cluster set — junk colours that a swatch or a commentary phrase
# could then have attributed to a team. These bounds mirror the single-player
# seed contract in `player_id.is_plausible_player_seed_box` (same 0.30 area /
# 0.70 side caps) plus the one extra shape fact a broadcast crop always has: a
# standing player is TALLER than wide.
MAX_KIT_BOX_AREA = 0.30
MAX_KIT_BOX_SIDE = 0.70

# --- scorebug swatch stability ---------------------------------------------
# A swatch is a per-side colour reading off the scoreboard ROI. On a broadcast
# where the ROI sits over advertising boards, the side half behind the graphic
# reads the AD BOARD, not the kit: measured on the cited job, 79 of 147 probed
# frames produced a home/away pair, home was "red" in 91% of them but the away
# half read blue / sky blue / orange / red / maroon / pink across frames (the
# LED boards behind the bug). Trusting one frame there attributes the wrong
# colour. So once a side has REPEATED readings its modal colour must hold
# ``MIN_SWATCH_SHARE`` of them (and repeat at least twice); an unstable half
# yields nothing instead of a wrong kit.
MIN_SWATCH_SHARE = 0.60

# ---------------------------------------------------------------------------
# Sport resolution
# ---------------------------------------------------------------------------
# Lexicon keys. ``unknown`` is a real, valid outcome (AC6) — an unmapped sport
# must never inherit another sport's team list.
SPORT_UNKNOWN = "unknown"
SPORT_KEYS = (
    "soccer",
    "american_football",
    "basketball",
    "ice_hockey",
    "baseball",
    "team_esports",
    SPORT_UNKNOWN,
)

# Alias -> lexicon key. Accepts BOTH Florence's canonical sport tokens
# (``florence.canonical_sport`` returns "soccer" / "american football" /
# "basketball" / "valorant" / ...) and raw league/game hints, so the caller can
# pass whichever it has. Deliberately mirrors ``florence._GAME_HINT_ALIASES``
# where they overlap ("football" alone is AMERICAN football there: ADAAAA-6463).
_SPORT_ALIASES: dict[str, str] = {
    "soccer": "soccer",
    "soccer ball": "soccer",
    "football match": "soccer",
    "association football": "soccer",
    "futbol": "soccer",
    "premier league": "soccer",
    "champions league": "soccer",
    "la liga": "soccer",
    "laliga": "soccer",
    "bundesliga": "soccer",
    "serie a": "soccer",
    "ligue 1": "soccer",
    "eredivisie": "soccer",
    "primeira liga": "soccer",
    "liga mx": "soccer",
    "mls": "soccer",
    "fa cup": "soccer",
    "world cup": "soccer",
    "euro": "soccer",
    "copa": "soccer",
    "uefa": "soccer",
    "american football": "american_football",
    "american-football": "american_football",
    "football": "american_football",
    "nfl": "american_football",
    "ncaa": "american_football",
    "college football": "american_football",
    "super bowl": "american_football",
    "gridiron": "american_football",
    "basketball": "basketball",
    "nba": "basketball",
    "euroleague": "basketball",
    "ncaa basketball": "basketball",
    "ice hockey": "ice_hockey",
    "ice-hockey": "ice_hockey",
    "hockey": "ice_hockey",
    "nhl": "ice_hockey",
    "baseball": "baseball",
    "mlb": "baseball",
    "team esports": "team_esports",
    "esports": "team_esports",
    "e-sports": "team_esports",
    "valorant": "team_esports",
    "counter-strike": "team_esports",
    "csgo": "team_esports",
    "cs2": "team_esports",
    "cs:go": "team_esports",
    "league of legends": "team_esports",
    "lol": "team_esports",
    "dota": "team_esports",
    "dota 2": "team_esports",
    "overwatch": "team_esports",
    "rainbow six": "team_esports",
    "r6": "team_esports",
    "apex legends": "team_esports",
    "call of duty": "team_esports",
    "rocket league": "team_esports",
}


def sport_key(raw: Optional[str]) -> str:
    """Map a raw hint or a Florence canonical sport token to a lexicon key.

    Substring match (longest alias first) so "Premier League final" and
    "NBA regular season" both land on the right sport, while an unmapped game
    returns ``"unknown"``. Never guesses: no sport means no team list.
    """
    text = (raw or "").strip().lower()
    if not text:
        return SPORT_UNKNOWN
    if text in _SPORT_ALIASES:
        return _SPORT_ALIASES[text]
    for alias in sorted(_SPORT_ALIASES, key=len, reverse=True):
        if alias in text:
            return _SPORT_ALIASES[alias]
    return SPORT_UNKNOWN


# ---------------------------------------------------------------------------
# Team lexicons (plan §3 "Sports coverage")
# ---------------------------------------------------------------------------
# Compact table form keeps the data auditable: ``(canonical, codes, aliases,
# demonyms)`` with ``|``-separated lists. Codes are resolved case-sensitively on
# UPPERCASE scorebug text (POR / ESP / LAL); aliases and demonyms are matched
# case-insensitively in prose (ASR) and on OCR lines.
# type: (str, str, str, str)


def _entries(raw: Sequence[tuple[str, str, str, str]]) -> list[dict[str, Any]]:
    out = []
    for canonical, codes, aliases, demonyms in raw:
        out.append(
            {
                "name": canonical,
                "codes": tuple(c for c in codes.split("|") if c),
                "aliases": tuple(a for a in aliases.split("|") if a),
                "demonyms": tuple(d for d in demonyms.split("|") if d),
            }
        )
    return out


# Soccer: national teams (the "Portugal vs Spain" class of job) + the clubs that
# show up in the stored VOD corpus (one earlier job mixed "Manchester City and
# Spain"). A club and a country can collide in prose ("Madrid"), so every alias
# is resolved only within the sport and an ambiguous alias is dropped.
_SOCCER_TEAMS = _entries(
    [
        ("Portugal", "POR|PRT", "portugal national team|selecao|seleção", "portuguese|portugal"),
        ("Spain", "ESP|SPA", "espana|españa|la roja|spain national team", "spanish|spaniard|spaniards"),
        ("Germany", "GER|DEU|ALE", "deutschland|die mannschaft|germany national team", "german|germans"),
        ("France", "FRA", "france national team|les bleus", "french"),
        ("England", "ENG", "england national team|three lions", "english"),
        ("Brazil", "BRA", "brasil|selecao brasileira", "brazilian|brazilians"),
        ("Argentina", "ARG", "argentina national team|la albiceleste", "argentine|argentinian|argentinians"),
        ("Italy", "ITA", "italia|azzurri", "italian|italians"),
        ("Netherlands", "NED|HOL|NLD", "holland|oranje", "dutch|netherlander"),
        ("Belgium", "BEL", "belgique|belgie|red devils", "belgian|belgians"),
        ("Croatia", "CRO", "hrvatska", "croatian|croatians"),
        ("Morocco", "MAR", "maroc", "moroccan|moroccans"),
        ("United States", "USA|USMNT", "united states of america|us national team|usa national team", "american|americans"),
        ("Mexico", "MEX", "mexico national team|el tri", "mexican|mexicans"),
        ("Japan", "JPN", "nippon|japan national team", "japanese"),
        ("South Korea", "KOR|KOREA", "korea republic|korea", "korean|koreans"),
        ("Senegal", "SEN", "senegal national team|lions of teranga", "senegalese"),
        ("Nigeria", "NGA", "super eagles", "nigerian|nigerians"),
        ("Ghana", "GHA", "black stars", "ghanaian|ghanaians"),
        ("Egypt", "EGY", "pharaohs", "egyptian|egyptians"),
        ("Cameroon", "CMR", "indomitable lions", "cameroonian"),
        ("Uruguay", "URU", "la celeste", "uruguayan|uruguayans"),
        ("Colombia", "COL", "los cafeteros", "colombian|colombians"),
        ("Chile", "CHI", "la roja de chile", "chilean|chileans"),
        ("Peru", "PER", "la blanquirroja", "peruvian|peruvians"),
        ("Ecuador", "ECU", "la tri", "ecuadorian"),
        ("Denmark", "DEN", "danmark", "danish|dane|danes"),
        ("Sweden", "SWE", "sverige", "swedish"),
        ("Norway", "NOR", "norge", "norwegian|norwegians"),
        ("Poland", "POL", "polska", "polish"),
        ("Switzerland", "SUI|CHE", "schweiz|suisse", "swiss"),
        ("Austria", "AUT", "osterreich|österreich", "austrian|austrians"),
        ("Turkey", "TUR", "turkiye|türkiye", "turkish|turk"),
        ("Greece", "GRE", "hellas", "greek|greeks"),
        ("Ukraine", "UKR", "ukraina", "ukrainian|ukrainians"),
        ("Serbia", "SRB", "srbija", "serbian|serbians"),
        ("Czechia", "CZE|CZV", "czech republic|czechia national team", "czech|czechs"),
        ("Hungary", "HUN", "magyarorszag", "hungarian|hungarians"),
        ("Scotland", "SCO", "scotland national team", "scottish|scots"),
        ("Wales", "WAL", "cymru", "welsh"),
        ("Republic of Ireland", "IRL", "ireland|eire", "irish"),
        ("Australia", "AUS", "socceroos", "australian|australians"),
        ("Canada", "CAN", "canada national team", "canadian|canadians"),
        ("China", "CHN", "pr china|china national team", "chinese"),
        ("Saudi Arabia", "KSA|SAU", "saudi", "saudi|saudis"),
        ("Qatar", "QAT", "qatar national team", "qatari"),
        ("Iran", "IRN", "ir iran", "iranian|iranians"),
        ("Israel", "ISR", "israel national team", "israeli|israelis"),
        ("Finland", "FIN", "suomi", "finnish|finn"),
        ("Iceland", "ISL", "island", "icelandic"),
        ("Romania", "ROU|ROM", "romania national team", "romanian|romanians"),
        ("Slovakia", "SVK", "slovensko", "slovak|slovaks"),
        ("Slovenia", "SVN", "slovenija", "slovenian|slovenians"),
        ("Bulgaria", "BUL", "bulgaria national team", "bulgarian|bulgarians"),
        ("Russia", "RUS", "russia national team", "russian|russians"),
        # Clubs (aliases include the short broadcast form).
        ("Real Madrid", "", "madrid|real|los blancos|real madrid cf", ""),
        ("Barcelona", "BAR", "barca|barça|fc barcelona|blaugrana", ""),
        ("Manchester City", "MCI|MANC", "man city|city|manchester city fc", ""),
        ("Manchester United", "MUN|MANU", "man united|man utd|united|manchester united fc", ""),
        ("Liverpool", "LIV", "liverpool fc|the reds", ""),
        ("Arsenal", "ARS", "arsenal fc|the gunners", ""),
        ("Chelsea", "CHE", "chelsea fc|the blues", ""),
        ("Tottenham", "TOT|TOTN", "tottenham hotspur|spurs", ""),
        ("Bayern Munich", "BAY|FCB", "bayern|fc bayern|bayern munchen|bayern münchen", ""),
        ("Borussia Dortmund", "BVB", "dortmund|bvb", ""),
        ("Paris Saint-Germain", "PSG", "paris saint germain|paris|psg", ""),
        ("Juventus", "JUV", "juve|juventus fc", ""),
        ("AC Milan", "MIL|ACM", "milan|ac milan", ""),
        ("Inter Milan", "INT|IM", "inter|internazionale", ""),
        ("Atletico Madrid", "ATM|ATL", "atletico|atlético|atleti", ""),
        ("Sevilla", "SEV", "sevilla fc", ""),
        ("Ajax", "AJA", "ajax amsterdam", ""),
        ("Benfica", "BEN", "sl benfica", ""),
        ("FC Porto", "FCP", "porto", ""),
        ("Sporting CP", "SCP", "sporting|sporting lisbon", ""),
        ("Celtic", "CEL", "celtic fc", ""),
        ("Rangers", "RAN", "glasgow rangers", ""),
    ]
)

_NFL_TEAMS = _entries(
    [
        ("Arizona Cardinals", "ARI", "cardinals", ""),
        ("Atlanta Falcons", "ATL", "falcons", ""),
        ("Baltimore Ravens", "BAL", "ravens", ""),
        ("Buffalo Bills", "BUF", "bills", ""),
        ("Carolina Panthers", "CAR", "panthers", ""),
        ("Chicago Bears", "CHI", "bears", ""),
        ("Cincinnati Bengals", "CIN", "bengals", ""),
        ("Cleveland Browns", "CLE", "browns", ""),
        ("Dallas Cowboys", "DAL", "cowboys", ""),
        ("Denver Broncos", "DEN", "broncos", ""),
        ("Detroit Lions", "DET", "lions", ""),
        ("Green Bay Packers", "GB|GNB", "packers|green bay", ""),
        ("Houston Texans", "HOU", "texans", ""),
        ("Indianapolis Colts", "IND", "colts", ""),
        ("Jacksonville Jaguars", "JAX", "jaguars", ""),
        ("Kansas City Chiefs", "KC|KAN", "chiefs|kansas city", ""),
        ("Las Vegas Raiders", "LV|LVR", "raiders", ""),
        ("Los Angeles Chargers", "LAC", "chargers", ""),
        ("Los Angeles Rams", "LA|LAR", "rams", ""),
        ("Miami Dolphins", "MIA", "dolphins", ""),
        ("Minnesota Vikings", "MIN", "vikings", ""),
        ("New England Patriots", "NE|NWE", "patriots|new england", ""),
        ("New Orleans Saints", "NO|NOR", "saints|new orleans", ""),
        ("New York Giants", "NYG", "giants", ""),
        ("New York Jets", "NYJ", "jets", ""),
        ("Philadelphia Eagles", "PHI", "eagles", ""),
        ("Pittsburgh Steelers", "PIT", "steelers", ""),
        ("San Francisco 49ers", "SF|SFO", "49ers|niners|san francisco", ""),
        ("Seattle Seahawks", "SEA", "seahawks", ""),
        ("Tampa Bay Buccaneers", "TB|TAM", "buccaneers|bucs", ""),
        ("Tennessee Titans", "TEN", "titans", ""),
        ("Washington Commanders", "WAS|WSH", "commanders|washington", ""),
    ]
)

_NBA_TEAMS = _entries(
    [
        ("Atlanta Hawks", "ATL", "hawks", ""),
        ("Boston Celtics", "BOS", "celtics", ""),
        ("Brooklyn Nets", "BKN|BRK", "nets", ""),
        ("Charlotte Hornets", "CHA", "hornets", ""),
        ("Chicago Bulls", "CHI", "bulls", ""),
        ("Cleveland Cavaliers", "CLE", "cavaliers|cavs", ""),
        ("Dallas Mavericks", "DAL", "mavericks|mavs", ""),
        ("Denver Nuggets", "DEN", "nuggets", ""),
        ("Detroit Pistons", "DET", "pistons", ""),
        ("Golden State Warriors", "GSW|GS", "warriors|golden state", ""),
        ("Houston Rockets", "HOU", "rockets", ""),
        ("Indiana Pacers", "IND", "pacers", ""),
        ("Los Angeles Clippers", "LAC", "clippers", ""),
        ("Los Angeles Lakers", "LAL", "lakers", ""),
        ("Memphis Grizzlies", "MEM", "grizzlies", ""),
        ("Miami Heat", "MIA", "heat", ""),
        ("Milwaukee Bucks", "MIL", "bucks", ""),
        ("Minnesota Timberwolves", "MIN", "timberwolves|wolves", ""),
        ("New Orleans Pelicans", "NOP", "pelicans", ""),
        ("New York Knicks", "NYK|NY", "knicks", ""),
        ("Oklahoma City Thunder", "OKC", "thunder", ""),
        ("Orlando Magic", "ORL", "magic", ""),
        ("Philadelphia 76ers", "PHI|SIX", "76ers|sixers", ""),
        ("Phoenix Suns", "PHX|PHO", "suns", ""),
        ("Portland Trail Blazers", "POR|PDX", "trail blazers|blazers", ""),
        ("Sacramento Kings", "SAC", "kings", ""),
        ("San Antonio Spurs", "SAS", "spurs", ""),
        ("Toronto Raptors", "TOR", "raptors", ""),
        ("Utah Jazz", "UTA|UTH", "jazz", ""),
        ("Washington Wizards", "WAS|WSH", "wizards", ""),
    ]
)

_NHL_TEAMS = _entries(
    [
        ("Anaheim Ducks", "ANA", "ducks", ""),
        ("Boston Bruins", "BOS", "bruins", ""),
        ("Buffalo Sabres", "BUF", "sabres", ""),
        ("Calgary Flames", "CGY", "flames", ""),
        ("Carolina Hurricanes", "CAR", "hurricanes|canes", ""),
        ("Chicago Blackhawks", "CHI", "blackhawks", ""),
        ("Colorado Avalanche", "COL", "avalanche|avs", ""),
        ("Columbus Blue Jackets", "CBJ", "blue jackets", ""),
        ("Dallas Stars", "DAL", "stars", ""),
        ("Detroit Red Wings", "DET", "red wings", ""),
        ("Edmonton Oilers", "EDM", "oilers", ""),
        ("Florida Panthers", "FLA", "panthers", ""),
        ("Los Angeles Kings", "LAK", "kings", ""),
        ("Minnesota Wild", "MIN", "wild", ""),
        ("Montreal Canadiens", "MTL", "canadiens|habs", ""),
        ("Nashville Predators", "NSH", "predators|preds", ""),
        ("New Jersey Devils", "NJD|NJ", "devils", ""),
        ("New York Islanders", "NYI", "islanders", ""),
        ("New York Rangers", "NYR", "rangers", ""),
        ("Ottawa Senators", "OTT", "senators", ""),
        ("Philadelphia Flyers", "PHI", "flyers", ""),
        ("Pittsburgh Penguins", "PIT", "penguins|pens", ""),
        ("San Jose Sharks", "SJS|SJ", "sharks", ""),
        ("Seattle Kraken", "SEA", "kraken", ""),
        ("St. Louis Blues", "STL", "blues", ""),
        ("Tampa Bay Lightning", "TBL|TB", "lightning|bolts", ""),
        ("Toronto Maple Leafs", "TOR", "maple leafs|leafs", ""),
        ("Utah Hockey Club", "UTA", "utah hc", ""),
        ("Vancouver Canucks", "VAN", "canucks", ""),
        ("Vegas Golden Knights", "VGK", "golden knights|knights", ""),
        ("Washington Capitals", "WSH|WAS", "capitals|caps", ""),
        ("Winnipeg Jets", "WPG", "jets", ""),
    ]
)

_MLB_TEAMS = _entries(
    [
        ("Arizona Diamondbacks", "ARI|AZ", "diamondbacks|dbacks", ""),
        ("Atlanta Braves", "ATL", "braves", ""),
        ("Baltimore Orioles", "BAL", "orioles|os", ""),
        ("Boston Red Sox", "BOS", "red sox", ""),
        ("Chicago Cubs", "CHC|CHN", "cubs", ""),
        ("Chicago White Sox", "CWS|CHA", "white sox", ""),
        ("Cincinnati Reds", "CIN", "reds", ""),
        ("Cleveland Guardians", "CLE", "guardians", ""),
        ("Colorado Rockies", "COL", "rockies", ""),
        ("Detroit Tigers", "DET", "tigers", ""),
        ("Houston Astros", "HOU", "astros", ""),
        ("Kansas City Royals", "KC|KCR", "royals", ""),
        ("Los Angeles Angels", "LAA", "angels", ""),
        ("Los Angeles Dodgers", "LAD", "dodgers", ""),
        ("Miami Marlins", "MIA|FLO", "marlins", ""),
        ("Milwaukee Brewers", "MIL", "brewers", ""),
        ("Minnesota Twins", "MIN", "twins", ""),
        ("New York Mets", "NYM", "mets", ""),
        ("New York Yankees", "NYY|NYK", "yankees|yanks", ""),
        ("Oakland Athletics", "OAK", "athletics|a's", ""),
        ("Philadelphia Phillies", "PHI", "phillies", ""),
        ("Pittsburgh Pirates", "PIT", "pirates", ""),
        ("San Diego Padres", "SD|SDP", "padres", ""),
        ("San Francisco Giants", "SF|SFG", "giants", ""),
        ("Seattle Mariners", "SEA", "mariners", ""),
        ("St. Louis Cardinals", "STL", "cardinals", ""),
        ("Tampa Bay Rays", "TB|TBR", "rays", ""),
        ("Texas Rangers", "TEX", "rangers", ""),
        ("Toronto Blue Jays", "TOR", "blue jays", ""),
        ("Washington Nationals", "WSH|WAS", "nationals|nats", ""),
    ]
)

# Team esports org tags (Valorant / CS2 / LoL / squad BR). Colour = side/agent
# colour rather than shirts; the prompt block (sibling issue ADAAAA-7856) is
# sport-aware, this module only carries identity.
_ESPORTS_ORGS = _entries(
    [
        ("Sentinels", "SEN", "sentinels", ""),
        ("Fnatic", "FNC", "fnatic", ""),
        ("Natus Vincere", "NAVI", "natus vincere|navi", ""),
        ("G2 Esports", "G2", "g2|g2 esports", ""),
        ("T1", "T1", "skt t1|t1", ""),
        ("Gen.G", "GEN|GENG", "gen g|geng", ""),
        ("DRX", "DRX", "drx", ""),
        ("Team Liquid", "TL|LIQ", "liquid|team liquid", ""),
        ("Cloud9", "C9", "cloud9|c9", ""),
        ("FaZe Clan", "FAZE", "faze|faze clan", ""),
        ("Team Vitality", "VIT|VITALITY", "vitality", ""),
        ("EDward Gaming", "EDG", "edward gaming|edg", ""),
        ("JD Gaming", "JDG", "jdg|jd gaming", ""),
        ("Bilibili Gaming", "BLG", "blg|bilibili gaming", ""),
        ("Weibo Gaming", "WBG", "wbg|weibo gaming", ""),
        ("LOUD", "LOUD", "loud", ""),
        ("FURIA Esports", "FURIA", "furia", ""),
        ("NRG", "NRG", "nrg", ""),
        ("100 Thieves", "100T", "100 thieves|100t", ""),
        ("Paper Rex", "PRX", "paper rex|prx", ""),
        ("ZETA DIVISION", "ZETA", "zeta|zeta division", ""),
        ("Rex Regum Qeon", "RRQ", "rrq|rex regum qeon", ""),
        ("Talon Esports", "TLN", "talon|talon esports", ""),
        ("Trace Esports", "TE", "trace|trace esports", ""),
        ("Global Esports", "GE", "global esports", ""),
        ("KRÜ Esports", "KRU", "kru|krü", ""),
        ("MIBR", "MIBR", "mibr", ""),
        ("Team Heretics", "TH|HER", "heretics|team heretics", ""),
        ("KOI", "KOI", "koi", ""),
        ("Movistar Riders", "MRS|RIDERS", "riders|movistar riders", ""),
    ]
)

TEAM_LEXICON: dict[str, list[dict[str, Any]]] = {
    "soccer": _SOCCER_TEAMS,
    "american_football": _NFL_TEAMS,
    "basketball": _NBA_TEAMS,
    "ice_hockey": _NHL_TEAMS,
    "baseball": _MLB_TEAMS,
    "team_esports": _ESPORTS_ORGS,
    SPORT_UNKNOWN: [],
}


@dataclass(frozen=True)
class TeamEntry:
    name: str
    sport: str
    codes: tuple[str, ...]
    aliases: tuple[str, ...]
    demonyms: tuple[str, ...]


def _index(sport: str) -> dict[str, list[TeamEntry]]:
    """Build the lookup index for one sport: token -> candidate entries."""
    idx: dict[str, list[TeamEntry]] = {}
    for raw in TEAM_LEXICON.get(sport, []):
        entry = TeamEntry(
            name=raw["name"],
            sport=sport,
            codes=tuple(raw["codes"]),
            aliases=tuple(raw["aliases"]),
            demonyms=tuple(raw["demonyms"]),
        )
        keys = {entry.name.lower()}
        keys.update(c.lower() for c in entry.codes)
        keys.update(a.lower() for a in entry.aliases)
        keys.update(d.lower() for d in entry.demonyms)
        # Broadcast short form: the city / first word ("Manchester City" ->
        # "manchester"), only when it is long enough to be unambiguous.
        first = entry.name.split()[0].lower()
        if len(first) >= 5:
            keys.add(first)
        for k in keys:
            idx.setdefault(k, []).append(entry)
    return idx


_INDEX_CACHE: dict[str, dict[str, list[TeamEntry]]] = {}


def index_for(sport: str) -> dict[str, list[TeamEntry]]:
    if sport not in _INDEX_CACHE:
        _INDEX_CACHE[sport] = _index(sport)
    return _INDEX_CACHE[sport]


_TOKEN_RE = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]{1,23}")
# A score-shaped line: the same pattern ``scoreboard._SCORE_LINE_RE`` uses. Kept
# local so this module never imports the score parser (separation guarantee).
_SCORE_SHAPE_RE = re.compile(r"(?P<a>\d{1,3})\s*[-–—]\s*(?P<b>\d{1,3})")


def _norm(text: str) -> str:
    return text.strip().strip(".,;:!?()[]\"'").lower()


def _levenshtein_le(a: str, b: str, limit: int = 1) -> bool:
    """True when edit distance(a, b) <= limit. Bounded early-exit, no deps.

    Damerau-style: a single adjacent transposition counts as ONE edit, because
    broadcast OCR/ASR transposes letters ("Portgual", "Spian") far more often
    than it substitutes them — a plain Levenshtein would need distance 2 and
    the fuzzy matcher would never fire on the real error class.
    """
    if a == b:
        return True
    if abs(len(a) - len(b)) > limit:
        return False
    if limit >= 1:
        # One adjacent transposition is one edit.
        for i in range(len(a) - 1):
            if a[i] != a[i + 1] and a[:i] + a[i + 1] + a[i] + a[i + 2 :] == b:
                return True
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return False
        prev = cur
    return prev[-1] <= limit


def resolve_token(token: str, sport: str, allow_fuzzy: bool = True) -> Optional[tuple[TeamEntry, bool]]:
    """Resolve one token to a canonical team in ``sport``.

    Returns ``(entry, fuzzy)`` or ``None``. An ambiguous token (two teams in the
    same sport share it, e.g. "cardinals" is impossible within one sport but
    "giants" collides if a sport maps both) is dropped rather than guessed —
    never attribute from ambiguity. Fuzzy matching is limited to tokens >= 5
    chars, distance <= 1, and a UNIQUE hit, and is flagged so the confidence
    fold can discount it (plan §7 risk: "never attribute on a single fuzzy hit").
    """
    if sport == SPORT_UNKNOWN or not token:
        return None
    idx = index_for(sport)
    raw = token.strip().strip(".,;:!?()[]\"'")
    # A leading article is prose, not part of the name ("the Germans").
    if raw.lower().startswith("the ") and len(raw) > 4:
        raw = raw[4:].strip()
    if not raw:
        return None
    # Scorebug codes are uppercase broadcasts; aliases/names are case-insensitive.
    candidates: list[TeamEntry] = []
    upper = raw.upper()
    for entry in idx.get(raw.lower(), []):
        candidates.append(entry)
    if upper != raw:
        for entry in idx.get(upper.lower(), []):
            if entry not in candidates:
                candidates.append(entry)
    # Uppercase 2-4 char tokens are only codes (never a name/alias match).
    if len(raw) <= 4 and raw.isupper():
        candidates = [e for e in candidates if raw.upper() in e.codes]
    if len({e.name for e in candidates}) > 1:
        return None  # ambiguous within the sport -> never guess
    if candidates:
        return candidates[0], False
    if not allow_fuzzy:
        return None
    key = raw.lower()
    if len(key) < 5:
        return None
    hits = [e for k, entries in idx.items() if _levenshtein_le(key, k) for e in entries]
    names = {e.name for e in hits}
    if len(names) == 1:
        return hits[0], True
    return None


# ---------------------------------------------------------------------------
# Stage 1 — scorebug team text (separate from parse_ocr_score)
# ---------------------------------------------------------------------------
@dataclass
class TeamText:
    """One team mention read from ROI-gated scorebug OCR text."""

    name: str
    side: str  # "home" | "away" | "unknown"
    raw: str
    snippet: str
    fuzzy: bool = False
    # Which metadata field produced the mention ("title" / "gameHint" /
    # "filename"). Only ``parse_metadata_hints`` sets it; it is what makes the
    # AC2 diagnosis ("metadata candidate Liverpool from the title") readable.
    field: Optional[str] = None
    # ADAAAA-7898: True when the name came from the sport-generic scorebug
    # channel (a printed token run the closed club lexicon does not cover), not
    # from a lexicon hit. The fold still books it at the scorebug source weight —
    # the flag exists so the record can say WHERE the name came from. Kept LAST so
    # the shipped positional construction sites keep their argument order.
    generic: bool = False


def _tokens(text: str) -> list[str]:
    return [m.group(0) for m in _TOKEN_RE.finditer(text or "")]


def _resolve_side_tokens(text: str, sport: str) -> list[tuple[TeamEntry, str, bool]]:
    """Resolve the tokens of one side-of-score segment, nearest-first.

    ``text`` is the half of a score line to the left or right of the score
    digits. Broadcast order is ``HOME 1 - 0 AWAY``, so within the left segment
    the LAST resolving token is the home team and within the right segment the
    FIRST is the away team. Tokens that resolve to the same team are collapsed.
    """
    found: list[tuple[TeamEntry, str, bool]] = []
    for tok in _tokens(text):
        hit = resolve_token(tok, sport)
        if hit is not None:
            found.append((hit[0], tok, hit[1]))
    return found


def parse_ocr_teams(
    ocr_lines: Optional[Sequence[str]],
    sport: str,
    roi: Any = None,
    ocr_boxes: Optional[Sequence[Optional[Sequence[float]]]] = None,
) -> list[TeamText]:
    """Extract the teams named on ROI-gated scorebug OCR lines.

    Strictly separate from :func:`app.scoreboard.parse_ocr_score`:

    - this function never returns a score and never calls the score parser;
    - the score parser never calls this function (so a team name can never
      forge a score delta — plan §7).

    ``ocr_lines`` are exactly the lines the score parser receives (the caller
    crops the frame to the scoreboard ROI first). ``roi`` / ``ocr_boxes`` are
    accepted for the same optional ROI filter the score parser applies so an
    out-of-region line can never claim a team either.

    Sides: a line shaped ``HOME 1 - 0 AWAY`` yields home/away from the left/right
    layout; a line with two distinct readable teams in reading order yields
    home then away; a single team yields ``side="unknown"`` (the caller may
    complete the pair when the other side resolved). Unreadable text yields
    ``[]`` — absence is a valid answer.
    """
    if not ocr_lines:
        return []
    claimed: dict[str, TeamText] = {}

    def _claim(team: TeamEntry, side: str, snippet: str, fuzzy: bool) -> None:
        prev = claimed.get(team.name)
        if prev is not None:
            # A concrete side always beats "unknown"; a score-line snippet beats
            # a bare-term snippet. Keep the strongest snippet for the evidence.
            better_side = prev.side == "unknown" and side != "unknown"
            if not better_side:
                return
            claimed[team.name] = TeamText(team.name, side, prev.raw, snippet, prev.fuzzy or fuzzy)
            return
        claimed[team.name] = TeamText(team.name, side, _tokens(snippet)[0] if _tokens(snippet) else "", snippet, fuzzy)

    from .scoreboard import _line_in_roi  # local import: keeps the two parsers separate

    for i, line in enumerate(ocr_lines):
        text = str(line or "").strip()
        if not text:
            continue
        box = ocr_boxes[i] if ocr_boxes is not None and i < len(ocr_boxes) else None
        if roi is not None and not _line_in_roi(roi, box):
            continue
        m = _SCORE_SHAPE_RE.search(text)
        if m:
            left = _resolve_side_tokens(text[: m.start()], sport)
            right = _resolve_side_tokens(text[m.end() :], sport)
            if left:
                team, raw, fuzzy = left[-1]
                _claim(team, "home", text, fuzzy)
            if right:
                team, raw, fuzzy = right[0]
                _claim(team, "away", text, fuzzy)
            continue
        # No score shape: treat as a name plate / banner line. Two distinct
        # teams in reading order map to the scorebug's left/right layout.
        found: list[TeamEntry] = []
        fuzzy_flag = False
        for tok in _tokens(text):
            hit = resolve_token(tok, sport)
            if hit is not None and hit[0] not in found:
                found.append(hit[0])
                fuzzy_flag = fuzzy_flag or hit[1]
        if len(found) >= 2:
            _claim(found[0], "home", text, fuzzy_flag)
            _claim(found[1], "away", text, fuzzy_flag)
        elif len(found) == 1:
            _claim(found[0], "unknown", text, fuzzy_flag)

    # Deterministic order: home first, then away, then unknown.
    order = {"home": 0, "away": 1, "unknown": 2}
    return sorted(claimed.values(), key=lambda t: (order[t.side], t.name))


# ---------------------------------------------------------------------------
# Stage 1b — sport-generic scorebug names (ADAAAA-7898)
# ---------------------------------------------------------------------------
# Every sport in TEAM_LEXICON resolves against a closed club list, and basketball
# resolves against the NBA set only — so a clean OCR read of a non-NBA club buys
# nothing. Measured inside the running perceive image on the CC BY 3.0 basketball
# clip: ``resolve_token('SAMSUNSPOR','basketball')`` -> None,
# ``resolve_token('LAKERS','basketball')`` -> Los Angeles Lakers, and
# ``parse_ocr_teams(['DENIZLI BASKET 11 - 8 SAMSUNSPOR'],'basketball')`` -> [],
# while those same frames plainly print "Denizli Basket 11 - 8 Samsunspor" and
# the decide summaries name both clubs. The names reach the caption layer and the
# resolver discarded them.
#
# This channel reads the two segments either side of the score digits and takes
# the printed token run nearest the score as the name. Lexicon membership is
# replaced by positional + stability requirements, because an over-eager wrong
# club is worse than ``unknown`` (parent AC6, plan §7):
#
#   * it runs ONLY when the lexicon pass resolved NO side at all for this job, so
#     every job whose scorebug the lexicon already names keeps its exact shipped
#     behaviour (the Portugal v Spain class included);
#   * a name must print on >= ``GENERIC_NAME_MIN_FRAMES`` distinct frames AND on
#     >= ``GENERIC_NAME_MIN_SHARE`` of the frames that carried a score line — the
#     corroboration that replaces lexicon membership;
#   * the pair is all-or-nothing: BOTH sides must clear the gate, so a stray
#     advertising-board or branding line can never complete a half pair, and a
#     scorebug whose away half is cropped away stays `unknown` instead of naming
#     one side.
#
# Tokens are bounded to the 3 nearest the score digits, competition/broadcast
# filler is dropped and a token must be >= 4 characters, so branding
# ("TÜRKİYE BASKETBOL LİGİ"), clock/period text ("1.Ç") and single-letter noise
# cannot ride into a name. Confidence is NOT inflated and no threshold is
# lowered: a generic name enters the fold at the same ``scorebug_ocr`` source
# weight as a lexicon hit, so it stays capped at ``SINGLE_SOURCE_CAP`` (below
# ``USABLE_CONFIDENCE``) and a later re-check may revise it.
GENERIC_NAME_MIN_FRAMES = 3
GENERIC_NAME_MIN_SHARE = 0.60
GENERIC_NAME_MAX_TOKENS = 3
GENERIC_NAME_MIN_CHARS = 4
# The same one-edit fuzzy tolerance the closed lexicon already uses for OCR/ASR
# slips (`_levenshtein_le`): a printed club name read two ways ("Samsungspor" /
# "Samsunspor") is ONE name, not two half-majorities. Deliberately 1, so two
# genuinely different clubs are never merged. This groups votes; it does not
# touch any confidence threshold (`USABLE_CONFIDENCE` / `SINGLE_SOURCE_CAP`).
GENERIC_NAME_CLUSTER_EDITS = 1
# Competition / broadcast filler that sits on or beside a scorebug. A fragment
# whose folded form is in this set is BRANDING: it ends the nearest-score token
# run instead of joining a name, which is what keeps
# "TÜRKİYE BASKETBOL LİGİ DENIZLI BASKET 11 8 SAMSUNSPOR" from producing the
# name "DENIZLI BASKET LİGİ". Deliberately does NOT contain "basket": that word
# is part of a real club name ("Denizli Basket").
#
# ADAAAA-7909: the sport words listed here are banner words, but they are also
# the printed SUFFIX of many club plates ("Denizli Basketball" is what the model
# reads off the Denizli plate), so a fragment that folds to one of
# `_GENERIC_SPORT_SUFFIXES` stays allowable as a name token. Branding printed as
# a caps block ("BASKETBOL") is dropped by the caps-run rule below anyway.
_GENERIC_NAME_STOPWORDS = frozenset(
    {
        "ligi",
        "lig",
        "league",
        "leagues",
        "cup",
        "trophy",
        "basketbol",
        "basketball",
        "football",
        "futbol",
        "fútbol",
        "soccer",
        "nba",
        "euroleague",
        "ncaa",
        "nfl",
        "nhl",
        "mlb",
        "live",
        "final",
        "kanal",
        "channel",
        "tv",
        "hd",
        "uhd",
        "quarter",
        "period",
        "half",
        "overtime",
        "türkiye",
        "turkiye",
        "turkey",
        "match",
        "game",
        "teams",
        "team",
        "score",
        "vs",
        "versus",
    }
)
# Printed sport words that can legitimately END a club name, folded to the form
# the vote counts ("Denizli Basketball" and "Denizli Basket" are one name).
_GENERIC_SPORT_SUFFIXES = {
    "basketball": "basket",
    "basketbol": "basket",
    "basketbal": "basket",
}
# Glued runs the model emits as ONE "word" that must be split back into their
# printed parts before a name can be read: "MBDentizi" -> "MB" + "Dentizi",
# "GDenizi" -> "G" + "Denizi", "TURBOYEMBDentizi" -> branding + "Dentizi".
_GENERIC_GLUE_SPLIT_RE = re.compile(
    r"(?<=[a-zà-ÿ])(?=[A-ZÀ-Þ])"  # lower|Upper      (Dentizi|Basket)
    r"|(?<=[A-ZÀ-Þ.])(?=[A-ZÀ-Þ][a-zà-ÿ])"  # CAPS/.|Capitalised (MB|Dentizi, G|Denizi)
)
# A glued OCR run is ONE "word" longer than the lexicon's 24-character token cap
# ("TURKIYEBASKETBOLMBDentizi" is 25), so the generic channel tokenises with its
# own bound — the lexicon's cap silently cut the club name to "Dentiz".
_GENERIC_TOKEN_RE = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.·\-]{0,39}")
# ADAAAA-7909: the score on a broadcast scorebug is separated by a GRAPHIC
# divider, not a printed glyph, so `<OCR>` returns the digits glued straight to
# the club text: "Denizli Basket13 8Samsunspor", "MB11 8Samsunspor1.G". The
# lexicon pass needs the printed "N - M"; this channel splits the side segments
# on the score DIGIT RUN pair instead, which is what the graphic prints.
_GENERIC_SCORE_DIGITS_RE = re.compile(
    r"(?<!\d)(?P<a>\d{1,3})(?!\d)\s*[-–—:.]?\s*(?P<b>\d{1,3})(?!\d)"
)
_GENERIC_LETTER_RE = re.compile(r"[A-Za-zÀ-ÿ]")
# Each side of the score needs at least this many printed letters before the
# split counts as a score line at all (a clock "1.Ç" or a bare score yields none).
_GENERIC_SIDE_MIN_LETTERS = 2


def _fold(text: str) -> str:
    """Case/punctuation-insensitive form used to compare printed names."""
    return " ".join(_norm(text).split())


def _generic_fragments(token: str) -> list[str]:
    """Split one glued OCR token into the printed fragments worth keeping.

    Returns ``[]`` for a token that is pure branding, a league/broadcaster code
    or too short — which is what ENDS the nearest-score run (see
    :func:`_generic_side_run`), so branding can never extend a name.
    """
    out: list[str] = []
    for part in _GENERIC_GLUE_SPLIT_RE.split(token or ""):
        part = part.strip(".,;:!?()[]\"'")
        core = _fold(part)
        if not core:
            continue
        if core in _GENERIC_SPORT_SUFFIXES:
            out.append(part)
            continue
        if core in _GENERIC_NAME_STOPWORDS:
            continue
        # A CAPS run of 3+ characters is a league / broadcaster / team code
        # printed as a block ("MB", "TBF", "TOC"), never part of a club name.
        if part.isupper() and len(part) >= 3:
            continue
        # ADAAAA-7909: an ad-board host / social handle ("Wykes.com",
        # "highlights.live", "@KanalS") is branding printed beside the graphic, not
        # a club — measured on the bounded basketball clip, one frame's home run
        # opened with "Wykes.com" and voted a name no other frame shared.
        if any(ch in part for ch in (".", "/", "@", "\\")) or core.startswith("www"):
            continue
        if len(core) < GENERIC_NAME_MIN_CHARS:
            continue
        out.append(part)
    return out


def _generic_tokens(segment: str, start: int = 0) -> list[tuple[int, str]]:
    """``(offset, token)`` pairs of one side segment, from ``start`` onward."""
    return [(m.start(), m.group(0)) for m in _GENERIC_TOKEN_RE.finditer(segment or "") if m.start() >= start]


def _generic_side_run(
    segment: str,
    side: str,
    start: int = 0,
) -> tuple[Optional[str], Optional[int]]:
    """The printed name nearest the score digits on one side of a score line.

    Broadcast order is ``HOME 11 - 8 AWAY``: the home name ENDS at the score
    digits (read backwards, then restored to print order) and the away name
    STARTS at them. The run stops at the first token that carries no printable
    fragment (branding / code / bracket), which is what bounds it.

    Returns ``(name, consumed_offset)``. ``consumed_offset`` is the character
    offset just past the last token the run consumed, so the caller can look for
    a second name run that the model printed in the other order.
    """
    toks = _generic_tokens(segment, start)
    if side == "home":
        toks = list(reversed(toks))
    picked: list[str] = []
    consumed: Optional[int] = None
    for off, tok in toks:
        # ADAAAA-7909: a token glued onto a period marker ("1.6Denizi") begins a
        # new print run — the away name never starts right after a dot or digit.
        # Stop here so that remainder can be read as the out-of-order home name
        # instead of polluting the away name ("Samsunspor1.GDenizi"). A run
        # STARTED after such a boundary (``picked`` empty) accepts its first
        # token, which is what lets that remainder be read at all.
        if side == "away" and picked and off > start and (segment[off - 1] in ".,:;" or segment[off - 1].isdigit()):
            break
        frags = _generic_fragments(tok)
        if not frags:
            break
        for frag in frags:
            key = _fold(frag)
            # A fragment repeated inside an already-collected one ("Bask" inside
            # "Basket") is one printed word, not a second one.
            if any(key in _fold(p) or _fold(p) in key for p in picked):
                continue
            picked.append(frag)
        consumed = off + len(tok)
        if len(picked) >= GENERIC_NAME_MAX_TOKENS:
            break
    picked = picked[:GENERIC_NAME_MAX_TOKENS]
    if side == "home":
        picked = list(reversed(picked))
    if not picked:
        return None, consumed
    # A run made only of sport words is the banner ("BASKETBALL"), not a club.
    if all(_fold(p) in _GENERIC_SPORT_SUFFIXES for p in picked):
        return None, consumed
    return (" ".join(picked).strip() or None), consumed


def _generic_score_splits(text: str) -> list[tuple[str, str]]:
    """``(left, right)`` segment pairs around the printed score digit run.

    Accepts the glued shape the scorebug actually produces ("13 8", "13.8",
    "138") as well as a printed "13 - 8". A line must carry printed letters on at
    least one side, so a bare score ("13.8") or a clock ("1.Ç") yields nothing.
    """
    out: list[tuple[str, str]] = []
    for m in _GENERIC_SCORE_DIGITS_RE.finditer(text or ""):
        left, right = text[: m.start()], text[m.end() :]
        # One printed side is enough to accept the split (a scorebug whose away
        # half is cropped away still reports `away:no-text` instead of pretending
        # the frame had no score line); the per-side run then declines on its own.
        if len(_GENERIC_LETTER_RE.findall(left + right)) >= _GENERIC_SIDE_MIN_LETTERS:
            out.append((left, right))
    return out


def generic_scorebug_sides(text: str) -> tuple[Optional[str], Optional[str]]:
    """``(home, away)`` names printed on ONE scorebug OCR line (no voting).

    Used by the caller to decide whether a frame's crop read produced any team
    text at all (ADAAAA-7909: a discovered-but-garbage ROI must not suppress the
    whole-frame read), and by the frame vote below.

    The home name comes from the left of the score. When the model printed the
    clubs in the other order the left side is branding only and the home name
    follows the away name in the same line; that second run is read as the home
    name so a swapped read still names both sides instead of dropping one.

    EVERY digit-run split in the line is considered, not just the first: a
    whole-frame read carries ad-board text before the graphic ("…15MIND…13 8
    Samsunspor"), and a junk digit pair in that text must not hide the real
    score. The split that names both sides wins; otherwise the first split that
    names one side is reported (the pair gate decides what is publishable).
    """
    best: tuple[Optional[str], Optional[str]] = (None, None)
    for left, right in _generic_score_splits(text):
        home, _ = _generic_side_run(left, "home")
        away, consumed = _generic_side_run(right, "away")
        if home is None and away is not None and consumed is not None:
            extra, _ = _generic_side_run(right, "away", start=consumed)
            if extra is not None and _fold(extra) != _fold(away):
                home = extra
        if home is not None and away is not None:
            return home, away
        if best == (None, None) and (home is not None or away is not None):
            best = (home, away)
    return best


def _generic_name_key(name: str) -> str:
    """Fold a printed name into the form the frame vote counts.

    A printed sport word at the end ("Basketball") is the same club suffix as
    "Basket", so it folds to it — otherwise one plate read two ways would split
    its own majority.
    """
    toks = str(name or "").split()
    if toks:
        tail = _fold(toks[-1])
        if tail in _GENERIC_SPORT_SUFFIXES:
            toks[-1] = _GENERIC_SPORT_SUFFIXES[tail]
    return _fold(" ".join(toks))


def _generic_vote_cluster(votes: Mapping[str, Mapping[str, int]]) -> tuple[str, list[str], int]:
    """The best-supported printed variant and every variant within one edit of it.

    ADAAAA-7909: the same one-edit tolerance the lexicon pass uses, applied
    uniformly instead of first-seen-first-grouped. A greedy pass against the
    existing GROUP KEYS is order-dependent: measured on the bounded basketball
    clip, ONE club printed three ways ("Dentizi" 5, "Denizi" 9, "Denizli" 7) split
    into 14 + 7 because "Dentizi" was seen first and "Denizli" is two edits from
    it, so the side was rejected as unstable at 14/30 while 21 frames actually
    named it. Choosing the variant the most frames agree with — and summing every
    variant within one edit of THAT — is order-independent, and it does not widen
    the tolerance: it is still one edit, still >= 3 frames, still >= 60 %.
    """
    totals = {key: sum(v.values()) for key, v in votes.items()}
    best_key = ""
    best_score = -1
    best_members: list[str] = []
    for key in sorted(totals):
        members = [o for o in totals if _levenshtein_le(key, o, GENERIC_NAME_CLUSTER_EDITS)]
        score = sum(totals[o] for o in members)
        # Tie -> the variant read on more frames, then the sorted key (stable).
        if score > best_score or (score == best_score and totals[key] > totals.get(best_key, 0)):
            best_key, best_score, best_members = key, score, members
    return best_key, best_members, best_score


def parse_generic_scorebug_names(
    ocr_frames: Optional[Sequence[Mapping[str, Any]]],
    sport: str,
) -> tuple[list[TeamText], dict[str, Any]]:
    """Names printed on a scorebug that the closed club lexicon does not cover.

    Returns ``(teams, status)`` where ``teams`` is either a complete home/away
    pair of :class:`TeamText` (``generic=True``) or ``[]``. ``status`` is the
    inspectable account of the channel (``scoreFrames``, the per-side vote, the
    accepted names with the printed variants that voted for each, and why a side
    was rejected) so an ``unknown`` job says what the gate saw instead of just
    reporting nothing.

    Pure and GPU-free: it reads the OCR lines the caller already has.
    """
    status: dict[str, Any] = {"scoreFrames": 0, "rejected": []}
    if not ocr_frames or sport == SPORT_UNKNOWN:
        return [], status
    # side -> printed variant key -> {printed form: frames}; ONE vote per frame per
    # side (ADAAAA-7909), which is what makes the cluster share comparable to the
    # frames that carried a score line.
    votes: dict[str, dict[str, dict[str, int]]] = {"home": {}, "away": {}}
    snippets: dict[str, dict[str, str]] = {"home": {}, "away": {}}
    score_frames = 0
    for frame in ocr_frames:
        lines = frame.get("lines") or frame.get("ocr") or []
        if not lines:
            continue
        frame_scored = False
        picked: dict[str, Optional[tuple[str, str]]] = {"home": None, "away": None}
        for line in lines:
            text = str(line or "").strip()
            if not text:
                continue
            splits = _generic_score_splits(text)
            if not splits:
                continue
            frame_scored = True
            home, away = generic_scorebug_sides(text)
            for side, name, segment in (
                ("home", home, splits[0][0]),
                ("away", away, splits[0][1]),
            ):
                # The first read on this frame that names the side wins; a second
                # line describing the same frame is not extra corroboration.
                if not name or picked[side] is not None:
                    continue
                # A side the lexicon already names is never re-read here.
                if _resolve_side_tokens(segment, sport):
                    continue
                picked[side] = (name, text[:200])
        if frame_scored:
            score_frames += 1
        for side in ("home", "away"):
            entry = picked[side]
            if entry is None:
                continue
            name, snippet = entry
            key = _generic_name_key(name)
            votes[side].setdefault(key, {})
            votes[side][key][name] = votes[side][key].get(name, 0) + 1
            snippets[side].setdefault(key, snippet)
    status["scoreFrames"] = score_frames
    if not score_frames:
        status["rejected"].append("no-score-line")
        return [], status
    picks: dict[str, tuple[str, str, int]] = {}
    for side in ("home", "away"):
        if not votes[side]:
            status["rejected"].append(f"{side}:no-text")
            continue
        group, members, n = _generic_vote_cluster(votes[side])
        printed: dict[str, int] = {}
        for member in members:
            for name, count in votes[side][member].items():
                printed[name] = printed.get(name, 0) + count
        share = n / score_frames
        if n < GENERIC_NAME_MIN_FRAMES or share < GENERIC_NAME_MIN_SHARE:
            status["rejected"].append(f"{side}:unstable({n}/{score_frames})")
            continue
        # Publish the spelling the model printed most often inside the cluster;
        # ties break on the printed form so the published spelling never depends
        # on the order the frames arrived in (ADAAAA-7909).
        name = max(sorted(printed), key=lambda k: (printed[k], k))
        picks[side] = (name, snippets[side].get(group, ""), n)
        status.setdefault("names", {})[side] = {
            "name": name,
            "frames": n,
            "share": round(share, 3),
            "variants": dict(sorted(printed.items())),
        }
    if len(picks) < 2:
        return [], status
    if _generic_name_key(picks["home"][0]) == _generic_name_key(picks["away"][0]):
        status["rejected"].append("both-sides-same-name")
        status.pop("names", None)
        return [], status
    return [
        TeamText(picks["home"][0], "home", picks["home"][0], picks["home"][1], generic=True),
        TeamText(picks["away"][0], "away", picks["away"][0], picks["away"][1], generic=True),
    ], status


def scorebug_lines_sides(ocr_lines: Optional[Sequence[str]], sport: str) -> set[str]:
    """Which sides of the score these OCR lines actually name.

    ADAAAA-7909: a region that clips part of the graphic can read ONE side and
    still count as "team text present" — measured on the bounded basketball job,
    the crop named the away club on 27/30 frames and the home plate on only 10,
    so the gate blocked a pair that the region was not even showing. This returns
    the sides a read covers so the caller can repair the region when it covers
    fewer than two.
    """
    sides: set[str] = set()
    for line in ocr_lines or []:
        text = str(line or "").strip()
        if not text:
            continue
        for team in parse_ocr_teams([text], sport):
            if team.side in ("home", "away"):
                sides.add(team.side)
        home, away = generic_scorebug_sides(text)
        if home:
            sides.add("home")
        if away:
            sides.add("away")
    return sides


def scorebug_lines_have_team_text(ocr_lines: Optional[Sequence[str]], sport: str) -> bool:
    """True when these OCR lines carry a real team name (lexicon OR printed club).

    The ADAAAA-7190 whole-frame fallback used to fire only when the ROI crop read
    no SCORE, so a crop that parsed a score out of the crowd clock while reading
    no club text ("1515K") suppressed the whole-frame read that could see them.
    This predicate is the missing "did the crop read any team text" test; it is
    pure CPU (regex only) and adds no GPU work by itself.
    """
    for line in ocr_lines or []:
        text = str(line or "").strip()
        if not text:
            continue
        if any(resolve_token(tok, sport, allow_fuzzy=False) is not None for tok in _tokens(text)):
            return True
        home, away = generic_scorebug_sides(text)
        if home or away:
            return True
    return False


# ---------------------------------------------------------------------------
# Stage 2 — commentary probe scan
# ---------------------------------------------------------------------------
_KIT_COLOR_WORDS = (
    "red",
    "white",
    "black",
    "blue",
    "navy",
    "sky blue",
    "green",
    "yellow",
    "orange",
    "purple",
    "pink",
    "grey",
    "gray",
    "maroon",
    "teal",
    "gold",
    "silver",
    "brown",
    "cyan",
)
_KIT_PHRASE_RE = re.compile(
    r"\b(?:in|wearing|dressed in|sporting|with)\b[^.,;!?]{0,24}?\b("
    + "|".join(re.escape(c) for c in sorted(_KIT_COLOR_WORDS, key=len, reverse=True))
    + r")\b(?:\s+(?:shirts?|jerseys?|kits?|strips?|tops?|uniforms?))?",
    re.IGNORECASE,
)
# "Portugal in the white shirts" / "the side in red" — a phrase that names a kit
# colour within a clause. Team association requires the SAME clause to name
# exactly one team, otherwise the colour is not attributable.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;:])\s+|\n+")


@dataclass
class CommentaryMention:
    name: str
    snippet: str
    kit_color: Optional[str] = None
    # Character span of the clause that produced the mention, inside the
    # transcript the resolver was handed (ADAAAA-7889 AC2). A stored job can
    # then point at the exact commentary text instead of only naming the team.
    start: Optional[int] = None
    end: Optional[int] = None


def scan_commentary(transcript: Optional[str], sport: str) -> list[CommentaryMention]:
    """Find team mentions (and kit phrases) in one bounded transcript.

    Returns every resolved mention with the clause that produced it. Kit
    colours are attached only when the clause names exactly ONE team and a
    colour word — "Spain in the white shirts" attributes white to Spain, while
    "Portugal in red and Spain in white" leaves both colours unattributed (the
    caller then falls back to the scorebug swatches). Never invents a team: an
    unrecognised name is simply absent.
    """
    text = (transcript or "").strip()
    if not text or sport == SPORT_UNKNOWN:
        return []
    out: list[CommentaryMention] = []
    seen: set[str] = set()
    # Clause + its offset in the transcript, so every mention can report the
    # span it came from (ADAAAA-7889 AC2: an unknown must be diagnosable from
    # the record alone). `_SENTENCE_SPLIT_RE.split` drops the separators, so the
    # offsets are rebuilt from the separator matches instead of from lengths.
    clauses: list[tuple[str, int]] = []
    last = 0
    for sep in _SENTENCE_SPLIT_RE.finditer(text):
        clauses.append((text[last : sep.start()], last))
        last = sep.end()
    clauses.append((text[last:], last))
    for raw_clause, base in clauses:
        clause = raw_clause.strip()
        if not clause:
            continue
        start = base + (len(raw_clause) - len(raw_clause.lstrip()))
        end = start + len(clause)
        mentions: list[str] = []
        for tok in _tokens(clause):
            hit = resolve_token(tok, sport, allow_fuzzy=True)
            if hit is None:
                continue
            if hit[0].name not in mentions:
                mentions.append(hit[0].name)
        if not mentions:
            continue
        color: Optional[str] = None
        if len(mentions) == 1:
            km = _KIT_PHRASE_RE.search(clause)
            if km:
                color = _norm(km.group(1))
        for name in mentions:
            key = f"{name}|{color or ''}"
            if key in seen:
                continue
            seen.add(key)
            out.append(
                CommentaryMention(
                    name=name,
                    snippet=clause[:180],
                    kit_color=color,
                    start=start,
                    end=end,
                )
            )
    return out


# ---------------------------------------------------------------------------
# Stage 3 — kit colours (GPU-free)
# ---------------------------------------------------------------------------
# Colour naming: HSV buckets over sampled torso pixels. Names are the human
# vocabulary the prompt block and the plan contract use ("red", "white", ...).
_COLOR_BUCKETS: tuple[tuple[str, float, float], ...] = (
    # (name, hue_lo, hue_hi) in degrees for saturated colours
    ("red", 345.0, 15.0),
    ("orange", 15.0, 40.0),
    ("gold", 40.0, 55.0),
    ("yellow", 55.0, 68.0),
    ("green", 68.0, 165.0),
    ("cyan", 165.0, 200.0),
    ("sky blue", 200.0, 225.0),
    ("blue", 225.0, 255.0),
    ("purple", 255.0, 300.0),
    ("pink", 300.0, 345.0),
)


def rgb_to_hsv(rgb: Sequence[float]) -> tuple[float, float, float]:
    """(hue degrees, saturation 0..1, value 0..1) for an 0..255 RGB triple."""
    r, g, b = (max(0.0, min(255.0, float(v))) / 255.0 for v in rgb)
    mx, mn = max(r, g, b), min(r, g, b)
    delta = mx - mn
    if delta == 0:
        h = 0.0
    elif mx == r:
        h = (60.0 * ((g - b) / delta)) % 360.0
    elif mx == g:
        h = 60.0 * ((b - r) / delta) + 120.0
    else:
        h = 60.0 * ((r - g) / delta) + 240.0
    sat = 0.0 if mx == 0 else delta / mx
    return h, sat, mx


def name_color(rgb: Sequence[float]) -> str:
    """Map one sampled RGB to a human colour name.

    Low-saturation pixels are "white"/"grey"/"black" by value; saturated pixels
    take the nearest hue bucket. This is a naming function, not a classifier —
    two different jerseys that both name "red" are exactly the away-kit
    collision the resolver reports as ``ambiguous`` instead of guessing.
    """
    h, s, v = rgb_to_hsv(rgb)
    if v < 0.12:
        return "black"
    if s < 0.18:
        if v > 0.82:
            return "white"
        if v > 0.45:
            return "grey"
        return "black"
    if s < 0.35:
        # Muted light tones read as the pastel/light variant of their hue.
        if v > 0.72:
            return "white"
    for name, lo, hi in _COLOR_BUCKETS:
        if lo > hi:  # red wraps 345..360 + 0..15
            if h >= lo or h <= hi:
                # A dark-red shirt is still "red" in kit vocabulary; only a
                # near-black red reads as maroon (v < 0.22).
                return "maroon" if (name == "red" and v < 0.22) else name
        elif lo <= h < hi:
            # Dark saturated blue is "navy" in kit vocabulary; the light end of
            # the same hue is "sky blue" for azzurri-style shirts.
            if name == "blue" and v < 0.42:
                return "navy"
            if name == "sky blue" and v < 0.42:
                return "blue"
            return name
    return "grey"


# Colour families for the curated kit prior (ADAAAA-7866): a prior primary may
# match an observed cluster by exact name first, then by family. The families
# absorb the naming drift a broadcast crop produces (a dark red shirt reading
# "maroon", an azzurri shirt reading "sky blue"), while keeping genuinely
# different shirts apart — a family is never a licence to pick an unrelated
# colour.
_KIT_COLOR_FAMILIES: dict[str, str] = {
    "red": "warm-red",
    "maroon": "warm-red",
    "orange": "yellow-orange",
    "gold": "yellow-orange",
    "yellow": "yellow-orange",
    "green": "green",
    "teal": "green",
    "cyan": "blue",
    "sky blue": "blue",
    "blue": "blue",
    "navy": "blue",
    "purple": "purple-pink",
    "pink": "purple-pink",
    "white": "neutral-light",
    "silver": "neutral-light",
    "grey": "neutral-dark",
    "gray": "neutral-dark",
    "black": "neutral-dark",
    "brown": "neutral-dark",
}
# The colour vocabulary a prior entry may use: every name ``name_color`` can
# return (the buckets plus the neutral value/saturation names). An entry outside
# this set could never match an observed cluster, so it is a table bug rather
# than a runtime case (AC-P6).
_KIT_COLOR_NAMES = frozenset(_KIT_COLOR_FAMILIES)


def _color_family(color: str) -> str:
    """Family name for one colour, or ``"unknown"`` for a token outside the map."""
    return _KIT_COLOR_FAMILIES.get(_norm(color), "unknown")


def _is_pitch_or_background(rgb: Sequence[float]) -> bool:
    """True for grass / pitch / sky pixels that are not a jersey.

    Green pitch dominates a soccer frame; a torso crop still catches pitch
    between arms and legs, so a saturated mid-green sample must never become a
    "green kit". The band is narrow enough to keep genuinely green kits
    (Ireland, Nigeria, Wolfsburg) when the sample sits on the shirt — those
    samples are usually darker or brighter than broadcast grass, so the value
    band is bounded on both sides.
    """
    h, s, v = rgb_to_hsv(rgb)
    if s > 0.35 and 75.0 <= h <= 165.0 and 0.18 <= v <= 0.62:
        return True
    # Very bright low-sat pixels are stadium LED / white ad boards / sky.
    if v > 0.97 and s < 0.10:
        return True
    return False


def _is_skin_tone(rgb: Sequence[float]) -> bool:
    """True for bare-skin pixels (face/arms/legs) in a broadcast crop.

    A tracked player's box contains face and arms, so the modal colour of a
    sloppy crop is skin (measured on the cited job: [111,84,68] "orange" won the
    mode on a red-shirted player). Skin sits in a narrow warm band; rejecting it
    keeps jerseys and shorts, which is what a kit colour is. A genuinely orange
    kit is rare enough that requiring the jersey to win the mode of the remaining
    pixels is the safer trade (an unknown colour beats a wrong one).
    """
    h, s, v = rgb_to_hsv(rgb)
    return 8.0 <= h <= 45.0 and 0.16 <= s <= 0.62 and 0.40 <= v <= 0.94


def is_plausible_player_box(box: Optional[Sequence[float]]) -> bool:
    """True when a tracked box can be a single player's torso crop.

    A normalized ``[x0, y0, x1, y1]`` that is a plausible standing player: a
    bounded area (``MAX_KIT_BOX_AREA``), no side wider than
    ``MAX_KIT_BOX_SIDE`` (a broadcast frame is not a near-full-width band), and
    taller than wide. Junk SAM3 seeds — an advertising band spanning 0.997 of
    the frame, a boot, a leg, a grass strip — fail at least one bound and are
    never sampled, so they cannot define a kit colour.
    """
    if not box or len(box) != 4:
        return False
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        return False
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return False
    return (w * h) <= MAX_KIT_BOX_AREA and w <= MAX_KIT_BOX_SIDE and h <= MAX_KIT_BOX_SIDE and h > w


def sample_track_colors(
    frame_rgb: Any,
    tracks: Iterable[Mapping[str, Any]],
    max_tracks: int = 6,
    torso_y: tuple[float, float] = (0.28, 0.52),
) -> list[dict[str, Any]]:
    """Sample the torso colour of tracked player crops (CPU, no GPU).

    ``frame_rgb`` is an HxWx3 numpy array (or a nested list); ``tracks`` are the
    perception pass's own track dicts with a normalized ``box``
    ``[x0, y0, x1, y1]`` and a ``label``/``trackId``. Only player-like tracks
    contribute, and only when the box is a plausible single player
    (:func:`is_plausible_player_box`) — a SAM3 seed that propagated onto an
    advertising band, a boot or a strip of grass is skipped instead of being
    sampled as a "kit". The torso band (default 22-58% of the box height) is
    averaged after discarding pitch/background pixels, which is why this is a
    colour *sample* rather than a segmentation.

    Returns ``[{trackId, label, ts?, side, rgb:[r,g,b]}]``. An empty list is a
    valid result (no players tracked, unusable frame) — the caller folds that
    into ``ambiguous`` rather than fabricating a colour.
    """
    if frame_rgb is None:
        return []
    try:
        h_px = len(frame_rgb)
        w_px = len(frame_rgb[0]) if h_px else 0
    except TypeError:
        return []
    if h_px < 8 or w_px < 8:
        return []
    out: list[dict[str, Any]] = []
    for track in list(tracks)[: max(1, max_tracks)]:
        label = str(track.get("label") or track.get("kind") or "").lower()
        if label and not any(k in label for k in ("player", "goalkeeper", "skater", "batter", "athlete", "person")):
            continue
        box = track.get("box") or track.get("bbox")
        if not box or len(box) != 4:
            continue
        try:
            x0, y0, x1, y1 = (float(v) for v in box)
        except (TypeError, ValueError):
            continue
        # Normalized boxes; accept pixel boxes too by normalizing on the frame.
        if max(x0, y0, x1, y1) > 1.5:
            x0, x1 = x0 / w_px, x1 / w_px
            y0, y1 = y0 / h_px, y1 / h_px
        if not (0.0 <= x0 < x1 <= 1.0 and 0.0 <= y0 < y1 <= 1.0):
            continue
        if not is_plausible_player_box((x0, y0, x1, y1)):
            # A SAM3 seed that propagated onto an ad board / boot / grass band.
            # Sampling it would let a junk colour become a "kit" (see
            # MAX_KIT_BOX_AREA); an unusable frame is the honest answer.
            continue
        px0, px1 = int(x0 * w_px), max(int(x0 * w_px) + 1, int(x1 * w_px))
        # Inner torso box: 15-85% of the width, 25-60% of the height. The middle
        # of a tracking box is the shirt; the edges catch the pitch, an arm or a
        # neighbouring player. A box that covers most of the frame (a close-up)
        # still samples its own shirt region.
        bx0 = px0 + int((px1 - px0) * 0.15)
        bx1 = max(bx0 + 1, px0 + int((px1 - px0) * 0.85))
        py0 = int((y0 + (y1 - y0) * torso_y[0]) * h_px)
        py1 = max(py0 + 1, int((y0 + (y1 - y0) * torso_y[1]) * h_px))
        # MODAL colour, not the mean: a mean blends jersey + grass + skin into a
        # muddy brown (measured on the cited Portugal vs Spain job: red shirts
        # averaged to [118,137,152] blue-grey). The dominant colour NAME inside
        # the torso, averaged over only the pixels carrying that name, is the
        # shirt. Requires >= 30% of the sampled pixels to agree, so a genuinely
        # mixed crop yields no sample instead of a fake kit.
        tally: dict[str, list[list[float]]] = {}
        step_y = max(1, (py1 - py0) // 18)
        step_x = max(1, (bx1 - bx0) // 18)
        total = 0
        for yy in range(py0, min(py1, h_px), step_y):
            row = frame_rgb[yy]
            for xx in range(bx0, min(bx1, w_px), step_x):
                rgb = row[xx]
                if _is_pitch_or_background(rgb) or _is_skin_tone(rgb):
                    continue
                total += 1
                tally.setdefault(name_color(rgb), []).append([float(rgb[0]), float(rgb[1]), float(rgb[2])])
        if total < 8 or not tally:
            continue
        colour, pixels = max(tally.items(), key=lambda kv: len(kv[1]))
        if len(pixels) < max(6, int(0.35 * total)):
            continue
        n = len(pixels)
        rgb_out = [round(sum(p[i] for p in pixels) / n, 1) for i in range(3)]
        out.append(
            {
                "trackId": track.get("trackId") or track.get("id"),
                "label": label,
                "ts": track.get("ts"),
                "side": "left" if (x0 + x1) / 2.0 < 0.5 else "right",
                "color": colour,
                "rgb": rgb_out,
                "frames": 1,
            }
        )
    return out


def _dominant_swatch(rgb_rows: Sequence[Any], w0: int, w1: int, h0: int, h1: int) -> Optional[list[float]]:
    """Dominant saturated colour of one scoreboard-ROI half, or ``None``.

    The scorebug carries the side's kit colour as a flag/bar next to the team
    name. That swatch is the "scorebug layout" association source for kit
    colours (plan §3 Stage 3). Background text/LED white, black and the
    translucent banner fill are excluded so the swatch is the actual team
    colour, and a half with no saturated pixel returns ``None`` (never a guess).
    """
    tally: dict[str, list[list[float]]] = {}
    total = 0
    try:
        rows = len(rgb_rows)
    except TypeError:
        return None
    for yy in range(max(0, h0), min(rows, h1), max(1, (h1 - h0) // 24)):
        row = rgb_rows[yy]
        for xx in range(max(0, w0), min(len(row), w1), max(1, (w1 - w0) // 32)):
            rgb = row[xx]
            h, s, v = rgb_to_hsv(rgb)
            # Keep only clearly coloured, non-pitch pixels: a white banner fill,
            # a dark banner edge, or the grass behind a translucent score bug must
            # never become the team colour. (Measured failure this guards: the
            # cited job's ROI halves averaged to the pitch green [100,129,55].)
            if s < 0.30 or v < 0.18 or v > 0.96 or _is_pitch_or_background(rgb):
                continue
            total += 1
            tally.setdefault(name_color(rgb), []).append([float(rgb[0]), float(rgb[1]), float(rgb[2])])
    if total < 12 or not tally:
        return None
    colour, pixels = max(tally.items(), key=lambda kv: len(kv[1]))
    # A swatch must be a DOMINANT colour in its half — a score bug over grass has
    # no dominant colour and yields None rather than a green "home kit".
    if len(pixels) < max(10, int(0.35 * total)):
        return None
    n = len(pixels)
    return {"rgb": [round(sum(p[i] for p in pixels) / n, 1) for i in range(3)], "color": colour}


def sample_scorebug_swatches(frame_rgb: Any, roi: Any, ts: Optional[float] = None) -> list[dict[str, Any]]:
    """Sample the home/away kit swatches from the scoreboard ROI (CPU, free).

    ``roi`` is the same ``ScoreboardRoi`` the OCR pass crops to. Broadcast
    layout puts the home team on the LEFT of the score and the away team on the
    right, so half the ROI is the home swatch and half the away swatch. Returns
    ``[{side, rgb, ts}]`` for whichever halves carry a usable colour; calling
    this on the same ROI crop the score parser reads adds no GPU work.
    """
    if frame_rgb is None or roi is None:
        return []
    try:
        h_px = len(frame_rgb)
        w_px = len(frame_rgb[0]) if h_px else 0
    except TypeError:
        return []
    if h_px < 8 or w_px < 16:
        return []
    x0 = int(max(0.0, min(1.0, float(roi.x0))) * w_px)
    x1 = int(max(0.0, min(1.0, float(roi.x1))) * w_px)
    y0 = int(max(0.0, min(1.0, float(roi.y0))) * h_px)
    y1 = int(max(0.0, min(1.0, float(roi.y1))) * h_px)
    if x1 - x0 < 8 or y1 - y0 < 4:
        return []
    mid = x0 + (x1 - x0) // 2
    out: list[dict[str, Any]] = []
    for side, (a, b) in (("home", (x0, mid)), ("away", (mid, x1))):
        sw = _dominant_swatch(frame_rgb, a, b, y0, y1)
        if sw is not None:
            out.append({"side": side, "rgb": sw["rgb"], "color": sw["color"], "ts": ts})
    # A side's swatch only carries kit information when the two halves resolve to
    # DIFFERENT colours. Identical swatches mean the ROI is a shared graphic
    # (national flags / a translucent banner over grass) and cannot associate a
    # kit colour with a side — report nothing rather than assign both teams the
    # same colour.
    if len(out) == 2 and out[0].get("color") == out[1].get("color"):
        return []
    return out


def stable_swatch_by_side(swatches: Optional[Sequence[Mapping[str, Any]]]) -> dict[str, dict[str, Any]]:
    """Per-side swatch colour that REPEATS across frames, or nothing.

    ``sample_scorebug_swatches`` reads one dominant colour per ROI half per
    frame. When the scoreboard sits over advertising boards those halves read the
    boards, and consecutive frames disagree — measured on the cited job, the away
    half read blue, sky blue, orange, red, maroon and pink. A colour is therefore
    trusted only when it is the side's modal reading over at least
    ``MIN_SWATCH_FRAMES`` frames and holds at least ``MIN_SWATCH_SHARE`` of that
    side's readings. An unstable side is dropped: no kit colour beats a wrong one.
    """
    counts: dict[str, dict[str, int]] = {}
    rgbs: dict[tuple[str, str], list[list[float]]] = {}
    for sw in swatches or []:
        if not isinstance(sw, Mapping):
            continue
        side = str(sw.get("side") or "")
        rgb = sw.get("rgb")
        if side not in ("home", "away") or not rgb or len(rgb) != 3:
            continue
        # The sample carries its colour name; derive it when a caller only has
        # the RGB (same naming function, so the two paths cannot disagree).
        colour = str(sw.get("color") or name_color(rgb))
        counts.setdefault(side, {})
        counts[side][colour] = counts[side].get(colour, 0) + 1
        rgbs.setdefault((side, colour), []).append([float(v) for v in rgb])
    out: dict[str, dict[str, Any]] = {}
    for side, tally in counts.items():
        total = sum(tally.values())
        colour, n = max(tally.items(), key=lambda kv: (kv[1], kv[0]))
        # One reading has nothing to disagree with; repeated readings must agree.
        if total > 1 and (n < 2 or n / total < MIN_SWATCH_SHARE):
            continue
        rows = rgbs.get((side, colour)) or []
        mean = [round(sum(r[i] for r in rows) / len(rows), 1) for i in range(3)] if rows else None
        out[side] = {"side": side, "color": colour, "rgb": mean}
    return out


def _dist(a: Sequence[float], b: Sequence[float]) -> float:
    return math.sqrt(sum((float(a[i]) - float(b[i])) ** 2 for i in range(3)))


def _kmeans2(samples: Sequence[Sequence[float]], iters: int = 8) -> list[list[float]]:
    """Deterministic 2-means over RGB samples (init = the farthest pair).

    Deterministic on purpose: the persisted resolver trail must be reproducible
    for the AC4 audit, so the clustering cannot depend on a random seed.
    """
    pts = [list(map(float, s)) for s in samples]
    if not pts:
        return []
    if len(pts) == 1:
        return [pts[0]]
    # Farthest-pair init.
    best = (0, 1, -1.0)
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = _dist(pts[i], pts[j])
            if d > best[2]:
                best = (i, j, d)
    centers = [pts[best[0]], pts[best[1]]]
    for _ in range(iters):
        groups: list[list[list[float]]] = [[], []]
        for p in pts:
            groups[0 if _dist(p, centers[0]) <= _dist(p, centers[1]) else 1].append(p)
        moved = False
        for k, g in enumerate(groups):
            if not g:
                continue
            c = [sum(v[i] for v in g) / len(g) for i in range(3)]
            if _dist(c, centers[k]) > 0.5:
                moved = True
            centers[k] = c
        if not moved:
            break
    return centers


def _sample_rgb(sample: Mapping[str, Any]) -> Optional[list[float]]:
    """Validated RGB triple from a kit sample, or ``None`` (never raises)."""
    raw = sample.get("rgb") if isinstance(sample, Mapping) else None
    if raw is None and isinstance(sample, Mapping):
        raw = sample.get("color")
    if not raw or len(raw) != 3:
        return None
    try:
        rgb = [float(v) for v in raw]
    except (TypeError, ValueError):
        return None
    if any(v < 0 or v > 255 for v in rgb):
        return None
    return rgb


@dataclass
class KitCluster:
    primary: str
    secondary: Optional[str]
    rgb: list[float]
    frames: int
    count: int


def cluster_kit_colors(
    samples: Sequence[Mapping[str, Any]],
    min_frames: int = KIT_MIN_FRAMES,
) -> list[KitCluster]:
    """Cluster kit samples into up to two colour clusters (plan §3 Stage 3).

    A cluster needs ``min_frames`` distinct frames to count, so one noisy crop
    cannot define a kit. The primary colour is the cluster centroid's name and
    the secondary is a minority colour inside the same cluster (trim/shorts)
    only when it holds >= 15% of that cluster's samples. Two clusters that name
    the SAME colour are returned as-is; the caller turns that into
    ``ambiguous: true`` rather than picking one.
    """
    usable: list[tuple[Mapping[str, Any], list[float]]] = []
    for s in samples or []:
        rgb = _sample_rgb(s)
        if rgb is None:
            continue
        if _is_pitch_or_background(rgb):
            continue
        usable.append((s, rgb))
    if len(usable) < min_frames:
        return []
    centers = _kmeans2([rgb for _s, rgb in usable])
    if not centers:
        return []
    groups: list[list[tuple[Mapping[str, Any], list[float]]]] = [[] for _ in centers]
    for s, rgb in usable:
        k = 0 if len(centers) == 1 or _dist(rgb, centers[0]) <= _dist(rgb, centers[1]) else 1
        groups[k].append((s, rgb))
    clusters: list[KitCluster] = []
    for k, group in enumerate(groups):
        if not group:
            continue
        stamps = {s.get("ts") for s, _rgb in group if s.get("ts") is not None}
        keys = {(s.get("ts"), s.get("frameSeq"), s.get("frameId"), s.get("trackId")) for s, _rgb in group}
        frames = max(len(stamps), len(keys))
        if frames < min_frames:
            continue
        names = [name_color(rgb) for _s, rgb in group]
        counts: dict[str, int] = {}
        for n in names:
            counts[n] = counts.get(n, 0) + 1
        # Primary is the CLUSTER CENTROID's name, not the majority of per-crop
        # names. Measured on the cited job: distant player crops read skin /
        # ad-board shades, so the majority name was "orange" (94) over "red" (46)
        # while the cluster centroid [83, 51, 47] is plainly red — the majority
        # vote put a WRONG colour on Portugal. A muddy centroid that no sample
        # supports (mixed trim) falls back to the loudest sample name so a
        # two-tone cluster still names a real colour.
        primary = name_color(centers[k])
        if counts and primary not in counts:
            primary = max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]
        secondary: Optional[str] = None
        for name, c in sorted(counts.items(), key=lambda kv: -kv[1]):
            if name != primary and c >= max(3, int(0.30 * len(group))):
                secondary = name
                break
        clusters.append(
            KitCluster(
                primary=primary,
                secondary=secondary,
                rgb=list(centers[k]),
                frames=frames,
                count=len(group),
            )
        )
    return clusters


# ---------------------------------------------------------------------------
# Stage 3b — curated kit-colour prior (ADAAAA-7866, option 1 of ADAAAA-7864)
# ---------------------------------------------------------------------------
# A per-team canonical PRIMARY kit colour, used ONLY as an attribution key: it
# decides which already-observed cluster belongs to which team, never what that
# cluster's colour is. Keyed by CANONICAL lexicon name (every resolver path
# funnels through ``resolve_token``, so the names reaching ``associate_kits``
# are already canonical).
#
# A separate dict on purpose: ``_SOCCER_TEAMS`` stays untouched (80 rows), and a
# unit test can assert every key is a real canonical name and every colour is in
# the ``name_color`` vocabulary. Seed entries are MEASURED only — a second-hand
# entry is a wrong colour on the record, which is the one failure the plan's
# AC3 forbids. A further entry needs a cited source on its line.
_SOCCER_KIT_PRIORS: dict[str, tuple[str, Optional[str]]] = {
    # ADAAAA-7859 anchor frames on job dee44c2f: Portugal's red shirt is
    # visible in 10/10 frames; Spain's white shirt in 7/10 (and one close-up).
    "Portugal": ("red", None),
    "Spain": ("white", None),
}

# Sport -> prior table. Sports without a curated table keep the channel OFF, so
# their evidenceStatus never carries kitPriorMiss noise.
_KIT_PRIORS: dict[str, dict[str, tuple[str, Optional[str]]]] = {
    "soccer": _SOCCER_KIT_PRIORS,
}


def _prior_match_rank(primary: str, cluster: KitCluster) -> Optional[int]:
    """0 = prior primary equals the cluster's name, 2 = same family, None = no.

    The prior SECONDARY is deliberately NOT a matching key: trim/shorts colour is
    not the shirt colour, and matching it lets a team grab the opponent's primary
    (measured failure mode in simulation: Spain's "navy" trim against a navy away
    shirt on the other side — guardrail R1 of the ratified decision).
    """
    if _norm(cluster.primary) == _norm(primary):
        return 0
    family = _color_family(primary)
    if family != "unknown" and family == _color_family(cluster.primary):
        return 2
    return None


def _resolve_kit_prior(
    unresolved: Sequence[Mapping[str, Any]],
    clusters: Sequence[KitCluster],
    used: set[int],
    kit_prior: Mapping[str, tuple[str, Optional[str]]],
) -> tuple[list[tuple[str, int]], list[str], list[str]]:
    """Resolve the still-unattributed sides from the curated prior.

    All-or-nothing over the unresolved set (guardrail R3): the prior publishes
    only when EVERY unresolved side resolves to a DISTINCT unused cluster. Any
    miss, and any two sides landing on the same cluster, voids the pass — a
    single-sided guess assumes the matching cluster belongs to that side, and an
    away-kit swap breaks exactly that assumption.

    Returns ``(picks, miss, conflict)`` where ``picks`` is empty whenever the
    pass is voided. ``miss`` names every side without a usable hit (not just the
    first), ``conflict`` names every side in a shared-cluster collision.
    """
    picks: list[tuple[str, int]] = []
    miss: list[str] = []
    for team in unresolved:
        side = str(team.get("side") or "unknown")
        prior = kit_prior.get(str(team.get("name") or ""))
        primary = prior[0] if prior else None
        ranked: list[tuple[int, int, int]] = []
        if primary:
            for i, c in enumerate(clusters):
                if i in used:
                    continue
                rank = _prior_match_rank(primary, c)
                if rank is None:
                    continue
                # Exact name first, then the biggest measured cluster.
                ranked.append((rank, -c.count, i))
        if not ranked:
            miss.append(side)
            continue
        picks.append((side, sorted(ranked)[0][2]))
    shared: dict[int, list[str]] = {}
    for side, idx in picks:
        shared.setdefault(idx, []).append(side)
    conflict = [side for sides in shared.values() if len(sides) > 1 for side in sides]
    if miss or conflict:
        return [], miss, conflict
    return picks, miss, conflict


def associate_kits(
    teams: Sequence[Mapping[str, Any]],
    clusters: Sequence[KitCluster],
    scorebug_swatches: Optional[Sequence[Mapping[str, Any]]] = None,
    commentary: Optional[Sequence[CommentaryMention]] = None,
    kit_prior: Optional[Mapping[str, tuple[str, Optional[str]]]] = None,
    status: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, list[dict[str, str]]], bool]:
    """Attach kit colours to teams: scorebug swatch, ASR phrase, curated prior.

    ``scorebug_swatches`` are ``{side, rgb}`` samples of the scoreboard ROI half
    that belongs to that side (the perception pass samples them from the same
    ROI crop it OCRs, so this is free evidence). A side's swatch is only used
    when it is STABLE across frames (:func:`stable_swatch_by_side`) — a single
    frame over an advertising board reads the board, not the kit. The player
    cluster nearest to that swatch in RGB space is the side's kit — this is the
    "scorebug layout" association. When the swatch is missing/unusable the
    commentary phrase
    ("Spain in the white shirts") decides. When neither exists the team keeps
    ``kitColors: []`` instead of a guessed colour, unless a curated ``kit_prior``
    can link an already-observed cluster to it (ADAAAA-7866): the third channel
    runs LAST, only on sides neither measured channel decided, and it publishes
    the cluster's own colour — never a colour of its own.

    ``status`` is an optional out-dict that receives ``kitPriorUsed``,
    ``kitPriorMiss`` and ``kitPriorConflict`` (side strings) so the caller can
    surface the channel in ``evidenceStatus``. It is only touched when
    ``kit_prior`` is given.

    Returns ``(per_side_kit, ambiguous)`` where ``per_side_kit`` maps
    ``"home"/"away"`` -> ``[{primary, secondary}]``. ``ambiguous`` is True when
    the two clusters name the same colour and the assignment therefore cannot
    distinguish the teams (away-kit collision — plan §7), or when two priors land
    on ONE cluster. A prior MISS is not ambiguity: it is reported through
    ``kitPriorMiss`` so ``ambiguous`` keeps its shipped meaning.
    """
    by_side: dict[str, list[dict[str, str]]] = {}
    prior_used: list[str] = []
    prior_miss: list[str] = []
    prior_conflict: list[str] = []
    if not clusters:
        if kit_prior is not None and status is not None:
            status["kitPriorUsed"] = prior_used
            status["kitPriorMiss"] = prior_miss
            status["kitPriorConflict"] = prior_conflict
        return by_side, False
    used: set[int] = set()
    colors = [c.primary for c in clusters]
    same_color = len(set(colors)) == 1 and len(clusters) > 1
    # A swatch must REPEAT before it can link a colour to a side (see
    # `stable_swatch_by_side`): one frame over an advertising board reads the
    # board, not the kit, and would attribute a wrong colour.
    swatch_by_side = stable_swatch_by_side(scorebug_swatches)
    # Swatch channel is only informative when both sides' swatches name different
    # colours (see sample_scorebug_swatches): identical swatches are a shared
    # graphic (flags/banner), not team kit colours.
    if len(swatch_by_side) >= 2 and len({s["color"] for s in swatch_by_side.values()}) == 1:
        swatch_by_side = {}

    unresolved: list[dict[str, str]] = []
    for team in teams:
        side = str(team.get("side") or "unknown")
        name = str(team.get("name") or "")
        chosen: Optional[int] = None
        sw = swatch_by_side.get(side)
        if sw is not None:
            rgb = [float(v) for v in sw["rgb"]]
            ranked = sorted(range(len(clusters)), key=lambda i: _dist(rgb, clusters[i].rgb))
            if ranked and _dist(rgb, clusters[ranked[0]].rgb) <= 120.0:
                chosen = ranked[0]
        if chosen is None and commentary:
            for mention in commentary:
                if mention.kit_color and mention.name == name:
                    for i, c in enumerate(clusters):
                        if c.primary == mention.kit_color and i not in used:
                            chosen = i
                            break
                if chosen is not None:
                    break
        # One cluster is one kit: never hand the same cluster to both sides (a
        # measured bug on the cited job assigned "maroon" to Portugal AND Spain
        # because both scorebug swatches landed nearest that centroid).
        if chosen is not None and chosen in used:
            chosen = None
        if chosen is None:
            unresolved.append({"side": side, "name": name})
            continue
        c = clusters[chosen]
        used.add(chosen)
        kit = [{"primary": c.primary}]
        if c.secondary:
            kit[0]["secondary"] = c.secondary
        by_side[side] = kit
    # Third channel (ADAAAA-7866): a curated prior only has to decide the sides
    # no measured channel could, and it is all-or-nothing over that set.
    if kit_prior is not None and unresolved:
        picks, prior_miss, prior_conflict = _resolve_kit_prior(unresolved, clusters, used, kit_prior)
        for side, idx in picks:
            c = clusters[idx]
            used.add(idx)
            kit = [{"primary": c.primary}]
            if c.secondary:
                kit[0]["secondary"] = c.secondary
            by_side[side] = kit
            prior_used.append(side)
    if kit_prior is not None and status is not None:
        status["kitPriorUsed"] = prior_used
        status["kitPriorMiss"] = prior_miss
        status["kitPriorConflict"] = prior_conflict
    # No positional fallback: a colour is attached to a team only when an
    # evidence channel links them (swatch, commentary phrase, or the curated
    # prior). Measured on the cited job, assigning the leftover cluster to the
    # other side put a junk "yellow" cluster (from non-player crops) on Spain.
    # Unattributed colours are reported by the caller through
    # `ambiguous`/evidenceStatus instead of a silent guess.
    return by_side, bool(same_color or prior_conflict)


# ---------------------------------------------------------------------------
# Stage 0 — metadata hints
# ---------------------------------------------------------------------------
_VS_RE = re.compile(r"\s+(?:vs\.?|v\.?|versus|against|-|–|—)\s+", re.IGNORECASE)


def parse_metadata_hints(hints: Optional[Mapping[str, Any]], sport: str) -> list[TeamText]:
    """Candidate teams from stored metadata (never an accepted attribution).

    Scans ``gameHint``, the job title and the source filename. A "<A> vs <B>"
    shape yields home/away in that order (the plan's Stage 0 candidate rule);
    everything else yields ``side="unknown"`` candidates. The confidence fold
    caps metadata-only evidence below the usable threshold, so this can feed a
    corroborated attribution but can never create one alone.
    """
    if not hints or sport == SPORT_UNKNOWN:
        return []
    out: list[TeamText] = []
    seen: set[str] = set()
    fields = (
        ("title", hints.get("title")),
        ("gameHint", hints.get("gameHint")),
        ("filename", hints.get("filename")),
        ("hint", hints.get("hint")),
    )
    for field, value in fields:
        # Source filenames carry separators ("Portugal_vs_Spain_2018_goal1.mp4");
        # normalize them to spaces so the "<A> vs <B>" shape matches. Metadata is
        # a candidate source only (weight 0.15), so this can corroborate but never
        # carry an attribution on its own.
        text = str(value or "").replace("_", " ").strip()
        if not text:
            continue
        parts = _VS_RE.split(text, maxsplit=1)
        if len(parts) == 2:
            for side, chunk in (("home", parts[0]), ("away", parts[1])):
                for tok in _tokens(chunk):
                    # EXACT tokens only (ADAAAA-7889). Metadata is typed text, not
                    # a noisy OCR/ASR read, so a fuzzy hit there has no error class
                    # to justify it — and it produced a real false positive: the
                    # auto-generated title "Clinical finish and celebration" is one
                    # edit from the demonym "Finnish", so every such job carried a
                    # Finland candidate. That candidate could pair-complete onto a
                    # free side and publish a WRONG team, which the plan's §7 ranks
                    # worse than `unknown`.
                    hit = resolve_token(tok, sport, allow_fuzzy=False)
                    if hit is not None and hit[0].name not in seen:
                        seen.add(hit[0].name)
                        out.append(TeamText(hit[0].name, side, tok, text[:180], hit[1], field))
        for tok in _tokens(text):
            hit = resolve_token(tok, sport, allow_fuzzy=False)
            if hit is not None and hit[0].name not in seen:
                seen.add(hit[0].name)
                out.append(TeamText(hit[0].name, "unknown", tok, text[:180], hit[1], field))
    return out


# ---------------------------------------------------------------------------
# Stage 4 — confidence fold + monotonic guard
# ---------------------------------------------------------------------------
@dataclass
class Candidate:
    name: str
    side: str
    sources: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def add(self, source: str, snippet: str, fuzzy: bool = False) -> None:
        entry: dict[str, Any] = {"source": source, "snippet": snippet}
        if fuzzy:
            entry["fuzzy"] = True
        bucket = self.sources.setdefault(source, [])
        if not any(e["snippet"] == snippet for e in bucket):
            bucket.append(entry)

    @property
    def confidence(self) -> float:
        total = 0.0
        n_sources = 0
        for source, entries in self.sources.items():
            weight = SOURCE_WEIGHTS.get(source, 0.0)
            if weight <= 0:
                continue
            # A source that only ever produced fuzzy reads counts discounted.
            factor = FUZZY_EVIDENCE_FACTOR if entries and all(e.get("fuzzy") for e in entries) else 1.0
            total += weight * factor
            n_sources += 1
        if n_sources <= 1:
            return round(min(total, SINGLE_SOURCE_CAP), 4)
        return round(min(total, 0.95), 4)

    @property
    def independent_sources(self) -> int:
        return len(self.sources)

    def evidence(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for source in ("scorebug_ocr", "asr", "metadata"):
            for e in self.sources.get(source, []):
                out.append(dict(e))
        return out


def fold_confidence(
    scorebug: Sequence[TeamText],
    commentary: Sequence[CommentaryMention],
    metadata: Sequence[TeamText],
) -> list[Candidate]:
    """Fold the three independent sources into per-team candidates (plan §3 S4).

    ``scorebug`` is the 0.5-weight source, ``commentary`` (ASR) 0.35 and
    ``metadata`` 0.15. Confidence is the sum of the DISTINCT source weights (a
    source that repeats itself still counts once), capped at
    ``SINGLE_SOURCE_CAP`` when only one source agrees. A team seen on both
    sides of the scorebug keeps the concrete side; a team only ever seen with
    ``side="unknown"`` stays unknown until the fold that completes the pair.
    """
    by_key: dict[tuple[str, str], Candidate] = {}

    def _upsert(name: str, side: str, source: str, snippet: str, fuzzy: bool = False) -> Candidate:
        cand = by_key.get((name, side))
        if cand is None:
            if side == "unknown":
                # Merge into a concrete-side candidate for the same team when one
                # already exists: a name plate does not contradict a score line.
                concrete = [c for (n, s), c in by_key.items() if n == name and s != "unknown"]
                if concrete:
                    cand = concrete[0]
                else:
                    cand = Candidate(name, side)
                    by_key[(name, side)] = cand
            else:
                cand = Candidate(name, side)
                by_key[(name, side)] = cand
        cand.add(source, snippet, fuzzy)
        return cand

    for t in scorebug:
        _upsert(t.name, t.side, "scorebug_ocr", t.snippet, t.fuzzy)
    for m in commentary:
        _upsert(m.name, "unknown", "asr", m.snippet)
    for m in metadata:
        _upsert(m.name, m.side, "metadata", m.snippet, m.fuzzy)

    cands = list(by_key.values())
    # Pair completion: exactly two teams, one on each side plus an unknown ->
    # the unknown takes the free side (scorebug layout order is the source).
    concrete = [c for c in cands if c.side != "unknown"]
    unknown = [c for c in cands if c.side == "unknown"]
    if len(concrete) == 1 and len(unknown) == 1:
        taken = concrete[0].side
        unknown[0].side = "away" if taken == "home" else "home"
        by_key[(unknown[0].name, unknown[0].side)] = unknown[0]
        by_key.pop((unknown[0].name, "unknown"), None)
        cands = list(by_key.values())
    # Deduplicate by name: keep the strongest candidate per team.
    best: dict[str, Candidate] = {}
    for c in cands:
        cur = best.get(c.name)
        if cur is None or c.confidence > cur.confidence:
            best[c.name] = c
        elif c.confidence == cur.confidence and cur.side == "unknown" and c.side != "unknown":
            best[c.name] = c
    return sorted(best.values(), key=lambda c: (-c.confidence, c.name))


def apply_monotonic_guard(
    previous: Optional[Mapping[str, Any]],
    candidates: Sequence[Candidate],
    kits: Optional[Mapping[str, list[dict[str, str]]]] = None,
    ambiguous: bool = False,
    progress_pct: float = 0.0,
    now: Optional[datetime] = None,
    observed_clusters: Optional[Sequence[str]] = None,
) -> dict[str, Any]:
    """Merge a re-check into the stored context without name flip-flop.

    Rule (plan §3 Stage 4, AC4): once a team is attributed at confidence >=
    ``USABLE_CONFIDENCE``, a later re-check may raise its confidence and update
    its kit colours, but it may NOT change the team name unless the new claim
    beats the stored confidence by >= ``FLIP_MARGIN`` AND carries >=
    ``FLIP_MIN_SOURCES`` independent agreeing sources. Every re-check appends one
    bounded trail entry so the persisted record shows the recompute trail.
    """
    at = (now or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
    trail: list[dict[str, Any]] = list((previous or {}).get("trail") or [])
    prev_teams = {str(t.get("side")): t for t in ((previous or {}).get("teams") or [])}
    out_teams: list[dict[str, Any]] = []
    actions: list[str] = []
    for cand in candidates:
        prev = prev_teams.get(cand.side) if cand.side in ("home", "away") else None
        if prev and prev.get("name") and prev.get("name") != cand.name:
            prev_conf = float(prev.get("confidence") or 0.0)
            if prev_conf >= USABLE_CONFIDENCE:
                prev_sources = len({e.get("source") for e in (prev.get("evidence") or [])})
                may_flip = (
                    cand.confidence >= prev_conf + FLIP_MARGIN
                    and cand.independent_sources >= FLIP_MIN_SOURCES
                    and prev_sources < 3
                )
                if not may_flip:
                    # Keep the stored identity, keep the stronger confidence.
                    # NEVER apply this candidate's kit colours to the retained
                    # team: the colours were associated with the CANDIDATE (a
                    # different team at that side, e.g. a reversed scorebug read),
                    # and painting the kept team with its rival's kit is exactly
                    # the "wrong colour" failure the guard exists to prevent.
                    kept = dict(prev)
                    kept["confidence"] = round(max(prev_conf, cand.confidence), 4)
                    out_teams.append(kept)
                    actions.append(f"kept {prev.get('name')} at {cand.side}")
                    continue
            actions.append(f"flipped {prev.get('name')} -> {cand.name} at {cand.side}")
        item: dict[str, Any] = {
            "name": cand.name,
            "side": cand.side,
            "kitColors": list((kits or {}).get(cand.side, [])),
            "confidence": cand.confidence,
            "evidence": cand.evidence(),
        }
        # Preserve colours already attributed to the same side/team — but only
        # while this pass's OWN observation does not contradict them. A stored
        # colour survives a thinner re-check (no clusters observed at all); it is
        # dropped when the pass observed clusters and none of them is the stored
        # colour, because that reading was produced by a different (or broken)
        # sampler and carrying it forward keeps a WRONG colour on the record
        # forever (measured on e397b7e7: a pre-fix `orange` away kit survived
        # every re-check after the sampler started naming `red`/`green`).
        if prev and prev.get("name") == cand.name and prev.get("kitColors") and not item["kitColors"]:
            observed = {str(c) for c in (observed_clusters or [])}
            stored = {str(k.get("primary")) for k in prev["kitColors"] if k.get("primary")}
            if not observed or (stored & observed):
                item["kitColors"] = prev["kitColors"]
        out_teams.append(item)
    # Teams from the previous context that this re-check did not reproduce keep
    # their identity (a later, thinner evidence pass must not erase an
    # attribution) unless they were explicitly contradicted above.
    for side, prev in prev_teams.items():
        if side not in ("home", "away"):
            continue  # an un-sided mention is never an attribution to preserve
        if any(t.get("side") == side for t in out_teams):
            continue
        if float(prev.get("confidence") or 0.0) >= USABLE_CONFIDENCE:
            out_teams.append(dict(prev))
    order = {"home": 0, "away": 1, "unknown": 2}
    out_teams.sort(key=lambda t: (order.get(str(t.get("side")), 3), str(t.get("name"))))
    trail.append(
        {
            "at": at,
            "progressPct": round(float(progress_pct), 1),
            "names": [{"side": t.get("side"), "name": t.get("name"), "confidence": t.get("confidence")} for t in out_teams],
            "action": actions or ["no change"],
        }
    )
    if len(trail) > MAX_TRAIL:
        trail = trail[-MAX_TRAIL:]
    return {
        "sport": (previous or {}).get("sport"),
        "teams": out_teams,
        "inferredAt": at,
        "resolverVersion": RESOLVER_VERSION,
        "ambiguous": bool(ambiguous),
        "trail": trail,
    }


# ---------------------------------------------------------------------------
# Contract assembly + top-level resolver
# ---------------------------------------------------------------------------
def build_match_context(
    sport: str,
    teams: Sequence[Mapping[str, Any]],
    inferred_at: Optional[datetime] = None,
    ambiguous: bool = False,
    trail: Optional[Sequence[Mapping[str, Any]]] = None,
) -> dict[str, Any]:
    """Assemble the persisted ``matchContext`` (plan §3 Stage 5 contract).

    Field-for-field the plan's shape, so the sibling prompt-injection issue
    (ADAAAA-7856) and the decide contract can consume it unchanged:
    ``{sport, teams[{name, side, kitColors[{primary, secondary}], confidence,
    evidence[{source, snippet}]}], inferredAt, resolverVersion, ambiguous}``.
    ``trail`` is the additive AC4 audit array (absent on a first pass? no — a
    first pass writes exactly one entry, so the recompute trail is always
    inspectable).
    """
    at = (inferred_at or datetime.now(timezone.utc)).isoformat().replace("+00:00", "Z")
    out_teams: list[dict[str, Any]] = []
    for t in teams:
        kit = []
        for k in (t.get("kitColors") or []):
            item = {"primary": str(k.get("primary") or "unknown")}
            if k.get("secondary"):
                item["secondary"] = str(k["secondary"])
            kit.append(item)
        out_teams.append(
            {
                "name": str(t.get("name") or "unknown"),
                "side": str(t.get("side") or "unknown"),
                "kitColors": kit,
                "confidence": round(float(t.get("confidence") or 0.0), 4),
                "evidence": [
                    {"source": str(e.get("source")), "snippet": str(e.get("snippet") or "")[:200]}
                    for e in (t.get("evidence") or [])
                ],
            }
        )
    return {
        "sport": sport if sport in SPORT_KEYS else SPORT_UNKNOWN,
        "teams": out_teams,
        "inferredAt": at,
        "resolverVersion": RESOLVER_VERSION,
        "ambiguous": bool(ambiguous),
        "trail": [dict(x) for x in (trail or [])],
    }


def _unknown_reason(
    outcomes: Mapping[str, Any],
    commentary: Sequence[CommentaryMention],
    metadata: Sequence[TeamText],
    candidates: Sequence[Candidate],
) -> str:
    """One-line, per-channel diagnosis of a pass that published no team (AC2).

    The record used to say `unknown` with zero confidence and stop there, which
    is indistinguishable between "the clip has no score graphic", "OCR read the
    ad boards", "commentary named three teams but none could be sided" and "the
    fold rejected a single-source name at the confidence cap". This string names
    which of those happened, using only values the status already carries, so
    `GET /jobs/:id` answers it without a box shell (ADAAAA-7889).
    """
    ocr = outcomes.get("scorebug_ocr") or {}
    parts = [
        "scorebug_ocr: {frames} frames, {lines} OCR lines, {team} with team text".format(
            frames=ocr.get("frames", 0), lines=ocr.get("lines", 0), team=ocr.get("teamLines", 0)
        )
    ]
    asr_names = sorted({m.name for m in commentary})
    parts.append(f"asr: {len(commentary)} mentions" + (f" ({', '.join(asr_names)})" if asr_names else ""))
    meta_names = [f"{m.name}:{m.side}" for m in metadata]
    parts.append(f"metadata: {len(metadata)} candidates" + (f" ({', '.join(meta_names)})" if meta_names else ""))
    if candidates:
        best = max(candidates, key=lambda c: c.confidence)
        parts.append(
            f"fold: best {best.name}@{best.confidence} from {','.join(sorted(best.sources))}"
            f" at side {best.side}, usable {USABLE_CONFIDENCE}"
        )
    else:
        parts.append(f"fold: no candidate reached a side, usable {USABLE_CONFIDENCE}")
    return "; ".join(parts)


def resolve_match_context(
    *,
    sport_hint: Optional[str] = None,
    game_hint: Optional[str] = None,
    ocr_frames: Optional[Sequence[Mapping[str, Any]]] = None,
    transcript: Optional[str] = None,
    hints: Optional[Mapping[str, Any]] = None,
    kit_samples: Optional[Sequence[Mapping[str, Any]]] = None,
    scorebug_swatches: Optional[Sequence[Mapping[str, Any]]] = None,
    previous: Optional[Mapping[str, Any]] = None,
    progress_pct: float = 0.0,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """One resolver pass over whatever evidence the caller has (Stage 0-5).

    Returns ``{"matchContext", "evidenceStatus"}``. ``evidenceStatus`` names
    which sources were AVAILABLE (``not_captured`` with the missing source when
    one is absent) so AC6 ("graceful degradation") is inspectable rather than
    inferred from a low number.

    An unknown sport short-circuits to ``sport="unknown"``, zero-confidence
    ``unknown`` teams and ``ambiguous: true`` — never a guessed team list.
    """
    sport = sport_key(sport_hint) if sport_hint else sport_key(game_hint)
    status: dict[str, Any] = {
        "scorebugOcrFrames": 0,
        "commentaryChars": len(transcript or ""),
        "kitSamples": len(kit_samples or []),
        "scorebugSwatches": len(scorebug_swatches or []),
        "sources": [],
    }
    if sport == SPORT_UNKNOWN:
        status["sport"] = "unknown"
        status["sources"] = []
        status["unknownReason"] = (
            f"sport not mapped to a lexicon: gameHint/sportHint {str(sport_hint or game_hint or '')!r}"
        )
        ctx = build_match_context(
            SPORT_UNKNOWN,
            [
                {"name": "unknown", "side": "home", "kitColors": [], "confidence": 0.0, "evidence": []},
                {"name": "unknown", "side": "away", "kitColors": [], "confidence": 0.0, "evidence": []},
            ],
            inferred_at=now,
            ambiguous=True,
            trail=(previous or {}).get("trail") or [],
        )
        return {"matchContext": ctx, "evidenceStatus": status}

    scorebug: list[TeamText] = []
    # AC2 (ADAAAA-7889): count what the scorebug channel actually READ, not just
    # how many frames had lines. `lines` vs `teamLines` is the number that
    # explains an `unknown` — a broadcast without a score graphic yields lines
    # (advertising boards) and zero team text, which used to look identical to a
    # scorebug whose team names were simply unreadable.
    ocr_line_count = 0
    ocr_team_line_count = 0
    raw_samples: list[str] = []
    team_samples: list[str] = []
    for frame in ocr_frames or []:
        lines = frame.get("lines") or frame.get("ocr") or []
        if not lines:
            continue
        status["scorebugOcrFrames"] += 1
        scorebug.extend(parse_ocr_teams(lines, sport))
        for line in lines:
            text = str(line or "").strip()
            if not text:
                continue
            ocr_line_count += 1
            if any(resolve_token(tok, sport, allow_fuzzy=False) is not None for tok in _tokens(text)):
                ocr_team_line_count += 1
                if len(team_samples) < MAX_STATUS_OCR_LINES:
                    team_samples.append(text[:200])
            if len(raw_samples) < MAX_STATUS_OCR_LINES:
                raw_samples.append(text[:200])
    # Stage 1b (ADAAAA-7898): a sport-generic name channel for scorebugs whose
    # clubs the closed lexicon does not cover. Gated on the lexicon having
    # resolved NO side at all this job, so every scorebug the lexicon already
    # names keeps its exact shipped behaviour (the Portugal v Spain class).
    lexicon_sides = {t.side for t in scorebug if t.side in ("home", "away")}
    if not lexicon_sides:
        generic_names, generic_status = parse_generic_scorebug_names(ocr_frames, sport)
        status["genericNameCandidates"] = generic_status
        if generic_names:
            scorebug.extend(generic_names)
    commentary = scan_commentary(transcript, sport)
    metadata = parse_metadata_hints(hints, sport)
    for name, present in (
        ("scorebug_ocr", status["scorebugOcrFrames"] > 0),
        ("asr", bool(transcript)),
        ("metadata", bool(hints)),
    ):
        status["sources"].append(name if present else f"{name}:not_captured")

    candidates = fold_confidence(scorebug, commentary, metadata)
    # Per-side folded confidence BEFORE any suppression, so the record shows the
    # strongest claim each side could have had even when the pass publishes
    # nothing (AC2). A `null` side means no candidate ever reached that side.
    folded_sides: dict[str, Optional[dict[str, Any]]] = {}
    for side in ("home", "away"):
        best = None
        for cand in candidates:
            if cand.side != side:
                continue
            if best is None or cand.confidence > best.confidence:
                best = cand
        folded_sides[side] = (
            None
            if best is None
            else {
                "name": best.name,
                "confidence": best.confidence,
                "sources": sorted(best.sources),
            }
        )
    status["channelOutcomes"] = {
        "scorebug_ocr": {
            "frames": status["scorebugOcrFrames"],
            "lines": ocr_line_count,
            "teamLines": ocr_team_line_count,
            "teams": [{"name": t.name, "side": t.side} for t in scorebug[:MAX_STATUS_TEAMS]],
            # The raw OCR text, so an operator reads the line that produced (or
            # failed to produce) a team instead of guessing from a count.
            "rawLines": (team_samples or raw_samples)[:MAX_STATUS_OCR_LINES],
        },
        "asr": {
            "chars": len(transcript or ""),
            "mentions": [
                {
                    "name": m.name,
                    "snippet": m.snippet,
                    "start": m.start,
                    "end": m.end,
                    "kitColor": m.kit_color,
                }
                for m in commentary[:MAX_STATUS_MENTIONS]
            ],
        },
        "metadata": {
            "candidates": [
                {"name": m.name, "side": m.side, "field": m.field, "fuzzy": m.fuzzy}
                for m in metadata[:MAX_STATUS_TEAMS]
            ],
        },
        "fold": {
            "usableConfidence": USABLE_CONFIDENCE,
            "singleSourceCap": SINGLE_SOURCE_CAP,
            "home": folded_sides["home"],
            "away": folded_sides["away"],
        },
    }
    unknown_reason = _unknown_reason(status["channelOutcomes"], commentary, metadata, candidates)
    # Only an ATTRIBUTED team belongs on the job record: a single-source mention
    # with no side is a candidate, not an attribution (plan §3: "single-source
    # attributions stay capped below the usable threshold"). Measured on the cited
    # job: the commentary's "Real Madrid's new coach" and a fuzzy ASR token
    # surfaced as extra 0.35 teams at side "unknown" and polluted the record. When
    # a concrete home/away pair exists those extras are suppressed and reported in
    # evidenceStatus instead.
    concrete = [c for c in candidates if c.side in ("home", "away")]
    extras = [c for c in candidates if c.side not in ("home", "away")]
    suppressed: list[str] = []
    if len(concrete) >= 2:
        suppressed = [c.name for c in extras] + [c.name for c in concrete[2:]]
        candidates = concrete[:2]
    else:
        suppressed = [c.name for c in extras if c.confidence < USABLE_CONFIDENCE]
        candidates = concrete + [c for c in extras if c.confidence >= USABLE_CONFIDENCE]
    if suppressed:
        status["suppressedCandidates"] = suppressed

    clusters = cluster_kit_colors(list(kit_samples or []))
    # Inspectability (ADAAAA-7859): name WHAT the colour pass saw. A job where
    # colours were observed but no side channel links them now reports the
    # clusters and the frame count that carried them, instead of only a low
    # number. `kitSampleFrames` counts distinct sampled frames so one noisy crop
    # cannot look like corroboration.
    if kit_samples:
        status["kitSampleFrames"] = len(
            {(s.get("frameSeq"), s.get("ts")) for s in kit_samples if s.get("rgb") is not None}
        )
        status["kitSampleTracks"] = len({str(s.get("trackId")) for s in kit_samples if s.get("trackId") is not None})
    if clusters:
        status["kitClusterColors"] = [c.primary for c in clusters]
    kits, kit_ambiguous = associate_kits(
        [{"name": c.name, "side": c.side} for c in candidates],
        clusters,
        scorebug_swatches=scorebug_swatches,
        commentary=commentary,
        # Third channel (ADAAAA-7866): a curated per-team primary-colour prior
        # links an already-observed cluster to a side neither measured channel
        # could decide. Off for sports without a curated table.
        kit_prior=_KIT_PRIORS.get(sport),
        status=status,
    )
    # A team whose kit colour has no linking evidence keeps kitColors: [] and is
    # reported here, so "the resolver saw two colours but could not attribute one
    # to Spain" is inspectable instead of invisible.
    if clusters:
        status["kitColorsUnattributed"] = [s for s in ("home", "away") if s not in kits and any(c.side == s for c in candidates)]
        # ADAAAA-7889 (AC2, PO scope split on ADAAAA-7890): the side list above is
        # empty whenever no team reached a side, even though colours WERE
        # observed — the record then says "[] unattributed" about a job whose
        # clusters are plainly visible, which reads as "nothing seen". Name the
        # clusters no side owns so the kit channel is inspectable on its own.
        attributed = {str(k.get("primary")) for side_kits in kits.values() for k in side_kits if k.get("primary")}
        leftover = sorted({c.primary for c in clusters} - attributed)
        if leftover:
            status["kitClustersUnattributed"] = leftover
    ambiguous = bool(kit_ambiguous)
    if len([c for c in candidates if c.side in ("home", "away")]) > 2:
        ambiguous = True
    if not candidates:
        # No evidence at all: keep the contract honest (AC6) — unknown teams,
        # zero confidence, never a fabricated name. AC2: the reason names which
        # channel had nothing so the record explains itself.
        status["unknownReason"] = unknown_reason
        ctx = build_match_context(
            sport,
            [
                {"name": "unknown", "side": "home", "kitColors": [], "confidence": 0.0, "evidence": []},
                {"name": "unknown", "side": "away", "kitColors": [], "confidence": 0.0, "evidence": []},
            ],
            inferred_at=now,
            ambiguous=True,
            trail=(previous or {}).get("trail") or [],
        )
        ctx["trail"] = list((previous or {}).get("trail") or [])
        ctx["trail"].append(
            {
                "at": ctx["inferredAt"],
                "progressPct": round(float(progress_pct), 1),
                "names": [],
                "action": ["no evidence"],
            }
        )
        ctx["trail"] = ctx["trail"][-MAX_TRAIL:]
        return {"matchContext": ctx, "evidenceStatus": status}

    merged = apply_monotonic_guard(
        previous,
        candidates,
        kits=kits,
        ambiguous=ambiguous,
        progress_pct=progress_pct,
        now=now,
        observed_clusters=[c.primary for c in clusters],
    )
    # Guard output already carries the previous sport when merging; a first pass
    # stamps the resolved one.
    merged["sport"] = sport
    ctx = build_match_context(
        merged["sport"],
        merged["teams"],
        inferred_at=now,
        ambiguous=merged["ambiguous"],
        trail=merged["trail"],
    )
    return {"matchContext": ctx, "evidenceStatus": status}
