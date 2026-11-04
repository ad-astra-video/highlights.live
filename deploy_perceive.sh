#!/bin/sh
set -eu
cd /home/brad/highlights.live
echo "=== deploy start $(date -u +%FT%TZ)"
git fetch origin
git reset --hard origin/master
git log --oneline -1
echo "=== docker build perceive $(date -u +%FT%TZ)"
docker build -f docker/Dockerfile.perceive.gpu -t adastravideo/highlights-live:perceive .
echo "=== image id"
docker image inspect -f '{{.Id}}' adastravideo/highlights-live:perceive
echo "=== deploy gate + recreate $(date -u +%FT%TZ)"
./docker/deploy.sh perceive
echo "=== post state"
docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}' | grep highlights-perceive || true
docker inspect -f 'perceive_started={{.State.StartedAt}}' highlights-perceive
docker exec highlights-perceive md5sum /srv/perceive/app/match_context.py /srv/perceive/app/scoreboard.py /srv/perceive/app/__init__.py
echo "=== host md5"
md5sum services/perceive/app/match_context.py services/perceive/app/scoreboard.py services/perceive/app/__init__.py
echo "=== deploy done $(date -u +%FT%TZ)"
