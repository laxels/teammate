#!/usr/bin/env bash
#
# Authoritative, cross-origin fleet lock — the Convex-backed serializer for
# fleet-PROVISIONING operations (scripts/provision-host.sh, adopt-host.sh).
#
# Unlike scripts/singleton-lock.sh — a local .git filesystem lock that only
# sees initiators in ONE checkout — this lock lives in Convex, so every
# fleet-mutating op grabs it regardless of origin: a laptop run, a GitHub
# Actions runner, or the future #88 capacity monitor. It is a LEASE: the holder
# renews before it expires, so a runner that dies mid-op never wedges the lock
# (the distributed analogue of singleton-lock's dead-owner steal).
#
# The lock is GLOBAL ("fleet"): one fleet operation at a time. Parallelism (e.g.
# GH Actions provisioning host-2..5 concurrently) happens WITHIN a single held
# op — the matrix fans out while the run holds the one lock; a second op from
# any origin waits.
#
# Usage:
#   scripts/fleet-lock.sh acquire [holder]      # one-shot; exits 0 if acquired
#   scripts/fleet-lock.sh release [holder]      # release if we own it
#   scripts/fleet-lock.sh with <command> [args] # acquire → renew → run → release
#   scripts/fleet-lock.sh guard <command> [args]# (lock already held) renew → run,
#                                               #   aborting the command if the
#                                               #   lease is lost; no acquire/release
#
# The `with` form is what provision-host.sh / adopt-host.sh re-exec through; it
# also guards against running from a linked worktree (divergent code must not
# reach live systems — same rule as singleton-lock.sh). The `guard` form is for
# the GitHub Actions matrix: the run's `lock` job already holds the lock, so each
# parallel job only renews + aborts-on-loss while it provisions, and a single
# `release` job frees it at the end.
#
# Env:
#   CONVEX_DEPLOYMENT_SLUG Convex deployment slug; the Convex URLs derive from it
#                          (or set CONVEX_SITE_URL directly — the lock API uses
#                          it). See scripts/deployment-constants.sh.
#   DEVBOX_SHARED_SECRET   shared secret (or read from $ULTRACLAUDE_ENV / .env)
#   FLEET_LOCK_HOLDER      holder id (default: <user>@<host>:<pid>)
#   FLEET_LOCK_TTL_MS      lease length (default 900000 = 15 min)
#   FLEET_LOCK_WAIT_SECS   how long `acquire`/`with` waits for a busy lock
#                          (default 0 = fail fast)
#   FLEET_LOCK_NAME        lock name (default "fleet")
#   ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1  bypass the worktree guard

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"

# Deployment-identity constants (CONVEX_SITE_URL): single source of truth shared
# with the other fleet scripts; stays env-overridable.
source "$REPO_ROOT/scripts/deployment-constants.sh"
# Shared fleet helpers (log, env_secret, …): single copy in scripts/fleet-lib.sh.
source "$REPO_ROOT/scripts/fleet-lib.sh"
LOCK_NAME="${FLEET_LOCK_NAME:-fleet}"
TTL_MS="${FLEET_LOCK_TTL_MS:-900000}"
WAIT_SECS="${FLEET_LOCK_WAIT_SECS:-0}"
# Renew at a third of the lease so two missed renewals still leave margin.
RENEW_SECS=$(( TTL_MS / 1000 / 3 ))
(( RENEW_SECS < 5 )) && RENEW_SECS=5

DEVBOX_SHARED_SECRET="$(env_secret DEVBOX_SHARED_SECRET)"

default_holder() { printf '%s@%s:%s' "$(id -un)" "$(hostname -s)" "$$"; }
HOLDER="${FLEET_LOCK_HOLDER:-$(default_holder)}"

# POST a JSON body to a /fleet/lock/* endpoint; prints the response, fails non-2xx.
lock_api() { # <endpoint> <json-body>
  local endpoint="$1" body="$2" resp code
  resp="$(curl -sS -w $'\n%{http_code}' -X POST \
    -H "x-devbox-secret: $DEVBOX_SHARED_SECRET" \
    -H "Content-Type: application/json" \
    -d "$body" "$CONVEX_SITE_URL/fleet/lock/$endpoint")"
  code="${resp##*$'\n'}"
  resp="${resp%$'\n'*}"
  if (( code >= 400 )); then
    echo "ERROR: fleet-lock $endpoint -> HTTP $code: $resp" >&2
    return 1
  fi
  printf '%s' "$resp"
}

json_field() { # <field> ; reads JSON on stdin, prints the value ("" if absent)
  python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
value = data.get(sys.argv[1])
if value is not None:
    print(value)
' "$1"
}

acquire_once() { # prints "ok" + sets nothing; returns 0 if acquired, 1 if held
  local resp acquired held
  resp="$(lock_api acquire \
    "{\"holder\":\"$HOLDER\",\"ttlMs\":$TTL_MS}")"
  acquired="$(json_field acquired <<<"$resp")"
  if [[ "$acquired" == "True" ]]; then
    return 0
  fi
  held="$(json_field heldBy <<<"$resp")"
  echo "fleet-lock: '$LOCK_NAME' held by ${held:-?}" >&2
  return 1
}

acquire_waiting() { # acquire, polling up to WAIT_SECS for a busy lock
  local deadline=$(( SECONDS + WAIT_SECS ))
  while true; do
    if acquire_once; then
      echo "fleet-lock: acquired '$LOCK_NAME' as $HOLDER" >&2
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "ERROR: could not acquire '$LOCK_NAME' within ${WAIT_SECS}s" >&2
      return 1
    fi
    sleep 10
  done
}

# Returns: 0 = renewed; 1 = transient (HTTP/network) error, safe to retry;
# 2 = lease LOST — we are no longer the holder (stolen, or expired and reclaimed).
# A lost lease must abort the op, not be silently swallowed: continuing would
# break fleet-wide mutual exclusion.
renew_once() {
  local resp renewed
  if ! resp="$(lock_api renew "{\"holder\":\"$HOLDER\",\"ttlMs\":$TTL_MS}")"; then
    echo "WARNING: fleet-lock renew of '$LOCK_NAME' failed (transient); will retry" >&2
    return 1
  fi
  renewed="$(json_field renewed <<<"$resp")"
  [[ "$renewed" == "True" ]] && return 0
  echo "ERROR: fleet-lock lease '$LOCK_NAME' LOST — now held by '$(json_field heldBy <<<"$resp")'" >&2
  return 2
}

release_once() {
  lock_api release "{\"holder\":\"$HOLDER\"}" >/dev/null || true
  echo "fleet-lock: released '$LOCK_NAME' ($HOLDER)" >&2
}

# Run "$@" as the leader of a NEW session (its own process group) so the whole
# descendant tree can be signalled together. Signalling only the wrapper shell
# is not enough: if the command is blocked in a long ssh / curl / brew /
# Scaleway call, killing the parent leaves that foreground child alive and still
# mutating the fleet. macOS ships no setsid(1), so use python3's os.setsid (also
# what these scripts already depend on). The returned PID == the process-group id.
SESSION_LAUNCHER='import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])'

# TERM then (after a grace) KILL an ENTIRE process group, and don't return until
# the group is provably empty (pgrep -g exits non-zero) — so a lease-lost abort
# cannot leave fleet-mutating descendants running. No-op (immediate) if the
# group is already gone, e.g. the command finished normally.
kill_group() { # <leader-pid == pgid>
  local pid="$1" _
  pgrep -g "$pid" >/dev/null 2>&1 || return 0
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    pgrep -g "$pid" >/dev/null 2>&1 || return 0
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    pgrep -g "$pid" >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo "WARNING: process group $pid still has members after SIGKILL" >&2
  return 1
}

# Background lease-keeper shared by `with` and `guard`: renew immediately, then
# every RENEW_SECS, and KILL the child's whole process group the moment the
# lease is lost (stolen / expired-and-reclaimed) — continuing to mutate the
# fleet without the lock would break fleet-wide mutual exclusion. Returns when
# the lease is lost (after the group is down) or the child has exited. Run it
# backgrounded.
abort_on_lost_lease() {
  local child="$1" rc
  while true; do
    renew_once && rc=0 || rc=$?
    if (( rc == 2 )); then
      echo "ERROR: fleet lease lost; killing the in-flight op's process group." >&2
      kill_group "$child"
      return 0
    fi
    kill -0 "$child" 2>/dev/null || return 0
    sleep "$RENEW_SECS"
  done
}

# Refuse to drive live fleet ops from a linked worktree (same guard as
# singleton-lock.sh): a worktree's code may diverge from what the fleet runs.
# A clean clone (GitHub Actions) or the primary checkout passes; outside a git
# checkout there's nothing to compare against.
worktree_guard() {
  local common git
  common="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)" || return 0
  common="$(cd "$REPO_ROOT" && cd "$common" && pwd)"
  git="$(cd "$REPO_ROOT" && cd "$(git rev-parse --git-dir)" && pwd)"
  if [[ "$git" != "$common" && "${ULTRACLAUDE_SINGLETON_FROM_WORKTREE:-}" != "1" ]]; then
    cat >&2 <<EOF
fleet-lock: refusing to run fleet provisioning from a linked worktree.
This checkout's code may diverge from what the live fleet runs. Run from the
primary checkout, or set ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1 if you mean it.
EOF
    return 1
  fi
}

# Shared shepherd for `with` and `guard`: launch the wrapped command as a
# session leader (so a lost-lease abort can kill its whole descendant tree, not
# just the wrapper), background the lease-keeper, and always stop renewing +
# kill the child's process group on exit. Re-entrancy: the wrapped command (and
# anything it calls, e.g. provision-host.sh -> adopt-host.sh) sees the lock is
# held and runs its body directly instead of acquiring again. `with` sets
# RELEASE_ON_EXIT=1 so its trap also releases the lock; `guard` never does (the
# run-level lock/release jobs own that). Exits with the child's exit code.
RELEASE_ON_EXIT=0
shepherd() { # <command> [args...]
  FLEET_LOCK_HELD=1 FLEET_LOCK_HOLDER="$HOLDER" python3 -c "$SESSION_LAUNCHER" "$@" &
  CHILD=$!
  abort_on_lost_lease "$CHILD" &
  RENEWER=$!
  trap 'kill "$RENEWER" 2>/dev/null || true; kill_group "$CHILD"; if (( RELEASE_ON_EXIT )); then release_once; fi' EXIT
  set +e
  wait "$CHILD"
  code=$?
  set -e
  exit "$code"
}

cmd="${1:-}"
shift || true

# For the low-level subcommands an optional positional arg overrides the holder
# (the GH workflow prefers the FLEET_LOCK_HOLDER env var).
case "$cmd" in
  acquire) [[ -n "${1:-}" ]] && HOLDER="$1"; acquire_waiting ;;
  release) [[ -n "${1:-}" ]] && HOLDER="$1"; release_once ;;
  with)
    # Full shepherd: acquire the lock, run the command while renewing, release
    # on exit. Aborts the command if the lease is ever lost mid-op.
    if (( $# < 1 )); then
      echo "Usage: $0 with <command> [args...]" >&2
      exit 1
    fi
    worktree_guard
    acquire_waiting
    RELEASE_ON_EXIT=1
    shepherd "$@"
    ;;
  guard)
    # Like `with`, but the lock is ALREADY held by this holder (e.g. the GH
    # Actions `lock` job holds it for the whole run). Renew it and ABORT the
    # command if the lease is lost — but never acquire or release (the run-level
    # lock/release jobs own that). This is what each parallel matrix job wraps
    # provision-host.sh in: a lost lease kills the provision instead of letting
    # it keep mutating the fleet unlocked.
    if (( $# < 1 )); then
      echo "Usage: $0 guard <command> [args...]" >&2
      exit 1
    fi
    shepherd "$@"
    ;;
  *)
    echo "Usage: $0 {acquire|release|with <command...>|guard <command...>} [holder]" >&2
    exit 1
    ;;
esac
