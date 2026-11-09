#!/usr/bin/env python3
"""ADAAAA-8516 evidence collector: pull the leg's stored record + clips (read-only).

Usage: python3 collect-leg8516.py <jobId> <outdir>
Writes: job.json, highlights.json, leg.json (grader input), clips.tsv, summary.json
"""
import json
import os
import subprocess
import sys

KOMODO = [
    "python3",
    "/paperclip/.hermes/skills/komodo/scripts/komodo.py",
    "livepeer-ai-x99",
]


def box(cmd: str, timeout: int = 120) -> str:
    p = subprocess.run(KOMODO + [cmd], capture_output=True, text=True, timeout=timeout)
    out = p.stdout
    # komodo appends a footer line
    return "\n".join(l for l in out.splitlines() if not l.startswith("__KOMODO_EXIT_CODE:"))


def psql(sql: str, timeout: int = 120) -> str:
    return box(
        "docker exec highlights-postgres psql -U highlights -d highlights -Atc "
        + "'" + sql.replace("'", "'\"'\"'") + "'",
        timeout=timeout,
    )


def main() -> int:
    job_id = sys.argv[1]
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    rec = psql(f"select record from jobs where id='{job_id}'").strip()
    if not rec:
        print("no job record for", job_id, file=sys.stderr)
        return 1
    job = json.loads(rec)
    json.dump(job, open(os.path.join(outdir, "job.json"), "w"), indent=2)

    hl_raw = psql(f"select record from highlights where job_id='{job_id}'").strip()
    highlights = [json.loads(l) for l in hl_raw.splitlines() if l.strip()] if hl_raw else []
    json.dump(highlights, open(os.path.join(outdir, "highlights.json"), "w"), indent=2)

    json.dump(
        {"job": job, "highlights": highlights},
        open(os.path.join(outdir, "leg.json"), "w"),
        indent=2,
    )

    clips = box(
        "cd /home/brad/highlights.live/docker/data/clips && "
        f"ls -1 {job_id}-*.mp4 2>/dev/null | while read f; do "
        "echo \"$f\t$(stat -c '%W' \"$f\")\t$(stat -c '%Y' \"$f\")\t$(stat -c '%s' \"$f\")\"; done"
    )
    clips = "\n".join(l for l in clips.splitlines() if l and not l.startswith("__"))
    open(os.path.join(outdir, "clips.tsv"), "w").write(clips + "\n")

    om = (job.get("observeMetrics") or {})
    dl = om.get("deliveredLatency") or {}
    rows = dl.get("rows") or []
    summary = {
        "jobId": job_id,
        "status": job.get("status"),
        "startedAt": job.get("startedAt"),
        "finishedAt": job.get("finishedAt"),
        "perceiveSessionS": job.get("perceiveSessionS"),
        "costUsd": job.get("costUsd"),
        "liveWatchMinutes": job.get("liveWatchMinutes"),
        "decideCalls": job.get("decideCalls"),
        "accepted": om.get("accepted"),
        "candidatesTriggered": job.get("candidatesTriggered"),
        "triggerWindows": om.get("triggerWindows"),
        "deliveredLatency": {k: v for k, v in dl.items() if k != "rows"},
        "rowCount": len(rows),
        "rowsWithHighlightId": sum(1 for r in rows if r.get("highlightId")),
        "rowsWithLocalizeOffset": sum(1 for r in rows if r.get("localizeOffsetMs") is not None),
        "decideCapacity": om.get("decideCapacity"),
        "decideStages": om.get("decideStages"),
        "allDecides": om.get("allDecides"),
        "highlightCount": len(highlights),
        "highlightEventTypes": {},
        "clipCount": len([l for l in clips.splitlines() if l.strip()]),
    }
    for h in highlights:
        et = str((h or {}).get("eventType") or "?")
        summary["highlightEventTypes"][et] = summary["highlightEventTypes"].get(et, 0) + 1
    json.dump(summary, open(os.path.join(outdir, "summary.json"), "w"), indent=2)
    print(json.dumps(summary, indent=2)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
