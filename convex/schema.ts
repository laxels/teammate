import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import type {
  HostCommandKind,
  LocalAccessStatus,
  RecordingStatus,
  TaskEffort,
  TaskStatus,
} from "../shared/protocol";

export const taskStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

// Compile-time check: the validator stays in lockstep with the wire contract.
type _TaskStatusMatchesProtocol = [
  Infer<typeof taskStatusValidator>,
  TaskStatus,
] extends [TaskStatus, Infer<typeof taskStatusValidator>]
  ? true
  : never;
const _taskStatusMatchesProtocol: _TaskStatusMatchesProtocol = true;
void _taskStatusMatchesProtocol;

// Reasoning effort for a task agent's session (#91). Mirrors the Agent SDK's
// EffortLevel and shared/protocol.ts TaskEffort.
export const effortValidator = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
  v.literal("max"),
);

type _TaskEffortMatchesProtocol = [
  Infer<typeof effortValidator>,
  TaskEffort,
] extends [TaskEffort, Infer<typeof effortValidator>]
  ? true
  : never;
const _taskEffortMatchesProtocol: _TaskEffortMatchesProtocol = true;
void _taskEffortMatchesProtocol;

/** Devbox gateway command kinds (the `commands` queue — see commands.ts).
 * The local daemon's `localCommands` queue reuses the same kinds and payloads
 * (see local.ts). */
export const commandKindValidator = v.union(
  v.literal("start"),
  v.literal("user_message"),
  v.literal("interrupt"),
);

/** Per-task local-machine grant (#138) — see shared/protocol.ts
 * LocalAccessStatus. Absent on the task = never requested. */
export const localAccessValidator = v.object({
  status: v.union(
    v.literal("requested"),
    v.literal("granted"),
    v.literal("denied"),
  ),
  requestedAt: v.optional(v.number()),
  resolvedAt: v.optional(v.number()),
});

type _LocalAccessStatusMatchesProtocol = [
  Infer<typeof localAccessValidator>["status"],
  LocalAccessStatus,
] extends [LocalAccessStatus, Infer<typeof localAccessValidator>["status"]]
  ? true
  : never;
const _localAccessStatusMatchesProtocol: _LocalAccessStatusMatchesProtocol = true;
void _localAccessStatusMatchesProtocol;

/** Host-agent command kinds (the `hostCommands` queue — see hosts.ts). */
export const hostCommandKindValidator = v.union(
  v.literal("provision_vm"),
  v.literal("destroy_vm"),
);

// Compile-time check: the validator stays in lockstep with the wire contract.
type _HostCommandKindMatchesProtocol = [
  Infer<typeof hostCommandKindValidator>,
  HostCommandKind,
] extends [HostCommandKind, Infer<typeof hostCommandKindValidator>]
  ? true
  : never;
const _hostCommandKindMatchesProtocol: _HostCommandKindMatchesProtocol = true;
void _hostCommandKindMatchesProtocol;

/** A file the requester shared in Slack, staged in Convex storage for the
 * task's devbox to fetch (see shared/protocol.ts DeliverableFile). The bytes
 * live in storage; only the id + metadata ride on the task row. */
export const taskFileValidator = v.object({
  name: v.string(),
  mimeType: v.string(),
  size: v.number(),
  storageId: v.id("_storage"),
});

export const recordingStatusValidator = v.union(
  v.literal("recording"),
  v.literal("uploading"),
  v.literal("available"),
  v.literal("failed"),
);

// Compile-time check: the validator stays in lockstep with the wire contract.
type _RecordingStatusMatchesProtocol = [
  Infer<typeof recordingStatusValidator>,
  RecordingStatus,
] extends [RecordingStatus, Infer<typeof recordingStatusValidator>]
  ? true
  : never;
const _recordingStatusMatchesProtocol: _RecordingStatusMatchesProtocol = true;
void _recordingStatusMatchesProtocol;

/** The devbox screen recording for a task (see gateway/src/recorder.ts and
 * shared/protocol.ts RecordingStatus). The gateway records with `screencapture`
 * while the task runs and uploads the .mov to Convex storage at the end; the
 * status + storageId ride the task row so both the live board and the
 * task-details page can show the right state. storageId is set only once
 * status reaches "available". */
export const taskRecordingValidator = v.object({
  status: recordingStatusValidator,
  storageId: v.optional(v.id("_storage")),
  bytes: v.optional(v.number()),
  uploadedAt: v.optional(v.number()),
  // Recorder wall-clock start time (ms), set with the first "recording" post
  // and preserved across later transitions. The task-details page maps a
  // video-relative second `t` to the absolute event timestamp `startedAt + t*1000`
  // so comments and events share one timeline (#70). Absent on recordings made
  // before the feature (those tasks can't align comments to events).
  startedAt: v.optional(v.number()),
});

export default defineSchema({
  // Raw inbound Slack events, deduplicated by Slack's event_id.
  // Slack retries deliveries that aren't acked within 3s, so ingestion
  // must be idempotent; processing happens asynchronously afterwards.
  slackEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    payload: v.string(),
    receivedAt: v.number(),
    processed: v.boolean(),
  })
    .index("by_event_id", ["eventId"])
    // Dead-letter sweep: find unprocessed events stranded by a crashed run.
    .index("by_processed", ["processed", "receivedAt"]),

  // One row per delegated Claude Code task.
  tasks: defineTable({
    taskId: v.string(),
    title: v.string(),
    prompt: v.string(),
    status: taskStatusValidator,
    devboxId: v.optional(v.string()),
    // Requested placement. "ephemeral" is the cloud default; an "ephemeral"
    // task with no devboxId is waiting for a VM slot (placed by
    // hosts.placeQueuedEphemeralTasks when one frees up or a new host comes
    // online). "local" (#138) runs the task's PRIMARY agent on the user's own
    // Mac via the localagent daemon — never queued: it is only created when a
    // registered machine is online and free. The "permanent" literal is
    // retained ONLY so historical rows from the retired always-on devbox-1
    // (#107) still validate; no code path writes it. Absent on
    // pre-placement-era rows.
    placement: v.optional(
      v.union(
        v.literal("ephemeral"),
        v.literal("permanent"),
        v.literal("local"),
      ),
    ),
    slackChannel: v.string(),
    // The task's home thread: every task anchors to the thread of the request
    // that started it (follow-up tasks started from a thread share it).
    // Absent only on rows from before DM replies were threaded.
    slackThreadTs: v.optional(v.string()),
    // Who asked (Slack user id). Steer/stop authorization: the owner from
    // anywhere, anyone from inside the task's thread. Absent on legacy rows.
    slackUser: v.optional(v.string()),
    // Deep link to the task's Slack thread (chat.getPermalink at creation).
    slackPermalink: v.optional(v.string()),
    // ts of the task's status card (the bot's first lifecycle message,
    // chat.update'd in place on every later event).
    slackCardTs: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // First applied "started" event / first applied terminal event. updatedAt
    // is clobbered by any patch, so durations need their own fields.
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    // When the staleness cron last posted a check-in for this task.
    lastNudgedAt: v.optional(v.number()),
    // Summary of the latest APPLIED status event (devboxes.recordEvent /
    // hosts.ts terminallyFailTask). The status card renders from the task row,
    // so a delayed notify action must be able to pair the row's status with
    // the summary that produced it — not its own (possibly stale) event's.
    // Absent on rows that predate the field.
    lastSummary: v.optional(v.string()),
    // Files the requester shared in Slack, staged in Convex storage. The
    // storageId rides the start command (hosts.dispatchTaskToSlot); the devbox
    // fetches the bytes from the secret-gated /devbox/file endpoint, never a
    // public storage URL.
    files: v.optional(v.array(taskFileValidator)),
    // Reasoning effort for the task agent's session, threaded into the start
    // command at placement (hosts.dispatchTaskToSlot). Absent => the gateway's
    // "xhigh" default; only the orchestrator sets it, and only on an explicit
    // user request (#91).
    effort: v.optional(effortValidator),
    // Devbox screen recording lifecycle + stored .mov (see recordings.ts and
    // gateway/src/recorder.ts). Absent on tasks that predate the feature.
    recording: v.optional(taskRecordingValidator),
    // Dashboard-local bookkeeping (#122): an archived task drops out of every
    // status filter on the fleet board and surfaces only under the "archived"
    // filter. Purely cosmetic — it never touches `status` or the task's
    // execution. Absent/false => not archived (the default for every row).
    archived: v.optional(v.boolean()),
    // ---- Local machine mode (#138) ----
    // The machine whose local agent serves this task. Set together with
    // `placement: "local"` for local-primary tasks, or when a split task's
    // helper agent is spawned. A task can have BOTH devboxId and
    // localMachineId (split task: cloud primary + local helper) — the model
    // is at most one agent of each kind per task.
    localMachineId: v.optional(v.string()),
    // Per-task, whole-machine grant to drive the user's local Mac. Absent =
    // never requested; see local.ts peerRequest / resolveAccess.
    localAccess: v.optional(localAccessValidator),
  })
    .index("by_task_id", ["taskId"])
    .index("by_status", ["status"])
    // Inbound thread replies look their task(s) up by thread anchor.
    .index("by_channel_thread", ["slackChannel", "slackThreadTs"]),

  // Devbox VMs — all ephemeral, created by hosts.ts allocateEphemeralSlot
  // (provisioning -> busy -> retiring -> row deleted by hosts.removeDevbox).
  // A devbox is never reused: no task runs on a previous task's VM.
  devboxes: defineTable({
    devboxId: v.string(),
    gatewayUrl: v.string(),
    status: v.union(
      v.literal("busy"),
      v.literal("provisioning"),
      v.literal("retiring"),
    ),
    taskId: v.optional(v.string()),
    // The Mac host whose agent manages this VM.
    hostId: v.optional(v.string()),
    lastSeenAt: v.number(),
  }).index("by_devbox_id", ["devboxId"]),

  // Mac hosts running the host agent (self-registered on first heartbeat).
  // Each host runs Tart VMs; Apple's EULA caps maxVms at 2 concurrent macOS
  // VMs per host. "draining" excludes a host from new allocations without
  // touching its running VMs. "provisioning" rows are pre-created by
  // hosts.requestHostProvision (the #88 capacity monitor / manual ops) to
  // serialize a scale-up; the GitHub Actions provisioner does the bootstrap,
  // and the new host's first heartbeat flips the row to "active".
  hosts: defineTable({
    hostId: v.string(),
    maxVms: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("draining"),
      v.literal("provisioning"),
    ),
    lastSeenAt: v.number(),
    // The host holds fleet credentials and is a provisioner of record. Reported
    // in its heartbeat; pickProvisioner (kept for the #88 monitor) selects it.
    // The host agent no longer bootstraps hosts itself — GitHub Actions does.
    canProvisionHosts: v.optional(v.boolean()),
    // The local tart image new ephemerals are cloned from (the hostagent's
    // GOLDEN_IMAGE), reported in every heartbeat. Lets the fleet observe which
    // golden each warm host serves so a golden-refresh (#89) can confirm
    // convergence instead of a host silently keeping a stale image. Optional:
    // older heartbeats omit it.
    goldenImage: v.optional(v.string()),
    // For "provisioning" rows: when the scale-up was requested (staleness
    // cutoff) and the provisioner of record (debugging).
    provisionRequestedAt: v.optional(v.number()),
    provisionedBy: v.optional(v.string()),
  }).index("by_host_id", ["hostId"]),

  // Host-level command queue (VM lifecycle), mirroring `commands`: the
  // orchestrator enqueues, host agents subscribe and ack (outbound-only).
  // Host *provisioning* is no longer a host-agent command — GitHub Actions is
  // the doer (see .github/workflows/provision-host.yml); the host agent only
  // manages VMs on a host that is already up.
  hostCommands: defineTable({
    commandId: v.string(),
    hostId: v.string(),
    kind: hostCommandKindValidator,
    // JSON payload: HostVmPayload for both kinds.
    payload: v.string(),
    // A consumer claims a command (pending -> running) before running its side
    // effect and only acks (-> acked) after, so a crash anywhere after the
    // claim leaves it "running" — never redelivered, never replayed. See
    // hosts.ts claim(). pendingFor returns only "pending".
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("acked"),
    ),
    // When the command was claimed (pending -> running); lets a future sweep
    // spot commands wedged in "running" by a consumer that died mid-execution.
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_host_status", ["hostId", "status"])
    .index("by_command_id", ["commandId"]),

  // Fleet-level lifecycle events (host provisioning progress, failures),
  // posted by host agents and the GitHub Actions provisioner (via the
  // secret-gated /fleet/event endpoint). The orchestrator's get_fleet tool
  // surfaces the recent tail so Ultraclaude can monitor and debug scale-ups.
  hostEvents: defineTable({
    hostId: v.string(),
    type: v.string(),
    summary: v.string(),
    ts: v.number(),
  }).index("by_host_id", ["hostId"]),

  // Authoritative, cross-origin mutual-exclusion for fleet-provisioning
  // operations (see src/fleetLock.ts). One row per lock name (today: the
  // single global "fleet" lock; #89's golden-refresh may take others). Unlike
  // scripts/singleton-lock.sh — a local .git filesystem lock that only sees
  // initiators in one checkout — this lives in Convex, so every fleet-mutating
  // op grabs it regardless of origin (laptop, GitHub Actions runner, the
  // future #88 monitor). It's a LEASE: the holder renews before expiresAt or
  // the next contender reclaims it, so a runner that dies mid-op never wedges
  // the lock (the distributed analogue of singleton-lock's dead-owner steal).
  fleetLocks: defineTable({
    name: v.string(),
    // Free-form id of the current holder, unique per operation, e.g.
    // "gh:<run_id>" or "<user>@<host>:<pid>". Renew/release target it; a
    // mismatch means the lease was stolen.
    holder: v.string(),
    acquiredAt: v.number(),
    renewedAt: v.number(),
    // Lease deadline: at/after this the lock is reclaimable by anyone.
    expiresAt: v.number(),
  }).index("by_name", ["name"]),

  // Control-plane command queue: the orchestrator enqueues, gateways
  // subscribe and ack (outbound-only — Convex cloud cannot reach tailnet
  // addresses, so gateways are never dialed into).
  commands: defineTable({
    commandId: v.string(),
    devboxId: v.string(),
    kind: commandKindValidator,
    // JSON payload: StartTaskRequest for "start", UserMessagePayload for
    // "user_message", InterruptPayload for "interrupt".
    payload: v.string(),
    // A gateway claims a command (pending -> running) before running its side
    // effect and only acks (-> acked) after, so a crash anywhere after the
    // claim leaves it "running" — never redelivered, never replayed (a
    // replayed `start` could evict a live session). See commands.ts claim().
    // pendingFor returns only "pending".
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("acked"),
    ),
    // When the command was claimed (pending -> running); lets a future sweep
    // spot commands wedged in "running" by a gateway that died mid-execution.
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_devbox_status", ["devboxId", "status"])
    .index("by_command_id", ["commandId"]),

  // Loom-style retro comments on a task's screen recording (#70). The operator
  // pins a comment to a video-relative timestamp on the task-details page; a
  // frame grabbed at that timestamp is stored separately and referenced by
  // imageStorageId. Anonymous + single-author for now (the dashboard has one
  // shared DASHBOARD_SECRET, no per-user identity). Scoped by taskId — a retry
  // is a new task, so its comments never bleed in.
  comments: defineTable({
    taskId: v.string(),
    // Seconds into the recording (matches the video element's currentTime).
    videoTimeSec: v.number(),
    text: v.string(),
    // The frame grabbed at videoTimeSec (PNG in Convex storage), absent when the
    // grab failed or hasn't completed — the UI then shows a text-only comment.
    imageStorageId: v.optional(v.id("_storage")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_task_id", ["taskId"]),

  // Bookkeeping for inbound Slack files staged in Convex storage: the daily
  // cleanup cron deletes the storage blob + this row past INBOUND_FILE_RETENTION_MS
  // (= QUEUE_RETENTION_MS, 7 days), so a task that waits through a host bootstrap
  // keeps its attachments; past that a queued task is effectively abandoned and a
  // missing blob 404s the gateway's /devbox/file fetch. Pruned by cleanup.pruneExpired.
  inboundFiles: defineTable({
    storageId: v.id("_storage"),
    // The Slack event the file came from (debugging orphaned blobs); the task
    // it lands on may not exist yet when the blob is staged.
    eventId: v.string(),
    createdAt: v.number(),
  }),

  // Lifecycle events posted by devbox gateways to /devbox/events and local
  // agents to /local/events (#138: those carry machineId instead of devboxId),
  // plus orchestrator-recorded events for tasks that never reached an agent
  // (queue cancellations) — those have neither. Peer-channel traffic is also
  // recorded here as timeline-only rows (type "peer_request"/"peer_reply",
  // inserted by local.ts). Status events drive task status; info events
  // (#70: assistant_text/tool_call/tool_result) only populate the
  // task-details retro timeline and carry the optional fields below. High
  // volume is expected for info events (a screenshot ~every step).
  taskEvents: defineTable({
    taskId: v.string(),
    devboxId: v.optional(v.string()),
    // The local machine whose agent produced this event (#138); lets the
    // dashboard attribute split-task timeline rows to the cloud/local agent.
    machineId: v.optional(v.string()),
    type: v.string(),
    summary: v.string(),
    ts: v.number(),
    // Full body for the expandable timeline entry (assistant turn, tool input
    // JSON, or tool result text); capped by the gateway (DETAIL_MAX_CHARS).
    detail: v.optional(v.string()),
    // Tool name for tool_call / tool_result events.
    tool: v.optional(v.string()),
    // Screenshot attached to a tool_result (computer-use), resolved to a URL by
    // taskDetail.
    imageStorageId: v.optional(v.id("_storage")),
  }).index("by_task_id", ["taskId"]),

  // ---- Local machine mode (#138) ----

  // The user's own Macs running the localagent daemon (self-registered on
  // first heartbeat, like `hosts`). Rows are permanent — a machine is a
  // standing surface, not an ephemeral resource. `taskId` marks the machine
  // busy: one local agent session per machine at a time; it is set when a
  // local agent is spawned and cleared when the task releases the machine.
  localMachines: defineTable({
    machineId: v.string(),
    // Human-readable label for Slack asks / the dashboard (heartbeat-reported).
    displayName: v.optional(v.string()),
    // Slack user id of the machine's owner (heartbeat-reported). When set,
    // only this user's say-so may grant local access, and permission asks tag
    // them; unset machines (single-user setups) accept any grant.
    ownerSlackUser: v.optional(v.string()),
    taskId: v.optional(v.string()),
    lastSeenAt: v.number(),
  }).index("by_machine_id", ["machineId"]),

  // Control-plane command queue for local daemons, mirroring `commands`:
  // the orchestrator enqueues, daemons subscribe and ack (outbound-only —
  // the cloud never dials a user's machine). Same claim lifecycle and
  // payload kinds as the devbox queue; auth is LOCAL_MACHINE_SECRET.
  localCommands: defineTable({
    commandId: v.string(),
    machineId: v.string(),
    kind: commandKindValidator,
    // JSON payload: StartTaskRequest for "start", UserMessagePayload for
    // "user_message", InterruptPayload for "interrupt".
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("acked"),
    ),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_machine_status", ["machineId", "status"])
    .index("by_command_id", ["commandId"]),

  // The Convex-relayed agent<->agent peer channel (#138): cloud agents file
  // "request" rows (POST /devbox/peer/request) and poll for the matching
  // "reply" (GET /devbox/peer/reply); local agents answer via
  // POST /local/peer/reply. The orchestrator LLM never touches these — only
  // the permission ask (first request against an ungranted task) involves the
  // user. Replies pair to requests by requestId; a request with no reply row
  // is still unanswered. Denials and local-agent death insert synthetic
  // replies so a blocked cloud agent always unblocks.
  peerMessages: defineTable({
    messageId: v.string(),
    taskId: v.string(),
    requestId: v.string(),
    kind: v.union(v.literal("request"), v.literal("reply")),
    // Free text, truncated to PEER_BODY_MAX_CHARS server-side.
    body: v.string(),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_request", ["requestId", "kind"]),

  // Capability manifests for golden devbox images (#138): what cloud agents
  // can and cannot do (installed apps, authed accounts, tooling), keyed by
  // golden tag. `generated` is auto-enumerated at bake time; `curated` is the
  // hand-maintained section (scripts/golden-capabilities.md). The latest row
  // is injected into the orchestrator's system prompt so routing (cloud vs
  // local vs split) is informed; it only changes on a new bake, matching how
  // cloud environment changes actually persist.
  capabilityManifests: defineTable({
    goldenTag: v.string(),
    generated: v.string(),
    curated: v.string(),
    updatedAt: v.number(),
  })
    .index("by_tag", ["goldenTag"])
    // capabilities.current runs on every orchestrator turn: newest row via
    // index, never a whole-table scan of multi-KB manifest bodies.
    .index("by_updated", ["updatedAt"]),
});
