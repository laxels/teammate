#!/usr/bin/env bash
#
# Provision a devbox from the golden-v2 image:
#   1. clone golden-v2 -> <devbox-id>, boot headless, wait for SSH
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
TART='~/tart.app/Contents/MacOS/tart'
SOURCE_IMAGE="golden-v2"
VM_USER="admin"
TAILNET_SUFFIX="tail4d21c4.ts.net"
GATEWAY_PORT=8787
CONVEX_SITE_URL="https://zealous-robin-941.convex.site"
CONVEX_URL="https://zealous-robin-941.convex.cloud"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  echo "ERROR: golden image $SOURCE_IMAGE not found on host (run scripts/bake-golden-v2.sh)" >&2
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
# top, so fresh devboxes always run HEAD. (Dependency changes still require a
# rebake: node_modules is not synced.)
log "Syncing current gateway/web code into the VM"
(cd "$REPO_ROOT/web" && bun run build >/dev/null 2>&1)
RSYNC_SSH="ssh ${VM_SSH_OPTS[*]}"
(cd "$REPO_ROOT" &&
  rsync -az -e "$RSYNC_SSH" --relative gateway/src shared web/dist \
    "$VM_USER@$VM_IP:ultraclaude/")

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

# ------------------------------------------------------------- join tailnet
log "Joining tailnet as $DEVBOX_ID"
# Authkey is piped via stdin so it never appears in a local command line.
vm "sudo /opt/homebrew/bin/tailscale up --authkey=\"\$(cat)\" --hostname=$DEVBOX_ID" \
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

# -------------------------------------------------------- register in Convex
log "Registering devbox in Convex"
(cd "$REPO_ROOT" && bunx convex run devboxes:registerDevbox \
  "{\"devboxId\": \"$DEVBOX_ID\", \"gatewayUrl\": \"$GATEWAY_URL\"}")

wait "$CERT_WARM_PID" 2>/dev/null || true
log "Done. $DEVBOX_ID is warm and registered at $GATEWAY_URL"
