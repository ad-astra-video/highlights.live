#!/usr/bin/env python3
"""Rights-cleared american-football footage scanner (ADAAAA-7767, stage 1 gate).

Stage 1 of the american-football measurement pass needs a held-out clip that
clears TWO independent bars:

1. rights basis: footage we own or commissioned, CC-BY / public-domain, or
   partner-supplied with written permission (CC BY-SA, CC BY-NC*, CC BY-ND*
   and unlicensed broadcast uploads are NOT the gate's CC-BY);
2. coverage floor: >= 300 s of continuous real game play carrying >= 6 verified
   scoring plays plus >= 10 comparable non-event windows.

This script screens the two open-licence corpora that carry game recordings
(Wikimedia Commons and the Internet Archive) against bar 1 and the duration
half of bar 2, and writes a machine-checkable candidate list. The "real game
play" half of bar 2 cannot be decided from metadata: a duration hit is written
with ``needs_frame_review: true`` and must be verified on frames before it can
become a label manifest.

Run:

    python3 evals/american_football_val/scan_rights_candidates.py \
        --out evals/american_football_val/rights-candidates.json

Exit codes: 0 = at least one candidate clears the automatic bars, 7 = none
does (the ``not_captured`` / ``no rights-cleared broadcast sample`` outcome).

Pure stdlib on purpose: the harnesses load standalone and the box has no
requests/pandas guarantee.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "highlights-eval-labeller/1.0 (ADAAAA-7767; https://ad-astra.network)"

# Coverage floor: >= 5 minutes of continuous real game play.
MIN_CLIP_S = 300.0

# Wikimedia Commons searches that reach american-football *game* footage. The
# generic "football filetype:video" query is dominated by association football,
# so every query here either says "american" or uses a gridiron-only term.
COMMONS_SEARCHES = (
    "american football filetype:video",
    "american football game filetype:video",
    "college football filetype:video",
    "college football highlights filetype:video",
    "high school football filetype:video",
    "varsity football filetype:video",
    "NFL filetype:video",
    "NCAA football filetype:video",
    "touchdown filetype:video",
    "gridiron filetype:video",
    "intitle:football filetype:video",
)
COMMONS_CATEGORIES = (
    "Category:Videos of American football",
    "Category:American football videos",
)
# Near-misses found by hand during the ADAAAA-7767 pass that a search-ranking
# cut can drop. Pinned so the committed record always carries the candidates
# that were actually frame-reviewed, instead of depending on ranking.
PINNED_COMMONS_TITLES = (
    "File:ThanksgivingGame2013CL10",
    "File:UVA Football Game 1950s.webm",
    "File:Princeton and Yale football game (1903).webm",
    "File:Northwestern vs. Michigan FOX-COLLEGE-FOOTBALL-HIGHLIGHTS.webm",
    "File:Oregon vs. Washington St - FOX COLLEGE FOOTBALL HIGHLIGHTS.webm",
    "File:Kickoff Baker v Benedictine 2014.webm",
    "File:Field Goal.ogv",
    "File:Devin Singletary touchdown (51394753691).webm",
    "File:Southern Methodist University vs. Louisville 2025 touchdown pass.webm",
)
COMMONS_API = "https://commons.wikimedia.org/w/api.php"

INTERNET_ARCHIVE_QUERIES = (
    'mediatype:movies AND subject:("american football") AND licenseurl:*creativecommons*',
    'mediatype:movies AND subject:("football") AND licenseurl:*publicdomain*',
    'mediatype:movies AND subject:("college football") AND licenseurl:*creativecommons*',
    'mediatype:movies AND subject:("varsity football") AND licenseurl:*publicdomain*',
)
# Items that decide this gate (a full community-access broadcast and a CC0
# youth-game recording) are pinned because advanced-search ranking is unstable.
PINNED_IA_IDENTIFIERS = (
    "ThanksgivingGame2013CL10",
    "HillCountryCowboysVHorneFrogsRealGame",
    "cornhuskercollection_volume3",
    "varsity-football-live-2022",
)


def _http_json(url: str, attempts: int = 4) -> dict:
    last = None
    for i in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # 429 is routine on Commons
            last = exc
            time.sleep(2.0 * (i + 1))
        except Exception as exc:  # noqa: BLE001 - recorded, not swallowed
            last = exc
            time.sleep(1.0 * (i + 1))
    raise RuntimeError(f"request failed after {attempts} attempts: {url}: {last}")


def _commons(**params) -> dict:
    params.update(action="query", format="json")
    return _http_json(COMMONS_API + "?" + urllib.parse.urlencode(params))


def classify_licence(name: str) -> str:
    """Map a licence string onto the gate's three classes.

    CC0 and public-domain marks are ``acceptable``; a plain CC BY (any version)
    is ``acceptable``; CC BY-SA is a real rights basis but not the basis the
    gate names, so it is ``needs_policy_decision``; NC/ND variants and unknown
    strings are ``rejected``.
    """
    n = (name or "").strip().lower()
    if not n:
        return "unknown"
    if n.startswith("cc0") or n.startswith("public domain"):
        return "acceptable"
    if "by-nc" in n or "by-nd" in n or "noncommercial" in n or "noderiv" in n:
        return "rejected"
    if "by-sa" in n:
        return "needs_policy_decision"
    if n.startswith("cc by") or n.startswith("cc-by") or "attribution" in n:
        return "acceptable"
    return "rejected"


def commons_titles() -> tuple[list[str], list[str]]:
    titles: set[str] = set(PINNED_COMMONS_TITLES)
    errors: list[str] = []
    for query in COMMONS_SEARCHES:
        try:
            data = _commons(list="search", srnamespace=6, srlimit=100, srsearch=query)
            for row in data.get("query", {}).get("search", []):
                titles.add(row["title"])
        except Exception as exc:  # noqa: BLE001
            errors.append(f"search {query!r}: {exc}")
    for cat in COMMONS_CATEGORIES:
        try:
            data = _commons(list="categorymembers", cmtitle=cat, cmtype="file", cmlimit=200)
            for row in data.get("query", {}).get("categorymembers", []):
                titles.add(row["title"])
        except Exception as exc:  # noqa: BLE001
            errors.append(f"category {cat!r}: {exc}")
    return sorted(titles), errors


def commons_candidates(titles: list[str], errors: list[str]) -> list[dict]:
    out: list[dict] = []
    ordered = list(titles)
    for start in range(0, len(ordered), 40):
        chunk = ordered[start:start + 40]
        try:
            data = _commons(
                titles="|".join(chunk),
                prop="imageinfo",
                iiprop="url|size|mime|extmetadata",
            )
        except Exception as exc:  # noqa: BLE001
            errors.append(f"imageinfo batch {start}: {exc}")
            continue
        for page in data.get("query", {}).get("pages", {}).values():
            info = (page.get("imageinfo") or [{}])[0]
            if not info:
                continue
            meta = info.get("extmetadata", {}) or {}
            licence = (meta.get("LicenseShortName", {}) or {}).get("value", "")
            out.append({
                "corpus": "wikimedia_commons",
                "title": page.get("title"),
                "duration_s": float(info.get("duration") or 0.0),
                "width": info.get("width"),
                "height": info.get("height"),
                "licence": licence,
                "licence_class": classify_licence(licence),
                "credit": (meta.get("Credit", {}) or {}).get("value", ""),
                "description": (meta.get("ImageDescription", {}) or {}).get("value", "")[:400],
                "url": (info.get("url") or "").split("?")[0],
            })
    return out


def internet_archive_candidates(errors: list[str]) -> list[dict]:
    out: list[dict] = []
    for query in INTERNET_ARCHIVE_QUERIES:
        params = [("q", query), ("rows", 60), ("output", "json"),
                  ("fl[]", "identifier"), ("fl[]", "title"),
                  ("fl[]", "runtime"), ("fl[]", "licenseurl")]
        url = "https://archive.org/advancedsearch.php?" + urllib.parse.urlencode(params)
        try:
            data = _http_json(url)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"archive.org {query!r}: {exc}")
            continue
        response = data.get("response")
        if not response:
            errors.append(f"archive.org {query!r}: {data.get('error', 'no response')}")
            continue
        for doc in response.get("docs", []):
            runtime = doc.get("runtime") or ""
            out.append(_ia_row(
                identifier=doc.get("identifier"),
                display_title=doc.get("title"),
                licence_url=doc.get("licenseurl") or "",
                duration_s=_runtime_seconds(runtime),
                duration_note=runtime or "not reported",
            ))
    out.extend(_internet_archive_pinned(errors))
    return out


def _ia_row(identifier, display_title, licence_url, duration_s, duration_note):
    licence_url = licence_url or ""
    if "publicdomain/zero" in licence_url:
        licence = "CC0"
    elif "publicdomain/mark" in licence_url or "licenses/publicdomain" in licence_url:
        licence = "Public domain"
    elif "/by-nc-sa/" in licence_url:
        licence = "CC BY-NC-SA"
    elif "/by-nc-nd/" in licence_url:
        # The ND half matters: NoDerivatives also forbids the derived label work.
        licence = "CC BY-NC-ND"
    elif "/by-nc/" in licence_url:
        licence = "CC BY-NC"
    elif "/by-nd/" in licence_url:
        licence = "CC BY-ND"
    elif "/by-sa/" in licence_url:
        licence = "CC BY-SA"
    elif "/by/" in licence_url:
        licence = "CC BY"
    else:
        licence = "unknown"
    return {
        "corpus": "internet_archive",
        "title": identifier,
        "display_title": display_title,
        "duration_s": duration_s,
        "duration_note": duration_note,
        "licence": licence,
        "licence_class": classify_licence(licence),
        "credit": licence_url,
        "url": f"https://archive.org/details/{identifier}",
    }


def _internet_archive_pinned(errors: list[str]) -> list[dict]:
    """Fetch the pinned candidates directly from item metadata."""
    out: list[dict] = []
    for ident in PINNED_IA_IDENTIFIERS:
        try:
            meta = _http_json(f"https://archive.org/metadata/{ident}")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"archive.org metadata {ident}: {exc}")
            continue
        md = meta.get("metadata", {}) or {}
        lengths = []
        for f in meta.get("files", []) or []:
            name = f.get("name", "")
            if name.lower().endswith(".mp4"):
                try:
                    lengths.append(float(f.get("length") or 0.0))
                except (TypeError, ValueError):
                    continue
        out.append(_ia_row(
            identifier=ident,
            display_title=md.get("title"),
            licence_url=md.get("licenseurl") or "",
            duration_s=max(lengths) if lengths else 0.0,
            duration_note="longest mp4 file length from item metadata",
        ))
    return out


def _runtime_seconds(runtime: str) -> float:
    """archive.org runtime is \"HH:MM:SS\" or \"MM:SS\"; unknown -> 0.0."""
    if not runtime:
        return 0.0
    parts = runtime.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return 0.0
    total = 0.0
    for num in nums:
        total = total * 60 + num
    return total


# A title/description scan cannot tell american football from association
# football ("football" in most of the world), from rugby, or from game
# emulation footage, so relevance is filtered explicitly before screening.
_AMERICAN_RE = ("american football", "college football", "high school football",
                "varsity football", "gridiron", "nfl", "ncaa", "touchdown",
                "quarterback", "super bowl", "bowl game", "pigskin")
_NOT_AMERICAN_RE = ("association football", "soccer", "fifa", "uefa", "premier league",
                    "la liga", "serie a", "bundesliga", "champions league",
                    "world cup", "rugby", "australian rules", "gaelic",
                    "table football", "foosball", "subbuteo", "sega", "nintendo",
                    "playstation", "xbox", "madden", "nfl 2k", "retro bowl",
                    "fantasy football", "futsal")


def american_football_relevant(row: dict) -> bool:
    """True only for a row that names american football and not another sport."""
    blob = " ".join(str(row.get(k) or "") for k in ("title", "display_title")).lower()
    if any(bad in blob for bad in _NOT_AMERICAN_RE):
        return False
    return any(good in blob for good in _AMERICAN_RE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="evals/american_football_val/rights-candidates.json")
    ap.add_argument("--min-clip-s", type=float, default=MIN_CLIP_S)
    args = ap.parse_args()

    errors: list[str] = []
    titles, title_errors = commons_titles()
    errors.extend(title_errors)
    candidates = commons_candidates(titles, errors)
    candidates.extend(internet_archive_candidates(errors))

    screened_total = len(candidates)
    candidates = [row for row in candidates if american_football_relevant(row)]
    dropped_not_american = screened_total - len(candidates)

    for row in candidates:
        row["clears_duration_floor"] = row["duration_s"] >= args.min_clip_s
        row["needs_frame_review"] = (
            row["licence_class"] == "acceptable" and row["clears_duration_floor"]
        )

    for row in candidates:
        if row["licence_class"] == "acceptable" and row["clears_duration_floor"]:
            row["screening"] = "qualifying_pending_frame_review"
        elif row["licence_class"] == "acceptable":
            row["screening"] = "rejected_duration_floor"
        elif row["licence_class"] == "needs_policy_decision":
            row["screening"] = "rejected_licence_not_cc_by"
        else:
            row["screening"] = "rejected_licence"

    candidates.sort(key=lambda r: (-r["duration_s"], str(r["title"])))
    qualifying = [r for r in candidates if r["screening"] == "qualifying_pending_frame_review"]

    payload = {
        "$comment": (
            "ADAAAA-7767 stage-1 rights scan. Generated by "
            "evals/american_football_val/scan_rights_candidates.py. A duration hit "
            "is not a measurement: every 'qualifying_pending_frame_review' row still "
            "has to be verified on frames as continuous real game play carrying "
            ">= 6 scoring plays before it can become a label manifest."
        ),
        "generated_by": "evals/american_football_val/scan_rights_candidates.py",
        "min_clip_s": args.min_clip_s,
        "queries": {
            "wikimedia_commons_search": list(COMMONS_SEARCHES),
            "wikimedia_commons_categories": list(COMMONS_CATEGORIES),
            "internet_archive": list(INTERNET_ARCHIVE_QUERIES),
        },
        "counts": {
            "commons_titles": len(titles),
            "metadata_rows_screened": screened_total,
            "dropped_not_american_football": dropped_not_american,
            "american_football_candidates": len(candidates),
            "qualifying_pending_frame_review": len(qualifying),
        },
        "errors": errors,
        "candidates": candidates,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, sort_keys=False)
        fh.write("\n")
    print(json.dumps(payload["counts"], indent=1))
    for row in qualifying:
        print(f'  QUALIFY {row["duration_s"]:8.0f}s {row["licence"]:14s} {row["title"]}')
    if errors:
        print(f"errors: {len(errors)}", file=sys.stderr)
    return 0 if qualifying else 7


if __name__ == "__main__":
    raise SystemExit(main())
