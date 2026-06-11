# ultraclaude architecture

A Slack-addressable "virtual teammate". The orchestrator (Claude Fable 5,
effort `xhigh`, no model fallback) receives DMs/mentions, manages tasks, and
delegates each task to a Claude Code instance running in a macOS devbox VM.

## Components

| Component | Dir | Runs on | Role |
|---|---|---|---|
| Orchestrator | `convex/` | Convex (deployment `teammate`) | Slack events in/out, task + devbox state, Fable 5 tool loop, staleness cron |
| Devbox gateway | `gateway/` | Inside each devbox VM (Bun) | Runs Claude Code via the Agent SDK, exposes steering WebSocket + VNC bridge, posts lifecycle events to Convex, serves the monitoring page |
| Monitoring page | `web/` | Served by the gateway, tailnet-only | react-vnc remote desktop + Claude-in-Chrome-style steering sidebar + Stop Claude button |
| Shared contracts | `shared/` | imported by all three | Wire types (`shared/protocol.ts`) |

## Infrastructure

- Host: Scaleway Mac mini M2-L (`ultraclaude-host-1`, tailnet 100.121.13.107),
  running Tart VMs (max 2 concurrent macOS VMs per Apple EULA).
- Golden image: `golden-v1` (local tart VM + private `ghcr.io/laxels/ultraclaude-golden:v1`) —
  macOS Sequoia with Chrome + Claude in Chrome (logged in), Claude desktop
  (logged in), Claude Code ≥2.1.172 pinned to `claude-fable-5` at `xhigh`
  (`~/.claude/settings.json`), `switchModelsOnFlag: false`, subscription OAuth
  token at `~/claude-oauth-token.txt`.
- Each devbox VM joins the tailnet with its own identity at provision time
  (tailscale is installed in the image but deliberately logged out).
- Devbox VM networking is host-NAT (192.168.64.x); nothing on the host proxies
  VM traffic in production — the gateway binds inside the VM and is reached
  over the VM's own tailnet address. (macOS Local Network TCC silently blocks
  non-Apple-signed host processes from reaching VM IPs.)

## Task flow

1. Slack event → Convex HTTP action `/slack/events` (signature-verified,
   deduped into `slackEvents`).
2. Orchestrator action (Fable 5 `xhigh` + tools) decides: answer directly, or
   start/steer/stop a task on a devbox.
3. Task start: the orchestrator enqueues a command row in Convex (it cannot
   reach the tailnet); the gateway's outbound subscription picks it up within
   seconds, runs an Agent SDK session (streaming input mode), and posts
   `DevboxEvent`s back to Convex `/devbox/events`. Gateways heartbeat every
   60s; `claimWarm` only assigns devboxes seen in the last 2 minutes.
4. Orchestrator turns events into Slack updates (thread-aware) and posts the
   monitoring link `http://<devbox-tailnet-host>:8787/`.
5. Monitoring page: full remote desktop (`/ws/vnc` → VM Screen Sharing) plus
   steering sidebar (`/ws/steer` → Agent SDK streaming input / `interrupt()`).
6. A Convex cron flags tasks with no events for >30 min and the orchestrator
   checks on them proactively.

## Conventions

- Secrets: local `.env` (never committed); Convex env vars for the deployment;
  `DEVBOX_SHARED_SECRET` authenticates gateway→Convex posts.
- Model policy: `claude-fable-5` + effort `xhigh` everywhere; never configure
  `--fallback-model`; API calls send no `fallbacks` parameter; flagged
  requests refuse rather than downgrade.
