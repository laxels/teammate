# Ultraclaude architecture

A Slack-addressable "virtual teammate". The orchestrator (Claude Opus 4.8,
effort `xhigh`, no model fallback) receives DMs/mentions, manages tasks, and
delegates each task to a Claude Code instance running in a macOS devbox VM.

## Components

| Component | Dir | Runs on | Role |
|---|---|---|---|
| Orchestrator | `convex/` | Convex (project `teammate`, deployment `zealous-robin-941`) | Slack events in/out, task + devbox state, Opus 4.8 tool loop, staleness cron |
| Devbox gateway | `gateway/` | Inside each devbox VM (Bun) | Runs Claude Code via the Agent SDK with in-process computer-use MCP tools (`gateway/src/computer/`: screenshots, mouse, keyboard over `screencapture`/`cliclick`/`osascript`) and Playwright browser MCP tools (`gateway/src/browser/`: aria snapshots + ref-targeted actions in a gateway-owned headed Chrome — see "Browser automation" below), exposes steering WebSocket + VNC bridge, posts lifecycle events to Convex, serves the monitoring page |
| Monitoring page | `web/` | Served by the gateway, tailnet-only | react-vnc remote desktop + steering sidebar + Stop Claude button |
| Fleet dashboard | `dashboard/` | Fleet host (LaunchAgent `com.ultraclaude.dashboard` + Tailscale Serve), tailnet-only | Live board of in-flight tasks + history, stop/follow-up/retry controls, fleet status; talks straight to Convex (`convex/dashboard.ts`, gated by `DASHBOARD_SECRET` from a host-side `config.json`). Deploy: `scripts/deploy-dashboard.sh` → `https://ultraclaude-host-1.<tailnet>/` |
| Host agent | `hostagent/` | Each fleet Mac host (LaunchAgent `com.ultraclaude.hostagent`, Bun) | Heartbeats the host to Convex every 60s (self-registers its row + liveness) and consumes `provision_vm`/`destroy_vm` host commands to clone/boot/rsync-code-into/destroy ephemeral Tart VMs (`hostagent/src/vm.ts`). Advertises the fleet-provisioner role (`FLEET_PROVISIONER=1`) in its heartbeat, but no longer bootstraps new hosts itself — GitHub Actions does (#87) |
| Shared contracts | `shared/` | imported by `convex`, `gateway`, `hostagent`, `src`, `web` | Wire types (`shared/protocol.ts`) |

## Infrastructure

- Hosts: a fleet of Scaleway Apple-silicon (M2-L) Macs in `fr-par-1`
  (`ultraclaude-host-1`, `-2`, …), each joined to the tailnet under its host
  name and running Tart VMs (max 2 concurrent macOS VMs per host, per Apple
  EULA). The orchestrator spreads ephemeral devbox VMs across the pool —
  least-loaded host wins (`src/hostPool.ts` `pickHost`). See "Fleet scaling".
- Golden image: `golden-v4` (local tart VM + private `ghcr.io/laxels/ultraclaude-golden:v4`) —
  macOS Sequoia with Chrome (logged in, default browser, Claude-in-Chrome
  extension removed), Claude desktop (logged in), Claude Code run at
  `claude-opus-4-8`/`xhigh` (set by the gateway via the Agent SDK `model`
  option, which is authoritative over the baked `~/.claude/settings.json` pin;
  v4 also bakes that pin as `claude-opus-4-8` — v3 still read `claude-fable-5`;
  settings.json also carries `autoCompactWindow`, BASH timeout env,
  `cleanupPeriodDays`), `switchModelsOnFlag: false`, subscription OAuth token at
  `~/claude-oauth-token.txt`. Browser-tool deps (`playwright-core`, PR #23) are
  baked into node_modules as of v4, so ephemerals no longer install it at
  provision time. Computer-use prerequisites baked in: `cliclick`
  at /usr/local/bin, TCC grants seeded via `scripts/seed-devbox-tcc.sh`
  (SIP is disabled in the guest; grants persist across clones), 1920x1080
  display (1:1 points==pixels), `en-US` locale, never-sleep/no-screen-lock,
  notifications under an always-on DND schedule, automatic macOS updates off,
  keyboard autocorrect/smart-quotes off.
- Provisioning clones `golden-v4` and overlays the repo's current gateway/web
  code on top (the image carries the slow-to-build environment + baked
  node_modules; code goes stale with every merge). The image is rebuilt with
  `scripts/bake-golden.sh` (version-parameterized: `--from`/`--to`).
- Each devbox VM joins the tailnet with its own identity at provision time:
  tailscaled's on-disk state (`/Library/Tailscale`, machine key included) is
  wiped — at bake time AND again per-clone before `tailscale up` — because a
  merely logged-out image still bakes a machine key that every clone would
  share, collapsing the whole fleet onto one tailnet node.
- The monitoring page is fronted by Tailscale Serve (HTTPS on 443 → gateway
  port 8787): noVNC needs a secure context (`crypto.subtle`).
- Devbox VM networking is host-NAT (192.168.64.x); nothing on the host proxies
  VM traffic in production — the gateway binds inside the VM and is reached
  over the VM's own tailnet address. (macOS Local Network TCC silently blocks
  non-Apple-signed host processes from reaching VM IPs.)

## Fleet scaling

- The fleet grows by provisioning whole new Mac hosts (not more VMs per host —
  the Apple EULA caps that at 2). As of #87/#90 provisioning is decoupled from
  the task hot path and runs in GitHub Actions
  (`.github/workflows/provision-host.yml`): an ephemeral Linux runner creates
  the Scaleway Mac over the API and bootstraps it over ssh
  (`scripts/provision-host.sh` → `adopt-host.sh` → `smoke-host.sh`). A new host
  counts as ready only once it heartbeats `active` AND passes a
  clone/boot/destroy smoke test.
- Every fleet-mutating op takes ONE global, Convex-backed lease lock
  (`scripts/fleet-lock.sh`, `convex/fleetLock.ts`), so only one fleet op runs at
  a time across all origins (a laptop, a GH Actions run, the future monitor); a
  single run can still provision several hosts in parallel under the one lock it
  holds.
- Convex keeps the scaling decision + serialization machinery
  (`convex/hosts.ts` `requestHostProvision`, `src/hostPool.ts`): it pre-creates
  a `provisioning` host row, allows one bootstrap in flight, and a new host's
  first heartbeat flips that row to `active` and drains any queued tasks.
- On-demand autoscale on task spillover is currently gated off (#87): a task
  with no free VM slot stays `queued` and drains when a slot frees
  (`placeQueuedEphemeralTasks`). Proactive capacity growth is the planned #88
  monitor, which calls `requestHostProvision` and fires the GitHub Actions
  provisioner via `repository_dispatch`.

## Task flow

1. Slack event → Convex HTTP action `/slack/events` (signature-verified,
   deduped into `slackEvents`).
2. Orchestrator action (Opus 4.8 `xhigh` + tools) decides: answer directly, or
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

## Browser automation

- Devbox sessions get two complementary browser paths: Playwright `browser_*`
  MCP tools (`gateway/src/browser/`) for everything inside a web page, and the
  pixel computer-use tools for native dialogs, browser UI outside the page,
  and sites that defeat DOM automation.
- The gateway owns one Chrome instance for its lifetime, launched lazily by
  `playwright-core` over a stdio pipe (`launchPersistentContext`) — NOT
  attached over CDP: playwright's bundled WebSocket client never completes its
  HTTP upgrade under Bun, while the pipe transport works. A CDP port would
  also require a non-default profile since Chrome 136 ignores
  `--remote-debugging-port` on the default user-data-dir.
- The window is headed on the devbox desktop (visible over VNC, reachable by
  the pixel tools) and uses a persistent profile at
  `~/.ultraclaude/chrome-profile`, so logins performed in it survive across
  tasks and gateway restarts. This is a separate instance from the golden
  image's default-profile Chrome; sites needing auth must be logged in once in
  the automation profile.
- Tools snapshot the page as an accessibility tree (`ariaSnapshot(mode:"ai")`)
  and target elements by `[ref=eN]`; every action returns a fresh snapshot,
  and `browser_batch` chains several actions in one round trip. No screenshots
  needed for most steps — faster and far less error-prone than pixel clicks.
- Crash recovery: on shutdown the gateway closes Chrome (3s cap); after a hard
  kill, the next launch evicts an orphaned Chrome holding the profile's
  ProcessSingleton lock and retries. If Chrome quits out from under the
  gateway (VNC user, crash), the next tool call relaunches it.

## Conventions

- **UI branding invariant**: every Ultraclaude UI surface (fleet dashboard,
  monitoring page, anything future) matches Anthropic's styling/theme/branding
  as closely as possible without claiming to be official — warm ivory paper,
  terracotta accent, serif display type (canonical tokens in
  dashboard/src/styles.css and web/src/styles.css). Never introduce a
  divergent theme.

- Secrets: local `.env` (never committed); Convex env vars for the deployment;
  `DEVBOX_SHARED_SECRET` authenticates gateway→Convex posts.
- Model policy: `claude-opus-4-8` + effort `xhigh` everywhere; never configure
  `--fallback-model`; API calls send no `fallbacks` parameter; flagged
  requests refuse rather than downgrade.
