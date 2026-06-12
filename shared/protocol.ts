// Wire contracts between the three ultraclaude components:
// monitoring page (web/) <-> devbox gateway (gateway/) <-> orchestrator (convex/).
//
// The gateway runs INSIDE each devbox VM and is reachable only over the
// tailnet. The monitoring page is served statically by the gateway, so all
// page connections are same-origin.

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

// ---- Monitoring page <-> gateway: WebSocket at /ws/steer ----

export type SteerClientMessage =
  | { type: "user_message"; text: string }
  | { type: "interrupt" }
  // No UI sender yet (planned sidebar control); the gateway already handles it.
  | { type: "set_permission_mode"; mode: PermissionMode };

export type SteerServerMessage =
  // Raw SDKMessage from @anthropic-ai/claude-agent-sdk, forwarded verbatim.
  | { type: "sdk_message"; message: unknown }
  | { type: "status"; running: boolean; taskId: string | null }
  // Sent once on connect: in-memory transcript so late joiners catch up.
  | { type: "history"; messages: unknown[] }
  | { type: "error"; message: string };

// ---- Monitoring page <-> gateway: WebSocket at /ws/vnc ----
// Binary RFB bridge to the VM's own Screen Sharing server (127.0.0.1:5900),
// consumed by noVNC/react-vnc. No JSON framing — raw bytes both ways.

// ---- Control plane: orchestrator -> gateway ----
// Convex cloud cannot reach tailnet addresses, so the orchestrator never
// dials a gateway. It enqueues rows in the Convex `commands` table
// (kind "start" with a StartTaskRequest payload, "user_message" with a
// UserMessagePayload, or "interrupt"); the gateway subscribes via an outbound
// Convex client connection, executes against its own local HTTP surface, and
// acks.
//
// ---- Gateway HTTP surface (tailnet/local only) ----
// POST /task       StartTaskRequest   -> 202, or 409 if a task is running
// POST /message    UserMessagePayload -> 200, or 409 if no live session for
//                  that taskId (steering a finished/evicted session is a
//                  no-op, never a crosstalk risk)
// POST /interrupt  {}                 -> 200
// GET  /health     -> GatewayHealth
// All POSTs require the x-devbox-secret header (Tailscale Serve exposes the
// whole port to the tailnet); missing/wrong secret -> 401.
export type StartTaskRequest = {
  taskId: string;
  prompt: string;
  cwd?: string;
};

/** A Slack-relayed steering message for a running task's live session (same
 * effect as typing into the monitoring page's steering box). taskId guards
 * against a stale command reaching a devbox that moved on to another task. */
export type UserMessagePayload = {
  taskId: string;
  text: string;
};

/** Payload for "interrupt". With taskId, the gateway only stops the session
 * if it still belongs to that task (a stale stop must never kill a later
 * occupant). Without it ("{}"), the interrupt is unconditional — the local
 * eviction path uses that form. */
export type InterruptPayload = {
  taskId?: string;
};

export type GatewayHealth = {
  devboxId: string;
  running: boolean;
  taskId: string | null;
};

// ---- Host-level control plane: orchestrator -> host agent ----
// Each Mac host runs a host agent (same outbound-subscription pattern as the
// gateway, against the `hostCommands` table) that manages VM lifecycle.
// Apple's EULA caps each host at 2 concurrent macOS VMs; concurrency scales
// by adding hosts (scripts/provision-host.sh).
//
// VM lifecycle for ephemeral devboxes: the orchestrator pre-creates the
// devbox row (status "provisioning", deterministic gatewayUrl from the
// devbox id + tailnet suffix) and enqueues the task's start command BEFORE
// the VM exists — the freshly booted gateway picks it up on first
// subscription. After the task reaches a terminal status the devbox goes to
// "retiring" (never back to warm) and is destroyed after a short grace
// period, so no task ever runs on a previous task's VM.

export type HostCommandKind = "provision_vm" | "destroy_vm" | "provision_host";

// JSON payload for the VM command kinds.
export type HostVmPayload = {
  devboxId: string;
};

// JSON payload for provision_host: a fleet host with provisioning capability
// bootstraps a brand-new Scaleway Mac under this name (Scaleway server name,
// tailnet hostname, and Convex hostId are all the same string).
export type HostProvisionPayload = {
  hostName: string;
};

/** How long a finished ephemeral devbox stays up (monitoring page, final
 * event flush) before the destroy command is enqueued. */
export const EPHEMERAL_RETIRE_GRACE_MS = 5 * 60_000;

// ---- Gateway -> orchestrator: POST {CONVEX_SITE_URL}/devbox/events ----
// Auth: `x-devbox-secret` header must equal the DEVBOX_SHARED_SECRET env var
// on both sides.

// ---- Gateway -> orchestrator: POST {CONVEX_SITE_URL}/devbox/transcript ----
// Sent once per task when it reaches a terminal status: the session's SDK
// message transcript, so history outlives the ephemeral VM. Oldest messages
// are dropped until the serialized payload fits MAX_TRANSCRIPT_BYTES
// (Convex documents cap at ~1 MB).

export type TranscriptUpload = {
  devboxId: string;
  taskId: string;
  // Raw SDKMessages, JSON-serializable, oldest first.
  messages: unknown[];
};

export const MAX_TRANSCRIPT_BYTES = 900_000;

export type DevboxEventType =
  | "started"
  | "progress"
  // No producer yet: the gateway does not emit needs_input (roadmap).
  | "needs_input"
  | "completed"
  | "failed"
  | "stopped";

export type DevboxEvent = {
  devboxId: string;
  taskId: string;
  type: DevboxEventType;
  // One- or two-sentence human-readable summary, suitable for posting to
  // Slack as a status update.
  summary: string;
  ts: number;
};

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "stopped";

export const DEVBOX_EVENT_TO_TASK_STATUS: Record<DevboxEventType, TaskStatus> =
  {
    started: "running",
    progress: "running",
    needs_input: "needs_input",
    completed: "completed",
    failed: "failed",
    stopped: "stopped",
  };

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "stopped",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/**
 * Whether an incoming devbox event may change a task's status. Events can
 * arrive out of order (concurrent POSTs, retries), so a non-terminal event
 * must never regress a task that already reached a terminal status.
 *
 * Terminal-to-terminal transitions apply (a retry/correction wins), with one
 * exception: completed -> stopped is blocked, because a later session
 * eviction (interrupting a finished-but-steerable session to free the
 * devbox) must not regress a finished task's record.
 */
export function shouldApplyTaskStatus(
  current: TaskStatus,
  incoming: TaskStatus,
): boolean {
  if (current === "completed" && incoming === "stopped") {
    return false;
  }
  return !isTerminalTaskStatus(current) || isTerminalTaskStatus(incoming);
}
