#!/usr/bin/env bash
#
# Provision a devbox from the fleet golden image (scripts/golden-constants.sh):
#   1. clone the golden image -> <devbox-id>, boot headless, wait for SSH
#   2. write ~/ultraclaude.env (gateway config + shared secret), join the
#      tailnet as <devbox-id>, kick the gateway LaunchAgent
#   3. verify /health over the tailnet, then register the devbox in Convex
#
# Usage: scripts/provision-devbox.sh <devbox-id>
#
# Requires in the repo-root .env: TAILSCALE_AUTHKEY, DEVBOX_SHARED_SECRET.
# Secret values are never printed.

set -euo pipefail

DEVBOX_ID="${1:-}"
if [[ ! "$DEVBOX_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <devbox-id>   (lowercase letters, digits, hyphens)" >&2
  exit 1
fi

HOST_SSH="m1@100.121.13.107"
HOST_ID="ultraclaude-host-1"
TART='~/tart.app/Contents/MacOS/tart'
VM_USER="admin"
GATEWAY_PORT=8787
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Deployment-identity constants (CONVEX_SITE_URL, CONVEX_URL, TAILNET_SUFFIX):
# single source of truth shared with the other fleet scripts.
source "$REPO_ROOT/scripts/deployment-constants.sh"
# Golden-image pin (GOLDEN_LOCAL/GOLDEN_REMOTE): single source of truth (issue
# #89), so a permanent devbox is cloned from the same golden the fleet runs.
source "$REPO_ROOT/scripts/golden-constants.sh"
SOURCE_IMAGE="$GOLDEN_LOCAL"
GATEWAY_URL="http://$DEVBOX_ID.$TAILNET_SUFFIX:$GATEWAY_PORT"

# Ephemeral NAT clones share host keys and reuse 192.168.64.x IPs, so host-key
# pinning is meaningless; skip known_hosts to keep reruns non-interactive.
VM_SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=10 -J "$HOST_SSH")

log() { printf '\n==> %s\n' "$*"; }

host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }
tart_host() { host "$TART $*"; }

VM_IP=""
vm() { ssh "${VM_SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }

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

list="$(tart_host list)"
grep -q "^local *$SOURCE_IMAGE " <<<"$list" || {
  echo "ERROR: golden image $SOURCE_IMAGE not found on host (pull $GOLDEN_REMOTE or rebuild it with scripts/bake-golden.sh)" >&2
  exit 1
}
if grep -q "^local *$DEVBOX_ID " <<<"$list"; then
  echo "ERROR: VM '$DEVBOX_ID' already exists on host" >&2
  exit 1
fi
running_count="$(grep -c 'running$' <<<"$list" || true)"
if (( running_count >= 2 )); then
  echo "ERROR: $running_count VMs already running (Apple EULA max 2);" \
    "no headroom for $DEVBOX_ID" >&2
  exit 1
fi

# ------------------------------------------------------------- clone + boot
log "Cloning $SOURCE_IMAGE -> $DEVBOX_ID and booting headless"
tart_host clone "$SOURCE_IMAGE" "$DEVBOX_ID"
host "nohup $TART run $DEVBOX_ID --no-graphics </dev/null >>/tmp/tart-$DEVBOX_ID.log 2>&1 & sleep 1; echo launched"

log "Waiting for VM IP + SSH"
for i in $(seq 1 36); do
  VM_IP="$(tart_host ip "$DEVBOX_ID" 2>/dev/null || true)"
  [[ -n "$VM_IP" ]] && break
  sleep 5
done
[[ -n "$VM_IP" ]] || { echo "ERROR: $DEVBOX_ID never got an IP" >&2; exit 1; }
echo "VM IP: $VM_IP"
for i in $(seq 1 60); do
  if vm true 2>/dev/null; then break; fi
  [[ "$i" == 60 ]] && { echo "ERROR: SSH to $VM_IP never came up" >&2; exit 1; }
  sleep 5
done

# ----------------------------------------------------------- sync current code
# The golden image provides the slow-to-build environment (logins, apps, bun,
# node_modules); the CODE is whatever was baked at image time and goes stale
# with every merge. Provisioning deploys the repo's current gateway + page on
# top, so fresh devboxes always run HEAD.
log "Syncing current gateway/web code into the VM"
(cd "$REPO_ROOT/web" && bun run build >/dev/null 2>&1)
RSYNC_SSH="ssh ${VM_SSH_OPTS[*]}"
# The full workspace-manifest skeleton rides along (root + every member listed
# in "workspaces") so the `bun install --frozen-lockfile` below succeeds: bun
# refuses to install when a listed member's package.json is missing. Mirrors
# scripts/deploy-payload.sh (the ephemeral path's payload).
(cd "$REPO_ROOT" &&
  rsync -az -e "$RSYNC_SSH" --relative gateway/src shared web/dist \
    bun.lock bunfig.toml package.json \
    dashboard/package.json gateway/package.json hostagent/package.json web/package.json \
    "$VM_USER@$VM_IP:ultraclaude/")

# The baked node_modules lags the synced code: a dependency added after the
# golden image was baked crashes the gateway at import (observed 2026-06-12:
# playwright-core). Install against the synced lockfile every provision,
# mirroring the self-healing ephemeral path (hostagent/src/vm.ts); the baked
# bun cache makes the no-change case sub-second, so only genuinely new packages
# hit the network.
log "Installing dependencies against the synced lockfile"
vm 'cd ~/ultraclaude && ~/.bun/bin/bun install --frozen-lockfile'

# ------------------------------------------------------- gateway env config
# Claude Code auth is NOT configured here: it comes from the golden image
# itself (~/.zprofile exports CLAUDE_CODE_OAUTH_TOKEN from
# ~/claude-oauth-token.txt, and ~/.claude/settings.json carries an env block).
# ultraclaude.env only configures the gateway.
log "Writing ~/ultraclaude.env"
vm 'umask 077; cat > ~/ultraclaude.env && chmod 600 ~/ultraclaude.env' <<EOF
DEVBOX_ID=$DEVBOX_ID
PORT=$GATEWAY_PORT
CONVEX_SITE_URL=$CONVEX_SITE_URL
CONVEX_URL=$CONVEX_URL
DEVBOX_SHARED_SECRET=$DEVBOX_SHARED_SECRET
EOF

# ------------------------------------------------- interactive claude config
# Humans debugging via the remote desktop must never stall on permission
# prompts; gateway sessions already bypass via SDK options.
log "Setting bypassPermissions default for interactive claude"
vm 'python3 -c '"'"'import json; p="/Users/admin/.claude/settings.json"; d=json.load(open(p)); d.setdefault("permissions",{})["defaultMode"]="bypassPermissions"; json.dump(d,open(p,"w"),indent=2)'"'"''

# ------------------------------------------------------------- join tailnet
# Clones inherit the golden image's tailscaled state (/Library/Tailscale,
# machine key included): without a wipe every clone shares ONE tailnet
# identity — each `tailscale up` re-keys and renames that single node,
# knocking the previous holder offline. Wipe it with the daemon down so this
# clone joins as a fresh node.
log "Wiping inherited tailscaled state (fresh tailnet identity)"
# launchd teardown is async: bootstrap right after bootout intermittently
# fails with "Bootstrap failed: 5: Input/output error" — wait + retry.
vm 'set -e
sudo launchctl bootout system/homebrew.mxcl.tailscale 2>/dev/null || true
for i in $(seq 1 15); do
  sudo launchctl print system/homebrew.mxcl.tailscale >/dev/null 2>&1 || break
  sleep 1
done
sudo rm -rf /Library/Tailscale
for i in $(seq 1 10); do
  sudo launchctl bootstrap system /Library/LaunchDaemons/homebrew.mxcl.tailscale.plist 2>/dev/null && break
  sleep 2
done
for i in $(seq 1 30); do
  /opt/homebrew/bin/tailscale version --daemon >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "tailscaled did not come back after state wipe" >&2; exit 1'

log "Joining tailnet as $DEVBOX_ID"
# Authkey is piped via stdin so it never appears in a local command line.
# --accept-dns=false: VM egress is plain NAT through the host; MagicDNS
# rewriting the VM's resolvers is pure risk (ts.net resolves publicly anyway).
vm "sudo /opt/homebrew/bin/tailscale up --authkey=\"\$(cat)\" --hostname=$DEVBOX_ID --accept-dns=false" \
  <<<"$TAILSCALE_AUTHKEY"
vm '/opt/homebrew/bin/tailscale ip -4'
# HTTPS front for the monitoring page: noVNC needs a secure context
# (crypto.subtle), so the page is served via Tailscale Serve on 443.
vm 'sudo /opt/homebrew/bin/tailscale serve --bg 8787'
# Pre-warm the TLS cert: the first HTTPS request triggers issuance (~30s);
# doing it here means the monitoring link works instantly when posted.
(curl -fsS --max-time 60 "https://$DEVBOX_ID.$TAILNET_SUFFIX/health" >/dev/null 2>&1 || true) &
CERT_WARM_PID=$!

# ------------------------------------------------------------ start gateway
log "Kicking the gateway LaunchAgent"
vm 'launchctl kickstart -k gui/501/com.ultraclaude.gateway \
  || { launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.ultraclaude.gateway.plist 2>/dev/null;
       launchctl kickstart -k gui/501/com.ultraclaude.gateway; }'

# -------------------------------------------------- verify over the tailnet
log "Waiting for $GATEWAY_URL/health from this machine (over the tailnet)"
health=""
for i in $(seq 1 36); do
  health="$(curl -fsS --max-time 5 "$GATEWAY_URL/health" 2>/dev/null || true)"
  [[ -n "$health" ]] && break
  sleep 5
done
echo "health: ${health:-<no response>}"
if ! grep -q "\"devboxId\":\"$DEVBOX_ID\"" <<<"$health"; then
  echo "ERROR: gateway health check failed for $DEVBOX_ID" >&2
  echo "Diagnostics: ssh ${VM_SSH_OPTS[*]} $VM_USER@$VM_IP 'tail -50 ~/gateway.log'" >&2
  exit 1
fi

# Only now may the gateway consume commands (it polls for this marker): a
# gateway booting mid-provision must never accept a task — the kickstart
# above would kill it, and the task with it.
log "Writing provision-ready marker"
vm 'touch ~/ultraclaude.ready'

# -------------------------------------------------------- register in Convex
log "Registering devbox in Convex"
(cd "$REPO_ROOT" && bunx convex run devboxes:registerDevbox \
  "{\"devboxId\": \"$DEVBOX_ID\", \"gatewayUrl\": \"$GATEWAY_URL\", \"hostId\": \"$HOST_ID\"}")

wait "$CERT_WARM_PID" 2>/dev/null || true
log "Done. $DEVBOX_ID is warm and registered at $GATEWAY_URL"
