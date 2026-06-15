#!/usr/bin/env bash
#
# Bake a golden devbox image by cloning an existing one, refreshing its baked
# dependencies + Claude Code config, wiping the tailnet identity, and renaming
# the result. Parameterized so the repo always ships a reproducible recipe for
# the current image (replaces the old per-version bake-golden-v2.sh; see #56).
#
#   Usage: scripts/bake-golden.sh [--from <image>] [--to <image>]
#   Defaults: --from golden-v5  --to golden-v6  (the current pin -> the next)
#
# What this bake does, on a clone of --from:
#   1. ensure bun is installed (idempotent — present on v2+ images)
#   2. rsync the repo's current workspace skeleton + gateway/web code and run
#      `bun install` so node_modules carries every CURRENT dependency. This is
#      what bakes `playwright-core` (the browser tools, PR #23) into the image:
#      ephemerals then no longer pay the provision-time install (#26) for it.
#      Note: playwright-core drives the system Google Chrome (executablePath),
#      so NO `playwright install chromium` download is needed.
#   3. install the gateway LaunchAgent (canonical copy lives here)
#   4. pin Claude Code to MODEL in ~/.claude/settings.json (the gateway's SDK
#      `model` option is authoritative for gateway sessions, but interactive
#      `claude` on the devbox reads this; v3 still baked claude-fable-5 — #50)
#   5. remove ~/ultraclaude.env (provisioning writes it; the gateway fails fast
#      and launchd KeepAlive retries without it)
#   6. wipe tailscaled's on-disk state (a logged-out image still bakes a machine
#      key that every clone would share — collapsing the fleet onto one node)
#
# What this bake deliberately PRESERVES from --from (do not regress):
#   - ~/claude-oauth-token.txt    the subscription OAuth token. Cloning carries
#                                 it forward untouched. Re-minting (#36) needs
#                                 an interactive `claude` login, which CLOBBERS
#                                 ~/.claude.json — do it as a deliberate manual
#                                 step, not part of this script.
#   - TCC grants, cliclick, Chrome (default browser, extension removed), the
#                                 display/locale/DND/no-sleep environment.
#
# MANUAL desktop steps (NOT scripted — they need credentials or a click in the
# VM's GUI, so a human runs them once over VNC, then a bake from that VM
# captures the result). Like ~/claude-oauth-token.txt above, all of these live
# on disk and so persist across `tart clone` — capture them ONCE and they ride
# forward into every later golden until they expire; you do NOT redo them each
# bake:
#   - Automation-profile site logins (#37): boot a VM with graphics, launch
#     Chrome against the gateway's persistent profile (NOT the default-profile
#     Chrome — this one starts logged out of everything), log into the sites the
#     teammate needs, quit Chrome, then bake from that VM:
#         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
#           --user-data-dir="$HOME/.ultraclaude/chrome-profile"
#   - Local Network grant (#93): silence the "Allow bun to find devices on local
#     networks?" prompt that otherwise hangs on the headless desktop and stalls
#     browser tasks. Boot a VM with graphics, run a browser task to surface the
#     prompt, click Allow once (or System Settings > Privacy & Security > Local
#     Network → enable bun), then bake from that VM. This manual grant is the
#     ONLY mechanism: macOS exposes no programmatic seed (it is a Network
#     Extension policy — necp.plist, keyed by signing identifier — not a TCC row,
#     so scripts/seed-devbox-tcc.sh cannot grant it), and a Chrome launch flag
#     does not help (playwright-core already disables MediaRouter/DialMediaRoute-
#     Provider yet the prompt still fires, so Cast/DIAL discovery is not the
#     trigger). The grant lives on disk, so it persists across `tart clone`.
#   - OAuth re-mint (#36): a DECISION, not always needed — cloning carries the
#     working token forward (see PRESERVES above). Re-mint only when the token
#     must change; it needs an interactive `claude` login that CLOBBERS
#     ~/.claude.json, so do it as a deliberate manual step, never in this script.
#
# After this bake, push the image to ghcr so new hosts can pull it (host-1
# already has the local copy this produces), then bump the pin
# (scripts/golden-constants.sh) and roll it out (scripts/refresh-golden.sh,
# issue #89):
#   TART_REGISTRY_USERNAME=laxels TART_REGISTRY_PASSWORD=$GITHUB_PAT \
#     ~/tart.app/Contents/MacOS/tart push golden-v6 \
#       ghcr.io/laxels/ultraclaude-golden:v6
#
# Run from anywhere on the local machine; operates on the Tart host over SSH.
# Refuses to run if the staging or target VM already exist.

set -euo pipefail

# Singleton lane: one fleet operation at a time, from the primary checkout
# (scripts/singleton-lock.sh; no-ops on fleet hosts, which have no git).
if [[ "${SINGLETON_LOCK:-}" != "fleet" ]]; then
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/singleton-lock.sh" fleet "$0" "$@"
fi

# Bake the NEXT golden FROM the current one. The live fleet pin is golden-v5
# (scripts/golden-constants.sh, rolled out by issue #89), so the next bake goes
# golden-v5 -> golden-v6; override with --from/--to for a different jump.
SOURCE_IMAGE="golden-v5"
TARGET="golden-v6"
# Canonical Claude model baked into ~/.claude/settings.json. MUST match the
# gateway/orchestrator runtime model (gateway/src/session.ts, convex/orchestrator.ts).
MODEL="claude-opus-4-8"

while (($#)); do
  case "$1" in
    --from) SOURCE_IMAGE="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "Usage: $0 [--from <image>] [--to <image>] [--model <id>]" >&2; exit 1 ;;
  esac
done

HOST_SSH="m1@100.121.13.107"
TART='~/tart.app/Contents/MacOS/tart'
STAGING="${TARGET}-staging"
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
log "Preflight checks (from=$SOURCE_IMAGE to=$TARGET model=$MODEL)"
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

# ------------------------------------------------------------- ensure bun
# Idempotent: the bun installer is a no-op upgrade when bun already exists
# (v2+ images bake it), but bake-from-bare-v1 still works.
log "Ensuring bun is installed in the VM"
vm 'command -v ~/.bun/bin/bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash'
vm '~/.bun/bin/bun --version'

# ----------------------------------------------------- sync the gateway code
# The FULL workspace skeleton must ride along: `bun install` hard-errors
# ("Workspace not found") if any member listed in the root package.json
# "workspaces" is missing its manifest. Only the gateway's code actually runs
# in the VM; the other members need only their package.json for resolution.
log "Rsyncing repo subset into ~/ultraclaude"
(cd "$REPO_ROOT" && rsync -az --relative --exclude node_modules \
  -e "ssh ${VM_SSH_OPTS[*]}" \
  package.json bun.lock bunfig.toml shared gateway/src gateway/package.json \
  web/dist web/package.json dashboard/package.json hostagent/package.json \
  "$VM_USER@$VM_IP:ultraclaude/")

# This is the step that bakes playwright-core (and any other deps added since
# the source image) into node_modules.
log "bun install in ~/ultraclaude (bakes current dependencies)"
vm 'cd ~/ultraclaude && ~/.bun/bin/bun install'
# bun uses an isolated node_modules layout: workspace deps are NOT hoisted to
# the top-level node_modules. playwright-core (a gateway dep) lives under
# node_modules/.bun and is symlinked from gateway/node_modules; the only
# layout-independent check is that the gateway can actually resolve it.
log "Verifying playwright-core baked (importable from the gateway)"
vm 'cd ~/ultraclaude/gateway && ~/.bun/bin/bun -e "require(\"playwright-core\"); console.log(\"playwright-core: importable\")"'

# -------------------------------------------------------- LaunchAgent plist
# Canonical copy of ~/Library/LaunchAgents/com.ultraclaude.gateway.plist.
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

# --------------------------------------------------------- pin Claude model
# Merge-in (preserve env/OAuth, effortLevel, permissions, etc.); v3 baked
# claude-fable-5, which is stale post-#50.
log "Pinning Claude Code model to $MODEL in ~/.claude/settings.json"
vm "python3 -c 'import json,sys; p=\"/Users/admin/.claude/settings.json\"; d=json.load(open(p)); d[\"model\"]=sys.argv[1]; json.dump(d,open(p,\"w\"),indent=2)' $MODEL"
vm "python3 -c 'import json; d=json.load(open(\"/Users/admin/.claude/settings.json\")); assert d[\"model\"]==\"$MODEL\", d[\"model\"]; assert \"CLAUDE_CODE_OAUTH_TOKEN\" in d.get(\"env\",{}), \"OAuth env regressed!\"; print(\"settings.json OK: model=\"+d[\"model\"]+\", OAuth preserved\")'"

# The golden image must NOT carry a gateway env file: provisioning writes it.
vm 'rm -f ~/ultraclaude.env'

# ------------------------------------------------------------ tailscale state
log "Wiping tailscaled state (golden images must not carry a tailnet identity)"
# Make sure tailscaled runs at boot (root LaunchDaemon via brew services) so
# provisioning can `tailscale up` without extra setup.
if ! vm 'test -f /Library/LaunchDaemons/homebrew.mxcl.tailscale.plist'; then
  vm 'sudo /opt/homebrew/bin/brew services start tailscale'
  sleep 5
fi
# A logged-out CHECK is not enough: tailscaled's on-disk state
# (/Library/Tailscale) still carries the machine key, so every clone of the
# image would share one tailnet identity. Wipe the state dir with the daemon
# down; provisioning wipes again per-clone as belt-and-suspenders.
# launchd teardown is async: bootstrap right after bootout intermittently
# fails with "Bootstrap failed: 5: Input/output error" — wait + retry.
vm 'sudo launchctl bootout system/homebrew.mxcl.tailscale 2>/dev/null || true
for i in $(seq 1 15); do
  sudo launchctl print system/homebrew.mxcl.tailscale >/dev/null 2>&1 || break
  sleep 1
done
sudo rm -rf /Library/Tailscale
for i in $(seq 1 10); do
  sudo launchctl bootstrap system /Library/LaunchDaemons/homebrew.mxcl.tailscale.plist 2>/dev/null && break
  sleep 2
done'
ts_status=""
for i in $(seq 1 15); do
  ts_status="$(vm '/opt/homebrew/bin/tailscale status 2>&1 || true')"
  grep -qiE 'logged out|NeedsLogin' <<<"$ts_status" && break
  sleep 2
done
echo "tailscale status: $ts_status"
grep -qiE 'logged out|NeedsLogin' <<<"$ts_status" || {
  echo "ERROR: tailscale not factory-fresh after state wipe" >&2
  exit 1
}
echo "OK: tailscaled state wiped; daemon up and logged out"

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

log "Done. Golden image '$TARGET' is ready."
log "Next: E2E-verify a clone, then push to ghcr (see header), then flip the live host (config.ts default + scripts/deploy-payload.sh)."
