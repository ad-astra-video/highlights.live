#!/usr/bin/env python3
"""ADAAAA-9124: export a STORED-ROW corpus from the box's highlights DB.

The deck-count bar (`>= 10` servable bodies on one live leg) is a serve-yield
question: how many of a leg's stored rows survive the summary gate with a body on
the card. A leg costs money to run, so the census that picks a fixture and grades
a lever has to be read from rows a SERVED build already wrote. This tool does that
read, for free ($0: no model call, no job, no billing).

Usage (on the box, from the repo root):

    python3 evals/adaaa_9124/export_corpus_9124.py \
        --url /data/clips/kids95_8483.mp4 --out evals/adaaa_9124/live-deck-kids95_8483.json

Each row is exported with the fields the SERVED lane maps into summary evidence
(`summaryEvidenceForRow` in `services/server/src/summary-lane.ts`), so the replay
grades the same evidence the live lane handed the writer — no invented facts, no
re-derivation of the score pair here.
"""
import argparse
import json
import subprocess
import sys

DB = ["docker", "exec", "highlights-postgres", "psql", "-U", "highlights", "-d", "highlights", "-At", "-c"]

# The row fields the served evidence mapper reads. Kept explicit so a schema
# change shows up as a diff here rather than as a silently missing fact kind.
ROW_KEYS = (
    "id,eventType,outcome,reason,caption,postTitle,postTitleGate,trigger,start,end,"
    "matchClock,deferredAttestation,attestationUsed,goalConfirmed,confirmAttestation,"
    "asrTranscript,summary,summaryRaw,summaryGate,summaryViolations,summaryCalls,createdAt"
)


def psql_json(sql: str):
    out = subprocess.run(DB + [sql], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"psql failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="job sourceUrl (the fixture under test)")
    ap.add_argument("--out", required=True, help="corpus path")
    ap.add_argument("--since", default="2026-11-01", help="job created_at lower bound")
    args = ap.parse_args()

    jobs = psql_json(
        f"""
select coalesce(json_agg(json_build_object(
  'id', j.id,
  'createdAt', j.created_at,
  'costUsd', j.record::jsonb->>'costUsd',
  'source', j.record::jsonb->>'source',
  'sourceUrl', j.record::jsonb->>'sourceUrl',
  'matchContext', j.record::jsonb->'matchContext',
  'summaryCalls', (j.record::jsonb->>'summaryCalls')::int,
  'summaryDropped', (j.record::jsonb->>'summaryDropped')::int
) order by j.created_at), '[]'::json)
from jobs j
where j.record::jsonb->>'sourceUrl' = '{args.url}'
  and j.created_at > '{args.since}'
        """
    )
    if not jobs:
        sys.exit(f"no jobs for {args.url} since {args.since}")

    rows = psql_json(
        f"""
select coalesce(json_agg(json_build_object('jobId', h.job_id, 'row', h.record::jsonb)
       order by h.created_at), '[]'::json)
from highlights h join jobs j on j.id = h.job_id
where j.record::jsonb->>'sourceUrl' = '{args.url}'
  and j.created_at > '{args.since}'
        """
    )

    out_rows = []
    for entry in rows:
        raw = entry["row"]
        row = {"jobId": entry["jobId"]}
        for key in ROW_KEYS.split(","):
            row[key] = raw.get(key)
        row["body"] = raw.get("summary") or raw.get("summaryRaw") or None
        row["servedSummary"] = raw.get("summary")
        row["rawSummary"] = raw.get("summaryRaw")
        row["storedSummaryGate"] = raw.get("summaryGate")
        row["attestationAuthority"] = (raw.get("attestationUsed") or {}).get("authority")
        out_rows.append(row)

    # One surface per fixture is the normal case (every leg reads the same scorebug),
    # so the anchor context is stored ONCE and a leg is listed only when its context
    # differs. The 143-leg loop would otherwise carry 143 copies of the OCR evidence.
    anchor_ctx = jobs[0]["matchContext"]
    anchor_json = json.dumps(anchor_ctx, sort_keys=True)
    differing = {
        j["id"]: j["matchContext"]
        for j in jobs
        if json.dumps(j["matchContext"], sort_keys=True) != anchor_json
    }
    corpus = {
        "jobId": jobs[0]["id"],
        "source": jobs[0]["source"],
        "sourceUrl": jobs[0]["sourceUrl"],
        "matchContext": anchor_ctx,
        "fixture": {
            "url": args.url,
            "legs": len(jobs),
            "rows": len(out_rows),
            "legIds": [j["id"] for j in jobs],
            "costUsdByLeg": {j["id"]: j["costUsd"] for j in jobs},
            "legsWithDifferentMatchContext": len(differing),
        },
        "matchContextByLeg": differing,
        "rows": out_rows,
    }
    with open(args.out, "w") as fh:
        json.dump(corpus, fh, indent=1)
    served = sum(1 for r in out_rows if r["servedSummary"])
    print(
        f"wrote {args.out}: legs={len(jobs)} rows={len(out_rows)} "
        f"storedServed={served} withBody={sum(1 for r in out_rows if r['body'])}"
    )


if __name__ == "__main__":
    main()
