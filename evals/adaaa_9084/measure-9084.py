"""ADAAAA-9084 $0 measurement: what verdict the SERVED identity rule reads when the
delivered teams are the QA lever's instead of the resolved ones.

Reads the real plate swatches off a stored served row (job ad4dfd77, the served
`kids95_8483.mp4` broadcast) and folds them through the SERVED
`derive_surface_identity` with candidate delivered-team sets.
"""
import sys, types, json

APP = "/srv/perceive/app"
sys.path.insert(0, "/srv/perceive")
pkg = types.ModuleType("app")
pkg.__path__ = [APP]
sys.modules["app"] = pkg

from app.match_context import kit_prior_table, name_color, _COLOR_BUCKETS
from app.surface_identity import (
    derive_surface_identity,
    name_reference_rgb,
    chroma_distance,
    kit_distance_bar,
    demotion_note,
    team_tokens,
    token_matches_team,
)

# The stored row's OWN reading (jobs.record.scoreboardSurface.identity.kits/names).
READING = {"kits": {"home": [81.0, 61.0, 98.0], "away": [97.0, 105.0, 163.0]}, "names": ["RMA", "BAR"]}

priors = kit_prior_table("soccer")

def run(label, teams, reading=READING):
    out = derive_surface_identity(reading, teams, kit_priors=priors)
    print(f"\n== {label}")
    print(f"   teams   {[(t['side'], t['name'], [k.get('primary') for k in t.get('kitColors', [])]) for t in teams]}")
    print(f"   verdict {out['verdict']}  kitsDiffer={out['kitsDiffer']}  kitDistance={out['kitDistance']} "
          f"bar={out['threshold']}  ref={out['kitReference']}  namesMatch={out['namesMatch']} "
          f"namesMatched={out['namesMatched']} names={out['names']} fill={out.get('kitFillColor')}")
    if out["verdict"] == "contradicted":
        print(f"   note    {demotion_note(out)!r}")
    return out

echo_refs = {}
for c in ["blue", "navy", "red", "maroon", "orange", "gold", "yellow", "green", "cyan", "purple", "pink", "white", "black"]:
    rgb = name_reference_rgb(c)
    if not rgb:
        continue
    echo_refs[c] = {
        "bar": kit_distance_bar(c),
        "home": round(chroma_distance(READING["kits"]["home"], rgb), 4),
        "away": round(chroma_distance(READING["kits"]["away"], rgb), 4),
        "swatch_reads": name_color(rgb),
    }
print("== reference table vs the stored plates (home [81,61,98] / away [97,105,163])")
for c, v in sorted(echo_refs.items(), key=lambda kv: min(kv[1]["home"], kv[1]["away"])):
    inside = "INSIDE" if (v["home"] <= v["bar"] or v["away"] <= v["bar"]) else "outside"
    print(f"   {c:9s} bar={v['bar']:.2f} d_home={v['home']:.4f} d_away={v['away']:.4f} {inside}")

# The resolved (served) reference = the control arm: must stay `consistent`.
run("CONTROL — delivered teams as resolved today (Barcelona, observed blue)",
    [{"side": "away", "name": "Barcelona", "kitColors": [{"primary": "blue"}]}])

# Candidates for the lever: names that print neither RMA nor BAR, kits far from the plates.
CANDIDATES = {
    "A home=Juventus red / away=Liverpool red": [
        {"side": "home", "name": "Juventus", "kitColors": [{"primary": "red"}]},
        {"side": "away", "name": "Liverpool", "kitColors": [{"primary": "red"}]},
    ],
    "B home=Juventus green / away=Liverpool green": [
        {"side": "home", "name": "Juventus", "kitColors": [{"primary": "green"}]},
        {"side": "away", "name": "Liverpool", "kitColors": [{"primary": "green"}]},
    ],
    "C away only Liverpool red (one-sided lever)": [
        {"side": "away", "name": "Liverpool", "kitColors": [{"primary": "red"}]},
    ],
    "D home=Juventus white / away=Liverpool red": [
        {"side": "home", "name": "Juventus", "kitColors": [{"primary": "white"}]},
        {"side": "away", "name": "Liverpool", "kitColors": [{"primary": "red"}]},
    ],
}
for label, teams in CANDIDATES.items():
    run(label, teams)

print("\n== name-channel check for the chosen teams (RMA/BAR must NOT match)")
for name in ["Juventus", "Liverpool", "Barcelona", "Real Madrid"]:
    print(f"   {name:12s} RMA={token_matches_team('RMA', name)} BAR={token_matches_team('BAR', name)} tokens={sorted(team_tokens(name))}")

# Blank names stay `absent`, not contradicted (absence is not contradiction).
run("names UNREAD (no OCR tokens) with the lever teams", 
    [{"side": "home", "name": "Juventus", "kitColors": [{"primary": "red"}]},
     {"side": "away", "name": "Liverpool", "kitColors": [{"primary": "red"}]}],
    reading={"kits": READING["kits"], "names": []})
