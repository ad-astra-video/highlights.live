#!/usr/bin/env sh
# admin-readout.sh — read-only funnel + per-channel CAC readout for highlights.live.
#
# Prints the ADAAAA-6368 conversion funnel (signup -> activate -> generate ->
# subscribe -> retain), the per-channel breakdown, and the per-channel CAC
# (spend / paying subscribers) from a RUNNING server, using a *read-only* admin
# bearer token (ADAAAA-6385).
#
# Read-only by construction: the script only issues GET requests. The
# `admin_readonly` role is accepted on GET /admin/funnel, /admin/spend and
# /admin/monitoring; POST /admin/spend (recording spend) returns
# 403 {"error":"admin only"} with the same token, so this credential can measure
# and report but can never write the ledger.
#
# Why this exists: the launch leg needs a measured funnel/CAC report on demand,
# not a hand-typed curl with nested quotes. Anyone with box access can produce
# the same readout with one command instead of depending on a run-env binding:
#
#   ./docker/admin-readout.sh
#   ./docker/admin-readout.sh --json          # raw funnel + spend payloads
#   HIGHLIGHTS_API_BASE=https://highlights-server.dpn.gg ./docker/admin-readout.sh
#
# Env:
#   HIGHLIGHTS_API_BASE          server base URL (default http://localhost:3000)
#   HIGHLIGHTS_ADMIN_TOKEN       admin_readonly bearer token (overrides the file)
#   HIGHLIGHTS_ADMIN_TOKEN_FILE  path to a file holding the token
#                                (default ~/.highlights_admin_readonly_token)
#
# Exit codes:
#   0  readout printed
#   1  no admin_readonly token found
#   2  a /admin readout request failed (server down / token rejected)
#
# Honest reporting rule (ADAAAA-6384): an empty `cac` array means the spend
# ledger has no rows for the channel, so CAC is UNDEFINED — not $0 and not
# "<= target". Never read an empty ledger as a cheap channel.
set -u

API_BASE="${HIGHLIGHTS_API_BASE:-http://localhost:3000}"
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    -h | --help) printf 'usage: %s [--json]\n' "$0"; exit 0 ;;
    *)
      printf 'admin-readout: unknown argument: %s\n' "$arg" >&2
      printf 'usage: %s [--json]\n' "$0" >&2
      exit 64
      ;;
  esac
done

# Resolve the read-only admin token (bounded credential accepted on GET only).
TOKEN="${HIGHLIGHTS_ADMIN_TOKEN:-}"
TOKEN_SRC="env HIGHLIGHTS_ADMIN_TOKEN"
if [ -z "$TOKEN" ]; then
  TOKEN_FILE="${HIGHLIGHTS_ADMIN_TOKEN_FILE:-$HOME/.highlights_admin_readonly_token}"
  if [ -r "$TOKEN_FILE" ]; then
    TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
    TOKEN_SRC="file $TOKEN_FILE"
  fi
fi

if [ -z "$TOKEN" ]; then
  printf 'admin-readout: no admin_readonly token found (%s missing).\n' \
    "${HIGHLIGHTS_ADMIN_TOKEN_FILE:-$HOME/.highlights_admin_readonly_token}" >&2
  printf '  Set HIGHLIGHTS_ADMIN_TOKEN_FILE or HIGHLIGHTS_ADMIN_TOKEN. Never print the token value.\n' >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'admin-readout: jq is required to format the readout.\n' >&2
  exit 2
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/admin-readout.XXXXXX")" || {
  printf 'admin-readout: cannot create a temp dir\n' >&2
  exit 2
}
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM HUP

fetch_get() {
  path="$1"
  out="$2"
  code="$(curl -sS -m 20 -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
    "$API_BASE$path" 2>/dev/null || echo 000)"
  case "$code" in
    200 | 201 | 204) return 0 ;;
    401 | 403)
      printf 'admin-readout: GET %s -> %s: token rejected (expired or wrong scope).\n' "$path" "$code" >&2
      ;;
    000)
      printf 'admin-readout: GET %s -> no response; is the server up at %s?\n' "$path" "$API_BASE" >&2
      ;;
    *)
      printf 'admin-readout: GET %s -> HTTP %s\n' "$path" "$code" >&2
      ;;
  esac
  return 2
}

fetch_get /admin/funnel "$TMP_DIR/funnel.json" || exit 2
fetch_get /admin/spend "$TMP_DIR/spend.json" || exit 2

if [ "$JSON_OUT" -eq 1 ]; then
  printf '{"funnel":'
  cat "$TMP_DIR/funnel.json"
  printf ',"spend":'
  cat "$TMP_DIR/spend.json"
  printf '}\n'
  exit 0
fi

STAGES_ORDER='["signup","activate","generate","subscribe","retain"]'

printf 'highlights.live funnel + CAC readout\n'
printf '  api:        %s\n' "$API_BASE"
printf '  token:      %s (read-only)\n' "$TOKEN_SRC"
printf '  generated:  %s\n' \
  "$(jq -r '.generatedAt // "unknown"' "$TMP_DIR/funnel.json" 2>/dev/null || echo unknown)"
printf '\n'

printf '%s\n' "$(jq -r --argjson order "$STAGES_ORDER" \
  '.stages as $s | "stages:     " + ($order | map("\(.) \($s[.] // 0)") | join(" | "))' \
  "$TMP_DIR/funnel.json")"

printf '%s\n' "$(jq -r '
  (.perChannel // {}) as $pc
  | ($pc | keys_unsorted) as $chs
  | if ($chs | length) == 0 then "perChannel: (no channel events)"
    else ($chs | to_entries | map(
        (.key) as $i
        | (if $i == 0 then "perChannel: " else "            " end)
          + .value + " {" + ($pc[.value] | to_entries | map("\(.key) \(.value)") | join(", ")) + "}"
      ) | .[])
    end' \
  "$TMP_DIR/funnel.json")"

# CAC: spend / paying subscribers, per channel. Empty array = no spend rows yet.
printf '%s\n' "$(jq -r \
  'if ((.cac // []) | length) == 0
     then "cac:        []  (no channel_spend rows -> CAC undefined, NOT $0)"
     else (.cac[] | "cac:        " + .channel
        + "  spend=$" + ((.spendUsd // 0) | tostring)
        + "  subscribers=" + ((.subscribers // 0) | tostring)
        + "  cac=" + (if .cacUsd == null then "undefined (0 subscribers)" else "$" + (.cacUsd | tostring) end))
   end' \
  "$TMP_DIR/funnel.json")"

printf '%s\n' "$(jq -r \
  'if ((.spend // []) | length) == 0
     then "spend:      []  (0 ledger rows recorded)"
     else (.spend[] | "spend:      " + .channel + "  $" + ((.spendUsd // 0) | tostring)
        + (if .note == null then "" else "  (" + .note + ")" end))
   end' \
  "$TMP_DIR/spend.json")"

printf '\n'
printf 'Reading: CAC is spend / paying subscribers on the channel. An empty spend\n'
printf 'ledger means there is no numerator yet, so CAC is undefined here — do not\n'
printf 'report the channel as cheap or as "<= target" from this readout.\n'
