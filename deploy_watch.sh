#!/bin/sh
set -u
cd /home/brad/highlights.live
for i in $(seq 1 90); do
  n=$(docker exec highlights-postgres psql -U highlights -d highlights -tAc \
      "select count(*) from jobs where record::jsonb->>'status' in ('analyzing','queued','starting')" | tr -d ' \n')
  echo "WAIT $i inflight=$n $(date -u +%FT%TZ)"
  if [ "$n" = "0" ]; then
    echo "IDLE -> deploy $(date -u +%FT%TZ)"
    ./docker/deploy.sh perceive
    rc=$?
    echo "DEPLOY_RC=$rc"
    docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep highlights-perceive || true
    docker inspect -f 'perceive_started={{.State.StartedAt}}' highlights-perceive
    docker exec highlights-perceive md5sum /srv/perceive/app/match_context.py /srv/perceive/app/scoreboard.py /srv/perceive/app/__init__.py
    md5sum services/perceive/app/match_context.py services/perceive/app/scoreboard.py services/perceive/app/__init__.py
    exit $rc
  fi
  sleep 20
done
echo "GAVE_UP_BUSY"
exit 1
