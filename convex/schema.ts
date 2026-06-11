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

  // Devbox VMs (manually registered in v1 via devboxes.registerDevbox).
  devboxes: defineTable({
    devboxId: v.string(),
    gatewayUrl: v.string(),
    status: v.union(v.literal("warm"), v.literal("busy"), v.literal("offline")),
    taskId: v.optional(v.string()),
    lastSeenAt: v.number(),
  }).index("by_devbox_id", ["devboxId"]),

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
