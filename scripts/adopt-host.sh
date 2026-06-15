#!/usr/bin/env bash
#
# Adopt an ALREADY-bootstrapped Mac host (passwordless sudo, Homebrew,
# tailscale, sshpass, tart + golden image, auto-login — e.g. ultraclaude-host-1)
# as an Ultraclaude VM host:
#   1. install bun if missing
#   2. deploy the devbox payload + host agent (scripts/deploy-payload.sh)
#   3. write ~/hostagent.env and load the hostagent LaunchAgent
#   4. wait for the agent's first heartbeat in ~/hostagent.log
#
# Usage: scripts/adopt-host.sh <host-ssh> <host-name>
#        e.g. scripts/adopt-host.sh m1@100.121.13.107 ultraclaude-host-1
#
# Requires in the repo-root .env: TAILSCALE_EPHEMERAL_AUTHKEY,
# DEVBOX_SHARED_SECRET. Secret values are never printed.

set -euo pipefail

# Fleet lock: one fleet-provisioning op at a time, GLOBALLY, via authoritative
# Convex state (scripts/fleet-lock.sh). FLEET_LOCK_HELD=1 means the caller
# already holds it — when provision-host.sh runs us inside its lock, or a GH
# Actions matrix job holds the run's lock — so we run directly without re-locking.
if [[ "${FLEET_LOCK_HELD:-}" != "1" ]]; then
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fleet-lock.sh" with "$0" "$@"
fi

HOST_SSH="${1:-}"
HOST_NAME="${2:-}"
if [[ -z "$HOST_SSH" || ! "$HOST_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <host-ssh> <host-name>" >&2
  echo "  e.g. $0 m1@100.121.13.107 ultraclaude-host-1" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Fleet hosts run these scripts from the payload dir with secrets in a
# separate file (never shipped into VMs): ULTRACLAUDE_ENV overrides.
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"
# Deployment-identity constants (CONVEX_SITE_URL, CONVEX_URL, TAILNET_SUFFIX):
# single source of truth shared with the other fleet scripts.
source "$REPO_ROOT/scripts/deployment-constants.sh"
# Golden-image pin (GOLDEN_LOCAL): single source of truth (issue #89). Written
# into hostagent.env below so the hostagent clones the fleet golden — the
# authoritative runtime value, overriding hostagent/src/config.ts's fallback
# default. refresh-golden.sh rewrites this same line to roll a new golden.
source "$REPO_ROOT/scripts/golden-constants.sh"

log() { printf '\n==> %s\n' "$*"; }

host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }

env_secret() { # <KEY> -> value from the environment, else repo .env; never echoed
  # Prefer an env var of the same name (GitHub Actions injects secrets that
  # way); fall back to $ENV_FILE for laptop runs.
  local key="$1" val="${!1:-}"
  if [[ -n "$val" ]]; then printf '%s' "$val"; return 0; fi
  val="$(grep "^$key=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $key not set and missing from $ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$val"
}

# ---------------------------------------------------------------- preflight
log "Preflight checks"
# The hostagent enrolls EPHEMERAL VMs, so its authkey must be the
# reusable+ephemeral one (nodes auto-purge from the tailnet when they go
# offline). The non-ephemeral TAILSCALE_AUTHKEY is only for permanent
# enrollments: hosts (provision-host.sh) and permanent devboxes
# (provision-devbox.sh) — never give it to a hostagent.
TAILSCALE_EPHEMERAL_AUTHKEY="$(env_secret TAILSCALE_EPHEMERAL_AUTHKEY)"
DEVBOX_SHARED_SECRET="$(env_secret DEVBOX_SHARED_SECRET)"
host true

# ----------------------------------------------------------------- bun
log "Installing bun (if missing)"
host 'test -x ~/.bun/bin/bun || curl -fsSL https://bun.sh/install | bash'
host '~/.bun/bin/bun --version'

# -------------------------------------------------------------- code deploy
log "Deploying devbox payload + host agent"
"$REPO_ROOT/scripts/deploy-payload.sh" "$HOST_SSH"

# ------------------------------------------------------------ hostagent.env
log "Writing ~/hostagent.env"
host 'umask 077; cat > ~/hostagent.env && chmod 600 ~/hostagent.env' <<EOF
HOST_ID=$HOST_NAME
CONVEX_URL=$CONVEX_URL
CONVEX_SITE_URL=$CONVEX_SITE_URL
DEVBOX_SHARED_SECRET=$DEVBOX_SHARED_SECRET
TAILSCALE_AUTHKEY=$TAILSCALE_EPHEMERAL_AUTHKEY
TAILNET_SUFFIX=$TAILNET_SUFFIX
GOLDEN_IMAGE=$GOLDEN_LOCAL
EOF

# ----------------------------------------------------------- launchd agent
log "Loading the hostagent LaunchAgent"
# Remember where the log ends now: only heartbeat lines AFTER the (re)start
# below count, so a stale line from a previous run can't fake success.
log_offset="$(host 'wc -l < ~/hostagent.log 2>/dev/null || echo 0' | tr -d '[:space:]')"
host 'mkdir -p ~/Library/LaunchAgents &&
  cp ~/hostagent/launchd/com.ultraclaude.hostagent.plist ~/Library/LaunchAgents/'
host 'plutil -lint ~/Library/LaunchAgents/com.ultraclaude.hostagent.plist'
host 'launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.hostagent" \
  || { launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ultraclaude.hostagent.plist 2>/dev/null;
       launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.hostagent"; }'

# ------------------------------------------------------- first heartbeat
log "Waiting for the first heartbeat in ~/hostagent.log"
for i in $(seq 1 12); do
  if host "tail -n +$((log_offset + 1)) ~/hostagent.log 2>/dev/null \
      | grep -q 'first heartbeat acknowledged'"; then
    host 'tail -5 ~/hostagent.log'
    log "Done. $HOST_NAME is running the host agent."
    exit 0
  fi
  sleep 5
done

echo "ERROR: no heartbeat within 60s." >&2
echo "Diagnostics: ssh $HOST_SSH 'tail -50 ~/hostagent.log'" >&2
exit 1
