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

from typing import Any, Mapping, Optional, Sequence

from .match_context import (
    _COLOR_BUCKETS,
    kit_prior_primary,
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
    if len(tok) == 3:
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


def _side_kit_distance(
    sides: dict[str, list[float]],
    teams: Optional[Sequence[dict[str, Any]]],
    kit_priors: Optional[Mapping[str, Any]] = None,
) -> tuple[Optional[float], bool, Optional[str], bool]:
    """Best (side -> team kit) chromaticity distance, whether ANY side is inside,
    which reference source produced the best distance, and whether any side was
    compared against an OBSERVED (measured) kit colour.

    ``None`` for the distance means "no side could be compared" (no kit colour on
    the job AND no curated prior for its name, or no swatch on the bug) — which is
    absence, not contradiction.
    """
    best: Optional[float] = None
    best_source: Optional[str] = None
    any_inside = False
    observed_used = False
    by_side = {str((t or {}).get("side") or ""): t for t in teams or []}
    for side, colour in sides.items():
        team = by_side.get(side)
        names, source = _reference_kit_names(team, kit_priors)
        refs = [r for r in (name_reference_rgb(n) for n in names if n) if r]
        if not refs:
            continue
        if source == "observed":
            observed_used = True
        distances = [chroma_distance(colour, ref) for ref in refs]
        d = min(distances)
        if best is None or d < best:
            best = d
            best_source = source
        if d <= SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD:
            any_inside = True
    return best, any_inside, best_source, observed_used




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
    threshold: float = SURFACE_IDENTITY_KIT_DISTANCE_THRESHOLD,
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

    ``kit_source`` / ``kit_sample_seq`` (ADAAAA-8960) are PROVENANCE only, and
    they are additive: absent unless the caller names them. ``measured`` means
    the reading's swatch came off this observation's own crop, ``carried`` means
    it was measured on an EARLIER observation of the same surface/signature (the
    served jobs' publish frame, 272 frames after the pass that measured it), and
    ``none`` is the explicit statement that no pass of this surface measured a
    swatch at all. The rule below never reads them: ``contradicted`` stays
    ``kits_differ AND not names_match``, whatever the provenance.
    """
    kits = dict(reading.get("kits") or {})
    names = list(reading.get("names") or [])
    matched = match_printed_names(names, teams)
    distance, any_inside, reference, observed_used = _side_kit_distance(kits, teams, kit_priors)
    kits_present = bool(kits) and distance is not None
    kits_differ = bool(kits_present) and not any_inside
    names_match = bool(matched)
    # ADAAAA-8908: a CURATED reference (no observed kit colour on the job) is not a
    # measurement of this match's kit, so the kit channel alone may not contradict.
    # When every compared side used the prior, the printed names must have been
    # READ and unmatched — absence of a reading stays `absent` (the shipped rule's
    # "absence is not contradiction"), and no new recall path is created.
    names_unread_on_prior = reference == "prior" and not observed_used and not names
    if kits_differ and not names_match and not names_unread_on_prior:
        verdict = "contradicted"
    elif any_inside or names_match:
        verdict = "consistent"
    else:
        verdict = "absent"
    return {
        "verdict": verdict,
        "threshold": threshold,
        "kitDistance": None if distance is None else round(float(distance), 4),
        "kitsPresent": bool(kits),
        "kitsDiffer": bool(kits_differ),
        "kitReference": reference,
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
    window was not accepted without a replay.
    """
    if not identity or identity.get("verdict") != "contradicted":
        return ""
    d = identity.get("kitDistance")
    kit = f"kits Δ={d:.2f} > {identity.get('threshold')}" if d is not None else "kits differ"
    names = ", ".join(identity.get("namesMatched") or []) or ", ".join(identity.get("names") or [])
    return f"score change on a contradicted score surface: ignored ({kit}; printed names {names or 'none'} unmatched)"
