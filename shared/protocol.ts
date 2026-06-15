// Wire contracts between the three Ultraclaude components:
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
  /** Files the requester shared in Slack, already downloaded by the
   * orchestrator into Convex storage. The gateway fetches each by `storageId`
   * from the authenticated GET /devbox/file endpoint (bot token never reaches
   * the devbox) into the task's cwd and points the session at the local paths. */
  files?: DeliverableFile[];
};

/**
 * A file the orchestrator has staged in Convex storage for a devbox to fetch.
 * The bytes live in storage (not in the command row, which is capped near
 * 1 MB); only the `storageId` rides the wire. The devbox fetches the bytes
 * from the secret-gated GET /devbox/file?storageId=... endpoint — NOT a public
 * `ctx.storage.getUrl()` capability URL, so a leaked payload grants no access.
 */
export type DeliverableFile = {
  name: string;
  mimeType: string;
  size: number;
  storageId: string;
};

/** A Slack-relayed steering message for a running task's live session (same
 * effect as typing into the monitoring page's steering box). taskId guards
 * against a stale command reaching a devbox that moved on to another task.
 * `files` carries attachments shared in the steering message (same staging as
 * StartTaskRequest.files), downloaded into the session's cwd before delivery. */
export type UserMessagePayload = {
  taskId: string;
  text: string;
  files?: DeliverableFile[];
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
// gateway, against the `hostCommands` table) that manages VM lifecycle on a
// host that is already up. Apple's EULA caps each host at 2 concurrent macOS
// VMs; concurrency scales by adding hosts. Host *provisioning* itself is no
// longer a host-agent command — GitHub Actions is the doer (#87,
// .github/workflows/provision-host.yml).
//
// VM lifecycle for ephemeral devboxes: the orchestrator pre-creates the
// devbox row (status "provisioning", deterministic gatewayUrl from the
// devbox id + tailnet suffix) and enqueues the task's start command BEFORE
// the VM exists — the freshly booted gateway picks it up on first
// subscription. After the task reaches a terminal status the devbox goes to
// "retiring" (never back to warm) and is destroyed after a short grace
// period, so no task ever runs on a previous task's VM.

export type HostCommandKind = "provision_vm" | "destroy_vm";

// JSON payload for the VM command kinds.
export type HostVmPayload = {
  devboxId: string;
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

// ---- File handling caps (Slack <-> devbox, see src/slackApi.ts) ----
// Inbound: the largest Slack attachment the orchestrator downloads + stages
// for a task (oversized files are skipped with a note to the model).
export const MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
// Outbound: the largest artifact a devbox may push back through
// /devbox/artifact. Kept under Convex's 20 MB HTTP-action request cap with
// headroom for the multipart envelope.
export const MAX_OUTBOUND_FILE_BYTES = 18 * 1024 * 1024;
// The largest single image the orchestrator feeds to its OWN model inline (so
// it can answer about a screenshot in chat). Larger images still reach the
// devbox; they're just not shown to the orchestrator (per-image limit).
export const MAX_ORCHESTRATOR_IMAGE_BYTES = 5 * 1024 * 1024;
// AGGREGATE cap across all inline images in one orchestrator request. Anthropic
// caps a standard request at 32 MB; base64 inflates ~4/3, so 20 MB of raw image
// bytes (~27 MB base64) leaves headroom for the prompt/system/tools. Beyond
// this, further images are delivered to the devbox but not shown inline — so a
// burst of large screenshots can't 413 the request after the event is claimed.
export const MAX_ORCHESTRATOR_INLINE_TOTAL_BYTES = 20 * 1024 * 1024;

// ---- Gateway -> orchestrator: GET {CONVEX_SITE_URL}/devbox/file?storageId=... ----
// Auth: `x-devbox-secret` header (same shared secret as /devbox/events). Streams
// the staged inbound-file bytes from Convex storage so the devbox never receives
// a public capability URL; 404 when the blob is missing/pruned (the gateway then
// tells the session the file couldn't be downloaded).

// ---- Devbox -> orchestrator: POST {CONVEX_SITE_URL}/devbox/artifact ----
// Auth: `x-devbox-secret` header (same shared secret as /devbox/events).
// Body: multipart/form-data — fields `taskId`, `filename`, optional
// `title`/`comment`, and the binary `file`. The orchestrator stores the bytes
// in Convex storage and posts them into the task's Slack thread via the modern
// external-upload flow, then deletes the storage blob (outbound artifacts are
// transient). The devbox's `share_file` MCP tool drives this.

// ---- Devbox screen recording (see gateway/src/recorder.ts) ----
// The gateway records the devbox screen with macOS `screencapture -v` for the
// duration of each task (cursor + clicks included), then uploads the .mov to
// Convex file storage so it outlives the ephemeral VM. The four lifecycle
// states ride on the task row's `recording` field:
//   recording  — capture in progress (task still running)
//   uploading  — task ended; finalizing + pushing the file to storage
//   available  — stored and playable (storageId set; dashboard resolves a URL)
//   failed     — capture never produced a valid file, or the upload failed
// A task with no `recording` field at all predates the feature → "unavailable".
//
// Upload is the Convex generateUploadUrl flow (NOT an HTTP-action multipart
// POST like /devbox/artifact): a recording easily exceeds the ~20 MB HTTP
// request cap (~13 MB/min). The whole finalize+upload must land inside the
// EPHEMERAL_RETIRE_GRACE_MS window before the VM is reclaimed; a recording too
// large to push in a single (non-resumable) upload POST is simply lost (the
// state goes "failed" → the dashboard shows "unavailable"). Acceptable for MVP.
export type RecordingStatus =
  | "recording"
  | "uploading"
  | "available"
  | "failed";

// Recordings are .mov (QuickTime container, H.264) — what `screencapture -v`
// emits, which plays natively in browsers without transcoding.
export const RECORDING_CONTENT_TYPE = "video/quicktime";

// ---- Devbox -> orchestrator: POST {CONVEX_SITE_URL}/devbox/recording/upload-url ----
// Auth: `x-devbox-secret`. Returns { url } — a short-lived Convex storage
// upload URL the gateway POSTs the recording bytes to (which yields a
// storageId), keeping the large file off the size-capped HTTP-action path.
//
// ---- Devbox -> orchestrator: POST {CONVEX_SITE_URL}/devbox/recording ----
// Auth: `x-devbox-secret`. JSON body { taskId, devboxId, status, storageId?,
// bytes? } records a recording lifecycle transition on the task row. storageId
// is required for (and only for) status "available".

export type DevboxEventType =
  | "started"
  | "progress"
  // Emitted when the session blocks on AskUserQuestion (gateway session.ts);
  // a steered user message answers it.
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
