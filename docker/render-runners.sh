#!/bin/sh
# ADAAAA-6854 + ADAAAA-6891: render docker/runners.json from
# docker/runners.template.json, honoring DECIDE_RUNNER_CAPACITY (default 2) and
# PERCEIVE_RUNNER_CAPACITY (default 2) so the go-livepeer orchestrator admits N
# concurrent sessions for each. The perceive default matches decide (both 2),
# per the CEO direction (ADAAAA-6891): perceive is cap-2 alongside decide until
# a prod media-server path reserves a perceive session per job. The template
# marks each tunable capacity as a distinct numeric sentinel; this script
# substitutes the (validated) N for that runner. Idempotent; run before
# `docker compose ... up -d` on the deploy box.
#
#   DECIDE_RUNNER_CAPACITY=2 PERCEIVE_RUNNER_CAPACITY=2 ./render-runners.sh
#
# The committed docker/runners.json already ships the defaults (both 2).
#
# Live-path note (ADAAAA-7008): the live path runs a cadence-driven
# decide-observer; perceive remains the persistent session runner and decide the
# single-shot fixed-price runner. Each decide invocation is still a single-shot
# paid call, so the runner registration/capacity model is unchanged by that
# architecture (only the cadence at which the SERVER fires decide changes).
set -e
cd "$(dirname "$0")"

# (label):(template sentinel):(env var):(default)
SPECS="highlights-decide:21127:DECIDE_RUNNER_CAPACITY:2 highlights-perceive:21128:PERCEIVE_RUNNER_CAPACITY:2"

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
    label, sentinel, env, default = tok.split(':')
    r = by_label.get(label)
    if r is None:
        sys.exit(f"{label} runner not found in template")
    raw = os.environ.get(env, '')
    if not raw.isdigit() or int(raw) == 0:
        cap = int(default)
    else:
        cap = int(raw)
    if r.get('capacity') not in (int(sentinel), cap):
        sys.exit(f"unexpected capacity {r.get('capacity')!r} for {label}")
    r['capacity'] = cap

with open('runners.json', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')

print("rendered docker/runners.json (decide=%d perceive=%d)" %
      (by_label['highlights-decide']['capacity'], by_label['highlights-perceive']['capacity']))
PY
