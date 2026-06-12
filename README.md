# teammate

![CI](https://github.com/laxels/teammate/actions/workflows/ci.yml/badge.svg)

ultraclaude: a Slack-addressable "virtual teammate". A [Convex](https://convex.dev)-hosted
orchestrator receives Slack DMs/mentions and delegates engineering work to Claude Code
instances running in macOS devbox VMs, each with a full desktop that tasks can drive
directly via built-in computer-use tools (screenshots, mouse, keyboard). Every
task gets a tailnet-only monitoring page with a live remote desktop and a steering sidebar.
See [ARCHITECTURE.md](ARCHITECTURE.md) for components, infrastructure, and task flow.

## Setup

```sh
bun install
bun run dev   # starts Convex dev deployment (prompts for login on first run)
```

## Checks

```sh
bun run validate   # typecheck + lint + test, run concurrently with grouped output
```

Individual checks: `bun run typecheck`, `bun run lint` (`lint:fix` to autofix), `bun test`.

## Worktrees and the singleton lane

Parallel sessions each get their own git worktree. Worktree creation runs
`bun run worktree-setup` ([scripts/worktree-setup.sh](scripts/worktree-setup.sh)),
which copies `.env`/`.env.local` from the primary checkout and runs
`bun install --frozen-lockfile`, so a fresh worktree passes `bun run validate`
immediately. Validation is safe to run concurrently in any number of worktrees
(tests bind ephemeral ports and read no env).

Operations that touch shared live systems are the **singleton lane** and are
serialized by [scripts/singleton-lock.sh](scripts/singleton-lock.sh), which
also refuses to run them from a worktree (only the primary checkout's code
should reach live systems; override with `ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1`):

- `convex` lock: `bun run dev` (continuous push to the live Convex deployment)
  and `bun run deploy:convex` (one-shot deploy — prefer this over raw
  `bunx convex dev --once`).
- `fleet` lock: `scripts/deploy-payload.sh`, `provision-host.sh`,
  `adopt-host.sh`, `bake-golden-v2.sh` (Scaleway hosts, golden image). The
  lock no-ops on fleet hosts themselves, where the payload has no git checkout.

Merge hygiene across worktrees: never hand-merge `bun.lock` (take both sides'
package.json, then re-run `bun install`) or `convex/_generated/` (re-run
`bunx convex codegen` — it is offline and touches no deployment).

## Conventions

- Strict TypeScript everywhere (`strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.).
- Biome for linting and formatting.
- Dependency versions are pinned exactly (`bunfig.toml` sets `install.exact`); the Bun version is pinned in `.bun-version`.
- `main` is protected: PRs only, squash merge only, linear history, CI must pass and the branch must be up to date. Auto-merge is enabled.
