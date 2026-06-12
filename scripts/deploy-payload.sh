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

# Singleton lane: one fleet operation at a time, from the primary checkout
# (scripts/singleton-lock.sh; no-ops on fleet hosts, which have no git).
if [[ "${SINGLETON_LOCK:-}" != "fleet" ]]; then
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/singleton-lock.sh" fleet "$0" "$@"
fi

if (( $# < 1 )); then
  echo "Usage: $0 <host-ssh> [<host-ssh>...]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_OPTS=(-o ConnectTimeout=10)

log() { printf '\n==> %s\n' "$*"; }

# Fleet hosts run this from the payload dir, which carries a prebuilt
# web/dist but no web source.
if [[ -d "$REPO_ROOT/web/src" ]]; then
  log "Building web UI locally"
  (cd "$REPO_ROOT/web" && bun run build >/dev/null)
else
  log "No web source here (payload context); shipping the prebuilt web/dist"
fi

for HOST_SSH in "$@"; do
  log "[$HOST_SSH] Syncing devbox payload to ~/ultraclaude-payload"
  # --relative from the repo root, mirroring provision-devbox.sh: the host
  # agent later rsyncs this directory verbatim into each VM's ~/ultraclaude/.
  # scripts/ rides along so fleet hosts can bootstrap new hosts; secrets do
  # NOT (the fleet env lives outside the payload — see ULTRACLAUDE_ENV).
  # The full workspace-manifest skeleton rides along (root + every member
  # listed in "workspaces"): provisioning runs `bun install --frozen-lockfile`
  # inside each VM, and bun refuses to install when a listed member's
  # package.json is missing.
  (cd "$REPO_ROOT" &&
    rsync -az --relative -e "ssh ${SSH_OPTS[*]}" gateway/src shared web/dist \
      scripts gateway/package.json bun.lock \
      package.json bunfig.toml dashboard/package.json hostagent/package.json \
      web/package.json \
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
