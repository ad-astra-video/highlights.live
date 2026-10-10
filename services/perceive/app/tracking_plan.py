# TrackingPlan contract (increment A — ADAAAA-6462, child of ADAAAA-6441).
#
# A category-agnostic JSON object the decide brain (planner) emits telling
# perceive WHAT to track: anchor + targets (the closed detection roster),
# optional zones, discovery provenance, and a proposed maxTracks.
#
# Role division (per plan §14.2 of ADAAAA-6441):
#   * this module is the CONTRACT + the validator ("must implement validator
#     rules" — increment A acceptance). It is pure data + coercion; it never
#     raises on bad LLM output and never touches the GPU.
#   * the PER-FRAME path consumes a normalized plan (increment B will wire
#     resolve_vocabulary / resolve_zones / anchor slot to it). The guarantee
#     this module buys is that an unparseable/unknown/absent plan can never
#     crash the per-frame path: normalize() coerces, validate() reports, and
#     the caller degrades to the canned/safe-default roster.
#
# Field rules (issue spec):
#   - role: open enum ball|player|agent|entity|zone (zone = region, not a
#     track target). Unknown role -> safe default "entity" (never crash).
#   - anchor: exactly one; must appear in targets. Missing/malformed ->
#     safe-default to the first trackable target + warning (never an error).
#   - targets[].label maps onto the closed-vocabulary gate: the roster IS the
#     vocabulary. Trackability gate: no abstract/untrackable targets, no
#     UI/HUD elements (Florence reads HUD as unrelated junk; OCR/decide own
#     those, not vision tracking).
#   - zones[].normalized: 4 floats in [0,1].
#   - maxTracks: LLM proposes; the server hard-clamps (3 live / 8 VOD).
#   - discovery: optional but recorded when a discovery pass ran (audit).

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

# --- contract constants ----------------------------------------------------

PLAN_VERSION = 1

# Open role enum. The set is open by design (plan §4.1) — but every value the
# brain can emit is covered; anything outside this set is unknown and maps to
# the safe default below.
VALID_ROLES: tuple[str, ...] = ("ball", "player", "agent", "entity", "zone")
SAFE_DEFAULT_ROLE: str = "entity"

# maxTracks clamp (invariant, never silently changed — plan §11): the LLM
# proposes, the server clamps.
LIVE_MAX_TRACKS = 3
VOD_MAX_TRACKS = 8
MODE_MAX_TRACKS: dict[str, int] = {"live": LIVE_MAX_TRACKS, "vod": VOD_MAX_TRACKS}

# Trackability gate — substring blocklists applied to targets[].label.
# UI/HUD elements are never SAM3 track targets: Florence-2 reads a minimap as
# "mobile phone", a timer as "digital clock", a kill-feed fragment as
# "short pants" (measured live, ADAAAA-6340 notes in florence.py). On-screen
# text belongs to <OCR> / the decide stage, not vision tracking.
UI_HUD_BLOCKS: tuple[str, ...] = (
    "kill feed",
    "killfeed",
    "scoreboard",
    "minimap",
    "mini map",
    "radar",
    "hud",
    "ui ",
    " ui",
    "timer",
    "clock",
    "spectator",
    "chat",
    "banner",
    "overlay",
    "watermark",
)
# Abstract / untrackable targets — nothing a detector can box and a tracker
# can follow. The brain must name concrete objects (plan §4.2a).
ABSTRACT_BLOCKS: tuple[str, ...] = (
    "atmosphere",
    "mood",
    "vibe",
    "crowd energy",
    "energy",
    "style",
    "aesthetic",
    "frame-level",
    "camera work",
    "cinematic",
    "background music",
    "sound",
    "audio",
    "commentary",
    "narrative",
    "story",
    "emotion",
    "tension",
    "drama",
)

# Canonical discovery methods (plan §4.1 discovery.method).
DISCOVERY_METHODS: tuple[str, ...] = ("od", "caption", "region", "mixed")

# Florence-2 task tokens the planner may record in discovery.florenceTasks
# (the full task table — increment A acceptance: the capability seed must
# cover this table; recording any of these is a valid audit entry).
FLORENCE_TASKS: tuple[str, ...] = (
    "<OD>",
    "<CAPTION>",
    "<DETAILED_CAPTION>",
    "<MORE_DETAILED_CAPTION>",
    "<DENSE_REGION_CAPTION>",
    "<REGION_PROPOSAL>",
    "<CAPTION_TO_PHRASE_GROUNDING>",
    "<REFERRING_EXPRESSION_SEGMENTATION>",
    "<OCR>",
)


# --- pure helpers ----------------------------------------------------------


def clamp_max_tracks(proposed: Any, mode: str = "live") -> int:
    """Hard-clamp the LLM-proposed maxTracks to the company cap for `mode`
    ("live" -> 3, "vod" -> 8; unknown mode -> 0). The LLM proposes; the server
    clamps. Non-int proposals coerce best-effort (None/"" -> 0)."""
    cap = MODE_MAX_TRACKS.get(mode, 0)
    try:
        val = int(proposed)
    except (TypeError, ValueError):
        val = 0
    if val < 0:
        val = 0
    return min(val, cap)


def coerce_role(role: Any) -> tuple[str, bool]:
    """Coerce an arbitrary model role value to a known role.

    Returns (role, coerced). Unknown/missing roles map to the safe default
    ("entity") with coerced=True — the safe-default rule means the per-frame
    path NEVER sees an unknown role. Case/whitespace-normalized.
    """
    r = str(role).strip().lower() if role is not None else ""
    if r in VALID_ROLES:
        return r, False
    return SAFE_DEFAULT_ROLE, True


def is_ui_hud_label(label: str) -> bool:
    """True when a label names UI/HUD content (never a track target)."""
    low = f" {str(label).strip().lower()} "
    return any(b in low for b in UI_HUD_BLOCKS)


def is_abstract_label(label: str) -> bool:
    """True when a label is abstract / untrackable (nothing a detector can
    box and a tracker can follow)."""
    low = f" {str(label).strip().lower()} "
    return any(b in low for b in ABSTRACT_BLOCKS)


def label_trackable(label: str) -> bool:
    """The closed-vocab trackability gate for a single roster label: non-empty,
    not UI/HUD, not abstract."""
    l = str(label).strip()
    if not l:
        return False
    return not is_ui_hud_label(l) and not is_abstract_label(l)


def _is_zone_label(label: str) -> bool:
    """Soft hint: a label that reads like a region name (end zone, goal
    mouth...) — zones are still declared via role="zone"; this only guards
    against the brain putting a region in targets without the zone role."""
    low = str(label).strip().lower()
    return low in {"zone", "region", "area", "zone of interest"}


# --- coercion of the raw model output (never raises) -----------------------


def _as_text(value: Any) -> str:
    s = str(value).strip() if value is not None else ""
    return s


def _as_bool(value: Any, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("true", "yes", "1"):
            return True
        if low in ("false", "no", "0"):
            return False
    return default


def _coerce_zone_box(raw: Any, warnings: list[str]) -> list[float] | None:
    """Coerce a zone's normalized box to 4 floats in [0,1] (x1<=x2, y1<=y2).
    Accepts a 4-sequence or a {x1,y1,x2,y2} dict. Returns None (dropped zone)
    when it cannot be coerced. Coordinates are clamped, never rejected."""
    vals: Any = raw
    if isinstance(raw, dict):
        vals = [raw.get("x1"), raw.get("y1"), raw.get("x2"), raw.get("y2")]
    if not isinstance(vals, (list, tuple)) or len(vals) < 4:
        return None
    try:
        nums = [float(v) for v in vals[:4]]
    except (TypeError, ValueError):
        return None
    nums = [min(max(n, 0.0), 1.0) for n in nums]
    if nums[0] > nums[2]:
        nums[0], nums[2] = nums[2], nums[0]
    if nums[1] > nums[3]:
        nums[1], nums[3] = nums[3], nums[1]
    return nums


def _normalize_target(raw: Any, index: int, warnings: list[str]) -> dict | None:
    """Coerce one raw target. Returns None when the label is missing or fails
    the trackability gate (UI/HUD or abstract) — those are dropped with a
    warning, so the roster never carries an untrackable target."""
    if isinstance(raw, str):
        raw = {"label": raw}
    if not isinstance(raw, dict):
        warnings.append(f"targets[{index}] is not an object; dropped")
        return None
    label = _as_text(raw.get("label"))
    if not label:
        warnings.append(f"targets[{index}] has no label; dropped")
        return None
    if not label_trackable(label):
        why = "ui/hud element" if is_ui_hud_label(label) else "abstract/untrackable"
        warnings.append(f"targets[{index}] label {label!r} rejected ({why}); dropped")
        return None
    role, coerced = coerce_role(raw.get("role"))
    if _is_zone_label(label):
        # A region name in targets is a zone by content even when the model
        # forgot role="zone" — zones are not track targets.
        role, coerced = "zone", True
    if coerced:
        warnings.append(
            f"targets[{index}] unknown role {raw.get('role')!r} -> safe default "
            f"{SAFE_DEFAULT_ROLE!r}"
        )
    try:
        slot = int(raw.get("slotPriority"))
    except (TypeError, ValueError):
        slot = index
    if slot < 0:
        slot = index
    return {
        "label": label,
        "role": role,
        "slotPriority": slot,
        "track": _as_bool(raw.get("track"), default=True),
    }


def _normalize_anchor(raw: Any, targets: list[dict], warnings: list[str]) -> dict:
    """Exactly one anchor, and it must appear in targets. Missing/malformed
    anchor -> safe-default to the first trackable (non-zone) target +
    warning. An anchor naming a non-target label is repaired onto the closest
    surviving target so the invariant (anchor in targets) always holds after
    normalize() — the caller then sees a consistent plan."""
    first = next((t for t in targets if t["role"] != "zone"), None)
    if isinstance(raw, dict) and _as_text(raw.get("label")):
        label = _as_text(raw.get("label"))
        match = next((t for t in targets if t["label"].lower() == label.lower()), None)
        if match is not None:
            role, _ = coerce_role(raw.get("role"))
            if match["role"] == "zone":
                # An anchor must be a trackable target, never a region.
                warnings.append(f"anchor {label!r} is a zone; re-anchored to first trackable target")
                if first is None:
                    warnings.append("no trackable target available for anchor")
                    return {"label": "", "role": SAFE_DEFAULT_ROLE}
                return {"label": first["label"], "role": first["role"]}
            return {"label": match["label"], "role": role}
        warnings.append(f"anchor {label!r} does not appear in targets; re-anchored to first trackable target")
    else:
        warnings.append("anchor missing/malformed; safe-defaulted to first trackable target")
    if first is None:
        warnings.append("no trackable target available for anchor")
        return {"label": "", "role": SAFE_DEFAULT_ROLE}
    return {"label": first["label"], "role": first["role"]}


def _normalize_discovery(raw: Any) -> dict | None:
    """discovery is optional but recorded: when the planner ran a discovery
    pass it records method + Florence-2 tasks + notes so QA can audit which
    task produced the track set. Absent/None/empty -> None (no discovery
    recorded). Malformed -> a minimal audit stub (never an error)."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return {"method": "mixed", "florenceTasks": [], "notes": f"unparseable discovery {raw!r}"}
    method = _as_text(raw.get("method")).lower() or "mixed"
    if method not in DISCOVERY_METHODS:
        method = "mixed"
    tasks_raw = raw.get("florenceTasks")
    tasks: list[str] = []
    if isinstance(tasks_raw, (list, tuple)):
        for t in tasks_raw:
            s = _as_text(t)
            if s and s not in tasks:
                tasks.append(s)
    notes = _as_text(raw.get("notes"))
    return {"method": method, "florenceTasks": tasks, "notes": notes}


def _normalize_zones(raw: Any, warnings: list[str]) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        warnings.append(f"zones is not a list; ignored ({type(raw).__name__})")
        return []
    out: list[dict] = []
    for i, z in enumerate(raw):
        if not isinstance(z, dict):
            warnings.append(f"zones[{i}] is not an object; dropped")
            continue
        name = _as_text(z.get("name")) or f"zone{i}"
        box = _coerce_zone_box(z.get("normalized"), warnings)
        if box is None:
            warnings.append(f"zones[{i}] ({name}) bad normalized box; dropped")
            continue
        out.append(
            {
                "name": name,
                "normalized": box,
                "purpose": _as_text(z.get("purpose")),
            }
        )
    return out


# --- the validator ----------------------------------------------------------


def normalize(raw: Any) -> tuple[dict, list[str]]:
    """Coerce arbitrary (usually LLM) input to a contract-shaped dict.

    Returns (plan, warnings). NEVER raises: unknown roles -> safe default,
    bad zones/targets dropped with a warning, anchor repaired. The one thing
    normalize cannot fix — no trackable targets at all — is reported via
    validate() (hard error), and the caller degrades to the canned/safe
    default roster. An empty dict input yields a valid-but-empty plan so the
    per-frame path has a stable shape to consume.
    """
    warnings: list[str] = []
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        warnings.append(f"plan is not an object ({type(raw).__name__}); coerced to empty plan")
        raw = {}

    # targets first (the roster is authoritative for everything else).
    targets_raw = raw.get("targets")
    if targets_raw is None:
        targets_raw = []
    if not isinstance(targets_raw, (list, tuple)):
        warnings.append(f"targets is not a list; ignored ({type(targets_raw).__name__})")
        targets_raw = []
    targets: list[dict] = []
    for i, t in enumerate(targets_raw):
        nt = _normalize_target(t, i, warnings)
        if nt is not None:
            targets.append(nt)

    anchor = _normalize_anchor(raw.get("anchor"), targets, warnings)
    zones = _normalize_zones(raw.get("zones"), warnings)

    # maxTracks: the LLM's proposal (clamped to [1, 8] as a sane plan-scale
    # bound; the 3-live/8-VOD hard clamp is the SERVER's job via
    # clamp_max_tracks — see the note on that function).
    proposed = raw.get("maxTracks")
    try:
        max_tracks = int(proposed)
    except (TypeError, ValueError):
        max_tracks = LIVE_MAX_TRACKS
        if proposed not in (None, ""):
            warnings.append(f"maxTracks {proposed!r} not an int; defaulting to {LIVE_MAX_TRACKS}")
    if max_tracks < 1:
        warnings.append(f"maxTracks {max_tracks} < 1; clamped to 1")
        max_tracks = 1
    elif max_tracks > VOD_MAX_TRACKS:
        warnings.append(f"maxTracks {max_tracks} > {VOD_MAX_TRACKS}; clamped to {VOD_MAX_TRACKS}")
        max_tracks = VOD_MAX_TRACKS

    plan = {
        "planVersion": PLAN_VERSION,
        "category": _as_text(raw.get("category")).lower() or "general",
        "intent": _as_text(raw.get("intent")),
        "anchor": anchor,
        "targets": targets,
        "zones": zones,
        "discovery": _normalize_discovery(raw.get("discovery")),
        "maxTracks": max_tracks,
        "reason": _as_text(raw.get("reason")),
    }
    return plan, warnings


def validate(raw: Any) -> tuple[bool, list[str]]:
    """Hard validation of raw input (plan §14.2: the validator rules are the
    acceptance gate). Returns (ok, errors). A plan is invalid only when it
    carries no trackable targets at all — everything else is coercible, so
    the per-frame path has exactly one degrade decision to make (use this
    roster vs canned/safe-default)."""
    plan, warnings = normalize(raw)
    errors: list[str] = []
    if not plan["targets"]:
        errors.append("no trackable targets (all missing, untrackable, or UI/HUD)")
    # Anchor consistency is guaranteed by normalize(); assert it so a future
    # edit that breaks the invariant fails loudly at the contract boundary.
    if plan["targets"] and plan["anchor"]["label"]:
        if not any(t["label"].lower() == plan["anchor"]["label"].lower() for t in plan["targets"]):
            errors.append("anchor does not appear in targets")
    return (not errors), errors + warnings


# --- the dataclass (typed consumer shape) -----------------------------------


@dataclass
class TrackingPlan:
    """Typed shape of a normalized TrackingPlan. Use TrackingPlan.from_dict()
    on already-normalized input (see normalize()). to_dict() round-trips the
    contract keys exactly."""

    planVersion: int = PLAN_VERSION
    category: str = "general"
    intent: str = ""
    anchor: dict = field(default_factory=lambda: {"label": "", "role": SAFE_DEFAULT_ROLE})
    targets: list = field(default_factory=list)
    zones: list = field(default_factory=list)
    discovery: Optional[dict] = None
    maxTracks: int = LIVE_MAX_TRACKS
    reason: str = ""

    @classmethod
    def from_dict(cls, d: Any) -> "TrackingPlan":
        """Build a TrackingPlan from a RAW dict, normalizing first (never
        raises). Invalid plans (no trackable targets) still produce an object
        with .targets == [] so callers can test `plan.targets` for the
        degrade decision."""
        norm, _ = normalize(d)
        return cls(
            planVersion=int(norm.get("planVersion", PLAN_VERSION)),
            category=norm.get("category", "general"),
            intent=norm.get("intent", ""),
            anchor=dict(norm.get("anchor") or {"label": "", "role": SAFE_DEFAULT_ROLE}),
            targets=list(norm.get("targets") or []),
            zones=list(norm.get("zones") or []),
            discovery=norm.get("discovery"),
            maxTracks=int(norm.get("maxTracks", LIVE_MAX_TRACKS)),
            reason=norm.get("reason", ""),
        )

    def to_dict(self) -> dict:
        return {
            "planVersion": self.planVersion,
            "category": self.category,
            "intent": self.intent,
            "anchor": dict(self.anchor),
            "targets": [dict(t) for t in self.targets],
            "zones": [dict(z) for z in self.zones],
            "discovery": dict(self.discovery) if isinstance(self.discovery, dict) else None,
            "maxTracks": self.maxTracks,
            "reason": self.reason,
        }

    @property
    def is_valid(self) -> bool:
        """True when the plan carries at least one trackable target (the only
        hard-invalid case — everything else is coerced)."""
        return bool(self.targets)

    def vocabulary(self) -> list[str]:
        """The closed detection roster this plan defines: target labels in
        slotPriority order, de-duplicated, zone-role targets excluded (zones
        are regions, not detection vocabulary). Feeds the closed-vocab gate
        (resolve_vocabulary) in increment B."""
        out: list[str] = []
        for t in sorted(self.targets, key=lambda t: int(t.get("slotPriority", 0))):
            if t.get("role") == "zone":
                continue
            lab = str(t.get("label", "")).strip()
            if lab and lab not in out:
                out.append(lab)
        return out


def plan_vocabulary(plan: Any) -> list[str]:
    """Convenience: the closed roster from a plan dict (already-normalized or
    raw — normalizes on demand, never raises). Empty list == no plan roster
    (caller degrades to canned/safe-default)."""
    if isinstance(plan, TrackingPlan):
        return plan.vocabulary()
    if not isinstance(plan, dict) or "targets" not in plan:
        return []
    return TrackingPlan.from_dict(plan).vocabulary()
