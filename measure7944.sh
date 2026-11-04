#!/bin/sh
set -eu
mkdir -p /tmp/hl7944_jobs
API=http://localhost:3000
EM=$(docker exec highlights-server printenv ADMIN_EMAIL)
PW=$(docker exec highlights-server printenv ADMIN_PASSWORD)
python3 -c "import json,sys;open('/tmp/hl7944_login.json','w').write(json.dumps({'email':sys.argv[1],'password':sys.argv[2]}))" "$EM" "$PW"
chmod 600 /tmp/hl7944_login.json
TOK=$(curl -sS -X POST "$API/auth/login" -H 'Content-Type: application/json' --data-binary @/tmp/hl7944_login.json | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
printf '%s' "$TOK" > /tmp/hl7944.token
chmod 600 /tmp/hl7944.token

run_one() {
  sport="$1"; hint="$2"; clip="$3"
  body=$(python3 -c "import json,sys;print(json.dumps({'source':'file','videoPath':sys.argv[1],'gameHint':sys.argv[2]}))" "$clip" "$hint")
  echo "SUBMIT $sport $(date -u +%FT%TZ) $clip"
  resp=$(curl -sS -X POST "$API/jobs" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$body")
  echo "SUBMIT_RESP $sport $resp"
  jid=$(printf '%s' "$resp" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("job",{}).get("id") or d.get("id") or "")')
  if [ -z "$jid" ]; then echo "NO_JOB $sport"; return 0; fi
  echo "JOB $sport $jid"
  n=0
  while [ "$n" -lt 90 ]; do
    st=$(curl -sS "$API/jobs/$jid" -H "Authorization: Bearer $TOK" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("job",{}).get("status",""))')
    echo "POLL $sport $jid $st $(date -u +%FT%TZ)"
    case "$st" in done|failed|stopped|cancelled) break;; esac
    sleep 20
    n=$((n+1))
  done
  curl -sS "$API/jobs/$jid" -H "Authorization: Bearer $TOK" > "/tmp/hl7944_jobs/$sport.json"
  docker exec highlights-postgres psql -U highlights -d highlights -tAc \
    "select record::jsonb from jobs where id='$jid'" > "/tmp/hl7944_jobs/$sport.record.json"
  echo "DONE $sport $jid $(date -u +%FT%TZ)"
}

run_one american_football american_football /data/clips/adaaa7914_af_110s.mp4
run_one ice_hockey ice_hockey /data/clips/adaaa7914_hockey_110s.mp4
run_one baseball baseball /data/clips/adaaa7914_baseball_110s.mp4
run_one team_esports team_esports /data/clips/adaaa7914_esports_110s.mp4
echo "ALL_DONE $(date -u +%FT%TZ)"
