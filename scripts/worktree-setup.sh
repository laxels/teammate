#!/usr/bin/env bash
#
# Bootstrap a freshly created git worktree of this repo so it is immediately
# usable: copy gitignored env files from the primary checkout and install
# dependencies. Invoked as `bun run worktree-setup` by the global Claude Code
# WorktreeCreate hook (~/.claude/hooks/worktree-create.sh), which provides:
#   SOURCE_DIR     the primary checkout the worktree was created from
#   WORKTREE_PATH  the new worktree (defaults to the working directory)
#   WORKTREE_SETUP_REDIRECT_SETUP_OUTPUT_TO_STDERR
#                  when "true", keep stdout clean (the hook's stdout is
#                  reserved for reporting the worktree path to Claude Code)

set -euo pipefail

if [[ "${WORKTREE_SETUP_REDIRECT_SETUP_OUTPUT_TO_STDERR:-}" == "true" ]]; then
  exec 1>&2
fi

if [[ -z "${SOURCE_DIR:-}" || ! -d "${SOURCE_DIR:-}" ]]; then
  echo "worktree-setup: SOURCE_DIR must point at the primary checkout" >&2
  exit 1
fi

WORKTREE_PATH="${WORKTREE_PATH:-$PWD}"
cd "$WORKTREE_PATH"

# Gitignored files a worktree needs: secrets (.env) and the Convex deployment
# pointer (.env.local, used by admin reads like `bunx convex run`; pushes from
# worktrees are blocked by scripts/singleton-lock.sh).
for f in .env .env.local; do
  if [[ -f "$SOURCE_DIR/$f" ]]; then
    cp "$SOURCE_DIR/$f" "$WORKTREE_PATH/$f"
  else
    echo "worktree-setup: $f not found in $SOURCE_DIR, skipping" >&2
  fi
done

bun install --frozen-lockfile
