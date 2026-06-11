#!/usr/bin/env bash
#
# Provision a brand-new Scaleway Apple Silicon (M2-L) Mac host end to end and
# adopt it as an ultraclaude VM host:
#   1. create the server via the Scaleway API (zone fr-par-1), wait until ready
#   2. bootstrap macOS over ssh: passwordless sudo, Homebrew, tailscale (joins
#      the tailnet as <host-name>), sshpass, tart 2.32.1, auto-login for m1
#      (kcpassword), key-only sshd, reboot
#   3. pull the golden image from ghcr and clone it to local "golden-v2"
#   4. delegate bun + code deploy + host agent setup to scripts/adopt-host.sh
#
# Usage: scripts/provision-host.sh <host-name>
#
# Requires in the repo-root .env: SCALEWAY_ACCESS_KEY_ID, SCALEWAY_SECRET_KEY,
# GITHUB_PAT, TAILSCALE_AUTHKEY, DEVBOX_SHARED_SECRET. Never prints secrets.
# Idempotent where cheap: reuses an existing server with the same name and
# skips already-completed bootstrap steps.

set -euo pipefail

HOST_NAME="${1:-}"
if [[ ! "$HOST_NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <host-name>   (lowercase letters, digits, hyphens)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="https://api.scaleway.com"
ZONE="fr-par-1"
SERVERS_PATH="/apple-silicon/v1alpha1/zones/$ZONE/servers"
SERVER_TYPE="M2-L"
SSH_USER="m1"
TART='~/tart.app/Contents/MacOS/tart'
TART_URL="https://github.com/openai/tart/releases/download/2.32.1/tart.tar.gz"
GOLDEN_REMOTE="ghcr.io/laxels/ultraclaude-golden:v2"
GOLDEN_LOCAL="golden-v2"

log() { printf '\n==> %s\n' "$*"; }

env_secret() { # <KEY> -> value from repo .env, never echoed
  local val
  val="$(grep "^$1=" "$REPO_ROOT/.env" | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $1 missing from $REPO_ROOT/.env" >&2
    return 1
  fi
  printf '%s' "$val"
}

scw_api() { # <method> <path> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -H "X-Auth-Token: $SCALEWAY_SECRET_KEY" \
      -H "Content-Type: application/json" -d "$body" "$API$path"
  else
    curl -fsS -X "$method" -H "X-Auth-Token: $SCALEWAY_SECRET_KEY" "$API$path"
  fi
}

json_get() { # <dot.path> — reads JSON on stdin, prints the value
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value[key]
print(value)
' "$1"
}

HOST_SSH="" # set once the server has an IP
host() { ssh -o ConnectTimeout=10 "$HOST_SSH" "$@"; }

# ---------------------------------------------------------------- preflight
log "Preflight checks"
SCALEWAY_ACCESS_KEY_ID="$(env_secret SCALEWAY_ACCESS_KEY_ID)"
SCALEWAY_SECRET_KEY="$(env_secret SCALEWAY_SECRET_KEY)"
GITHUB_PAT="$(env_secret GITHUB_PAT)"
TAILSCALE_AUTHKEY="$(env_secret TAILSCALE_AUTHKEY)"
env_secret DEVBOX_SHARED_SECRET >/dev/null # adopt-host.sh needs it; fail early

# ------------------------------------------------------------ create server
log "Resolving Scaleway project id"
PROJECT_ID="$(scw_api GET "/iam/v1alpha1/api-keys/$SCALEWAY_ACCESS_KEY_ID" \
  | json_get default_project_id)"

log "Creating $SERVER_TYPE server '$HOST_NAME' in $ZONE (reused if it exists)"
SERVER_ID="$(scw_api GET "$SERVERS_PATH" | python3 -c '
import json, sys
for server in json.load(sys.stdin).get("servers") or []:
    if server["name"] == sys.argv[1]:
        print(server["id"])
        break
' "$HOST_NAME")"
if [[ -n "$SERVER_ID" ]]; then
  echo "reusing existing server $SERVER_ID"
else
  SERVER_ID="$(scw_api POST "$SERVERS_PATH" \
    "{\"name\": \"$HOST_NAME\", \"project_id\": \"$PROJECT_ID\", \"type\": \"$SERVER_TYPE\"}" \
    | json_get id)"
  echo "created server $SERVER_ID"
fi

log "Waiting for the server to be ready (a fresh M2 can take ~15 min)"
STATUS=""
last_status=""
for i in $(seq 1 120); do
  STATUS="$(scw_api GET "$SERVERS_PATH/$SERVER_ID" | json_get status)"
  if [[ "$STATUS" != "$last_status" ]]; then
    echo "server status: $STATUS"
    last_status="$STATUS"
  fi
  [[ "$STATUS" == "ready" ]] && break
  sleep 15
done
if [[ "$STATUS" != "ready" ]]; then
  echo "ERROR: server $SERVER_ID is '$STATUS' after 30 min" >&2
  exit 1
fi

# The expanded response carries the m1 sudo password; keep it off the screen.
server_info="$(scw_api GET "$SERVERS_PATH/$SERVER_ID?expand=sudo_password")"
SERVER_IP="$(json_get ip <<<"$server_info")"
SUDO_PASSWORD="$(json_get sudo_password <<<"$server_info")"
unset server_info
HOST_SSH="$SSH_USER@$SERVER_IP"
echo "server IP: $SERVER_IP"

# -------------------------------------------------------------- wait for ssh
# Pre-seed known_hosts so every later ssh (including deploy-payload.sh and
# adopt-host.sh, which use plain ssh) is non-interactive.
log "Waiting for SSH and pinning the host key"
mkdir -p ~/.ssh
ssh-keygen -R "$SERVER_IP" >/dev/null 2>&1 || true
ssh_ready=""
for i in $(seq 1 90); do
  if ssh-keyscan -T 5 "$SERVER_IP" 2>/dev/null | grep -q .; then
    ssh_ready=1
    break
  fi
  sleep 10
done
if [[ -z "$ssh_ready" ]]; then
  echo "ERROR: SSH on $SERVER_IP never came up" >&2
  exit 1
fi
ssh-keyscan -T 5 "$SERVER_IP" >>~/.ssh/known_hosts 2>/dev/null
host true

# --------------------------------------------------------- passwordless sudo
log "Enabling passwordless sudo for $SSH_USER"
if host 'sudo -n true 2>/dev/null'; then
  echo "already enabled"
else
  # The sudo password arrives via stdin (sudo -S); it never hits a command line.
  host "sudo -S sh -c 'echo \"$SSH_USER ALL=(ALL) NOPASSWD: ALL\" > /etc/sudoers.d/ultraclaude && chmod 440 /etc/sudoers.d/ultraclaude'" \
    <<<"$SUDO_PASSWORD"
  host 'sudo -n true'
fi

# ------------------------------------------------------------------ homebrew
log "Installing Homebrew (if missing)"
if host 'test -x /opt/homebrew/bin/brew'; then
  echo "already installed"
else
  host 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
fi

log "Installing tailscale + sshpass (if missing)"
host '/opt/homebrew/bin/brew list tailscale >/dev/null 2>&1 || /opt/homebrew/bin/brew install tailscale'
host '/opt/homebrew/bin/brew list sshpass >/dev/null 2>&1 || /opt/homebrew/bin/brew install sshpass'

# ------------------------------------------------------------------- tailnet
log "Joining the tailnet as $HOST_NAME (if not already)"
if host '/opt/homebrew/bin/tailscale status >/dev/null 2>&1'; then
  echo "already joined"
else
  if ! host 'pgrep -x tailscaled >/dev/null'; then
    host 'sudo /opt/homebrew/bin/brew services start tailscale'
    sleep 5
  fi
  # Authkey is piped via stdin so it never appears in a command line.
  host "sudo /opt/homebrew/bin/tailscale up --authkey=\"\$(cat)\" --hostname=$HOST_NAME" \
    <<<"$TAILSCALE_AUTHKEY"
fi
host '/opt/homebrew/bin/tailscale ip -4'

# ---------------------------------------------------------------------- tart
log "Installing tart 2.32.1 (if missing)"
if host "test -x $TART"; then
  echo "already installed"
else
  host "curl -fsSL '$TART_URL' | tar -xz -C ~"
fi
host "$TART --version"

# ---------------------------------------------------------------- auto-login
# tart VMs and the gui launchd domain need a live GUI session for m1, so the
# host must log m1 in at the loginwindow on every boot.
log "Enabling auto-login for $SSH_USER (kcpassword)"
if [[ "$(host 'sudo defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true')" == "$SSH_USER" ]]; then
  echo "already enabled"
else
  # /etc/kcpassword is the login password XORed with Apple's fixed key,
  # zero-padded to the key length. The password arrives via stdin.
  KCPASSWORD_PY='
import os
import sys
key = [0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F]
pw = sys.stdin.buffer.read().rstrip(b"\n")
pw += b"\x00" * (len(key) - (len(pw) % len(key)))
data = bytes(b ^ key[i % len(key)] for i, b in enumerate(pw))
with open("/etc/kcpassword", "wb") as f:
    f.write(data)
os.chmod("/etc/kcpassword", 0o600)
'
  host "sudo /usr/bin/python3 -c '$KCPASSWORD_PY'" <<<"$SUDO_PASSWORD"
  host "sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser $SSH_USER"
fi

# ------------------------------------------------------------ key-only sshd
# Named 000-* because sshd_config.d files apply first-match-wins in lexical
# order and must beat Apple's 100-macos.conf.
log "Hardening sshd (key-only)"
if host 'test -f /etc/ssh/sshd_config.d/000-ultraclaude.conf'; then
  echo "already hardened"
else
  host "sudo sh -c 'printf \"PasswordAuthentication no\nKbdInteractiveAuthentication no\n\" > /etc/ssh/sshd_config.d/000-ultraclaude.conf'"
  host 'sudo launchctl kickstart -k system/com.openssh.sshd'
fi

# -------------------------------------------------------------------- reboot
log "Rebooting so auto-login takes effect"
if [[ "$(host 'stat -f %Su /dev/console')" == "$SSH_USER" ]]; then
  echo "console session already belongs to $SSH_USER; skipping reboot"
else
  host 'sudo shutdown -r now' || true
  sleep 30
  back=""
  for i in $(seq 1 60); do
    if host true 2>/dev/null; then
      back=1
      break
    fi
    sleep 10
  done
  if [[ -z "$back" ]]; then
    echo "ERROR: host did not come back after reboot" >&2
    exit 1
  fi
  console_user="$(host 'stat -f %Su /dev/console')"
  if [[ "$console_user" != "$SSH_USER" ]]; then
    echo "ERROR: console user is '$console_user' after reboot (auto-login failed)" >&2
    exit 1
  fi
fi

# ------------------------------------------------------------- golden image
log "Pulling the golden image (if missing; ~60 GB on first pull)"
if host "$TART list 2>/dev/null | grep -q '^local *$GOLDEN_LOCAL '"; then
  echo "$GOLDEN_LOCAL already present"
else
  # ghcr auth (the PAT) is piped via stdin so it never hits a command line.
  host "TART_REGISTRY_USERNAME=laxels TART_REGISTRY_PASSWORD=\"\$(cat)\" $TART pull $GOLDEN_REMOTE" \
    <<<"$GITHUB_PAT"
  host "$TART clone $GOLDEN_REMOTE $GOLDEN_LOCAL"
fi
host "$TART list"

# ------------------------------------------------------------------ adoption
log "Adopting the host (bun, payload, host agent)"
"$REPO_ROOT/scripts/adopt-host.sh" "$HOST_SSH" "$HOST_NAME"

log "Done. $HOST_NAME ($SERVER_IP) is bootstrapped and running the host agent."
