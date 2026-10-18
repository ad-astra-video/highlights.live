#!/bin/sh
# ADAAAA-6854: render docker/runners.json from docker/runners.template.json,
# honoring DECIDE_RUNNER_CAPACITY (default 2) for the highlights-decide
# single-shot runner so the go-livepeer orchestrator admits N concurrent
# decide requests. The template marks the decide capacity as the numeric
# sentinel 21127; this script substitutes the (validated) N in the
# highlights-decide runner only. Idempotent; run before
# `docker compose ... up -d` on the deploy box.
#
#   DECIDE_RUNNER_CAPACITY=2 ./render-runners.sh
#
# The committed docker/runners.json already ships the default (capacity 2).
set -e
cd "$(dirname "$0")"

CAP="${DECIDE_RUNNER_CAPACITY:-2}"
case "$CAP" in
  ''|*[!0-9]*|0) echo "invalid DECIDE_RUNNER_CAPACITY='$CAP'; falling back to 2" >&2; CAP=2 ;;
esac

if [ ! -f runners.template.json ]; then
  echo "runners.template.json not found next to render-runners.sh" >&2
  exit 1
fi

python3 - "$CAP" <<'PY'
import json, sys
cap = int(sys.argv[1])
d = json.load(open('runners.template.json'))
for r in d['runners']:
    if r.get('label') == 'highlights-decide' and r.get('mode') == 'single-shot':
        assert r.get('capacity') in (21127, cap), f"unexpected capacity {r.get('capacity')!r} in template"
        r['capacity'] = cap
        break
else:
    sys.exit("highlights-decide single-shot runner not found in template")
with open('runners.json', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
PY
echo "rendered docker/runners.json (highlights-decide capacity=$CAP)"
