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

## Conventions

- Strict TypeScript everywhere (`strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.).
- Biome for linting and formatting.
- Dependency versions are pinned exactly (`bunfig.toml` sets `install.exact`); the Bun version is pinned in `.bun-version`.
- `main` is protected: PRs only, squash merge only, linear history, CI must pass and the branch must be up to date. Auto-merge is enabled.
