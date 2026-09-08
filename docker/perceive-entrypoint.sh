#!/bin/sh
# Perceive live-runner entrypoint.
#
# When PERCEIVE_MODE=florence, first run the boot device gate. If the configured
# device cannot sustain PERCEIVE_MIN_FPS (default 1.0), exit non-zero here so
# the runner never boots and never registers with the orchestrator.
set -e

if [ "$PERCEIVE_MODE" = "florence" ]; then
  echo "[perceive] running device 1fps boot gate..."
  python /srv/perceive/bootcheck.py
  echo "[perceive] gate passed; starting runner"
fi

exec uvicorn app:app --host 0.0.0.0 --port 8080
