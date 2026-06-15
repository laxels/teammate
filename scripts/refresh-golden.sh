#!/usr/bin/env bash
#
# Roll a new golden image across the standing warm fleet (issue #89).
#
# A standing warm host PINS whatever golden it was prepped with (its hostagent
# clones a fixed local tart image for every new ephemeral), so bumping the golden
# is no longer free — a live host keeps serving the stale image until it is
# deliberately refreshed. This script is that operation: the per-host refresh
# PRIMITIVE (drain -> pull -> clone -> swap -> rejoin) plus two rollout MODES over
# the fleet. It generalizes bake-golden.sh's single-host "flip the live host"
# closing note to the whole fleet.
#
#   Usage: scripts/refresh-golden.sh [options]
#     --tag <vN>            golden version to roll to (default: the pinned
#                          GOLDEN_VERSION in scripts/golden-constants.sh)
#     --mode rolling|all-at-once   rollout mode (default: rolling)
#     --hosts "h1 h2"      target hosts (default: every active host in the fleet)
#     --drain-timeout <s>  all-at-once: bounded wait for in-flight tasks to drain
#                          before force-evicting (default: 300)
#     --rolling-drain-timeout <s>  rolling: per-host wait for a host to drain
#                          naturally; on timeout the host is left on the OLD
#                          golden rather than disrupted (default: 2700 = 45m)
#     --dry-run            resolve the plan and print it; mutate nothing, take no
#                          lock. Safe to run anytime.
#
# Rollout modes (both end on: every target host on the new golden + pin coverage):
#   rolling (default)  Walks the fleet ONE host at a time: drain that host's
#                      ephemerals (let in-flight tasks finish, no new ones land),
#                      pull+clone, swap, rejoin, then advance. Never disrupts an
#                      in-flight task; keeps the fleet at ~N-1 capacity throughout;
#                      wall-clock ~= sum of per-host refresh times.
#   all-at-once        Refreshes EVERY host in parallel to minimize convergence
#                      wall-clock — trading fleet capacity for speed. Drains each
#                      host with a BOUNDED timeout, then FORCE-EVICTS whatever is
#                      left (abandoning those tasks — surfaced in the output and a
#                      fleet event). For a broken/security-critical golden, a known
#                      low-traffic window, or a from-cold fleet. Opt-in only.
#
# This op mutates live fleet state, so it takes the global Convex "fleet" lock
# (scripts/fleet-lock.sh) — the SAME lock as provisioning, so a roll and a
# provision (or two rolls) can never race. It also pairs with the golden pin
# (scripts/golden-constants.sh): bump GOLDEN_VERSION there and run this, and new
# hosts (provision-host.sh) and existing hosts (this script) converge on one tag.
#
# Reaches each host the same way provision-host.sh does: resolves its public IP
# from the Scaleway API and ssh's in as m1. The per-host runtime work is pure
# tart + hostagent.env + launchctl over ssh; Convex is mutated only via the
# secret-gated /fleet/* HTTP endpoints (outbound-only control plane preserved).
#
# Requires in the repo-root .env (or as env vars — GitHub Actions injects them):
# SCALEWAY_ACCESS_KEY_ID, SCALEWAY_SECRET_KEY (resolve host IPs), GITHUB_PAT
# (ghcr pull of the golden), DEVBOX_SHARED_SECRET (Convex /fleet/* auth). Never
# prints secrets.

set -euo pipefail

# Pre-scan for --dry-run so a read-only plan never takes the lock (and never
# blocks a real op). Everything else is parsed after the lock re-exec below.
DRY_RUN=0
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=1
done

# Global Convex "fleet" lock: one fleet op at a time, regardless of origin
# (laptop, GitHub Actions, the #88 monitor). `with` acquires it, renews it for
# the whole run, refuses to run from a linked worktree, and releases on exit.
# FLEET_LOCK_HELD=1 means the caller already holds it (the GH workflow). A
# dry-run mutates nothing, so it skips the lock.
if [[ "$DRY_RUN" != "1" && "${FLEET_LOCK_HELD:-}" != "1" ]]; then
  exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fleet-lock.sh" with "$0" "$@"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"
# Hostagent LaunchAgent PATH lacks homebrew; harmless to widen for ssh/curl.
export PATH="/opt/homebrew/bin:$PATH"
API="https://api.scaleway.com"
ZONE="fr-par-1"
SERVERS_PATH="/apple-silicon/v1alpha1/zones/$ZONE/servers"
SSH_USER="m1"
TART='~/tart.app/Contents/MacOS/tart'

# ---------------------------------------------------------------- arg parsing
MODE="rolling"
TAG=""
HOSTS_ARG=""
DRAIN_TIMEOUT_SECS=300
ROLLING_DRAIN_TIMEOUT_SECS=2700
# How long to wait, after a force-evict, for the destroy_vm commands to clear
# the devbox rows before moving on (all-at-once trades cleanliness for speed —
# a lingering teardown does not block the swap, which never touches running VMs).
EVICT_SETTLE_SECS=120
# How long to wait for a swapped host to heartbeat the new golden before we call
# the host's refresh confirmed.
VERIFY_TIMEOUT_SECS=180
POLL_INTERVAL_SECS=10

while (($#)); do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --hosts) HOSTS_ARG="$2"; shift 2 ;;
    --drain-timeout) DRAIN_TIMEOUT_SECS="$2"; shift 2 ;;
    --rolling-drain-timeout) ROLLING_DRAIN_TIMEOUT_SECS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ "$MODE" != "rolling" && "$MODE" != "all-at-once" ]]; then
  echo "ERROR: --mode must be 'rolling' or 'all-at-once' (got '$MODE')" >&2
  exit 1
fi

# Resolve the golden pin. Exporting GOLDEN_VERSION before sourcing lets --tag
# override it while GOLDEN_REMOTE/GOLDEN_LOCAL still derive from the one place
# (no duplicated ghcr-ref format here).
[[ -n "$TAG" ]] && export GOLDEN_VERSION="$TAG"
source "$REPO_ROOT/scripts/golden-constants.sh"
# Deployment-identity constants (CONVEX_SITE_URL): single source of truth.
source "$REPO_ROOT/scripts/deployment-constants.sh"

log() { printf '\n==> %s\n' "$*"; }

env_secret() { # <KEY> -> value from env, else repo .env; never echoed
  local key="$1" val="${!1:-}"
  if [[ -n "$val" ]]; then printf '%s' "$val"; return 0; fi
  val="$(grep "^$key=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $key not set and missing from $ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$val"
}

json_string() { # <str> -> JSON-quoted string
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

# ---------------------------------------------------------------- Scaleway IP
scw_api() { # <method> <path> -> response body on stdout (errors to stderr)
  local method="$1" path="$2" response http_code
  response="$(curl -sS -w $'\n%{http_code}' -X "$method" \
    -H "X-Auth-Token: $SCALEWAY_SECRET_KEY" "$API$path")"
  http_code="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if (( http_code >= 400 )); then
    echo "ERROR: Scaleway API $method $path -> HTTP $http_code: $response" >&2
    return 1
  fi
  printf '%s' "$response"
}

# Map a host NAME to its public IP from the (cached) server list. Empty if the
# host has no Scaleway server (a typo, or a host not in this project).
resolve_host_ip() { # <host-name> -> ip or ""
  python3 -c '
import json, sys
name = sys.argv[1]
try:
    servers = json.loads(sys.argv[2]).get("servers") or []
except ValueError:
    servers = []
for s in servers:
    if s.get("name") == name:
        print(s.get("ip") or "")
        break
' "$1" "$SERVER_LIST"
}

# ----------------------------------------------------------- Convex /fleet/*
convex_get() { # <path> -> response body (empty on transport failure)
  curl -sS -H "x-devbox-secret: $DEVBOX_SHARED_SECRET" "$CONVEX_SITE_URL$1" \
    2>/dev/null || true
}

convex_post() { # <path> <json-body> -> response body (non-2xx fails)
  local path="$1" body="$2" resp code
  resp="$(curl -sS -w $'\n%{http_code}' -X POST \
    -H "x-devbox-secret: $DEVBOX_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    -d "$body" "$CONVEX_SITE_URL$path")"
  code="${resp##*$'\n'}"
  resp="${resp%$'\n'*}"
  if (( code >= 400 )); then
    echo "ERROR: POST $path -> HTTP $code: $resp" >&2
    return 1
  fi
  printf '%s' "$resp"
}

# Best-effort fleet lifecycle event (get_fleet surfaces these). Never fails the
# roll on a reporting hiccup.
fleet_event() { # <host> <type> <summary>
  convex_post /fleet/event \
    "{\"hostId\":\"$1\",\"type\":\"$2\",\"summary\":$(json_string "$3")}" \
    >/dev/null 2>&1 || true
}

host_set_status() { # <host> <active|draining>
  convex_post /fleet/host/status "{\"hostId\":\"$1\",\"status\":\"$2\"}" >/dev/null
}

# Count live ephemeral VM rows still on a host (drained == 0). A fetch/parse
# failure prints -1 so the caller keeps waiting (never a false "drained").
host_vm_count() { # <host> -> integer (>=0, or -1 on unknown)
  local json
  json="$(convex_get /fleet/status)"
  python3 -c '
import json, sys
host = sys.argv[1]
try:
    data = json.loads(sys.stdin.read())
except ValueError:
    print(-1); sys.exit(0)
print(sum(1 for d in data.get("devboxes", [])
          if d.get("hostId") == host and d.get("ephemeral")))
' "$host" <<<"$json"
}

# The golden a host currently reports in its heartbeat ("" if none / stale /
# unfetchable).
host_reported_golden() { # <host> -> golden image name or ""
  local json
  json="$(convex_get /fleet/status)"
  python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
except ValueError:
    print(""); sys.exit(0)
host = next((h for h in data.get("hosts", []) if h.get("hostId") == sys.argv[1]), None)
print((host or {}).get("goldenImage") or "")
' "$1" <<<"$json"
}

# ----------------------------------------------------------- per-host helpers
host_ssh_run() { # <ip> <remote-cmd...>
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    "$SSH_USER@$1" "${@:2}"
}

# Wait until a host has zero ephemeral VMs, up to <timeout> seconds. Returns 0
# if it drained, 1 on timeout.
wait_for_drain() { # <host> <timeout-secs>
  local host="$1" deadline=$(( SECONDS + $2 )) count
  while true; do
    count="$(host_vm_count "$host")"
    [[ "$count" == "0" ]] && return 0
    if (( SECONDS >= deadline )); then
      echo "  [$host] still ${count/-1/unknown} VM(s) after ${2}s drain wait" >&2
      return 1
    fi
    echo "  [$host] draining: ${count/-1/unknown} VM(s) in flight; waiting…"
    sleep "$POLL_INTERVAL_SECS"
  done
}

# Wait until a host heartbeats the target golden, up to VERIFY_TIMEOUT_SECS.
wait_for_golden() { # <host> <golden-local>
  local host="$1" want="$2" deadline=$(( SECONDS + VERIFY_TIMEOUT_SECS )) got
  while true; do
    got="$(host_reported_golden "$host")"
    [[ "$got" == "$want" ]] && return 0
    if (( SECONDS >= deadline )); then
      echo "  [$host] heartbeat still reports '${got:-none}', not '$want'" >&2
      return 1
    fi
    sleep "$POLL_INTERVAL_SECS"
  done
}

# Pull the new golden from ghcr and clone it to the local image (idempotent:
# skips when the local image already exists). ghcr auth is piped via stdin so
# the PAT never hits a command line — mirrors provision-host.sh.
host_pull_clone() { # <ip>
  local ip="$1"
  if host_ssh_run "$ip" "$TART list 2>/dev/null | grep -q '^local *$GOLDEN_LOCAL '"; then
    echo "  [$ip] $GOLDEN_LOCAL already present"
    return 0
  fi
  echo "  [$ip] pulling $GOLDEN_REMOTE (first pull is ~60 GB)…"
  host_ssh_run "$ip" \
    "TART_REGISTRY_USERNAME=laxels TART_REGISTRY_PASSWORD=\"\$(cat)\" $TART pull $GOLDEN_REMOTE" \
    <<<"$GITHUB_PAT"
  host_ssh_run "$ip" "$TART clone $GOLDEN_REMOTE $GOLDEN_LOCAL"
}

# Point the hostagent at the new golden: rewrite GOLDEN_IMAGE in ~/hostagent.env
# (preserving the other keys + 0600) and restart the agent. Detached tart VMs
# already running are unaffected; only NEW clones use the new image.
host_swap_golden() { # <ip>
  host_ssh_run "$1" "GOLDEN_LOCAL='$GOLDEN_LOCAL' bash -s" <<'REMOTE'
set -euo pipefail
umask 077
# Never rewrite a missing env into a GOLDEN_IMAGE-only file: that would drop
# HOST_ID/secret and crash-loop the agent. An active host always has this.
[[ -f ~/hostagent.env ]] || { echo "ERROR: ~/hostagent.env missing" >&2; exit 1; }
tmp="$(mktemp)"
grep -v '^GOLDEN_IMAGE=' ~/hostagent.env > "$tmp" || true
printf 'GOLDEN_IMAGE=%s\n' "$GOLDEN_LOCAL" >> "$tmp"
mv "$tmp" ~/hostagent.env
chmod 600 ~/hostagent.env
launchctl kickstart -k "gui/$(id -u)/com.ultraclaude.hostagent"
REMOTE
}

# Refresh ONE host end to end: drain -> [evict] -> pull -> clone -> swap ->
# verify -> rejoin. Writes a single result line ("OK …" / "FAIL: …" / "SKIP: …")
# to $RESULT_DIR/<host>; the caller reads it for the summary. Runs under `set
# +e` (run_host) with explicit checks, so it ALWAYS leaves the host active
# (never stuck draining) and always records a result — one host's failure can't
# abort the roll or silently shrink the fleet.
refresh_one_host() { # <host-name>
  local host="$1" ip rc evicted
  local result="$RESULT_DIR/$host"

  ip="$(resolve_host_ip "$host")"
  if [[ -z "$ip" ]]; then
    echo "SKIP: no Scaleway server named '$host'" > "$result"
    echo "  [$host] SKIP — not found in Scaleway $ZONE" >&2
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "  [$host] ($ip): would drain → pull+clone $GOLDEN_LOCAL → swap → rejoin (mode: $MODE)"
    echo "OK (dry-run)" > "$result"
    return 0
  fi

  log "[$host] draining (mode: $MODE)"
  if ! host_set_status "$host" draining; then
    echo "FAIL: could not mark $host draining (Convex unreachable?)" > "$result"
    echo "  [$host] FAIL — could not start drain" >&2
    return 0
  fi
  fleet_event "$host" golden_refresh_started \
    "Golden-refresh started: rolling $host to $GOLDEN_LOCAL ($MODE)."

  # Drain in-flight VMs. Rolling waits long and never disrupts; all-at-once
  # waits a bounded window then force-evicts the remainder.
  if [[ "$MODE" == "all-at-once" ]]; then
    if ! wait_for_drain "$host" "$DRAIN_TIMEOUT_SECS"; then
      log "[$host] drain window elapsed — force-evicting remaining VMs"
      evicted="$(convex_post /fleet/host/evict "{\"hostId\":\"$host\"}" || echo '{}')"
      echo "  [$host] evict result: $evicted"
      # The teardown clears the rows asynchronously; don't block the swap on it.
      wait_for_drain "$host" "$EVICT_SETTLE_SECS" || true
    fi
  else
    if ! wait_for_drain "$host" "$ROLLING_DRAIN_TIMEOUT_SECS"; then
      host_set_status "$host" active || true # restore capacity; never disrupt
      fleet_event "$host" golden_refresh_skipped \
        "Golden-refresh skipped $host: still busy after ${ROLLING_DRAIN_TIMEOUT_SECS}s; left on the old golden."
      echo "FAIL: drain timed out after ${ROLLING_DRAIN_TIMEOUT_SECS}s; left on old golden, rejoined" > "$result"
      echo "  [$host] FAIL — drain timed out; left on old golden" >&2
      return 0
    fi
  fi

  # Post-drain steps. Any failure re-activates the host (restore capacity — the
  # host still runs the old golden, no worse than before) and reports FAIL.
  log "[$host] pulling + cloning + swapping to $GOLDEN_LOCAL"
  rc=0
  { host_pull_clone "$ip" \
      && host_swap_golden "$ip" \
      && wait_for_golden "$host" "$GOLDEN_LOCAL"; } || rc=$?
  host_set_status "$host" active || true
  if (( rc != 0 )); then
    fleet_event "$host" golden_refresh_failed \
      "Golden-refresh of $host failed (step exit $rc); rejoined on the old golden — investigate."
    echo "FAIL: pull/clone/swap/verify failed (exit $rc); rejoined on old golden" > "$result"
    echo "  [$host] FAIL — see logs; rejoined on old golden" >&2
    return 0
  fi
  fleet_event "$host" golden_refresh_succeeded \
    "$host refreshed to $GOLDEN_LOCAL and rejoined the fleet."
  echo "OK: on $GOLDEN_LOCAL" > "$result"
  log "[$host] DONE — on $GOLDEN_LOCAL and active"
}

# Run one host's refresh in a `set +e` subshell so an unexpected command failure
# is contained to that host (the subshell aborts, the roll continues) and never
# leaks the option change back to the main shell.
run_host() { # <host-name>
  ( set +e; refresh_one_host "$1" )
}

# ---------------------------------------------------------------- preflight
log "Golden-refresh preflight"
DEVBOX_SHARED_SECRET="$(env_secret DEVBOX_SHARED_SECRET)"
SCALEWAY_SECRET_KEY="$(env_secret SCALEWAY_SECRET_KEY)"
GITHUB_PAT="$(env_secret GITHUB_PAT)"
SERVER_LIST="$(scw_api GET "$SERVERS_PATH")"

# Target hosts: the explicit --hosts list, else every active host in the fleet.
HOSTS=()
if [[ -n "$HOSTS_ARG" ]]; then
  read -r -a HOSTS <<<"${HOSTS_ARG//,/ }"
else
  while IFS= read -r h; do
    [[ -n "$h" ]] && HOSTS+=("$h")
  done < <(convex_get /fleet/status | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
except ValueError:
    sys.exit(0)
for host in data.get("hosts", []):
    if host.get("status") == "active":
        print(host["hostId"])
')
fi
if (( ${#HOSTS[@]} == 0 )); then
  echo "ERROR: no target hosts (none active in the fleet, or --hosts was empty)" >&2
  exit 1
fi

echo "Rolling golden -> $GOLDEN_LOCAL ($GOLDEN_REMOTE)"
echo "Mode:    $MODE"
echo "Hosts:   ${HOSTS[*]}"
echo "Dry-run: $([[ "$DRY_RUN" == "1" ]] && echo yes || echo no)"

RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

# ---------------------------------------------------------------- rollout
if [[ "$MODE" == "rolling" ]]; then
  # One host at a time: at most one host out of rotation, ~N-1 capacity held.
  for host in "${HOSTS[@]}"; do
    run_host "$host"
  done
else
  # Every host in parallel: fastest convergence, lowest capacity during the roll.
  pids=()
  for host in "${HOSTS[@]}"; do
    run_host "$host" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done
fi

# ---------------------------------------------------------------- summary
log "Golden-refresh summary ($GOLDEN_LOCAL, $MODE)"
failures=0
for host in "${HOSTS[@]}"; do
  outcome="$(cat "$RESULT_DIR/$host" 2>/dev/null || echo "FAIL: no result recorded")"
  printf '  %-22s %s\n' "$host" "$outcome"
  # Anything but OK (a FAIL, or a SKIP for a host that isn't in the fleet) is a
  # non-zero exit so a typo'd --hosts or a stuck host never looks like success.
  [[ "$outcome" == OK* ]] || failures=$(( failures + 1 ))
done

if (( failures > 0 )); then
  echo >&2
  echo "ERROR: $failures of ${#HOSTS[@]} host(s) did not converge on $GOLDEN_LOCAL." >&2
  exit 1
fi
log "All ${#HOSTS[@]} host(s) converged on $GOLDEN_LOCAL."
