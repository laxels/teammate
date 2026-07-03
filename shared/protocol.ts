// Wire contracts between the Ultraclaude components:
// monitoring page (web/) <-> devbox gateway (gateway/) <-> orchestrator
// (convex/) <-> localagent daemon (localagent/, #138).
//
// The gateway runs INSIDE each devbox VM and is reachable only over the
// tailnet. The monitoring page is served statically by the gateway, so all
// page connections are same-origin. The localagent daemon runs on the user's
// own Mac and is fully outbound (its contracts are in the "Local machine
// mode" section below).

// ---- Monitoring page <-> gateway: WebSocket at /ws/steer ----

export type SteerClientMessage =
  | { type: "user_message"; text: string }
  | { type: "interrupt" };

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

/**
 * Reasoning-effort levels a task agent's Claude Code session may run at —
 * mirrors the Agent SDK's `EffortLevel`. Single source of truth for the type,
 * the tool-schema enum (orchestrator), and the wire validators (gateway parse,
 * Convex schema). The default everywhere is `xhigh` (model policy: accuracy
 * first, see ARCHITECTURE.md); the orchestrator overrides it ONLY when the
 * requester explicitly and unambiguously asks for a specific level (issue #91),
 * and its own model stays pinned to `xhigh` regardless. */
export const TASK_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type TaskEffort = (typeof TASK_EFFORTS)[number];

/** Narrows arbitrary input to a valid effort level, returning undefined for
 * absent/unknown values so a stray arg degrades to the `xhigh` default rather
 * than rejecting the task. Used at both trust boundaries (orchestrator tool
 * input, gateway start-request parse). */
export function parseTaskEffort(value: unknown): TaskEffort | undefined {
  return typeof value === "string" &&
    (TASK_EFFORTS as readonly string[]).includes(value)
    ? (value as TaskEffort)
    : undefined;
}

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
  /** Reasoning effort for the task agent's session. Omitted on the wire unless
   * the requester explicitly asked for a non-default level; the gateway falls
   * back to its `xhigh` default when absent. */
  effort?: TaskEffort;
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
// "retiring" (never reused) and is destroyed after a short grace period, so no
// task ever runs on a previous task's VM.

export type HostCommandKind = "provision_vm" | "destroy_vm";

// JSON payload for the VM command kinds.
export type HostVmPayload = {
  devboxId: string;
};

/** How long a finished ephemeral devbox stays up (monitoring page, final
 * event flush) before the destroy command is enqueued. */
export const EPHEMERAL_RETIRE_GRACE_MS = 5 * 60_000;

/** The port every devbox gateway listens on. The orchestrator pre-computes
 * gateway URLs with it (src/hostPool.ts), the gateway defaults to it
 * (gateway/src/config.ts), and hostagent/src/vm.ts wires it into VM
 * provisioning (deploy-payload.sh ships shared/ to hosts as ~/shared, so
 * hostagent may import it at runtime). */
export const GATEWAY_PORT = 8787;

// ---- Gateway -> orchestrator: POST {CONVEX_SITE_URL}/devbox/events ----
// Auth: `x-devbox-secret` header must equal the DEVBOX_SHARED_SECRET env var
// on both sides.

// The persisted session transcript (its own `transcripts` table + a
// /devbox/transcript upload endpoint) was removed in #70: the task-details
// retro timeline now streams full assistant text, tool calls, and tool results
// as info events (see DevboxInfoEventType), which supersede it.

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
// bytes?, startedAt? } records a recording lifecycle transition on the task
// row. storageId is required for (and only for) status "available". startedAt
// is the recorder's wall-clock start time (ms), sent with the first "recording"
// post and preserved across later transitions; the task-details page needs it
// to map video-relative seconds to the absolute event timestamps on the
// timeline (#70 — comment ↔ event alignment).

// Status events drive the task's lifecycle status (DEVBOX_EVENT_TO_TASK_STATUS)
// and are mirrored to the task's Slack thread. "needs_input" is emitted when
// the session blocks on AskUserQuestion (gateway session.ts); a steered user
// message answers it.
export const DEVBOX_STATUS_EVENT_TYPES = [
  "started",
  "progress",
  "needs_input",
  "completed",
  "failed",
  "stopped",
] as const;

export type DevboxStatusEventType = (typeof DEVBOX_STATUS_EVENT_TYPES)[number];

// Info events enrich the task-details retro timeline (#70): the full assistant
// narration, each tool call, and each tool result (including computer-use
// screenshots). They are appended to taskEvents but NEVER drive task status
// (statusForEvent returns undefined) and are NOT posted to Slack — see
// convex/devboxes.ts recordEvent. Volume is high (computer-use emits a
// screenshot roughly every step); that is expected and acceptable.
export const DEVBOX_INFO_EVENT_TYPES = [
  "assistant_text",
  "tool_call",
  "tool_result",
] as const;

export type DevboxInfoEventType = (typeof DEVBOX_INFO_EVENT_TYPES)[number];

// The single source of truth for the DevboxEvent wire types: the HTTP-boundary
// validator (src/orchestration.ts parseDevboxEvent) and the Convex mutation
// validator (convex/constants.ts) both derive from this array, so adding an
// event type here propagates everywhere.
export const DEVBOX_EVENT_TYPES = [
  ...DEVBOX_STATUS_EVENT_TYPES,
  ...DEVBOX_INFO_EVENT_TYPES,
] as const;

export type DevboxEventType = (typeof DEVBOX_EVENT_TYPES)[number];

export type DevboxEvent = {
  devboxId: string;
  taskId: string;
  type: DevboxEventType;
  // Human-readable body shown everywhere this event surfaces (Slack + dashboard).
  // For status events it is the Slack-suitable status line. For assistant_text —
  // and the assistant-derived progress / completed / failed lines — it is the
  // FULL response, never excerpted (#114): a retrieval task's answer is the
  // deliverable, so it is shown whole. For tool_call / tool_result info events it
  // is a one-line preview of `detail`. Always clipped to DETAIL_MAX_CHARS.
  summary: string;
  ts: number;
  // ---- Info-event enrichment (set only on info events) ----
  // The full, un-excerpted body the expandable retro view renders: the tool input
  // JSON or the tool result text. (assistant_text no longer sets this — its full
  // text already rides in `summary` per #114.) Capped at DETAIL_MAX_CHARS so a
  // single event row stays well under Convex's ~1 MB doc limit even under the
  // high info-event volume.
  detail?: string;
  // Tool name for tool_call / tool_result events (e.g. "left_click").
  tool?: string;
  // Convex storageId of a screenshot attached to a tool_result (computer-use
  // returns a fresh screenshot after every action). Resolved to a URL by
  // taskDetail; never inline base64 (row-size limits).
  imageStorageId?: string;
};

/** Max characters of an info event's `detail` body persisted on the wire/row.
 * Generous enough for full assistant turns and tool I/O, small enough that even
 * a burst of info events can't approach Convex's per-document size cap. */
export const DETAIL_MAX_CHARS = 16_000;

// ---- Local machine mode (#138) ----
// An always-on daemon (localagent/) on the user's own Mac mirrors the gateway's
// outbound-only pattern against its own control plane: it self-registers via
// heartbeat (`local:heartbeat` -> localMachines row), subscribes to the
// `localCommands` queue (same "start" | "user_message" | "interrupt" kinds and
// payloads as the devbox queue), and posts LocalAgentEvents to /local/events.
// It authenticates with LOCAL_MACHINE_SECRET — its own trust tier, NEVER the
// fleet-wide devbox secret — via the `x-local-secret` header on HTTP endpoints
// and a `secret` function argument on Convex client calls.
//
// ---- Local daemon HTTP surface (orchestrator side, {CONVEX_SITE_URL}) ----
// POST /local/events       LocalAgentEvent          (x-local-secret)
// POST /local/upload-url   -> { url }               (x-local-secret; the
//                          generateUploadUrl flow for tool-result screenshots)
// GET  /local/file?storageId=...                    (x-local-secret; staged
//                          Slack attachments, mirrors /devbox/file)
// POST /local/artifact     multipart, same fields as /devbox/artifact
// POST /local/peer/reply   PeerReplyPayload         (x-local-secret)
//
// ---- Cloud-agent peer surface (gateway side, {CONVEX_SITE_URL}) ----
// POST /devbox/peer/request  PeerRequestPayload     (x-devbox-secret)
// GET  /devbox/peer/reply?taskId=...&requestId=...  (x-devbox-secret)
//
// The peer channel is Convex-relayed (both sides subscribe/poll outbound; the
// cloud never dials an agent) and the orchestrator LLM is out of the loop once
// a local agent is live: requests are delivered to the local session as
// `user_message` localCommands mechanically, and replies are polled by the
// cloud agent's await tool. Permission is per-task, whole-machine: the first
// peer request against an ungranted task flips it to "requested" and posts a
// Slack ask in the task's thread (tagging the requester); the orchestrator
// records the user's decision via its resolve_local_access tool.

/** Per-task local-machine grant state. Absent on the task = never requested.
 * "requested" means the Slack ask is posted and pending; peer requests queue
 * (unanswered) until the user decides. No standing "always allow" exists. */
export type LocalAccessStatus = "requested" | "granted" | "denied";

/** Lifecycle/info event posted by the local daemon to /local/events — the
 * DevboxEvent shape with the machine id in place of a devbox id. Status
 * events drive task status ONLY when the local agent is the task's primary
 * agent (placement "local"); for a split task's helper agent they are
 * recorded on the timeline (and needs_input still notifies) but never move
 * task status — see convex/local.ts recordEvent. */
export type LocalAgentEvent = {
  machineId: string;
  taskId: string;
  type: DevboxEventType;
  summary: string;
  ts: number;
  detail?: string;
  tool?: string;
  imageStorageId?: string;
};

/** Cloud agent -> orchestrator: request work on the user's local machine
 * (gateway `request_local_work` tool -> POST /devbox/peer/request). The
 * devboxId is the crosstalk guard: only the task's current devbox may file
 * requests for it. requestId is caller-generated and idempotent — a retried
 * POST with the same requestId returns the current state without duplicating
 * the request. */
export type PeerRequestPayload = {
  taskId: string;
  devboxId: string;
  requestId: string;
  body: string;
};

/** Local agent -> orchestrator: answer a peer request (localagent
 * `reply_to_cloud` tool -> POST /local/peer/reply). */
export type PeerReplyPayload = {
  machineId: string;
  taskId: string;
  requestId: string;
  body: string;
};

/** Max characters of a peer request/reply body persisted on the row; longer
 * bodies are truncated server-side (rows must stay far under Convex's ~1 MB
 * doc cap). Matches DETAIL_MAX_CHARS so a full tool-sized payload fits. */
export const PEER_BODY_MAX_CHARS = 16_000;

/** The synthetic reply a blocked cloud agent receives when local access is
 * denied — one constant so the request-after-denial path, the denial
 * resolution path, and the gateway tool guidance stay in lockstep. */
export const LOCAL_ACCESS_DENIED_REPLY =
  "Local-machine access was denied for this task. Continue cloud-only, best effort, and note the limitation in your result.";

/** Timeline-only event types for peer traffic, inserted Convex-side when a
 * request/reply lands (never posted by an agent, never drive task status).
 * The dashboard renders them as pills; unknown consumers ignore them. */
export const PEER_EVENT_TYPES = ["peer_request", "peer_reply"] as const;

export type PeerEventType = (typeof PEER_EVENT_TYPES)[number];

export type TaskStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "stopped";

const DEVBOX_EVENT_TO_TASK_STATUS: Record<DevboxStatusEventType, TaskStatus> = {
  started: "running",
  progress: "running",
  needs_input: "needs_input",
  completed: "completed",
  failed: "failed",
  stopped: "stopped",
};

/**
 * The task status an event drives, or undefined for info events (#70). Info
 * events (assistant_text/tool_call/tool_result) are recorded on the timeline
 * but must never change task status — a tool_result arriving after a task
 * completed must not regress it. Callers branch on undefined to skip the status
 * transition entirely (convex/devboxes.ts recordEvent).
 */
export function statusForEvent(type: DevboxEventType): TaskStatus | undefined {
  return (
    DEVBOX_EVENT_TO_TASK_STATUS as Record<string, TaskStatus | undefined>
  )[type];
}

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
