#!/usr/bin/env bash
#
# Deploy the repo's current code to one or more ultraclaude Mac hosts:
#   ~/ultraclaude-payload/  gateway/src, shared, web/dist — rsynced into each
#                           devbox VM at provision time by the host agent
#   ~/hostagent/            host agent source + deps (bun install on the host)
# Restarts the hostagent LaunchAgent when it is loaded (no-op otherwise).
#
# Usage: scripts/deploy-payload.sh <host-ssh> [<host-ssh>...]
#        e.g. scripts/deploy-payload.sh m1@100.121.13.107

set -euo pipefail

if (( $# < 1 )); then
  echo "Usage: $0 <host-ssh> [<host-ssh>...]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o ConnectTimeout=10)

log() { printf '\n==> %s\n' "$*"; }

log "Building web UI locally"
(cd "$REPO_ROOT/web" && bun run build >/dev/null)

for HOST_SSH in "$@"; do
  log "[$HOST_SSH] Syncing devbox payload to ~/ultraclaude-payload"
  # --relative from the repo root, mirroring provision-devbox.sh: the host
  # agent later rsyncs this directory verbatim into each VM's ~/ultraclaude/.
  (cd "$REPO_ROOT" &&
    rsync -az --relative -e "ssh ${SSH_OPTS[*]}" gateway/src shared web/dist \
      "$HOST_SSH:ultraclaude-payload/")

  log "[$HOST_SSH] Syncing host agent to ~/hostagent"
  (cd "$REPO_ROOT/hostagent" &&
    rsync -az --exclude node_modules -e "ssh ${SSH_OPTS[*]}" \
      src launchd package.json tsconfig.json \
      "$HOST_SSH:hostagent/")

  log "[$HOST_SSH] bun install in ~/hostagent"
  ssh "${SSH_OPTS[@]}" "$HOST_SSH" 'cd ~/hostagent && ~/.bun/bin/bun install'

  log "[$HOST_SSH] Restarting hostagent LaunchAgent (if loaded)"
  ssh "${SSH_OPTS[@]}" "$HOST_SSH" \
    'launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.hostagent" 2>/dev/null \
       && echo "restarted" || echo "not loaded; skipping"'
done

log "Done."
