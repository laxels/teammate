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
| `DEVBOX_SHARED_SECRET` | `http.ts`, `commands.ts`, `hosts.ts`, `fleetLock.ts` | Shared secret for all gateway/host/provisioner traffic — sent as the `x-devbox-secret` header on the `/devbox/*` and `/fleet/*` HTTP endpoints (`http.ts`), and as a `secret` argument on the Convex functions gateways/host agents call directly (`commands.ts`, `hosts.ts`; they're Convex clients, so there are no request headers) |
| `DASHBOARD_SECRET` | `dashboard.ts` | Gates the public dashboard query/mutation functions |
| `TAILNET_SUFFIX` | `hosts.ts` | Derives an ephemeral devbox's gateway URL; required once a host is available (otherwise placement throws) |

Set via `npx convex env set NAME value` (or the dashboard). Nothing reads a
local `.env` at runtime.

## HTTP endpoints (convex.site)

Every `/devbox/*` and `/fleet/*` endpoint is authenticated by the shared secret
(401 unless `x-devbox-secret` matches `DEVBOX_SHARED_SECRET`); `/slack/events` is
verified by the Slack signature instead.

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
- `POST /fleet/lock/{acquire,renew,release}` — the authoritative cross-origin
  fleet lock (`fleetLock.ts`), so a Linux GitHub Actions runner / laptop can
  serialize fleet provisioning with just curl + the secret (no Convex client).
- `GET /fleet/status` — fleet snapshot (`hosts.fleetSnapshot`) for the
  provisioner's smoke test ("is this host active + recently seen?").
- `POST /fleet/event` — fleet lifecycle event (`{ hostId, type, summary }`) from
  the GH Actions provisioner / a laptop run into `hostEvents` (get_fleet shows
  them); a `provision_failed` event also drops a stale pre-created `provisioning`
  row.

## Devbox placement

Every task runs on a **fresh ephemeral devbox VM** — there is nothing
to register. When a task starts, `hosts.allocateEphemeral` provisions a VM on an
available Mac host (`provisioning` → `busy` → `retiring` → row deleted by
`hosts.removeDevbox`) and derives its gateway URL from `TAILNET_SUFFIX`.
A devbox is never reused — no task runs on a previous task's
VM. When all host VM slots are full, the task simply **queues** and drains the
moment a slot frees (`hosts.placeQueuedEphemeralTasks`, scheduled on every
`removeDevbox` and host `heartbeat`).

The fleet is a **standing warm set**: on-demand autoscale on task spillover is
gated off (#87), so an unplaceable task never blocks on a ~30–45 min bootstrap.
New Mac hosts are provisioned out-of-band by the GitHub Actions provisioner
([provision-host.yml](../.github/workflows/provision-host.yml)), serialized by
the Convex fleet lock (`fleetLock.ts`). The Convex decision/serialization
machinery (`hosts.requestHostProvision`, `inflightProvision`, `pickProvisioner`)
is kept for the proactive capacity monitor in #88, which will grow the fleet
ahead of demand and fire the provisioner via `repository_dispatch`.

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
3. `start_task` places the task on a fresh ephemeral VM
   (`hosts.placeEphemeralTask`), enqueues a command in the
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
