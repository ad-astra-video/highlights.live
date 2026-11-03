"""ADAAAA-7856: scan captions/narratives for out-of-context team attributions.

AC2 needs a machine check, not a human impression: a job whose stored
``matchContext`` says Portugal vs Spain must produce ZERO window narratives,
highlight reasons or chapter copy naming a team/nationality that context does
not sanction (the "German defender" class of error).

Usage (returns 0 hits => exit 0, any hit => exit 1):

    python scan_team_attributions.py \
        --match-context match-context.json \
        --text window-narratives.json     # JSON: list[str] or {"texts": [...]}
    python scan_team_attributions.py --match-context ctx.json --text-file captions.txt

``--text -`` reads stdin. Output is JSON on stdout; every hit names the text
index, the offending token and its offset so the failure is citable.

The scanner is deliberately conservative in the ALLOWED direction and generous
in the FLAGGED direction: a matchContext team sanctions its own name, its
demonym ("Portugal" -> "Portuguese") and any alias listed in the context's
evidence snippets. Everything else in the built-in team/nationality lexicon is
a hit — a false positive is cheap to read, a missed "German defender" is the
bug this exists to catch.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from app.match_context_prompt import sanitize_match_context

#: country/national team -> demonyms that attribute that nationality.
#: Covers the sports the pipeline supports (soccer national sides, NBA/NFL/NHL
#: markets, esports org countries). Extend with --extra-terms per job.
DEMONYM_MAP: dict[str, tuple[str, ...]] = {
    "Argentina": ("argentine", "argentinian"),
    "Australia": ("australian", "socceroo", "socceroos"),
    "Austria": ("austrian",),
    "Belgium": ("belgian",),
    "Brazil": ("brazilian", "brasil"),
    "Cameroon": ("cameroonian",),
    "Canada": ("canadian",),
    "Chile": ("chilean",),
    "China": ("chinese",),
    "Colombia": ("colombian",),
    "Croatia": ("croatian",),
    "Czech Republic": ("czech",),
    "Denmark": ("danish",),
    "Ecuador": ("ecuadorian",),
    "Egypt": ("egyptian",),
    "England": ("english", "three lions"),
    "France": ("french",),
    "Germany": ("german", "germans"),
    "Ghana": ("ghanaian",),
    "Greece": ("greek",),
    "Hungary": ("hungarian",),
    "Iceland": ("icelandic",),
    "Iran": ("iranian",),
    "Ireland": ("irish",),
    "Italy": ("italian",),
    "Ivory Coast": ("ivorian",),
    "Japan": ("japanese",),
    "Mexico": ("mexican",),
    "Morocco": ("moroccan",),
    "Netherlands": ("dutch", "holland"),
    "Nigeria": ("nigerian",),
    "Norway": ("norwegian",),
    "Poland": ("polish",),
    "Portugal": ("portuguese",),
    "Qatar": ("qatari",),
    "Russia": ("russian",),
    "Saudi Arabia": ("saudi",),
    "Scotland": ("scottish",),
    "Senegal": ("senegalese",),
    "Serbia": ("serbian",),
    "South Korea": ("korean",),
    "Spain": ("spanish", "spaniard", "spaniards"),
    "Sweden": ("swedish",),
    "Switzerland": ("swiss",),
    "Tunisia": ("tunisian",),
    "Turkey": ("turkish",),
    "Ukraine": ("ukrainian",),
    "United States": ("american", "usa", "usmnt"),
    "Uruguay": ("uruguayan",),
    "Wales": ("welsh",),
}

#: Club/international shorthand that is NOT a nationality but is still a team
#: attribution: naming one of these is only allowed when the context names it
#: (or carries it in an evidence snippet).
CLUB_HINTS: tuple[str, ...] = (
    "real madrid",
    "barcelona",
    "manchester united",
    "manchester city",
    "liverpool",
    "chelsea",
    "arsenal",
    "juventus",
    "bayern",
    "dortmund",
    "psg",
)

_WORD = re.compile(r"[A-Za-z][A-Za-z'’-]+")


def _allowed_terms(ctx: dict | None) -> set[str]:
    """Lowercased tokens the context sanctions: names, demonyms, evidence text."""
    allowed: set[str] = set()
    if not ctx:
        return allowed
    for team in ctx.get("teams") or []:
        name = (team.get("name") or "").strip().lower()
        if not name:
            continue
        allowed.add(name)
        for word in name.split():
            allowed.add(word)
        for country, demonyms in DEMONYM_MAP.items():
            if country.lower() == name or country.lower() in name:
                allowed.update(demonyms)
                # A short-form name ("POR") is not a demonym; the canonical
                # country is sanctioned by the same context.
                allowed.add(country.lower())
    for team in ctx.get("teams") or []:
        for ev in team.get("evidence") or []:
            snippet = (ev.get("snippet") or "").lower()
            for word in _WORD.findall(snippet):
                allowed.add(word.lower())
    return allowed


def _lexicon(extra_terms: list[str] | None) -> dict[str, str]:
    """token -> canonical team it attributes."""
    lex: dict[str, str] = {}
    for country, demonyms in DEMONYM_MAP.items():
        lex[country.lower()] = country
        for d in demonyms:
            lex[d] = country
    for club in CLUB_HINTS:
        lex[club] = club.title()
    for extra in extra_terms or []:
        lex[extra.strip().lower()] = extra.strip()
    return lex


def scan_texts(
    texts: list[str],
    match_context: object,
    extra_terms: list[str] | None = None,
) -> list[dict]:
    """Return one hit per out-of-context team/nationality mention.

    A hit is ``{"index": int, "token": str, "team": str, "offset": int,
    "text": str}``. ``text`` is bounded so a hit stays citable in a comment.
    """
    ctx = sanitize_match_context(match_context)
    allowed = _allowed_terms(ctx)
    lex = _lexicon(extra_terms)
    hits: list[dict] = []
    for i, text in enumerate(texts or []):
        if not isinstance(text, str) or not text:
            continue
        lowered = text.lower()
        for token, team in lex.items():
            if token not in lowered:
                continue
            # Whole-token match: "american" must not fire on "Americanisms"
            # inside a longer word boundary pair of letters.
            pattern = re.compile(rf"(?<![A-Za-z]){re.escape(token)}(?![A-Za-z])")
            for m in pattern.finditer(lowered):
                if token in allowed:
                    continue
                hits.append(
                    {
                        "index": i,
                        "token": text[m.start() : m.end()],
                        "team": team,
                        "offset": m.start(),
                        "text": text[max(0, m.start() - 60) : m.end() + 60],
                    }
                )
    return hits


def _load_texts(path: str) -> list[str]:
    if path == "-":
        raw = sys.stdin.read()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return [line for line in raw.splitlines() if line.strip()]
    else:
        with open(path, "r", encoding="utf-8") as fh:
            raw = fh.read()
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return [line for line in raw.splitlines() if line.strip()]
    if isinstance(parsed, list):
        return [x if isinstance(x, str) else json.dumps(x) for x in parsed]
    if isinstance(parsed, dict):
        for key in ("texts", "narratives", "captions", "reasons", "chapters"):
            if isinstance(parsed.get(key), list):
                return [x if isinstance(x, str) else json.dumps(x) for x in parsed[key]]
    raise SystemExit("input must be a JSON list, or an object with a texts/narratives/captions/reasons/chapters list")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--match-context", required=True, help="stored matchContext JSON (or '-' for stdin)")
    ap.add_argument("--text", help="JSON list of texts / object with a texts list (or '-' for stdin)")
    ap.add_argument("--text-file", help="plain text, one caption/narrative per line")
    ap.add_argument("--extra-terms", default="", help="comma-separated additional team terms to treat as teams")
    ap.add_argument("--out", help="write the JSON report here instead of stdout")
    args = ap.parse_args(argv)

    if args.match_context == "-":
        ctx_raw = json.loads(sys.stdin.read())
    else:
        with open(args.match_context, "r", encoding="utf-8") as fh:
            ctx_raw = json.load(fh)
    if isinstance(ctx_raw, dict) and "matchContext" in ctx_raw and "teams" not in ctx_raw:
        ctx_raw = ctx_raw.get("matchContext")

    texts = _load_texts(args.text_file) if args.text_file else _load_texts(args.text or "-")
    extra = [t for t in (args.extra_terms or "").split(",") if t.strip()]
    hits = scan_texts(texts, ctx_raw, extra)
    report = {
        "textsScanned": len(texts),
        "teamsInContext": [t.get("name") for t in (sanitize_match_context(ctx_raw) or {}).get("teams", [])],
        "hitCount": len(hits),
        "hits": hits,
    }
    out = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out + "\n")
    else:
        print(out)
    return 0 if not hits else 1


if __name__ == "__main__":  # pragma: no cover - CLI surface
    raise SystemExit(main())
