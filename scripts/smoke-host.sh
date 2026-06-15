#!/usr/bin/env bash
#
# Smoke-test a freshly provisioned fleet host: a host is "ready" only when it
#   1. heartbeats `active` (and recently) in Convex — GET /fleet/status, AND
#   2. can clone the golden image, boot one throwaway ephemeral VM to an IP,
#      and destroy it — exercised over ssh, exactly what a real task needs.
# "Hostagent started" is NOT "ready" (issue #87). provision-host.sh runs this as
# its final gate; it's also runnable standalone.
#
# Usage: scripts/smoke-host.sh <host-ssh> <host-name>
#        e.g. scripts/smoke-host.sh m1@51.x.x.x ultraclaude-host-2
#
# Env: CONVEX_DEPLOYMENT_SLUG (default in scripts/deployment-constants.sh),
#      DEVBOX_SHARED_SECRET (env or .env),
#      GOLDEN_LOCAL (default in scripts/golden-constants.sh).

set -euo pipefail

HOST_SSH="${1:-}"
HOST_NAME="${2:-}"
if [[ -z "$HOST_SSH" || -z "$HOST_NAME" ]]; then
  echo "Usage: $0 <host-ssh> <host-name>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"
# Deployment-identity constants (CONVEX_SITE_URL): single source of truth shared
# with the other fleet scripts; stays env-overridable.
source "$REPO_ROOT/scripts/deployment-constants.sh"
# Golden-image pin (GOLDEN_LOCAL): single source of truth (issue #89), so the
# smoke test boots the same golden the fleet runs. Stays env-overridable.
source "$REPO_ROOT/scripts/golden-constants.sh"
# A host is "fresh" if seen within this window; > HEARTBEAT_FRESHNESS_MS (120s).
FRESH_CUTOFF_SECS="${FLEET_SMOKE_FRESH_SECS:-180}"

log() { printf '\n==> %s\n' "$*"; }

env_secret() { # <KEY> -> value from env, else repo .env; never echoed
  local key="$1" val="${!1:-}"
  if [[ -n "$val" ]]; then printf '%s' "$val"; return 0; fi
  val="$(grep "^$key=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $key not set and missing from $ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$val"
}

DEVBOX_SHARED_SECRET="$(env_secret DEVBOX_SHARED_SECRET)"

host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }

# ----------------------------------------------- 1. Convex heartbeat readiness
log "Checking $HOST_NAME is active in Convex ($CONVEX_SITE_URL/fleet/status)"
status_json="$(curl -sS -H "x-devbox-secret: $DEVBOX_SHARED_SECRET" \
  "$CONVEX_SITE_URL/fleet/status")"
python3 -c '
import json, sys
name, cutoff = sys.argv[1], int(sys.argv[2])
data = json.loads(sys.stdin.read())
host = next((h for h in data.get("hosts", []) if h["hostId"] == name), None)
if host is None:
    sys.exit("ERROR: %s has no host row in Convex (never heartbeated?)" % name)
if host["status"] != "active":
    sys.exit("ERROR: %s status is %r, expected active" % (name, host["status"]))
seen = host.get("secondsSinceSeen", 1e9)
if seen > cutoff:
    sys.exit("ERROR: %s last heartbeat was %ss ago (> %ss)" % (name, seen, cutoff))
print("%s is active, last seen %ss ago" % (name, seen))
' "$HOST_NAME" "$FRESH_CUTOFF_SECS" <<<"$status_json"

# ----------------------------------------- 2. clone + boot + destroy one VM
# Single ssh invocation so the throwaway VM is always torn down on the host,
# even if the boot poll fails. Mirrors the tart sequence in hostagent/src/vm.ts.
log "Smoke-booting a throwaway VM from $GOLDEN_LOCAL on $HOST_NAME"
host "GOLDEN='$GOLDEN_LOCAL' bash -s" <<'REMOTE'
set -euo pipefail
TART=~/tart.app/Contents/MacOS/tart
NAME="smoke-$$-${RANDOM}"
cleanup() {
  $TART stop "$NAME" >/dev/null 2>&1 || true
  $TART delete "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
$TART clone "$GOLDEN" "$NAME"
# tart run blocks for the VM's lifetime, so detach it (same pattern as vm.ts).
nohup "$TART" run "$NAME" --no-graphics </dev/null >"/tmp/smoke-$NAME.log" 2>&1 &
ip=""
for _ in $(seq 1 60); do
  ip="$($TART ip "$NAME" 2>/dev/null || true)"
  [[ -n "$ip" ]] && break
  sleep 5
done
if [[ -z "$ip" ]]; then
  echo "ERROR: smoke VM never got an IP (boot failed)" >&2
  exit 1
fi
echo "smoke VM booted at $ip; tearing it down"
REMOTE

log "Smoke test passed: $HOST_NAME is task-ready."
