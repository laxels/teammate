#!/usr/bin/env bash
#
# Build and deploy the fleet dashboard to a fleet host, served tailnet-only:
#   browser → Tailscale Serve (HTTPS 443) → dashboard-server.ts (127.0.0.1:8788)
#   page → Convex cloud directly (live queries), authenticated with
#   DASHBOARD_SECRET from config.json (written here from the repo .env —
#   never committed, never bundled).
#
# Prereqs: DASHBOARD_SECRET in the repo .env AND set on the Convex deployment
# (npx convex env set DASHBOARD_SECRET ...); CONVEX_URL in .env.local.
#
# Usage: scripts/deploy-dashboard.sh [<host-ssh>]   (default m1@100.121.13.107)

set -euo pipefail

HOST_SSH="${1:-m1@100.121.13.107}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o ConnectTimeout=10)
TAILSCALE=/opt/homebrew/bin/tailscale
PORT=8788

log() { printf '\n==> %s\n' "$*"; }

env_value() { # <KEY> <file> -> value, never echoed
  local val
  val="$(grep "^$1=" "$REPO_ROOT/$2" | head -1 | cut -d= -f2- | cut -d' ' -f1)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $1 missing from $2" >&2
    return 1
  fi
  printf '%s' "$val"
}

DASHBOARD_SECRET="$(env_value DASHBOARD_SECRET .env)"
CONVEX_URL="$(env_value CONVEX_URL .env.local)"

log "Building dashboard locally"
(cd "$REPO_ROOT/dashboard" && rm -f public/config.json && bun run build >/dev/null)

log "[$HOST_SSH] Syncing dist + server"
(cd "$REPO_ROOT" &&
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" dashboard/dist \
    "$HOST_SSH:ultraclaude-dashboard/" &&
  rsync -az -e "ssh ${SSH_OPTS[*]}" scripts/dashboard-server.ts \
    scripts/launchd/com.ultraclaude.dashboard.plist \
    "$HOST_SSH:ultraclaude-dashboard/")

log "[$HOST_SSH] Writing config.json (secret from .env; streamed via stdin — never in argv/ps)"
CONVEX_URL="$CONVEX_URL" DASHBOARD_SECRET="$DASHBOARD_SECRET" python3 -c '
import json, os
print(json.dumps({"convexUrl": os.environ["CONVEX_URL"], "secret": os.environ["DASHBOARD_SECRET"]}))
' | ssh "${SSH_OPTS[@]}" "$HOST_SSH" 'umask 077; cat > ~/ultraclaude-dashboard/dist/config.json'

log "[$HOST_SSH] Installing + (re)loading LaunchAgent"
# bootout + bootstrap: kickstart alone restarts the OLD job definition and
# never re-reads a changed plist.
ssh "${SSH_OPTS[@]}" "$HOST_SSH" '
  cp ~/ultraclaude-dashboard/com.ultraclaude.dashboard.plist ~/Library/LaunchAgents/
  launchctl bootout "gui/$(id -u)/com.ultraclaude.dashboard" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.ultraclaude.dashboard.plist
  launchctl kickstart "gui/$(id -u)/com.ultraclaude.dashboard"'

log "[$HOST_SSH] Tailscale Serve 443 -> $PORT"
ssh "${SSH_OPTS[@]}" "$HOST_SSH" "$TAILSCALE serve --bg $PORT"

log "Health check (first deploy may mint a TLS cert; retrying up to 3 min)"
HOSTNAME_FQDN="$(ssh "${SSH_OPTS[@]}" "$HOST_SSH" "$TAILSCALE status --json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
deadline=$((SECONDS + 180))
until curl -fsS --max-time 30 "https://$HOSTNAME_FQDN/" | grep -qi ultraclaude; do
  if (( SECONDS >= deadline )); then
    echo "ERROR: dashboard not reachable at https://$HOSTNAME_FQDN/" >&2
    echo "Diagnostics: ssh $HOST_SSH 'tail -20 ~/dashboard.log'" >&2
    exit 1
  fi
  sleep 5
done
echo "OK: https://$HOSTNAME_FQDN/"

log "Done."
