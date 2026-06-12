# ultraclaude architecture

A Slack-addressable "virtual teammate". The orchestrator (Claude Fable 5,
effort `xhigh`, no model fallback) receives DMs/mentions, manages tasks, and
delegates each task to a Claude Code instance running in a macOS devbox VM.

## Components

| Component | Dir | Runs on | Role |
|---|---|---|---|
| Orchestrator | `convex/` | Convex (deployment `teammate`) | Slack events in/out, task + devbox state, Fable 5 tool loop, staleness cron |
| Devbox gateway | `gateway/` | Inside each devbox VM (Bun) | Runs Claude Code via the Agent SDK with in-process computer-use MCP tools (`gateway/src/computer/`: screenshots, mouse, keyboard over `screencapture`/`cliclick`/`osascript`), exposes steering WebSocket + VNC bridge, posts lifecycle events to Convex, serves the monitoring page |
| Monitoring page | `web/` | Served by the gateway, tailnet-only | react-vnc remote desktop + steering sidebar + Stop Claude button |
| Fleet dashboard | `dashboard/` | Fleet host (LaunchAgent `com.ultraclaude.dashboard` + Tailscale Serve), tailnet-only | Live board of in-flight tasks + history, stop/follow-up/retry controls, fleet status; talks straight to Convex (`convex/dashboard.ts`, gated by `DASHBOARD_SECRET` from a host-side `config.json`). Deploy: `scripts/deploy-dashboard.sh` → `https://ultraclaude-host-1.<tailnet>/` |
| Shared contracts | `shared/` | imported by all three | Wire types (`shared/protocol.ts`) |

## Infrastructure

- Host: Scaleway Mac mini M2-L (`ultraclaude-host-1`, tailnet 100.121.13.107),
  running Tart VMs (max 2 concurrent macOS VMs per Apple EULA).
- Golden image: `golden-v3` (local tart VM + private `ghcr.io/laxels/ultraclaude-golden:v3`) —
  macOS Sequoia with Chrome (logged in, default browser, Claude-in-Chrome
  extension removed), Claude desktop (logged in), Claude Code pinned to
  `claude-fable-5` at `xhigh` (`~/.claude/settings.json`, which also carries
  `autoCompactWindow`, BASH timeout env, `cleanupPeriodDays`),
  `switchModelsOnFlag: false`, subscription OAuth token at
  `~/claude-oauth-token.txt`. Computer-use prerequisites baked in: `cliclick`
  at /usr/local/bin, TCC grants seeded via `scripts/seed-devbox-tcc.sh`
  (SIP is disabled in the guest; grants persist across clones), 1920x1080
  display (1:1 points==pixels), `en-US` locale, never-sleep/no-screen-lock,
  notifications under an always-on DND schedule, automatic macOS updates off,
  keyboard autocorrect/smart-quotes off.
- Provisioning (`scripts/provision-devbox.sh`) clones `golden-v2`: golden-v1
  plus the gateway and its LaunchAgent baked in.
- Each devbox VM joins the tailnet with its own identity at provision time
  (tailscale is installed in the image but deliberately logged out).
- The monitoring page is fronted by Tailscale Serve (HTTPS on 443 → gateway
  port 8787): noVNC needs a secure context (`crypto.subtle`).
- Devbox VM networking is host-NAT (192.168.64.x); nothing on the host proxies
  VM traffic in production — the gateway binds inside the VM and is reached
  over the VM's own tailnet address. (macOS Local Network TCC silently blocks
  non-Apple-signed host processes from reaching VM IPs.)

## Task flow

1. Slack event → Convex HTTP action `/slack/events` (signature-verified,
   deduped into `slackEvents`).
2. Orchestrator action (Fable 5 `xhigh` + tools) decides: answer directly, or
   start/steer/stop a task on a devbox. Every reply is threaded under the
   triggering message — one task = one Slack thread, anchored at the request.
3. Task start: the orchestrator enqueues a command row in Convex (it cannot
   reach the tailnet); the gateway's outbound subscription picks it up within
   seconds, runs an Agent SDK session (streaming input mode), and posts
   `DevboxEvent`s back to Convex `/devbox/events`. Gateways heartbeat every
   60s; `claimWarm` only assigns devboxes seen in the last 2 minutes.
4. Orchestrator turns events into Slack updates posted to the task's thread,
   with the monitoring link `https://<devbox-tailnet-host>/` (Tailscale
   Serve).
5. Each task gets a **status card**: the bot's first lifecycle message in the
   thread, chat.update'd in place on every event (status, latest summary,
   duration, monitoring link). Detail events that deserve a notification ping
   (needs_input/terminal) still arrive as fresh thread replies; progress only
   refreshes the card. Status reactions (👀/✅/❌/🛑) land on the request
   message. Legacy threadless tasks adopt their card as the thread anchor.
6. Replies in a task's thread reach the orchestrator with that task injected
   as context: `steer_task` relays guidance into the live session via a
   `user_message` command (gateway `POST /message`, taskId-guarded so stale
   commands never reach a later task's session); `stop_task` interrupts,
   refusing terminal tasks and devboxes that moved on to other work.
7. Un-mentioned replies inside a channel task-thread also reach the
   orchestrator (message.channels/message.groups subscriptions); replies in
   threads that aren't ours are dropped pre-LLM, and the model answers
   NO_REPLY to bystander chatter. The gateway emits `needs_input` when the
   session calls AskUserQuestion, and uploads the session transcript to
   Convex (`/devbox/transcript`, `transcripts` table) at terminal status so
   the record outlives the VM (browsable from the dashboard).
8. Monitoring page: full remote desktop (`/ws/vnc` → VM Screen Sharing) plus
   steering sidebar (`/ws/steer` → Agent SDK streaming input / `interrupt()`)
   — the same `pushUserMessage` primitive Slack thread replies use, so steers
   from either surface appear in the page's transcript.
9. A Convex cron flags tasks with no events for >30 min and the orchestrator
   checks on them proactively.

## Conventions

- **UI branding invariant**: every ultraclaude UI surface (fleet dashboard,
  monitoring page, anything future) matches Anthropic's styling/theme/branding
  as closely as possible without claiming to be official — warm ivory paper,
  terracotta accent, serif display type (canonical tokens in
  dashboard/src/styles.css and web/src/styles.css). Never introduce a
  divergent theme.

- Secrets: local `.env` (never committed); Convex env vars for the deployment;
  `DEVBOX_SHARED_SECRET` authenticates gateway→Convex posts.
- Model policy: `claude-fable-5` + effort `xhigh` everywhere; never configure
  `--fallback-model`; API calls send no `fallbacks` parameter; flagged
  requests refuse rather than downgrade.
