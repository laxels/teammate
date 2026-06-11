#!/usr/bin/env bash
#
# Bake the golden-v2 devbox image: clone golden-v1, install bun + the
# ultraclaude gateway (with LaunchAgent), verify tailscale is logged out,
# then stop and rename the result to "golden-v2".
#
# Run from anywhere on the local machine; operates on the Tart host over SSH.
# Idempotent-ish: refuses to run if golden-v2 or the staging VM already exist.
#
# What the image deliberately does NOT contain:
#   - ~/ultraclaude.env       (provisioning writes it; the gateway fails fast
#                              without it and launchd KeepAlive retries)
#   - a tailnet identity      (tailscale installed + daemon enabled, logged out)

set -euo pipefail

HOST_SSH="m1@100.121.13.107"
TART='~/tart.app/Contents/MacOS/tart'
SOURCE_IMAGE="golden-v1"
STAGING="golden-v2-staging"
TARGET="golden-v2"
VM_USER="admin"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ephemeral NAT clones share host keys and reuse 192.168.64.x IPs, so host-key
# pinning is meaningless; skip known_hosts to keep reruns non-interactive.
VM_SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=10 -J "$HOST_SSH")

log() { printf '\n==> %s\n' "$*"; }

host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }
tart_host() { host "$TART $*"; }

VM_IP=""
vm() { ssh "${VM_SSH_OPTS[@]}" "$VM_USER@$VM_IP" "$@"; }

wait_for_ip() { # <vm-name> -> sets VM_IP
  local name="$1" i
  for i in $(seq 1 36); do
    VM_IP="$(tart_host ip "$name" 2>/dev/null || true)"
    [[ -n "$VM_IP" ]] && return 0
    sleep 5
  done
  echo "ERROR: $name never got an IP" >&2
  return 1
}

wait_for_ssh() {
  local i
  for i in $(seq 1 60); do
    if vm true 2>/dev/null; then return 0; fi
    sleep 5
  done
  echo "ERROR: SSH to $VM_IP never came up" >&2
  return 1
}

# ---------------------------------------------------------------- preflight
log "Preflight checks"
list="$(tart_host list)"
grep -q "^local *$SOURCE_IMAGE " <<<"$list" || {
  echo "ERROR: source image $SOURCE_IMAGE not found on host" >&2
  exit 1
}
for name in "$STAGING" "$TARGET"; do
  if grep -q "^local *$name " <<<"$list"; then
    echo "ERROR: VM '$name' already exists on host; remove it first" >&2
    exit 1
  fi
done
running_count="$(grep -c 'running$' <<<"$list" || true)"
if (( running_count >= 2 )); then
  echo "ERROR: $running_count VMs already running (Apple EULA max 2);" \
    "no headroom for the staging VM" >&2
  exit 1
fi

# ------------------------------------------------------- build web locally
log "Building web UI locally (web/dist ships in the image)"
(cd "$REPO_ROOT/web" && bun run build)

# -------------------------------------------------- clone + boot staging VM
log "Cloning $SOURCE_IMAGE -> $STAGING and booting headless"
tart_host clone "$SOURCE_IMAGE" "$STAGING"
tart_host set "$STAGING" --cpu 6 --memory 8192 --display 1920x1080
host "nohup $TART run $STAGING --no-graphics </dev/null >>/tmp/tart-$STAGING.log 2>&1 & sleep 1; echo launched"

log "Waiting for VM IP + SSH"
wait_for_ip "$STAGING"
echo "VM IP: $VM_IP"
wait_for_ssh

# ------------------------------------------------------------- install bun
log "Installing bun in the VM"
vm 'curl -fsSL https://bun.sh/install | bash'
vm '~/.bun/bin/bun --version'

# ----------------------------------------------------- sync the gateway code
log "Rsyncing repo subset into ~/ultraclaude"
(cd "$REPO_ROOT" && rsync -az -R --exclude node_modules \
  -e "ssh ${VM_SSH_OPTS[*]}" \
  package.json bun.lock bunfig.toml shared gateway web/package.json web/dist \
  "$VM_USER@$VM_IP:ultraclaude/")

log "bun install in ~/ultraclaude"
vm 'cd ~/ultraclaude && ~/.bun/bin/bun install'

# -------------------------------------------------------- LaunchAgent plist
# Exact copy of ~/Library/LaunchAgents/com.ultraclaude.gateway.plist on the
# live devbox-1 (devbox-golden VM).
log "Installing gateway LaunchAgent"
vm 'mkdir -p ~/Library/LaunchAgents && cat > ~/Library/LaunchAgents/com.ultraclaude.gateway.plist' <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ultraclaude.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>set -a; source ~/ultraclaude.env; set +a; exec ~/.bun/bin/bun run ~/ultraclaude/gateway/src/index.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/admin/gateway.log</string>
  <key>StandardErrorPath</key><string>/Users/admin/gateway.log</string>
</dict>
</plist>
PLIST
vm 'plutil -lint ~/Library/LaunchAgents/com.ultraclaude.gateway.plist'

# The golden image must NOT carry a gateway env file: provisioning writes it.
vm 'rm -f ~/ultraclaude.env'

# ------------------------------------------------------------ tailscale state
log "Verifying tailscale is installed, daemon enabled, and logged OUT"
# Make sure tailscaled runs at boot (root LaunchDaemon via brew services) so
# provision-devbox.sh can `tailscale up` without extra setup.
if ! vm 'pgrep -x tailscaled >/dev/null'; then
  vm 'sudo /opt/homebrew/bin/brew services start tailscale'
  sleep 5
fi
ts_status="$(vm '/opt/homebrew/bin/tailscale status 2>&1 || true')"
echo "tailscale status: $ts_status"
if grep -qiE 'logged out|NeedsLogin|Logged Out' <<<"$ts_status"; then
  echo "OK: tailscale is logged out"
else
  echo "Tailscale appears logged in; logging out (golden images must not carry a tailnet identity)"
  vm 'sudo /opt/homebrew/bin/tailscale logout'
fi

# --------------------------------------------------------- stop and rename
log "Stopping $STAGING"
tart_host stop "$STAGING"
for i in $(seq 1 24); do
  if tart_host list | grep -q "^local *$STAGING .*stopped$"; then break; fi
  sleep 5
done
tart_host list | grep -q "^local *$STAGING .*stopped$" || {
  echo "ERROR: $STAGING did not stop cleanly" >&2
  exit 1
}

log "Renaming $STAGING -> $TARGET"
tart_host rename "$STAGING" "$TARGET"
tart_host list | grep "^local *$TARGET "

log "Done. Golden image '$TARGET' is ready; provision clones with scripts/provision-devbox.sh"
