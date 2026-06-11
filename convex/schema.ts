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
  }).index("by_event_id", ["eventId"]),

  // One row per delegated Claude Code task.
  tasks: defineTable({
    taskId: v.string(),
    title: v.string(),
    prompt: v.string(),
    status: taskStatusValidator,
    devboxId: v.optional(v.string()),
    slackChannel: v.string(),
    slackThreadTs: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // When the staleness cron last posted a check-in for this task.
    lastNudgedAt: v.optional(v.number()),
  })
    .index("by_task_id", ["taskId"])
    .index("by_status", ["status"]),

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
  // touching its running VMs.
  hosts: defineTable({
    hostId: v.string(),
    maxVms: v.number(),
    status: v.union(v.literal("active"), v.literal("draining")),
    lastSeenAt: v.number(),
  }).index("by_host_id", ["hostId"]),

  // Host-level command queue (VM lifecycle), mirroring `commands`: the
  // orchestrator enqueues, host agents subscribe and ack (outbound-only).
  hostCommands: defineTable({
    commandId: v.string(),
    hostId: v.string(),
    kind: v.union(v.literal("provision_vm"), v.literal("destroy_vm")),
    // JSON payload: HostVmPayload for both kinds.
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("acked")),
    createdAt: v.number(),
  })
    .index("by_host_status", ["hostId", "status"])
    .index("by_command_id", ["commandId"]),

  // Control-plane command queue: the orchestrator enqueues, gateways
  // subscribe and ack (outbound-only — Convex cloud cannot reach tailnet
  // addresses, so gateways are never dialed into).
  commands: defineTable({
    commandId: v.string(),
    devboxId: v.string(),
    kind: v.union(v.literal("start"), v.literal("interrupt")),
    // JSON payload: StartTaskRequest for "start", "{}" for "interrupt".
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("acked")),
    createdAt: v.number(),
  })
    .index("by_devbox_status", ["devboxId", "status"])
    .index("by_command_id", ["commandId"]),

  // Lifecycle events posted by devbox gateways to /devbox/events.
  taskEvents: defineTable({
    taskId: v.string(),
    devboxId: v.string(),
    type: v.string(),
    summary: v.string(),
    ts: v.number(),
  }).index("by_task_id", ["taskId"]),
});
