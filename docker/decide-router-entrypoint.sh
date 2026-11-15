#!/bin/sh
# ADAAAA-9101: render the decide router's PRIMARY upstreams from the environment.
#
# docker/decide-router.conf is tracked and the repository is public, so the conf
# must not carry the LAN address of the host that publishes the decide worker
# ports. This entrypoint writes those `server` lines to /tmp/decide-workers.conf
# (the file the tracked conf `include`s) from:
#
#   DECIDE_WORKER_HOST   LAN address of the worker host. REQUIRED — there is no
#                        default, so an unset value is an explicit boot error
#                        instead of a silent fallback to a real address.
#   DECIDE_WORKER_PORTS  comma-separated published ports (default 8091,8092,8093).
#
# The x99 backup upstreams (`decide`, `decide-b`) are compose service names and
# stay in the tracked file. Only the rendered count is logged, never the address.
set -eu

host=${DECIDE_WORKER_HOST:-}
if [ -z "$host" ]; then
  echo "decide-router: DECIDE_WORKER_HOST is unset — set it in the box docker/.env to the LAN address that publishes the decide worker ports (ADAAAA-9101)" >&2
  exit 1
fi

ports=${DECIDE_WORKER_PORTS:-8091,8092,8093}
out=/tmp/decide-workers.conf
: > "$out"
n=0
for port in $(printf '%s' "$ports" | tr ',' ' '); do
  printf '    server %s:%s max_fails=2 fail_timeout=10s;\n' "$host" "$port" >> "$out"
  n=$((n + 1))
done
echo "decide-router: rendered $n primary upstream(s) from DECIDE_WORKER_HOST"

exec nginx -g 'daemon off;'
