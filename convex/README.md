# Orchestrator (Convex)

Slack-driven orchestrator: ingests Slack events, runs a Claude Fable 5 tool
loop (`orchestrator.ts`), manages tasks/devboxes, relays devbox lifecycle
events back to Slack, and proactively checks on stale tasks (`crons.ts`).

## Environment variables (Convex deployment)

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SLACK_SIGNING_SECRET` | `http.ts` | Verifies `/slack/events` request signatures |
| `SLACK_BOT_TOKEN` | `orchestrator.ts`, `notify.ts`, `staleness.ts` | `chat.postMessage` replies and status updates |
| `ANTHROPIC_API_KEY` | `orchestrator.ts` | Fable 5 tool loop (`claude-fable-5`, effort `xhigh`, no fallbacks) |
| `DEVBOX_SHARED_SECRET` | `http.ts` | Authenticates gateway posts to `/devbox/events` (`x-devbox-secret` header) |

Set via `npx convex env set NAME value` (or the dashboard). Nothing reads a
local `.env` at runtime.

## HTTP endpoints (convex.site)

- `POST /slack/events` — Slack Events API (url_verification + event_callback,
  deduped into `slackEvents`, processed async by `orchestrator.processSlackEvent`).
- `POST /devbox/events` — gateway lifecycle events (`DevboxEvent` from
  `shared/protocol.ts`). 401 unless `x-devbox-secret` matches.

## Devbox registration (v1, manual)

After provisioning a devbox VM:

```sh
npx convex run devboxes:registerDevbox \
  '{"devboxId": "devbox-1", "gatewayUrl": "http://<tailnet-host>:8787"}'
```

Re-running upserts and resets the devbox to `warm`.

## Flow

1. Slack message → `/slack/events` → `slackEvents` row → scheduled
   `orchestrator.processSlackEvent`.
2. The orchestrator filters bot/self messages (`src/orchestration.ts`), then
   runs the Fable 5 loop with tools `list_tasks` / `get_task` / `start_task` /
   `steer_task` / `stop_task`. Every reply is threaded under the triggering
   message (one request = one thread); a reply inside a task's thread gets
   that task injected as `<thread_context>` (looked up via the tasks
   `by_channel_thread` index), so thread replies steer, query, or stop their
   task without naming it.
3. `start_task` claims a warm devbox, enqueues a command in the `commands`
   table (gateways subscribe outbound — Convex cannot reach the tailnet), and
   inserts a `tasks` row anchored to the thread; the gateway then posts
   `DevboxEvent`s to `/devbox/events`, which update task/devbox state and
   notify the task's Slack thread (with the monitoring link
   `https://<devbox-host>/`). `steer_task` enqueues a `user_message` command
   that the gateway delivers to the live session (`POST /message`, taskId
   guarded so a stale command never reaches a later task's session).
4. Every 15 min, `crons.ts` → `staleness.checkStaleTasks`: active (queued or
   running) tasks with no event for 30+ min get a one-line check-in (devbox
   heartbeat freshness + monitoring link), at most once per 30 min per task
   (`lastNudgedAt`).

Pure logic (event filtering, thread targeting, monitoring-URL derivation,
staleness predicate, DevboxEvent validation) lives in `src/orchestration.ts`
and is covered by `bun test`.
