#!/usr/bin/env bash
#
# setup-localagent.sh — install the localagent daemon + cua-driver on THIS Mac
# (#138 "local machine" mode). Run it ON the machine you want tasks to drive,
# from a checkout of this repo:
#
#   scripts/setup-localagent.sh [--owner <slack-user-id>]
#
# What it does:
#   1. Installs bun (if missing) and the repo's dependencies.
#   2. Installs the PINNED cua-driver release (CuaDriver.app -> /Applications,
#      binary symlinked to ~/.local/bin/cua-driver), SHA256-verified.
#   3. Runs `cua-driver permissions grant` — INTERACTIVE: macOS shows the
#      Accessibility + Screen Recording prompts, attributed to CuaDriver.app.
#   4. Installs the cua-driver `serve` LaunchAgent (upstream-recommended: a
#      launchd-started daemon keeps TCC attribution on com.trycua.driver).
#   5. Writes ~/.localagent.env (identity + Convex endpoints + secret) and
#      installs the com.ultraclaude.localagent LaunchAgent, then waits for the
#      first acknowledged heartbeat.
#
# Prerequisites:
#   - LOCAL_MACHINE_SECRET in the repo's .env (or exported), matching the
#     Convex deployment env var:  npx convex env set LOCAL_MACHINE_SECRET ...
#   - A GUI session (the TCC grant dialogs need one).
#
# The daemon runs FROM THIS CHECKOUT (LOCALAGENT_DIR in ~/.localagent.env);
# update by pulling + `launchctl kickstart -k gui/$UID/com.ultraclaude.localagent`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"
# shellcheck source=deployment-constants.sh
source "$REPO_ROOT/scripts/deployment-constants.sh"
# shellcheck source=fleet-lib.sh
source "$REPO_ROOT/scripts/fleet-lib.sh"

# ---- pinned cua-driver release (#138: young project, fast API churn) ----
# https://github.com/trycua/cua — libs/cua-driver, MIT. Bump deliberately.
CUA_DRIVER_VERSION="0.7.0"
CUA_DRIVER_SHA256="d9ae82dd7ee5c53d6f7cf409bc6172ace6c7342823a74070524c9a160cce1477"
CUA_DRIVER_URL="https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64.tar.gz"
CUA_BIN="$HOME/.local/bin/cua-driver"

OWNER_SLACK_USER="${LOCAL_OWNER_SLACK_USER:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER_SLACK_USER="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }

if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
  echo "ERROR: localagent supports Apple-silicon macOS only (got $(uname -s)/$(uname -m))" >&2
  exit 1
fi

LOCAL_MACHINE_SECRET="$(env_secret LOCAL_MACHINE_SECRET)"

# ------------------------------------------------------------------- bun
log "Installing bun (if missing) + repo dependencies"
test -x "$HOME/.bun/bin/bun" || curl -fsSL https://bun.sh/install | bash
(cd "$REPO_ROOT" && "$HOME/.bun/bin/bun" install --frozen-lockfile)

# ------------------------------------------------------------ cua-driver
if [[ -x "$CUA_BIN" ]] && "$CUA_BIN" --version 2>/dev/null | grep -q "$CUA_DRIVER_VERSION"; then
  log "cua-driver $CUA_DRIVER_VERSION already installed"
else
  log "Installing cua-driver $CUA_DRIVER_VERSION (pinned)"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "$CUA_DRIVER_URL" -o "$TMP_DIR/cua-driver.tar.gz"
  echo "$CUA_DRIVER_SHA256  $TMP_DIR/cua-driver.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xzf "$TMP_DIR/cua-driver.tar.gz" -C "$TMP_DIR"
  APP_SRC="$(find "$TMP_DIR" -maxdepth 2 -name 'CuaDriver.app' -type d | head -1)"
  if [[ -z "$APP_SRC" ]]; then
    echo "ERROR: CuaDriver.app not found in the release tarball" >&2
    exit 1
  fi
  # TCC grants are tied to the stable bundle id (com.trycua.driver) at this
  # path, so grants persist across updates.
  rm -rf /Applications/CuaDriver.app
  cp -R "$APP_SRC" /Applications/CuaDriver.app
  mkdir -p "$HOME/.local/bin"
  ln -sf /Applications/CuaDriver.app/Contents/MacOS/cua-driver "$CUA_BIN"
  "$CUA_BIN" --version
fi

log "Requesting Accessibility + Screen Recording grants (interactive)"
# Launches via LaunchServices so the TCC dialogs attribute to CuaDriver.app.
# Re-running with grants already present is a fast no-op.
"$CUA_BIN" permissions grant || {
  echo "WARNING: permissions grant did not complete — grant Accessibility and" >&2
  echo "Screen Recording to CuaDriver in System Settings, then re-run." >&2
}

# cua-driver serve daemon: launchd-started so TCC attribution stays on
# com.trycua.driver (upstream recipe); `cua-driver mcp` proxies to it over the
# Unix socket. Label matches upstream's to avoid duplicate daemons.
log "Installing cua-driver serve LaunchAgent"
CUA_PLIST="$HOME/Library/LaunchAgents/com.trycua.cua-driver.plist"
cat > "$CUA_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trycua.cua-driver</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec >> ~/.cua-driver-serve.log 2>&amp;1; exec ~/.local/bin/cua-driver serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
PLIST
plutil -lint "$CUA_PLIST"
launchctl kickstart -k "gui/$(id -u)/com.trycua.cua-driver" 2>/dev/null || {
  launchctl bootstrap "gui/$(id -u)" "$CUA_PLIST"
  launchctl kickstart -k "gui/$(id -u)/com.trycua.cua-driver"
}

# ---------------------------------------------------------- localagent env
log "Writing ~/.localagent.env"
MACHINE_NAME="$(scutil --get ComputerName 2>/dev/null || hostname -s)"
MACHINE_SLUG="$(printf '%s' "$MACHINE_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')"
umask 077
cat > "$HOME/.localagent.env" <<EOF
LOCAL_MACHINE_ID=local-${MACHINE_SLUG:-mac}
LOCAL_DISPLAY_NAME=$MACHINE_NAME
CONVEX_URL=$CONVEX_URL
CONVEX_SITE_URL=$CONVEX_SITE_URL
LOCAL_MACHINE_SECRET=$LOCAL_MACHINE_SECRET
LOCALAGENT_DIR=$REPO_ROOT
CUA_DRIVER_BIN=$CUA_BIN
${OWNER_SLACK_USER:+LOCAL_OWNER_SLACK_USER=$OWNER_SLACK_USER}
EOF
chmod 600 "$HOME/.localagent.env"

# ------------------------------------------------------ localagent daemon
log "Installing localagent LaunchAgent"
LA_PLIST="$HOME/Library/LaunchAgents/com.ultraclaude.localagent.plist"
BEFORE_LINES="$( (wc -l < "$HOME/localagent.log") 2>/dev/null || echo 0 )"
cp "$REPO_ROOT/localagent/launchd/com.ultraclaude.localagent.plist" "$LA_PLIST"
plutil -lint "$LA_PLIST"
launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.localagent" 2>/dev/null || {
  launchctl bootstrap "gui/$(id -u)" "$LA_PLIST"
  launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.localagent"
}

log "Waiting for the first acknowledged heartbeat"
for _ in $(seq 1 12); do
  sleep 5
  if tail -n "+$((BEFORE_LINES + 1))" "$HOME/localagent.log" 2>/dev/null \
      | grep -q 'first heartbeat acknowledged'; then
    log "localagent is up — machine registered as local-${MACHINE_SLUG:-mac}"
    exit 0
  fi
done
echo "ERROR: no heartbeat after 60s — check ~/localagent.log (is LOCAL_MACHINE_SECRET set on the Convex deployment?)" >&2
exit 1
