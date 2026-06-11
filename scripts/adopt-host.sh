#!/usr/bin/env bash
#
# Adopt an ALREADY-bootstrapped Mac host (passwordless sudo, Homebrew,
# tailscale, sshpass, tart + golden-v2, auto-login — e.g. ultraclaude-host-1)
# as an ultraclaude VM host:
#   1. install bun if missing
#   2. deploy the devbox payload + host agent (scripts/deploy-payload.sh)
#   3. write ~/hostagent.env and load the hostagent LaunchAgent
#   4. wait for the agent's first heartbeat in ~/hostagent.log
#
# Usage: scripts/adopt-host.sh <host-ssh> <host-name>
#        e.g. scripts/adopt-host.sh m1@100.121.13.107 ultraclaude-host-1
#
# Requires in the repo-root .env: TAILSCALE_AUTHKEY, DEVBOX_SHARED_SECRET.
# Secret values are never printed.

set -euo pipefail

HOST_SSH="${1:-}"
HOST_NAME="${2:-}"
if [[ -z "$HOST_SSH" || ! "$HOST_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <host-ssh> <host-name>" >&2
  echo "  e.g. $0 m1@100.121.13.107 ultraclaude-host-1" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAILNET_SUFFIX="tail4d21c4.ts.net"
CONVEX_SITE_URL="https://zealous-robin-941.convex.site"
CONVEX_URL="https://zealous-robin-941.convex.cloud"

log() { printf '\n==> %s\n' "$*"; }

host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }

env_secret() { # <KEY> -> value from repo .env, never echoed
  local val
  val="$(grep "^$1=" "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $1 missing from $REPO_ROOT/.env" >&2
    return 1
  fi
  printf '%s' "$val"
}

# ---------------------------------------------------------------- preflight
log "Preflight checks"
TAILSCALE_AUTHKEY="$(env_secret TAILSCALE_AUTHKEY)"
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
TAILSCALE_AUTHKEY=$TAILSCALE_AUTHKEY
TAILNET_SUFFIX=$TAILNET_SUFFIX
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
