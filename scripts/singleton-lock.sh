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
mkdir -p "$(dirname "$LOCK_DIR")"

acquire() {
  mkdir "$LOCK_DIR" 2>/dev/null
}

owner_pid() {
  sed -n 's/^pid=//p' "$LOCK_DIR/owner" 2>/dev/null
}

if ! acquire; then
  pid="$(owner_pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "singleton-lock: '$NAME' is held by pid $pid ($(sed -n 's/^command=//p' "$LOCK_DIR/owner" 2>/dev/null)). Try again when it finishes." >&2
    exit 1
  fi
  # Owner is gone (crashed or unreadable): steal.
  rm -rf "$LOCK_DIR"
  if ! acquire; then
    echo "singleton-lock: lost the race re-acquiring '$NAME', try again" >&2
    exit 1
  fi
fi

printf 'pid=%s\nstarted=%s\ncommand=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "$LOCK_DIR/owner"
trap 'rm -rf "$LOCK_DIR"' EXIT

export SINGLETON_LOCK="$NAME"
set +e
"$@"
code=$?
set -e
exit "$code"
