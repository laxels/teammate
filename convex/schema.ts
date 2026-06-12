import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import type { TaskStatus } from "../shared/protocol";

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
    // Requested placement. "ephemeral" tasks with no devboxId are waiting for
    // a VM slot (placed by hosts.placeQueuedEphemeralTasks when one frees up
    // or a new host comes online). Absent on pre-placement-era rows.
    placement: v.optional(
      v.union(v.literal("ephemeral"), v.literal("permanent")),
    ),
    slackChannel: v.string(),
    // The task's home thread: every task anchors to the thread of the request
    // that started it (follow-up tasks started from a thread share it).
    // Absent only on rows from before DM replies were threaded.
    slackThreadTs: v.optional(v.string()),
    // Who asked (Slack user id). Steer/stop authorization: the owner from
    // anywhere, anyone from inside the task's thread. Absent on legacy rows.
    slackUser: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // When the staleness cron last posted a check-in for this task.
    lastNudgedAt: v.optional(v.number()),
  })
    .index("by_task_id", ["taskId"])
    .index("by_status", ["status"])
    // Inbound thread replies look their task(s) up by thread anchor.
    .index("by_channel_thread", ["slackChannel", "slackThreadTs"]),

  // Devbox VMs. Permanent devboxes are registered manually via
  // devboxes.registerDevbox and cycle warm <-> busy; ephemeral devboxes are
  // created by hosts.allocateEphemeral (provisioning -> busy -> retiring ->
  // row deleted by hosts.removeDevbox) and never enter the warm pool.
  devboxes: defineTable({
    devboxId: v.string(),
    gatewayUrl: v.string(),
    status: v.union(
      v.literal("warm"),
      v.literal("busy"),
      v.literal("provisioning"),
      v.literal("retiring"),
    ),
    taskId: v.optional(v.string()),
    // The Mac host whose agent manages this VM (ephemeral devboxes only).
    hostId: v.optional(v.string()),
    // Ephemeral devboxes are destroyed after their single task finishes.
    ephemeral: v.optional(v.boolean()),
    lastSeenAt: v.number(),
  }).index("by_devbox_id", ["devboxId"]),

  // Mac hosts running the host agent (self-registered on first heartbeat).
  // Each host runs Tart VMs; Apple's EULA caps maxVms at 2 concurrent macOS
  // VMs per host. "draining" excludes a host from new allocations without
  // touching its running VMs. "provisioning" rows are pre-created by
  // hosts.requestHostProvision while a provisioner host bootstraps the new
  // Mac; the new host's first heartbeat flips it to "active".
  hosts: defineTable({
    hostId: v.string(),
    maxVms: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("draining"),
      v.literal("provisioning"),
    ),
    lastSeenAt: v.number(),
    // The host holds fleet credentials (Scaleway API, ghcr, fleet SSH key)
    // and can bootstrap new Mac hosts. Reported in its heartbeat.
    canProvisionHosts: v.optional(v.boolean()),
    // For "provisioning" rows: when the bootstrap was requested (staleness
    // cutoff) and which host is running it (debugging).
    provisionRequestedAt: v.optional(v.number()),
    provisionedBy: v.optional(v.string()),
  }).index("by_host_id", ["hostId"]),

  // Host-level command queue (VM lifecycle + fleet scaling), mirroring
  // `commands`: the orchestrator enqueues, host agents subscribe and ack
  // (outbound-only).
  hostCommands: defineTable({
    commandId: v.string(),
    hostId: v.string(),
    kind: v.union(
      v.literal("provision_vm"),
      v.literal("destroy_vm"),
      v.literal("provision_host"),
    ),
    // JSON payload: HostVmPayload for the vm kinds, HostProvisionPayload for
    // provision_host.
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("acked")),
    createdAt: v.number(),
  })
    .index("by_host_status", ["hostId", "status"])
    .index("by_command_id", ["commandId"]),

  // Fleet-level lifecycle events (host provisioning progress, failures),
  // posted by host agents. The orchestrator's get_fleet tool surfaces the
  // recent tail so ultraclaude can monitor and debug scale-ups.
  hostEvents: defineTable({
    hostId: v.string(),
    type: v.string(),
    summary: v.string(),
    ts: v.number(),
  }).index("by_host_id", ["hostId"]),

  // Control-plane command queue: the orchestrator enqueues, gateways
  // subscribe and ack (outbound-only — Convex cloud cannot reach tailnet
  // addresses, so gateways are never dialed into).
  commands: defineTable({
    commandId: v.string(),
    devboxId: v.string(),
    kind: v.union(
      v.literal("start"),
      v.literal("user_message"),
      v.literal("interrupt"),
    ),
    // JSON payload: StartTaskRequest for "start", UserMessagePayload for
    // "user_message", "{}" for "interrupt".
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("acked")),
    createdAt: v.number(),
  })
    .index("by_devbox_status", ["devboxId", "status"])
    .index("by_command_id", ["commandId"]),

  // Lifecycle events posted by devbox gateways to /devbox/events, plus
  // orchestrator-recorded events for tasks that never reached a devbox
  // (queue cancellations) — those have no devboxId.
  taskEvents: defineTable({
    taskId: v.string(),
    devboxId: v.optional(v.string()),
    type: v.string(),
    summary: v.string(),
    ts: v.number(),
  }).index("by_task_id", ["taskId"]),
});
