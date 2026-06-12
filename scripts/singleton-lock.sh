#!/usr/bin/env bash
#
# Serialize operations on shared singletons (the live Convex deployment, the
# Scaleway fleet) across concurrent checkouts of this repo:
#
#   scripts/singleton-lock.sh <name> <command> [args...]
#
# Guarantees, in order:
#   1. Singleton operations run from the primary checkout only — a linked
#      worktree is refused so divergent code can't be pushed to live systems
#      (override: ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1).
#   2. One holder per <name> at a time, across the primary checkout and all
#      of its worktrees: the lock lives in the shared .git common dir. A lock
#      whose owner process is dead is stolen automatically.
#   3. Outside a git checkout (the rsynced payload on fleet hosts) there is
#      nothing to coordinate against — the command runs unlocked.
#
# Wrapped scripts re-exec through this wrapper and detect it via the exported
# SINGLETON_LOCK=<name>, which also makes same-name nesting re-entrant
# (e.g. provision-host.sh delegating to adopt-host.sh under one fleet lock).

set -euo pipefail

NAME="${1:-}"
shift || true
if [[ ! "$NAME" =~ ^[a-z0-9-]+$ || $# -lt 1 ]]; then
  echo "Usage: $0 <lock-name> <command> [args...]   (lock name: [a-z0-9-]+)" >&2
  exit 1
fi

# Re-entrant: already running under this lock.
if [[ "${SINGLETON_LOCK:-}" == "$NAME" ]]; then
  exec "$@"
fi

# Host payload context: no git checkout, nothing to lock against.
if ! COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null)"; then
  exec "$@"
fi
COMMON_DIR="$(cd "$COMMON_DIR" && pwd)"
GIT_DIR="$(cd "$(git rev-parse --git-dir)" && pwd)"

if [[ "$GIT_DIR" != "$COMMON_DIR" && "${ULTRACLAUDE_SINGLETON_FROM_WORKTREE:-}" != "1" ]]; then
  cat >&2 <<EOF
singleton-lock: refusing to run '$NAME' operations from a linked worktree.
This checkout's code may diverge from what the live systems run. Run from the
primary checkout, or set ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1 if you mean it.
EOF
  exit 1
fi

LOCK_DIR="$COMMON_DIR/singleton-locks/$NAME"
STEAL_DIR="$LOCK_DIR.steal"
stole=""
mkdir -p "$(dirname "$LOCK_DIR")"

acquire() {
  mkdir "$LOCK_DIR" 2>/dev/null
}

owner_pid() {
  # Never fails: a missing/unreadable owner file yields "" (set -e safety).
  sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null || true
}

if ! acquire; then
  pid="$(owner_pid)"
  if [[ -z "$pid" ]]; then
    # No owner record: a rival is mid-acquire (the file lands microseconds
    # after mkdir), or an acquire crashed at exactly that point. Stealing
    # here could delete a live lock, so treat it as held.
    echo "singleton-lock: '$NAME' lock exists but has no owner record (likely mid-acquire). If it is stale, remove it: rm -rf '$LOCK_DIR'" >&2
    exit 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "singleton-lock: '$NAME' is held by pid $pid ($(sed -n 's/^command=//p' "$LOCK_DIR/owner" 2>/dev/null)). Try again when it finishes." >&2
    exit 1
  fi
  # Test seam: widens the window between the dead-owner check above and the
  # steal below so the race is reproducible. No-op outside tests.
  if [[ -n "${SINGLETON_LOCK_TEST_STEAL_DELAY:-}" ]]; then
    sleep "$SINGLETON_LOCK_TEST_STEAL_DELAY"
  fi
  # Owner is dead: steal. The dead-owner check and the removal must hold
  # together: between them a rival may have stolen the stale lock and
  # re-acquired it alive, and removing THAT lock would let two holders run
  # concurrently. A mutex dir serializes stealers and the owner is re-checked
  # under it; the mutex is held only across the lines through the owner
  # write below, never across the wrapped command.
  if ! mkdir "$STEAL_DIR" 2>/dev/null; then
    echo "singleton-lock: a rival contender is stealing the stale '$NAME' lock; try again. (Only if no contender is running: rm -rf '$STEAL_DIR')" >&2
    exit 1
  fi
  stole=1
  trap 'rmdir "$STEAL_DIR" 2>/dev/null' EXIT
  pid="$(owner_pid)"
  if [[ -d "$LOCK_DIR" && -z "$pid" ]]; then
    echo "singleton-lock: '$NAME' lock exists but has no owner record (likely mid-acquire). If it is stale, remove it: rm -rf '$LOCK_DIR'" >&2
    exit 1
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "singleton-lock: '$NAME' is held by pid $pid ($(sed -n 's/^command=//p' "$LOCK_DIR/owner" 2>/dev/null)). Try again when it finishes." >&2
    exit 1
  fi
  rm -rf "$LOCK_DIR"
  if ! acquire; then
    echo "singleton-lock: lost the race re-acquiring '$NAME', try again" >&2
    exit 1
  fi
fi

printf 'pid=%s\nstarted=%s\ncommand=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "$LOCK_DIR/owner"
if [[ -n "$stole" ]]; then
  rmdir "$STEAL_DIR" 2>/dev/null || true
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

export SINGLETON_LOCK="$NAME"

# Shepherd the command: run it as a child, forward fatal signals to it, and
# only release the lock (EXIT trap) once it has actually finished — never
# while it might still be touching the singleton. <&0 keeps stdin attached
# for interactive commands (`convex dev` login). SIGKILL is the one escape:
# it orphans the child and leaves the lock for the dead-owner steal path.
set +e
"$@" <&0 &
CHILD=$!
trap 'kill -HUP "$CHILD" 2>/dev/null' HUP
trap 'kill -INT "$CHILD" 2>/dev/null' INT
trap 'kill -TERM "$CHILD" 2>/dev/null' TERM
wait "$CHILD"
code=$?
# A trapped signal interrupts `wait` with 128+sig; re-wait while the child
# is still alive so we reap its real exit code.
while (( code > 128 )) && kill -0 "$CHILD" 2>/dev/null; do
  wait "$CHILD"
  code=$?
done
set -e
exit "$code"
