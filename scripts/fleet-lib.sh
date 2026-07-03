# shellcheck shell=bash
#
# Shared helpers + Scaleway constants for the fleet scripts (fleet-lock.sh,
# provision-host.sh, adopt-host.sh, refresh-golden.sh, smoke-host.sh) — the
# single copy that kills the per-script drift, same rationale as
# deployment-constants.sh (#81) / golden-constants.sh (#89). Like those files,
# it only assigns variables and DEFINES functions — no shell options, no
# commands run at source time — so it is safe to source under `set -euo pipefail`:
#   source "$REPO_ROOT/scripts/fleet-lib.sh"
# deploy-payload.sh rsyncs the whole scripts/ dir to fleet hosts, so this lib
# rides along into the payload context like the constants files do.
#
# Caller contract:
#   env_secret  reads $ENV_FILE (every fleet script sets it from
#               ${ULTRACLAUDE_ENV:-$REPO_ROOT/.env} before calling)
#   scw_api     reads $SCALEWAY_SECRET_KEY (resolve it via env_secret first)

# ------------------------------------------------------- Scaleway constants
API="https://api.scaleway.com"
ZONE="fr-par-1"
SERVERS_PATH="/apple-silicon/v1alpha1/zones/$ZONE/servers"
SSH_USER="m1"
# Deliberately unexpanded ~: interpolated into remote ssh command lines.
TART='~/tart.app/Contents/MacOS/tart'

log() { printf '\n==> %s\n' "$*"; }

json_string() { # <str> -> JSON-quoted string (escapes via python3)
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

env_secret() { # <KEY> -> value from the environment, else $ENV_FILE; never echoed
  # Prefer an env var of the same name so GitHub Actions can inject secrets
  # without writing them to a file; fall back to $ENV_FILE for laptop runs.
  local key="$1" val="${!1:-}"
  if [[ -n "$val" ]]; then printf '%s' "$val"; return 0; fi
  val="$(grep "^$key=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $key not set and missing from $ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$val"
}

scw_api() { # <method> <path> [json-body]
  # No curl -f: HTTP error bodies (quota details, validation messages) must
  # reach stderr — they end up in hostEvents when a fleet host runs this.
  local method="$1" path="$2" body="${3:-}" response http_code
  if [[ -n "$body" ]]; then
    response="$(curl -sS -w $'\n%{http_code}' -X "$method" \
      -H "X-Auth-Token: $SCALEWAY_SECRET_KEY" \
      -H "Content-Type: application/json" -d "$body" "$API$path")"
  else
    response="$(curl -sS -w $'\n%{http_code}' -X "$method" \
      -H "X-Auth-Token: $SCALEWAY_SECRET_KEY" "$API$path")"
  fi
  http_code="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if (( http_code >= 400 )); then
    echo "ERROR: Scaleway API $method $path -> HTTP $http_code: $response" >&2
    return 1
  fi
  printf '%s' "$response"
}
