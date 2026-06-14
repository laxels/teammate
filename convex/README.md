# Orchestrator (Convex)

Slack-driven orchestrator: ingests Slack events, runs a Claude Opus 4.8 tool
loop (`orchestrator.ts`), manages tasks/devboxes, relays devbox lifecycle
events back to Slack, and proactively checks on stale tasks (`crons.ts`).

## Environment variables (Convex deployment)

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | `http.ts` | Verifies `/slack/events` request signatures |
| `SLACK_BOT_TOKEN` | `orchestrator.ts`, `notify.ts`, `staleness.ts`, `artifacts.ts` | `chat.postMessage` replies, status updates, and outbound file uploads |
| `ANTHROPIC_API_KEY` | `orchestrator.ts` | Opus 4.8 tool loop (`claude-opus-4-8`, effort `xhigh`, no fallbacks) |
| `DEVBOX_SHARED_SECRET` | `http.ts`, `commands.ts`, `hosts.ts` | Authenticates gateway/host posts to the `/devbox/*` endpoints (`x-devbox-secret` header) |
| `DASHBOARD_SECRET` | `dashboard.ts` | Gates the public dashboard query/mutation functions |
| `TAILNET_SUFFIX` | `hosts.ts` | Derives an ephemeral devbox's gateway URL; required once a host is available (otherwise placement throws) |

Set via `npx convex env set NAME value` (or the dashboard). Nothing reads a
local `.env` at runtime.

## HTTP endpoints (convex.site)

Every `/devbox/*` endpoint is authenticated by the shared secret (401 unless
`x-devbox-secret` matches `DEVBOX_SHARED_SECRET`); `/slack/events` is verified by
the Slack signature instead.

- `POST /slack/events` — Slack Events API (url_verification + event_callback,
  deduped into `slackEvents`, processed async by `orchestrator.processSlackEvent`).
- `POST /devbox/events` — gateway lifecycle events (`DevboxEvent` from
  `shared/protocol.ts`) that update task/devbox state.
- `POST /devbox/transcript` — final session transcript (one JSON payload per
  task at terminal status), stored so the record outlives the ephemeral VM.
- `POST /devbox/artifact` — a devbox `share_file` upload (multipart); staged in
  storage, posted into the task's Slack thread, then the blob is deleted.
- `GET /devbox/file` — serves a staged inbound Slack attachment to the gateway by
  `storageId` (secret-gated instead of a public storage URL).

## Devbox placement

By default every task runs on a **fresh ephemeral devbox VM** — there is nothing
to register. When a task starts, `hosts.allocateEphemeral` provisions a VM on an
available Mac host (`provisioning` → `busy` → `retiring` → row deleted by
`hosts.removeDevbox`) and derives its gateway URL from `TAILNET_SUFFIX`.
Ephemeral devboxes never enter the warm pool — no task reuses a previous task's
VM. When all host VM slots are full, the task queues and the fleet bootstraps a
new Mac host automatically.

The permanent devbox `devbox-1` is the one exception: it is registered manually
and cycles `warm` ↔ `busy` so it can carry state across tasks (used only when a
task opts in with `use_permanent_devbox`). Register or re-point it with:

```sh
npx convex run devboxes:registerDevbox \
  '{"devboxId": "devbox-1", "gatewayUrl": "http://<tailnet-host>:8787"}'
```

`registerDevbox` is an `internalMutation`, which `convex run` invokes fine.
Re-running upserts by `devboxId` and resets it to `warm`. Pass an optional
`hostId` when the devbox occupies a managed host's VM slots, so capacity
accounting doesn't oversubscribe it (Apple's EULA caps a host at 2 concurrent
VMs).

## Flow

1. Slack message → `/slack/events` → `slackEvents` row → scheduled
   `orchestrator.processSlackEvent`.
2. The orchestrator filters bot/self messages (`src/orchestration.ts`), then
   runs the Opus 4.8 loop with tools `list_tasks` / `get_task` / `start_task` /
   `steer_task` / `stop_task`. Every reply is threaded under the triggering
   message (one request = one thread); a reply inside a task's thread gets
   that task injected as `<thread_context>` (looked up via the tasks
   `by_channel_thread` index), so thread replies steer, query, or stop their
   task without naming it.
3. `start_task` places the task on a devbox — by default it allocates a fresh
   ephemeral VM (`hosts.placeEphemeralTask`), or claims the warm permanent
   devbox when `use_permanent_devbox` is set — enqueues a command in the
   `commands` table (gateways subscribe outbound — Convex cannot reach the
   tailnet), and inserts a `tasks` row anchored to the thread; the gateway then posts
   `DevboxEvent`s to `/devbox/events`, which update task/devbox state and
   notify the task's Slack thread (with the monitoring link
   `https://<devbox-host>/`). `steer_task` enqueues a `user_message` command
   that the gateway delivers to the live session (`POST /message`, taskId
   guarded so a stale command never reaches a later task's session).
4. Every 15 min, `crons.ts` → `staleness.checkStaleTasks`: active (queued or
   running) tasks with no event for 30+ min get a one-line check-in (devbox
   heartbeat freshness + monitoring link), at most once per 30 min per task
   (`lastNudgedAt`).
5. Delivery resilience: events are claimed (marked processed) atomically
   BEFORE the tool loop, so processing is at-most-once and a crashed run can
   never double-start tasks; events stranded before the claim are replayed by
   the `slack.retryUnprocessed` cron (every 5 min, 2 min – 24 h old). Slack
   posts retry transient failures (429/5xx/transport) inside
   `postSlackMessage`, so rate-limited status updates aren't dropped.

Pure logic (event filtering, thread targeting, monitoring-URL derivation,
staleness predicate, DevboxEvent validation) lives in `src/orchestration.ts`
and is covered by `bun test`.
