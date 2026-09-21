#!/bin/bash
# highlights-live boot guard (ADAAAA-3248): ensure the compose stack converges
# after host/docker restart. restart:unless-stopped only resurrects containers
# that had STARTED; a service left in Created (dependency miss at compose-up)
# never gets started by the restart policy. This guard re-runs `docker compose
# up -d` after boot (and on retry) so any Created/stopped service starts once
# its dependency is healthy.
set -u
STACK=/home/brad/highlights.live/docker
LOG=/var/log/highlights-live-boot.log
attempt=0
max=20
while [ $attempt -lt $max ]; do
  attempt=$((attempt+1))
  echo "[$(date -Is)] compose up attempt $attempt/$max" >> "$LOG"
  docker compose -f "$STACK/docker-compose.yml" -f "$STACK/docker-compose.gpu.yml" up -d --remove-orphans >> "$LOG" 2>&1
  rc=$?
  # Converged when decide is Up (healthy) OR at least running.
  decide_state=$(docker inspect -f '{{.State.Status}} {{.State.Health.Status}}' highlights-decide 2>/dev/null)
  case "$decide_state" in
    running*|*healthy*)
      echo "[$(date -Is)] stack converged (decide=$decide_state) rc=$rc" >> "$LOG"
      exit 0
      ;;
  esac
  sleep 15
done
echo "[$(date -Is)] FATAL: stack did not converge after $max attempts" >> "$LOG"
exit 1
