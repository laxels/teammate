# teammate

![CI](https://github.com/laxels/teammate/actions/workflows/ci.yml/badge.svg)

Ultraclaude: a Slack-addressable "virtual teammate". A [Convex](https://convex.dev)-hosted
orchestrator receives Slack DMs/mentions and delegates engineering work to Claude Code
instances running in macOS devbox VMs, each with a full desktop that tasks can drive
directly via built-in computer-use tools (screenshots, mouse, keyboard). Every
task gets a tailnet-only monitoring page with a live remote desktop and a steering sidebar.
See [ARCHITECTURE.md](ARCHITECTURE.md) for components, infrastructure, and task flow.

## Setup

```sh
cp .env.example .env   # then fill in real values (see comments in the file)
bun install
bun run dev   # starts Convex dev deployment (prompts for login on first run)
```

`.env` and `.env.local` are gitignored and must never be committed. CI runs
[gitleaks](https://github.com/gitleaks/gitleaks) over the full git history on
every push and PR to catch any secret that slips through.

## Checks

```sh
bun run validate   # typecheck + lint + test, run concurrently with grouped output
```

Individual checks: `bun run typecheck`, `bun run lint` (`lint:fix` to autofix), `bun test`.

## Backlog

The backlog is GitHub issues, prioritized in the
[Teammate Backlog project](https://github.com/users/laxels/projects/1):
a single-select Priority field (P0/P1/P2) plus the project's manual rank
order within a tier. Priority lives only there — no priority labels.

```sh
scripts/backlog.sh list       # open issues in priority order; flags issues missing from the project
scripts/backlog.sh set 42 P1  # set priority, adding the issue to the project if needed
```

GitHub has no API to configure the project's auto-add workflow, so adding
issues to the project is `backlog.sh set`'s job (or the project UI).
`backlog.sh list` shows any open issue that slipped through as `UNTRACKED`.

## Worktrees and the singleton lane

Parallel sessions each get their own git worktree. Worktree creation runs
`bun run worktree-setup` ([scripts/worktree-setup.sh](scripts/worktree-setup.sh)),
which copies `.env`/`.env.local` from the primary checkout and runs
`bun install --frozen-lockfile`, so a fresh worktree passes `bun run validate`
immediately. Validation is safe to run concurrently in any number of worktrees
(tests bind ephemeral ports and read no env).

Operations that touch shared live systems are the **singleton lane**. They are
serialized by one of two locks, and the rule for which is: **a lock must live
where it can see every initiator.**

**Local lock** — [scripts/singleton-lock.sh](scripts/singleton-lock.sh), a
`.git`-dir filesystem lock shared across a checkout and its worktrees; refuses
to run from a worktree (only the primary checkout's code should reach live
systems; override with `ULTRACLAUDE_SINGLETON_FROM_WORKTREE=1`). Use it when
every initiator is a local checkout:

- `convex` lock: `bun run dev` (continuous push to the live Convex deployment)
  and `bun run deploy:convex` (one-shot deploy — prefer this over raw
  `bunx convex dev --once`).
- `fleet` lock: `scripts/deploy-payload.sh`, `scripts/bake-golden.sh`
  (golden-image bake — version-parameterized `--from`/`--to`; a bake produces an
  immutable `golden:vN`, it does **not** mutate the live fleet). The lock no-ops
  on fleet hosts themselves, where the payload has no git checkout.

**Convex fleet lock** — [scripts/fleet-lock.sh](scripts/fleet-lock.sh), an
authoritative lease in Convex state. Use it for live-fleet mutation: **provisioning**
(`scripts/provision-host.sh`, `scripts/adopt-host.sh`) and the **golden-refresh**
(`scripts/refresh-golden.sh`, [refresh-golden.yml](.github/workflows/refresh-golden.yml),
#89 — rolls a new `golden:vN` across the standing warm fleet). Both are
**multi-origin** — a laptop, a GitHub Actions runner
([provision-host.yml](.github/workflows/provision-host.yml)), or the future
capacity monitor (#88) can all mutate live host state Convex reads immediately, so
only authoritative Convex state can serialize them. It is one **global** lock: one
fleet op at a time across all origins (a roll and a provision can't race);
parallelism (the GH Actions matrix provisioning several hosts, or all-at-once
refreshing several) happens *within* a single held op. As a lease it auto-reclaims
if a holder dies mid-op (the distributed analogue of the local lock's dead-owner
steal). New Mac hosts are provisioned by the GitHub Actions workflow, not on a
task-running host.

Merge hygiene across worktrees: never hand-merge `bun.lock` (take both sides'
package.json, then re-run `bun install`) or `convex/_generated/` (re-run
`bunx convex codegen` — it is offline and touches no deployment).

## Conventions

- Strict TypeScript everywhere (`strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.).
- Biome for linting and formatting.
- Dependency versions are pinned exactly (`bunfig.toml` sets `install.exact`); the Bun version is pinned in `.bun-version`.
- `main` is protected: PRs only, squash merge only, linear history, CI must pass and the branch must be up to date. Auto-merge is enabled.
