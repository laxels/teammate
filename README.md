# teammate

TypeScript + [Bun](https://bun.sh) + [Convex](https://convex.dev) starter.

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
