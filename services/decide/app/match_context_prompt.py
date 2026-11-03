"""ADAAAA-7856: render the persisted job ``matchContext`` into decide prompts.

Stage 6-7 of the match-context spec (parent ADAAAA-7849). The sibling resolver
(ADAAAA-7855) figures out ONCE per job who is playing and which colour each
side wears, and stores it on the job record as ``matchContext``. This module
turns that stored record into the one compact prompt block every window
inspection carries, plus the anti-fabrication rule that stops the model
inventing a team/nationality ("German defender" on a Portugal vs Spain job).

Rules this module enforces:

* Absent context renders the EMPTY STRING. Every caller appends it
  unconditionally, so a job with no stored context sends byte-identical prompt
  text to what it sent before this change (AC6).
* A malformed context NEVER raises and never hard-fails a request: unknown
  fields are dropped, bad team entries are skipped, a context with no usable
  team name renders empty (i.e. today's prompt). Context is advisory evidence,
  not a reason to 422 a decide call.
* The rendered block is bounded (<= ``MAX_BLOCK_CHARS``) so the per-window
  prompt delta stays ~120 tokens with no extra inference call.
* Wording is sport-aware: team sports talk about shirts/trim, esports talk
  about side/agent colours and say "the player" rather than "the defender".
"""

from __future__ import annotations

#: Hard cap on the rendered block (4 chars/token => ~120 tokens, the plan §4
#: per-window prompt-delta budget). A block longer than this is truncated at a
#: line boundary; the rule line always survives.
MAX_BLOCK_CHARS = 480

#: A match has exactly two sides; anything beyond the first two usable teams is
#: dropped rather than described (a resolver glitch must not bloat the prompt).
MAX_TEAMS = 2

#: Sports whose "kit" is a side/agent/brand colour rather than a shirt. The
#: wording is different (no shirts, no trim) — a Valorant side wears agent
#: colours, not a jersey.
ESPORT_SPORTS = frozenset(
    {
        "valorant",
        "counter-strike",
        "counter strike",
        "csgo",
        "cs2",
        "cs",
        "league of legends",
        "lol",
        "dota",
        "dota2",
        "overwatch",
        "apex legends",
        "apex",
        "fortnite",
        "rocket league",
        "rainbow six",
        "siege",
        "call of duty",
        "cod",
        "esports",
        "e-sports",
        "gaming",
    }
)

_VALID_SIDES = ("home", "away")
_MAX_NAME = 60
_MAX_SPORT = 40
_MAX_COLOUR = 24


def canonical_sport(raw: object) -> str:
    """Lowercased, trimmed sport key. Never raises on a non-string."""
    if not isinstance(raw, str):
        return ""
    return raw.strip().lower()[:_MAX_SPORT]


def is_esports(sport: object) -> bool:
    s = canonical_sport(sport)
    if not s:
        return False
    if s in ESPORT_SPORTS:
        return True
    # "soccer" contains no esport token, but a hint like "Valorant (PC)" should
    # still match — check whole-token membership on the canonical key's words.
    return any(tok in ESPORT_SPORTS for tok in s.replace("/", " ").split())


def _text(raw: object, limit: int) -> str:
    if not isinstance(raw, str):
        return ""
    return raw.strip()[:limit]


def _clamp_confidence(raw: object) -> float:
    try:
        v = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if v != v:  # NaN
        return 0.0
    return max(0.0, min(1.0, v))


def _sanitize_colours(raw: object) -> list[dict]:
    """Keep at most two well-formed ``{primary, secondary}`` colour entries."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        primary = _text(item.get("primary"), _MAX_COLOUR)
        if not primary:
            continue
        secondary = _text(item.get("secondary"), _MAX_COLOUR)
        entry = {"primary": primary}
        if secondary:
            entry["secondary"] = secondary
        out.append(entry)
        if len(out) >= 2:
            break
    return out


def sanitize_match_context(raw: object) -> dict | None:
    """Normalise a stored/incoming ``matchContext`` to the prompt contract.

    Returns ``{"sport": str, "teams": [{name, side, kitColors, confidence}],
    "ambiguous": bool}`` — or ``None`` when there is nothing usable to name.
    Unknown fields are dropped, non-dict team entries are skipped, and a model
    object with ``model_dump`` is accepted too. Never raises.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        dump = getattr(raw, "model_dump", None)
        if callable(dump):
            try:
                raw = dump()
            except Exception:  # noqa: BLE001 - advisory input, never hard-fail
                return None
        if not isinstance(raw, dict):
            return None
    sport = canonical_sport(raw.get("sport"))
    teams_raw = raw.get("teams")
    if not isinstance(teams_raw, list):
        teams_raw = []
    teams: list[dict] = []
    seen_sides: set[str] = set()
    for item in teams_raw:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"), _MAX_NAME)
        # "unknown" is the resolver's explicit "could not attribute" value; it is
        # never rendered as a team name (that would be a fabricated claim).
        if not name or name.lower() == "unknown":
            continue
        side = _text(item.get("side"), 10).lower()
        if side not in _VALID_SIDES:
            side = "unknown"
        if side in seen_sides:
            continue
        seen_sides.add(side)
        teams.append(
            {
                "name": name,
                "side": side,
                "kitColors": _sanitize_colours(item.get("kitColors")),
                "confidence": _clamp_confidence(item.get("confidence")),
            }
        )
        if len(teams) >= MAX_TEAMS:
            break
    if not teams:
        return None
    return {
        "sport": sport,
        "teams": teams,
        "ambiguous": bool(raw.get("ambiguous")),
    }


def _colour_phrase(team: dict, esports: bool) -> str:
    colours = team.get("kitColors") or []
    if not colours:
        return ""
    primary = colours[0].get("primary") or ""
    secondary = colours[0].get("secondary") or ""
    if not primary:
        return ""
    if esports:
        phrase = f"{primary} agent/side colours"
        return phrase + (f", {secondary} accents" if secondary else "")
    phrase = f"{primary} shirts"
    return phrase + (f", {secondary} trim" if secondary else "")


def match_context_rule(sport: object) -> str:
    """The anti-fabrication rule, worded for the sport.

    This is the actual fix for the "German defender" class of error: without it
    the model is asked to narrate like an announcer with no team data and
    invents one. Kept to one sentence pair so the per-window prompt delta stays
    inside the ~120-token budget.
    """
    if is_esports(sport):
        unknown = 'say "the player"'
        source = "kit/agent colour, org logo, language or appearance"
    else:
        unknown = 'say "the defender"'
        source = "kit colour, logo, language or appearance"
    return (
        "Rule: name only the teams above. Never infer a team or nationality from "
        f"{source}. If a side is unknown, {unknown} — not a country."
    )


def render_match_context_block(raw: object) -> str:
    """Render the MATCH CONTEXT prompt block, or ``""`` when unusable/absent.

    Callers append the result unconditionally; an empty string keeps the prompt
    byte-identical to the pre-feature text (AC6).
    """
    ctx = sanitize_match_context(raw)
    if ctx is None:
        return ""
    sport = ctx.get("sport") or ""
    esports = is_esports(sport)
    lines = ["MATCH CONTEXT (inferred, authoritative for naming):"]
    for team in ctx["teams"]:
        side = team["side"] if team["side"] != "unknown" else "side unknown"
        colour = _colour_phrase(team, esports)
        label = team["name"]
        lines.append(f"  {side}: {label}" + (f" — {colour}" if colour else ""))
    if ctx.get("ambiguous"):
        # Emit the ambiguity instead of guessing which side is which (plan §7).
        lines.append("  (side assignment is ambiguous — name the team only when the frames plainly show it)")
    rule = match_context_rule(sport)
    block = "\n".join(lines) + "\n  " + rule
    if len(block) <= MAX_BLOCK_CHARS:
        return block
    # Truncate at a line boundary and always keep the rule line intact.
    keep: list[str] = []
    budget = MAX_BLOCK_CHARS - len(rule) - 4
    for line in lines:
        if len("\n".join(keep)) + len(line) + 1 > budget:
            break
        keep.append(line)
    if not keep:
        keep = [lines[0]]
    return "\n".join(keep) + "\n  " + rule


__all__ = [
    "MAX_BLOCK_CHARS",
    "MAX_TEAMS",
    "ESPORT_SPORTS",
    "canonical_sport",
    "is_esports",
    "match_context_rule",
    "render_match_context_block",
    "sanitize_match_context",
]
