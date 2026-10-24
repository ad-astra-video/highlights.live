#!/bin/sh
# ADAAAA-6854 + ADAAAA-6891 (updated ADAAAA-7385): render docker/runners.json
# from docker/runners.template.json. Each tunable capacity defaults to the value
# already carried in the template (decide 4, perceive 4 after ADAAAA-7383 /
# ADAAAA-7385); an explicit DECIDE_RUNNER_CAPACITY / PERCEIVE_RUNNER_CAPACITY
# env var overrides it (must be a positive integer). The go-livepeer orchestrator
# admits N concurrent sessions per runner. Idempotent; run before
# `docker compose ... up -d` on the deploy box.
#
#   DECIDE_RUNNER_CAPACITY=6 PERCEIVE_RUNNER_CAPACITY=4 ./render-runners.sh
#
# The committed docker/runners.json already ships the defaults (decide 4,
# perceive 4).
#
# Live-path note (ADAAAA-7008): the live path runs a cadence-driven
# decide-observer; perceive remains the persistent session runner and decide the
# single-shot fixed-price runner. Each decide invocation is still a single-shot
# paid call, so the runner registration/capacity model is unchanged by that
# architecture (only the cadence at which the SERVER fires decide changes).
set -e
cd "$(dirname "$0")"

# (label):(env var):(default from template)
SPECS="highlights-decide:DECIDE_RUNNER_CAPACITY highlights-perceive:PERCEIVE_RUNNER_CAPACITY"

if [ ! -f runners.template.json ]; then
  echo "runners.template.json not found next to render-runners.sh" >&2
  exit 1
fi

# shellcheck disable=SC2086
SPECS="$SPECS" python3 - <<'PY'
import json, os, sys

d = json.load(open('runners.template.json'))
by_label = {r['label']: r for r in d['runners']}

for tok in os.environ['SPECS'].split():
    label, env = tok.split(':')
    r = by_label.get(label)
    if r is None:
        sys.exit(f"{label} runner not found in template")
    raw = os.environ.get(env, '')
    if raw == '':
        cap = int(r['capacity'])  # default to the template's carried value
    elif not raw.isdigit() or int(raw) == 0:
        sys.exit(f"invalid {env}={raw!r}: must be a positive integer")
    else:
        cap = int(raw)
    r['capacity'] = cap

with open('runners.json', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')

print("rendered docker/runners.json (decide=%d perceive=%d)" %
      (by_label['highlights-decide']['capacity'], by_label['highlights-perceive']['capacity']))
PY
