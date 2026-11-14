"""Score-surface identity (ADAAAA-8844, Inc 2).

A live stream can carry a PIP of another game with its own score bug. Inc 1
(ADAAAA-8835) pins the bug per job, so an operator can stop the mis-scope, but a
pin cannot stop an un-pinned job, a second bug that appears mid-stream, or a pin
placed on the wrong surface. This module answers the question the pin cannot:
**is the surface this crop read actually this match's surface?**

Two channels, read off data that is ALREADY paid for:

- **kit swatches** — the plate colours the bug prints beside each team. The
  scoreboard crop perceive already took is sampled per half by
  ``sample_scorebug_swatches`` (CPU, no GPU). A side is compared with its own
  team's ``kitColors`` names from the job's match context, or — when the job
  carries a name but no observed kit colour (ADAAAA-8908: the served jobs' shape,
  `kitColors: []`) — with the curated PRIMARY for that team's name
  (``match_context._SOCCER_KIT_PRIORS``, ADAAAA-7866). The curated value is a
  REFERENCE only: it feeds the distance and is never published as a kit colour
  observation, and ``kitReference`` on the verdict records which source was used.
- **printed names** — the team tokens the bug prints next to the score. They come
  from the same ``<OCR>`` lines the score parser already read, so no read is
  added for this channel either.

The comparison is a CHROMATICITY distance (``rgb / sum(rgb)``), because raw RGB
is dominated by exposure: on the labelled truth set one washed-out crop reads
129 raw RGB away from its own consensus while sitting on the same hue, which
would force a bar wide enough to separate nothing. The bar itself is measured,
not chosen — see ``SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD``.

Verdicts:

- ``consistent`` — at least one channel positively matches this match (names, or
  a kit swatch inside the bar). A score change on this surface may attest.
  ADAAAA-8975 adds the printed-name conjunct for PRIOR-derived references; this
  increment does not change that path.
- ``contradicted`` — the kits sit outside the bar AND printed names do not
  match. When the reference came from the CURATED prior rather than an observed
  kit colour, the printed names must also have been READ (unmatched, not
  unreadable), because a curated colour is not a measurement of this match's
  kit: a surface whose text cannot be read stays ``absent`` (ADAAAA-8908). A
  score change here is a CLAIM: it must not attest a goal, and the window rests
  on decide's own verdict (AC2.3, both decide paths).
- ``absent`` — nothing usable was read (unattributed kits, unreadable names).
  Absence is not contradiction: today's behaviour is kept, because demoting an
  unreadable surface would cost recall on what we simply cannot see.

Cost: the kit swatches and the names ride the crop/OCR the pass already paid
for; the identity pass itself runs at most ``SURFACE_IDENTITY_MAX_PASSES`` times
per session (AC2.4), and it is the only thing gated on a counter at all.
"""
from __future__ import annotations

from typing import Any, Mapping, NamedTuple, Optional, Sequence

from .match_context import (
    _COLOR_BUCKETS,
    kit_prior_primary,
    name_color,
    sample_scorebug_swatches,
)

# ADAAAA-8927 AC1. MEASURED ON NATURAL TRAFFIC — the population this rule actually
# compares — not on same-surface drift. ADAAAA-8844 calibrated 0.35 as
# `1.15 x worst same-surface DRIFT (0.3005)`, and drift between two readings of ONE
# surface is a different quantity from the distance the rule computes: the rule
# compares a plate read off a real broadcast crop to a SATURATED reference
# (`name_reference_rgb("blue")` = [33.05, 33.05, 183.6], hue midpoint at sat 0.82 /
# val 0.72), and a real plate is washed out by exposure. That distance was never
# measured on genuine plates, so 0.35 demoted them.
#
# Measured by ADAAAA-8922 at $0 on the served build (`58f51ad`), with the SHIPPED
# sampler (`sample_scorebug_swatches`) at each job's own verified ROI
# `[0, 0, 1, 0.25]`, 640x360 @ 3 fps, every frame of each clip, over the 5 distinct
# broadcast clips the natural (`file`/`browser`) Barcelona jobs replay:
#
#   555 genuine plate readings (`name_color` == "blue") on 2263 frames
#     kids95_8483.mp4 80   kids180_8123.mp4 126  kids300_7935.mp4 210
#     qa8092_90s.mp4  71   kids300_goals_7992b.mp4 68
#   plate p50 0.349-0.353   p95 0.372-0.377   max 0.381
#   286 of 555 (52%) sat OUTSIDE 0.35 -> false demotions of a genuine surface
#
#   threshold = 1.15 x worst measured genuine plate (0.381) = 0.438 -> 0.44
#
# Same rule, same margin as ADAAAA-8844, applied to the quantity the conjunct
# compares. Recall at 0.44: 0 of 555 genuine readings demoted (was 286). Precision
# at 0.44, distance from the UNCHANGED saturated reference: pink 0.491, white
# 0.492, orange 0.651, gold 0.686, green (ADAAAA-8919 repaint) 0.797, red 0.894 —
# all still outside. Purple (0.395; the saturated `purple` reference itself is
# 0.313) moves INSIDE the bar; it was already only 0.045 outside and the
# printed-name channel is what separates it, so it is the one documented in-set
# colour on the blue arm and is excluded from the acceptance set. The bar is ONE
# constant, so it widens every reference pair: against `red`, gold (0.370) and a
# yellow fill (0.426) also fall inside (pink 0.313 / orange 0.248 were already
# inside 0.35), and the constant is also read by `_incumbent_surface_kept` (is a
# second box a DIFFERENT bug's surface?). Both consequences are pinned in
# `tests/test_surface_identity_natural_bar_8927.py`.
#
# Rejected alternatives, both measured on the same population (ADAAAA-8922):
#   (a) "reference at the measured saturation": rebuild the reference at the plate
#       population's own saturation (mean [97.2, 102.5, 174.2], chroma
#       [0.260, 0.274, 0.466]). Genuine plates fall to p50 0.031-0.038 / p95
#       0.072-0.110 / max 0.163 — but a foreign WHITE fill also falls to 0.163,
#       NAVY to 0.010 and PURPLE to 0.08, i.e. the precision arm collapses: an
#       achromatic foreign surface would read `consistent` and its score change
#       could attest. Rejected; the saturated reference stays the separator.
#   (b) "per-frame recall guard on a stabilised reading": the FOLDED per-20 s-window
#       reading (`stable_swatch_by_side`, the same fold the resolver uses) still
#       reads 0.3486-0.3579 in 4 of 15 windows, so the MODAL genuine plate is itself
#       outside 0.35 — stabilising cannot fix the bar. Kept as a second signal,
#       rejected as a substitute for this measurement.
#
# The margin stays on the WORST measured genuine reading, not the typical one,
# because demoting a genuine surface is the failure the increment must not cause
# (AC2.2). Precision is carried by the conjunct below: names must ALSO disagree
# before a surface is called contradicted.
SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD = 0.44

# ADAAAA-8952: ONE bar cannot carry every reference direction. The genuine-plate
# floors span 2.6x because a saturated red plate sits ~0.05 from its own reference
# while a washed-out blue plate sits ~0.35 from the same-style reference, so the
# single 0.44 is simultaneously over-wide for red/pink (it admits foreign fills
# the printed-name conjunct then has to reject) and too narrow for navy.
#
# Measured at $0 with the SHIPPED sampler/metric inside the served
# `highlights-perceive` container, on each clip's own frames (640x360 @ 3 fps) at
# a VERIFIED ROI: the box the served region selector itself PROVED by parsing a
# score on that frame (`scoreboardRoiVerified: true`), not a band chosen by hand.
# The genuine population for a family is a side whose OWN reference is that
# family, so the distance is the quantity the rule actually computes:
#
#   blue  kids/Barcelona 5 clips, box [0,0,1,0.25]         555 readings  worst 0.3811 -> 0.438
#   red   adaaa7912 away (Spain, "red"), verified [0,0,1,.25]  15 readings  worst 0.3667 -> 0.4217
#   pink  adaaa7914 home (BELMONT, "pink"), verified [0,.78,1,.94] 41 readings  worst 0.1714 -> 0.1971
#   navy  bb_q1 away (Samsungpor, "navy"), verified [0,.78,1,.94] 187 readings  worst 0.4426 -> 0.5090
#
# `1.15 x worst genuine reading`, the same rule ADAAAA-8844/8922/8927 used, rounded
# UP to 2 decimals (`0.4217 -> 0.43`, `0.1971 -> 0.20`, `0.5090 -> 0.51`).
#
# The navy row is the one that says 0.44 is too NARROW: 2 of the 187 genuine
# readings sat outside it (the clip's own ROI, so this row is measured, not
# inferred from the blue family). Blue is unchanged and reproduces ADAAAA-8922
# exactly (the 5 clips it measured are the served natural traffic).
#
# The red row is the one the ticket expected to land near 0.37, derived from
# ADAAAA-8936's PROVISIONAL worst of 0.3239 (measured without a verified ROI). At
# the verified ROI the worst genuine red reading is 0.3667, so a 0.37 bar would
# leave 0.003 of margin — under the 1.15x rule that drives every other row, and
# short of the recall this bar exists to protect. The measured floor 0.4217 sets
# it at 0.43. Recall, not precision, is what the red bar can buy: any bar >= 0.324
# already contains the saturated orange (0.2479) and pink (0.3134) fills, so the
# precision closure is NOT a bar value — it is the printed-name conjunct for
# prior-derived references, filed as ADAAAA-8975.
#
# Step 0 provenance (ADAAAA-8952, this replay): the served region selector was run
# over each clip's own frames with the served `matchContextTeams` on every body;
# every clip below reported `scoreboardRoiVerified: true` on the box above, so all
# four rows are measured at a VERIFIED box (`adaaa7912` 40 verified frames of 45,
# `adaaa7914_af` 43/45, `bb_q1` 32/45). `adaaa7912` also yields a second verified
# box (2 distinct), which is why its modal box is the one pinned in the table.
#
# Reading count is the PER-FRAME population on the declared side, the same
# convention ADAAAA-8936's instrument used and the input the served pass actually
# reads (`_surface_identity_pass` -> `surface_reading` on ONE analyze frame). The
# stable-fold view (`stable_swatch_by_side`, per 60 frames) is reported in the
# evidence for sensitivity; it is the resolver's fold, not the identity input.
#
# A family with NO measured row keeps `SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD`, so
# an unmeasured reference (`orange`, `gold`, `yellow`, `green`, `cyan`, `purple`,
# `sky blue`, `maroon`, achromatic) does not move. `maroon`/`sky blue` are
# deliberately NOT folded into `red`/`navy`: the measured floor was taken against
# the saturated `red`/`navy` reference, and a different reference is a different
# quantity.
SURFACE_IDENTITY_KIT_DISTANCE_BARS: dict[str, float] = {
    "blue": 0.44,
    "navy": 0.51,
    "red": 0.43,
    "pink": 0.20,
}

# ADAAAA-8975: a printed-name match is a CONJUNCT for prior-derived kit references.
#
# ADAAAA-8936 measured, on the shipped sampler/metric, that a red bar wide enough
# for recall also CONTAINS every saturated foreign fill the reference space can
# hand the red arm:
#
#   reference  genuine worst  bar (1.15x)  foreign fills inside that bar
#   red        0.3667         0.43          orange 0.2479, pink 0.3134,
#                                          gold 0.3699, yellow 0.4372
#   pink       0.1714         0.20          purple 0.2323
#
# No bar value separates them: a genuine red plate reaches 0.3667 at the verified
# ROI, and every fill above sits BELOW that, so widening or narrowing the number
# cannot make a red reference reject an orange fill that sits inside its own bar.
# The closure is the OTHER channel, and it only applies where the reference is a
# curated prior — `kitReference == "prior"` (ADAAAA-8908) means the colour is a
# reference for a team NAME, not a measurement of this match's kit; an OBSERVED
# `kitColors` entry is a measurement, so the bar alone still corroborates it.
#
# What "inside the bar" means for a prior. The measured genuine populations are
# DEFINED as readings whose own `name_color` sits in the reference's family
# (ADAAAA-8936: "readings whose shipped `name_color` is in R's family on a side
# whose own job declares R"). So the conjunct asks whether the SWATCH reads as the
# reference's family:
#
#   * SAME family (the genuine-plate shape) -> the kit channel still corroborates
#     on its own. That is the population every measured bar was derived from, and
#     it is what keeps the three ADAAAA-8927 Barcelona frames `consistent`: their
#     swatch reads `blue` while the OCR mangles the printed name into
#     `BARSANT`/`BARAZENDA`, so a bare name conjunct would demote a genuine
#     surface — the failure AC2.2 forbids. All 555 measured blue readings read
#     blue by definition of the population, and the served census reads `BAR` on
#     16/16 bursts.
#   * DIFFERENT family (the foreign-fill shape) -> the fill is not this match's
#     colour, it merely lands inside this family's loose bar. `consistent` now
#     requires the printed name to match too. With names READ and unmatched the
#     surface is `contradicted` — the named refusal, and the only verdict that
#     withholds a score change; with names UNREAD it stays `absent`, because
#     ADAAAA-8908's rule is not widened into a new recall path.
#
# Measured recall cost, not assumed: every genuine reading is same-family BY
# CONSTRUCTION (the 555 blue / 15 red / 41 pink / 187 navy readings cannot move),
# so the guard moves only foreign-fill rows — 118 of 1681 measured foreign
# readings against `red`, 0 against `blue` (green 0.797, orange 0.651, pink 0.491,
# white 0.492 are all outside 0.44). The served Barcelona arm (ADAAAA-8922: 16
# bursts / 192 frames, 10 consistent / 6 absent / 0 contradicted) is unchanged.
_KIT_REFERENCE_FAMILIES: dict[str, str] = {
    "blue": "blue",
    "navy": "blue",
    "sky blue": "blue",
    "red": "red",
    "maroon": "red",
    "orange": "orange",
    "gold": "orange",
    "yellow": "orange",
    "white": "achromatic",
    "grey": "achromatic",
    "gray": "achromatic",
    "black": "achromatic",
}

# AC2.4: the identity pass is a one-off per session, plus at most one re-read
# when a proven incumbent is replaced. Never per-frame, never a new OCR call.
SURFACE_IDENTITY_MAX_PASSES = 2

# Tokens shorter than this are initials/score chrome, not a team name.
_MIN_TOKEN = 3
_MAX_TOKENS = 8


def chroma(rgb: Sequence[float]) -> list[float]:
    """Normalized chromaticity (``rgb / sum(rgb)``) — exposure-invariant colour."""
    total = float(sum(float(v) for v in rgb)) or 1.0
    return [float(rgb[0]) / total, float(rgb[1]) / total, float(rgb[2]) / total]


def chroma_distance(a: Sequence[float], b: Sequence[float]) -> float:
    """Euclidean distance between two chromaticities (the AC2.5 metric)."""
    ca, cb = chroma(a), chroma(b)
    return sum((ca[i] - cb[i]) ** 2 for i in range(3)) ** 0.5


def _hsv_to_rgb(h: float, s: float, v: float) -> list[float]:
    """HSV (hue degrees, 0..1 sat, 0..1 val) -> 0..255 RGB."""
    h = (h % 360.0) / 60.0
    c = v * s
    x = c * (1 - abs(h % 2 - 1))
    m = v - c
    seg = int(h) % 6
    rgb = [
        (c, x, 0.0),
        (x, c, 0.0),
        (0.0, c, x),
        (0.0, x, c),
        (x, 0.0, c),
        (c, 0.0, x),
    ][seg]
    return [round((rgb[i] + m) * 255.0, 2) for i in range(3)]


def name_reference_rgb(name: str) -> Optional[list[float]]:
    """The reference RGB of a kit-colour NAME, taken from the production buckets.

    ``name_color`` maps pixels to these names; this is its inverse, so the two
    cannot drift apart. A bucket is represented by its hue midpoint at a kit-like
    saturation/value. ``navy`` / ``maroon`` are the same hues at the lower values
    ``name_color`` itself uses to split them from ``blue`` / ``red``.

    Achromatic names (white / grey / black) share one chromaticity, so a kit read
    in those colours can never be called "different" by distance alone — the
    printed-name channel carries that case. That is deliberate: the failure this
    module must not cause is a demoted real goal (AC2.2).
    """
    key = str(name or "").strip().lower()
    if key in ("white", "grey", "gray", "black"):
        return {"white": [240.0, 240.0, 240.0], "grey": [140.0, 140.0, 140.0],
                "gray": [140.0, 140.0, 140.0], "black": [25.0, 25.0, 25.0]}[key]
    for bucket, lo, hi in _COLOR_BUCKETS:
        if bucket != key and not (key == "navy" and bucket == "blue") and not (
            key == "maroon" and bucket == "red"
        ):
            continue
        mid = (lo + hi) / 2.0 if lo <= hi else ((lo + hi + 360.0) / 2.0) % 360.0
        if key == "navy":
            return _hsv_to_rgb(mid, 0.85, 0.35)
        if key == "maroon":
            return _hsv_to_rgb(mid, 0.85, 0.20)
        return _hsv_to_rgb(mid, 0.82, 0.72)
    return None


def printed_team_tokens(lines: Optional[Sequence[str]]) -> list[str]:
    """Team-like tokens the scorebug printed beside the score (``RMA``, ``BAR``).

    Read from the SAME lines the score parser consumed — never a new OCR call.
    Digits, separators and single letters are dropped, so ``0``/``-``/``2`` and
    an initial cannot become a "team".
    """
    out: list[str] = []
    for line in lines or []:
        token = ""
        for ch in str(line) + " ":
            if ch.isalpha():
                token += ch.upper()
                continue
            if len(token) >= _MIN_TOKEN and token not in out:
                out.append(token)
                if len(out) >= _MAX_TOKENS:
                    return out
            token = ""
    return out


def team_tokens(name: Optional[str]) -> set[str]:
    """Every token a job's team NAME can be recognised as on a score bug.

    Bugs print full names on some broadcasts and three-letter codes on others
    (the labelled truth set prints ``RMA 0 - 0 BAR`` for a Real Madrid vs
    Barcelona bug), so a match accepts the full word tokens, the initials and
    the 3-letter code. Nothing shorter than 3 letters is accepted, so a
    two-letter fragment cannot fake a match.
    """
    text = str(name or "").strip()
    if not text:
        return set()
    words = [w for w in "".join(ch if ch.isalnum() else " " for ch in text).upper().split() if w]
    out = {w for w in words if len(w) >= _MIN_TOKEN}
    significant = [w for w in words if len(w) >= 2]
    initials = "".join(w[0] for w in significant)
    if len(initials) >= _MIN_TOKEN:
        out.add(initials[:4])
    return out


def _is_subsequence(needle: str, haystack: str) -> bool:
    it = iter(haystack)
    return all(ch in it for ch in needle)


def token_matches_team(token: str, name: Optional[str]) -> bool:
    """Whether a printed token names ``name`` (full word, prefix, or 3-letter code).

    A broadcast bug often prints a FIFA-style code (``RMA``, ``BAR``) that is not
    derivable from the club name, so a 3-letter token also matches when it is a
    SUBSEQUENCE of the name's letters (``RMA`` ⊂ ``REALMADRID``, ``BAR`` ⊂
    ``FCBARCELONA``). Everything stays ≥3 letters, and the direction of a
    false positive is safe: a name match makes the surface ``consistent``, and
    only an unmatched name can contribute to a contradiction.
    """
    tok = str(token or "").strip().upper()
    if len(tok) < _MIN_TOKEN:
        return False
    if tok in team_tokens(name):
        return True
    letters = "".join(ch for ch in str(name or "").upper() if ch.isalnum())
    if not letters:
        return False
    if len(tok) == _MIN_TOKEN:
        return _is_subsequence(tok, letters)
    return any(word.startswith(tok) for word in str(name or "").upper().split())


def match_printed_names(
    printed: Sequence[str], teams: Optional[Sequence[dict[str, Any]]]
) -> list[str]:
    """Team names whose tokens appear on the bug (``RMA`` -> ``Real Madrid``)."""
    matched: list[str] = []
    for team in teams or []:
        name = str((team or {}).get("name") or "")
        if not name or name.lower() == "unknown":
            continue
        for tok in printed or []:
            if token_matches_team(tok, name):
                matched.append(name)
                break
    return matched


def _kits_from_crop(rgb: Any, roi: Any) -> dict[str, list[float]]:
    """Per-side kit swatch colours off the crop already taken (CPU, no GPU)."""
    kits: dict[str, list[float]] = {}
    for sw in sample_scorebug_swatches(rgb, roi):
        side = str(sw.get("side") or "")
        colour = sw.get("rgb")
        if side in ("home", "away") and colour and len(colour) == 3:
            kits[side] = [round(float(v), 1) for v in colour]
    return kits


def _reference_kit_names(
    team: Optional[dict[str, Any]], kit_priors: Optional[Mapping[str, Any]] = None
) -> tuple[list[str], Optional[str]]:
    """The kit colours this team's side may be compared against, and their source.

    ``observed`` — the job's own ``kitColors`` (a measurement).
    ``prior``    — the curated primary for the team's NAME (ADAAAA-8908): a
                   REFERENCE only, used when the kit sampler produced nothing.
                   It is never returned to the caller for publication; only the
                   distance is.

    An observed colour always wins over the prior, so a measurement is never
    overridden by the curated value.
    """
    kits = (team or {}).get("kitColors") or []
    names = [str(k.get("primary") or "") for k in kits if isinstance(k, Mapping)]
    names += [str(k.get("secondary") or "") for k in kits if isinstance(k, Mapping)]
    names = [n for n in names if n]
    if names:
        return names, "observed"
    prior = kit_prior_primary(str((team or {}).get("name") or ""), kit_priors)
    if prior:
        return [prior], "prior"
    return [], None


def kit_distance_bar(reference: Optional[str]) -> float:
    """The chromaticity bar for a kit REFERENCE name (ADAAAA-8952).

    One number per reference direction, because the genuine-plate floors span 2.6x
    (see ``SURFACE_IDENTITY_KIT_DISTANCE_BARS``). Any name with no measured row —
    including every name this file has never measured a genuine plate for — keeps
    ``SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD``, so an unmeasured reference does not
    move.
    """
    key = str(reference or "").strip().lower()
    return SURFACE_IDENTITY_KIT_DISTANCE_BARS.get(key, SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD)


class KitDistance(NamedTuple):
    """One reading's kit-channel measurement (ADAAAA-8952).

    ``best`` is the smallest (side -> its own reference) chromaticity distance,
    ``best_source`` the reference source that produced it, ``best_bar`` the bar it
    was judged at. ``any_inside`` is true when ANY compared side sat inside ITS OWN
    reference's bar.

    ADAAAA-8975 adds what those inside readings PROVE, because an inside reading
    against a curated prior is not evidence on its own:

    - ``inside_observed`` — an inside reading used the job's own `kitColors`
      (a measurement), which corroborates the kit channel by itself.
    - ``inside_prior_same_family`` — an inside reading used a curated prior AND the
      swatch's own ``name_color`` sits in that prior's family: the genuine-plate
      shape the measured bars were derived from.
    - ``inside_prior_foreign`` — an inside reading used a curated prior but the
      swatch reads as a DIFFERENT family (a saturated orange fill inside the red
      bar). This is the shape the printed-name conjunct must reject.
    - ``best_color`` — ``name_color`` of the swatch the reported distance came
      from, published so the board and the served proof can name the fill.
    """

    best: Optional[float]
    best_source: Optional[str]
    best_bar: Optional[float]
    any_inside: bool
    observed_used: bool
    inside_observed: bool = False
    inside_prior_same_family: bool = False
    inside_prior_foreign: bool = False
    best_color: Optional[str] = None

    @property
    def corroborated(self) -> bool:
        """Whether the kit channel corroborated this match WITHOUT the name channel.

        Observed kit colours always do; a curated prior does only when the swatch
        reads as the prior's own colour family (ADAAAA-8975).
        """
        return self.inside_observed or self.inside_prior_same_family


def kit_reference_family(name: Optional[str]) -> str:
    """The colour FAMILY a kit reference name belongs to (ADAAAA-8975).

    The grouping is the one ADAAAA-8936 measured the genuine populations in —
    ``blue/navy/sky blue``, ``red/maroon``, ``orange/gold/yellow``, achromatic — so
    "the swatch reads as this reference's family" is exactly the condition the
    measured recall floors were taken under. An unlisted name is its own family.
    """
    key = str(name or "").strip().lower()
    return _KIT_REFERENCE_FAMILIES.get(key, key)


def _side_kit_distance(
    sides: dict[str, list[float]],
    teams: Optional[Sequence[dict[str, Any]]],
    kit_priors: Optional[Mapping[str, Any]] = None,
    bar: Optional[float] = None,
) -> KitDistance:
    """Best (side -> team kit) chromaticity distance and what governed it.

    ``None`` for the distance means "no side could be compared" (no kit colour on
    the job AND no curated prior for its name, or no swatch on the bug) — which is
    absence, not contradiction.

    Each reference NAME is scored against its own bar (ADAAAA-8952): a `red`
    reference is judged at 0.43 and a `navy` reference at 0.51, while a name with
    no measured row keeps ``SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD``. An explicit
    ``bar`` replaces the table for EVERY reference — that is the pre-8952 one-bar
    behaviour a caller passing ``threshold`` expects, and it must not silently
    keep per-family bars for the names the table happens to carry.

    ADAAAA-8975 records WHICH KIND of evidence each inside reading is
    (``corroborated``), so the verdict can require a printed name when the only
    inside reading is a prior whose swatch is a different colour family.
    """
    best: Optional[float] = None
    best_source: Optional[str] = None
    best_bar: Optional[float] = None
    best_color: Optional[str] = None
    any_inside = False
    observed_used = False
    inside_observed = False
    inside_prior_same_family = False
    inside_prior_foreign = False
    by_side = {str((t or {}).get("side") or ""): t for t in teams or []}
    for side, colour in sides.items():
        team = by_side.get(side)
        names, source = _reference_kit_names(team, kit_priors)
        refs = [(r, name_reference_rgb(r)) for r in names if r]
        refs = [(r, rgb) for r, rgb in refs if rgb]
        if not refs:
            continue
        if source == "observed":
            observed_used = True
        swatch_color = name_color(colour)
        for name, ref in refs:
            d = chroma_distance(colour, ref)
            ref_bar = bar if bar is not None else kit_distance_bar(name)
            if best is None or d < best:
                best = d
                best_source = source
                best_bar = ref_bar
                best_color = swatch_color
            if d <= ref_bar:
                any_inside = True
                if source == "observed":
                    inside_observed = True
                elif kit_reference_family(swatch_color) == kit_reference_family(name):
                    inside_prior_same_family = True
                else:
                    inside_prior_foreign = True
    return KitDistance(
        best,
        best_source,
        best_bar,
        any_inside,
        observed_used,
        inside_observed,
        inside_prior_same_family,
        inside_prior_foreign,
        best_color,
    )




def surface_reading(
    rgb: Any, roi: Any, lines: Optional[Sequence[str]], timestamp: Optional[float] = None
) -> dict[str, Any]:
    """The surface as this crop prints it: kit swatches + team tokens (no reads)."""
    return {
        "kits": _kits_from_crop(rgb, roi) if rgb is not None and roi is not None else {},
        "names": printed_team_tokens(lines),
        "ts": timestamp,
    }


def derive_surface_identity(
    reading: dict[str, Any],
    teams: Optional[Sequence[dict[str, Any]]],
    *,
    threshold: Optional[float] = None,
    kit_priors: Optional[Mapping[str, Any]] = None,
    kit_source: Optional[str] = None,
    kit_sample_seq: Optional[int] = None,
) -> dict[str, Any]:
    """Fold one surface reading + the job's teams into a verdict (AC2.3's input).

    ``contradicted`` needs BOTH channels to disagree: kits outside the measured
    bar AND no printed name matching. Everything else that cannot be shown to be
    this match stays ``absent`` (today's behaviour).

    ``kit_priors`` (ADAAAA-8908) is the curated per-team kit table. It supplies a
    REFERENCE colour for a team that has a name but no observed ``kitColors``
    (the served-jobs shape), so the kit channel is measurable when the Stage-3
    sampler read nothing. It never becomes an observation: ``kits`` below is
    always the swatches the crop printed, and ``kitReference`` records which
    source the reported distance came from.

    ``threshold`` (ADAAAA-8952) is now the FALLBACK bar: by default each reference
    name is judged at its own measured bar (``SURFACE_IDENTITY_KIT_DISTANCE_BARS``)
    and an unmeasured name keeps ``SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD``. An
    explicit value overrides every reference with that one bar, which is the
    pre-8952 behaviour a caller asking for one bar expects. The ``threshold``
    reported on the verdict is the bar the reported reading was judged at.

    ``kit_source`` / ``kit_sample_seq`` (ADAAAA-8960) are PROVENANCE only, and
    they are additive: absent unless the caller names them. ``measured`` means
    the reading's swatch came off this observation's own crop, ``carried`` means
    it was measured on an EARLIER observation of the same surface/signature (the
    served jobs' publish frame, 272 frames after the pass that measured it), and
    ``none`` is the explicit statement that no pass of this surface measured a
    swatch at all. The rule below never reads them: ``contradicted`` stays
    ``kits_differ AND not names_match``, whatever the provenance.

    ADAAAA-8975 makes the printed-name channel a CONJUNCT for PRIOR-derived kit
    references: a swatch inside a curated prior's bar corroborates the surface only
    when it reads as that prior's colour family. A foreign-family fill inside the
    bar (saturated orange inside the red bar) is not evidence on its own, so
    ``consistent`` there needs a printed-name match; read-and-unmatched names make
    it ``contradicted`` (the named refusal), unread names leave it ``absent``.
    Observed ``kitColors`` references are untouched — a measured colour is this
    match's kit, so the bar alone still corroborates it.
    """
    kits = dict(reading.get("kits") or {})
    names = list(reading.get("names") or [])
    matched = match_printed_names(names, teams)
    kit = _side_kit_distance(kits, teams, kit_priors, threshold)
    distance, reference = kit.best, kit.best_source
    kits_present = bool(kits) and distance is not None
    kits_differ = bool(kits_present) and not kit.any_inside
    names_match = bool(matched)
    # ADAAAA-8975: the only inside reading was a PRIOR whose swatch reads as a
    # different colour family -> the kit channel did NOT corroborate this match.
    prior_fill_refused = bool(kits_present) and not kit.corroborated
    # ADAAAA-8908: a CURATED reference (no observed kit colour on the job) is not a
    # measurement of this match's kit, so the kit channel alone may not contradict.
    # When every compared side used the prior, the printed names must have been
    # READ and unmatched — absence of a reading stays `absent` (the shipped rule's
    # "absence is not contradiction"), and no new recall path is created.
    names_unread_on_prior = reference == "prior" and not kit.observed_used and not names
    kit_disagrees = kits_differ or prior_fill_refused
    if names_match:
        verdict = "consistent"
    elif kit_disagrees and not names_unread_on_prior:
        verdict = "contradicted"
    elif kit.any_inside and not prior_fill_refused:
        verdict = "consistent"
    else:
        verdict = "absent"
    return {
        "verdict": verdict,
        "threshold": SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD if kit.best_bar is None else kit.best_bar,
        "kitDistance": None if distance is None else round(float(distance), 4),
        "kitsPresent": bool(kits),
        "kitsDiffer": bool(kits_differ),
        "kitReference": reference,
        # ADAAAA-8975: the additive proof the conjunct reads — whether the kit
        # channel corroborated on its own, why not, and which colour the fill
        # actually reads (published so a served record names the fill).
        "kitCorroborated": bool(kit.corroborated),
        "kitNameRefused": bool(prior_fill_refused),
        "kitFillColor": kit.best_color if kits_present else None,
        "namesMatch": bool(names_match),
        "namesMatched": matched,
        "names": names[:_MAX_TOKENS],
        "kits": {side: list(colour) for side, colour in kits.items()},
        # ADAAAA-8960: additive provenance, present only when the caller names it
        # (a direct derive call stays byte-identical to the shipped shape).
        **(
            {"kitSource": kit_source, "kitSampleSeq": None if kit_sample_seq is None else int(kit_sample_seq)}
            if kit_source is not None
            else {}
        ),
    }


def demotion_note(identity: Optional[dict[str, Any]]) -> str:
    """The operator-facing reason a score change did not attest (scope item 5).

    Names the measurement, not just the outcome, so the board can see WHY a
    window was not accepted without a replay. ADAAAA-8975 adds the prior-name
    refusal: the swatch is INSIDE the bar, so quoting "Δ > bar" would be a lie —
    the note names the fill colour and the prior it matched instead.
    """
    if not identity or identity.get("verdict") != "contradicted":
        return ""
    d = identity.get("kitDistance")
    if identity.get("kitsDiffer") is False and identity.get("kitNameRefused"):
        fill = identity.get("kitFillColor") or "another colour"
        kit = f"swatch reads {fill}, not the prior's colour; Δ={'?' if d is None else f'{d:.2f}'} is inside {identity.get('threshold')}"
    else:
        kit = f"kits Δ={d:.2f} > {identity.get('threshold')}" if d is not None else "kits differ"
    names = ", ".join(identity.get("namesMatched") or []) or ", ".join(identity.get("names") or [])
    return f"score change on a contradicted score surface: ignored ({kit}; printed names {names or 'none'} unmatched)"
