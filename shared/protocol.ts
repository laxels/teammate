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
// (kind "start" with a StartTaskRequest payload, or "interrupt"); the gateway
// subscribes via an outbound Convex client connection, executes against its
// own local HTTP surface, and acks.
//
// ---- Gateway HTTP surface (tailnet/local only) ----
// POST /task       StartTaskRequest -> 202, or 409 if a task is running
// POST /interrupt  {}               -> 200
// GET  /health     -> GatewayHealth
export type StartTaskRequest = {
  taskId: string;
  prompt: string;
  cwd?: string;
};

export type GatewayHealth = {
  devboxId: string;
  running: boolean;
  taskId: string | null;
};

// ---- Gateway -> orchestrator: POST {CONVEX_SITE_URL}/devbox/events ----
// Auth: `x-devbox-secret` header must equal the DEVBOX_SHARED_SECRET env var
// on both sides.

export type DevboxEventType =
  | "started"
  | "progress"
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
 */
export function shouldApplyTaskStatus(
  current: TaskStatus,
  incoming: TaskStatus,
): boolean {
  return !isTerminalTaskStatus(current) || isTerminalTaskStatus(incoming);
}
