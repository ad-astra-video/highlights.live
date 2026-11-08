#!/usr/bin/env python3
"""Control-fidelity gate for ADAAAA-8371 (ADAAAA-8392 task 2).

The 37 carried kids-soccer windows are byte-for-byte the ADAAAA-8343 manifest,
so the CONTROL cell must reproduce 8343's outcome set exactly:

  TP (goal windows called scoring_play): ks-g-0117, ks-g-0341, ks-g-0662, ks-g-0770
  FP (no_goal windows called scoring_play): ks-n-0162, ks-n-0312, ks-n-0402,
                                            ks-n-0622, ks-n-0696, ks-n-0760

If they do not reproduce, the deployed replica/prompt changed under the eval and
the run must stop. Exit 0 = reproduced, 1 = mismatch.
"""
import argparse
import json
import subprocess
import sys

EXPECT_TP = {"ks-g-0117", "ks-g-0341", "ks-g-0662", "ks-g-0770"}
EXPECT_FP = {"ks-n-0162", "ks-n-0312", "ks-n-0402", "ks-n-0622", "ks-n-0696", "ks-n-0760"}


def parse(raws):
    code = ("import json,sys\nsys.path.insert(0,'/srv/decide')\n"
            "from app.gemma import parse_decision\n"
            "raws=json.load(sys.stdin)\n"
            "out=[]\n"
            "for r in raws:\n"
            "    p=parse_decision(r or '')\n"
            "    out.append((p or {}).get('outcome'))\n"
            "json.dump(out,sys.stdout)\n")
    p = subprocess.run(["docker", "exec", "-i", "highlights-decide", "python3", "-c", code],
                       input=json.dumps(raws).encode(), capture_output=True)
    if p.returncode != 0:
        print(p.stderr.decode()[:400], file=sys.stderr)
        sys.exit(2)
    return json.loads(p.stdout.decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--cell", default="live_ctrl_280_320x180")
    args = ap.parse_args()

    man = json.load(open(args.manifest))
    carried = {w["id"] for w in man["windows"]
               if w["id"].startswith("ks-") and "increment" not in w}
    rows = [json.loads(l) for l in open(args.rows) if l.strip()]
    rows = [r for r in rows if r["cell"] == args.cell and r["window"] in carried]
    outcomes = parse([r.get("raw") or "" for r in rows])
    got = {r["window"] for r, o in zip(rows, outcomes) if o == "scoring_play"}

    tp = sorted(got & {w for w in carried if w.startswith("ks-g")})
    fp = sorted(got & {w for w in carried if w.startswith("ks-n")})
    ok = set(tp) == EXPECT_TP and set(fp) == EXPECT_FP
    print(json.dumps({"cell": args.cell, "rows_scored": len(rows),
                      "carried_windows": len(carried),
                      "tp": tp, "fp": fp,
                      "expected_tp": sorted(EXPECT_TP), "expected_fp": sorted(EXPECT_FP),
                      "missing_carried_rows": sorted(carried - {r["window"] for r in rows}),
                      "reproduced_8343": ok}, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
