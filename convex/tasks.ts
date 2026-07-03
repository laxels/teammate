import { v } from "convex/values";
import {
  type InterruptPayload,
  isTerminalTaskStatus,
  type TaskEffort,
  type TaskStatus,
} from "../shared/protocol";
import { stopRejection } from "../src/orchestration";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
  query,
} from "./_generated/server";
import { devboxSecretOk, enqueueCommandRow } from "./commands";
import { devboxByDevboxId } from "./devboxes";
import type { StoredFile } from "./files";
import {
  effortValidator,
  taskFileValidator,
  taskStatusValidator,
} from "./schema";

const MAX_LISTED_TASKS = 50;
const MAX_TASK_EVENTS = 10;

/** The task row for a taskId (unique index lookup), or null. */
export async function taskByTaskId(ctx: QueryCtx, taskId: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
}

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tasks = await ctx.db
      .query("tasks")
      .order("desc")
      .take(MAX_LISTED_TASKS);
    return tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      devboxId: task.devboxId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }));
  },
});

export const getByTaskId = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await taskByTaskId(ctx, args.taskId);
  },
});

/**
 * Tasks anchored to a Slack thread, newest first — how an inbound thread
 * reply finds the work it is about. Multiple tasks can share a thread when
 * one request spawned several.
 */
export const findByChannelThread = internalQuery({
  args: { slackChannel: v.string(), slackThreadTs: v.string() },
  handler: async (ctx, args) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_channel_thread", (q) =>
        q
          .eq("slackChannel", args.slackChannel)
          .eq("slackThreadTs", args.slackThreadTs),
      )
      .collect();
    return tasks
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
      }));
  },
});

export const getWithEvents = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return null;
    }
    const events = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(MAX_TASK_EVENTS);
    return { task, events: events.reverse() };
  },
});

export type NewTaskArgs = {
  taskId: string;
  title: string;
  prompt: string;
  /** Absent for ephemeral tasks: hosts.placeEphemeralTask assigns the devbox
   * (immediately when a slot is free, or after a scale-up when not). */
  devboxId?: string;
  placement?: "ephemeral" | "permanent";
  slackChannel: string;
  slackThreadTs?: string;
  slackUser?: string;
  slackPermalink?: string;
  /** Reasoning effort for the task agent's session (#91). Absent => the
   * gateway's "xhigh" default; set only on an explicit user request. */
  effort?: TaskEffort;
  /** Slack attachments staged in Convex storage (see schema.taskFileValidator).
   * Resolved to URLs and handed to the devbox at start. */
  files?: StoredFile[];
};

/** Plain-function form so other mutations (dashboard retry) can insert a
 * task row inside their own transaction. */
export async function insertTaskRow(
  ctx: MutationCtx,
  args: NewTaskArgs,
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert("tasks", {
    taskId: args.taskId,
    title: args.title,
    prompt: args.prompt,
    status: "queued",
    ...(args.devboxId === undefined ? {} : { devboxId: args.devboxId }),
    ...(args.placement === undefined ? {} : { placement: args.placement }),
    slackChannel: args.slackChannel,
    ...(args.slackThreadTs === undefined
      ? {}
      : { slackThreadTs: args.slackThreadTs }),
    ...(args.slackUser === undefined ? {} : { slackUser: args.slackUser }),
    ...(args.slackPermalink === undefined
      ? {}
      : { slackPermalink: args.slackPermalink }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
    ...(args.files === undefined || args.files.length === 0
      ? {}
      : { files: args.files }),
    createdAt: now,
    updatedAt: now,
  });
}

export const create = internalMutation({
  args: {
    taskId: v.string(),
    title: v.string(),
    prompt: v.string(),
    devboxId: v.optional(v.string()),
    placement: v.optional(
      v.union(v.literal("ephemeral"), v.literal("permanent")),
    ),
    slackChannel: v.string(),
    slackThreadTs: v.optional(v.string()),
    slackUser: v.optional(v.string()),
    slackPermalink: v.optional(v.string()),
    effort: v.optional(effortValidator),
    files: v.optional(v.array(taskFileValidator)),
  },
  handler: async (ctx, args) => {
    await insertTaskRow(ctx, args);
  },
});

/**
 * Cancels a task that is still waiting for ephemeral placement (no devbox
 * assigned, nothing to interrupt). Returns false when the task has already
 * been placed — the caller should interrupt the devbox instead. Records a
 * "stopped" task event so the task's history isn't empty (devbox-path stops
 * get theirs from /devbox/events). Plain-function form so stopTaskCore can
 * cancel inside its caller's transaction.
 */
export async function cancelQueuedRow(
  ctx: MutationCtx,
  taskId: string,
): Promise<boolean> {
  const task = await taskByTaskId(ctx, taskId);
  if (
    task === null ||
    task.devboxId !== undefined ||
    task.status !== "queued"
  ) {
    return false;
  }
  const now = Date.now();
  await ctx.db.patch(task._id, {
    status: "stopped",
    updatedAt: now,
    finishedAt: now,
  });
  await ctx.db.insert("taskEvents", {
    taskId: task.taskId,
    type: "stopped",
    summary: "Cancelled while queued (before a devbox was assigned).",
    ts: now,
  });
  return true;
}

/** Outcome of stopTaskCore; each surface maps kinds to its own wording. */
export type StopTaskOutcome =
  | { kind: "not_found" }
  | { kind: "already_terminal"; status: TaskStatus }
  | { kind: "cancelled_queued" }
  | { kind: "cancel_conflict"; status: TaskStatus }
  | { kind: "rejected"; reason: string }
  | { kind: "interrupted" };

/**
 * Stops a task inside one transaction: cancels in place while queued,
 * otherwise enqueues a taskId-guarded interrupt. Terminal tasks and devboxes
 * that moved on are refused, never interrupted. Callers supply the Slack note
 * texts (each surface attributes its stops differently) and map the outcome
 * to their own result/error strings. Plain-function form so dashboard.stopTask
 * can stop inside its own mutation; the orchestrator's stop_task goes through
 * the tasks.stop wrapper.
 */
export async function stopTaskCore(
  ctx: MutationCtx,
  taskId: string,
  notes: {
    /** Thread note posted when the task is cancelled while still queued
     * (queue cancellations never reach /devbox/events, so this is the only
     * terminal note the thread gets). */
    queuedCancelText: string;
    /** Optional attribution note posted once an interrupt is enqueued — the
     * eventual :octagonal_sign: update doesn't say who asked. */
    interruptRequestedText?: string;
  },
): Promise<StopTaskOutcome> {
  const task = await taskByTaskId(ctx, taskId);
  if (task === null) {
    return { kind: "not_found" };
  }
  if (isTerminalTaskStatus(task.status)) {
    return { kind: "already_terminal", status: task.status };
  }
  if (task.devboxId === undefined) {
    if (await cancelQueuedRow(ctx, taskId)) {
      await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
        taskId,
        text: notes.queuedCancelText,
      });
      return { kind: "cancelled_queued" };
    }
    // Same transaction, so no race: the task is unplaced but not "queued"
    // (a state cancelQueuedRow refuses to touch).
    return { kind: "cancel_conflict", status: task.status };
  }
  const devbox = await devboxByDevboxId(ctx, task.devboxId);
  const rejection = stopRejection(task, devbox);
  if (rejection !== null || devbox === null) {
    return {
      kind: "rejected",
      reason: rejection ?? `devbox ${task.devboxId} is missing`,
    };
  }
  const payload: InterruptPayload = { taskId };
  await enqueueCommandRow(ctx, {
    devboxId: devbox.devboxId,
    kind: "interrupt",
    payload: JSON.stringify(payload),
  });
  if (notes.interruptRequestedText !== undefined) {
    await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
      taskId,
      text: notes.interruptRequestedText,
    });
  }
  return { kind: "interrupted" };
}

export const stop = internalMutation({
  args: {
    taskId: v.string(),
    queuedCancelText: v.string(),
    interruptRequestedText: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<StopTaskOutcome> => {
    return await stopTaskCore(ctx, args.taskId, {
      queuedCancelText: args.queuedCancelText,
      ...(args.interruptRequestedText === undefined
        ? {}
        : { interruptRequestedText: args.interruptRequestedText }),
    });
  },
});

/**
 * Records the task's status-card message. Set-if-absent: concurrent lifecycle
 * notifications can race to post the first card; the first writer wins and
 * later updates all edit that one. A legacy task with no home thread adopts
 * the card as its thread anchor, so subsequent updates (and user replies)
 * finally thread.
 */
export const setSlackCard = internalMutation({
  args: { taskId: v.string(), cardTs: v.string() },
  handler: async (ctx, args) => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return null;
    }
    if (task.slackCardTs !== undefined) {
      // Lost the first-event race: report the winner's canonical anchors so
      // the caller can delete its stray post and thread under the winner.
      return {
        won: false,
        cardTs: task.slackCardTs,
        threadTs: task.slackThreadTs ?? task.slackCardTs,
      };
    }
    await ctx.db.patch(task._id, {
      slackCardTs: args.cardTs,
      ...(task.slackThreadTs === undefined
        ? { slackThreadTs: args.cardTs }
        : {}),
    });
    return {
      won: true,
      cardTs: args.cardTs,
      threadTs: task.slackThreadTs ?? args.cardTs,
    };
  },
});

/** A status-card edit hit message_not_found (card deleted by a human): clear
 * the pointer so the next lifecycle event re-creates the card. */
export const clearSlackCard = internalMutation({
  args: { taskId: v.string(), cardTs: v.string() },
  handler: async (ctx, args) => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task !== null && task.slackCardTs === args.cardTs) {
      await ctx.db.patch(task._id, { slackCardTs: undefined });
    }
  },
});

export const markNudged = internalMutation({
  args: { taskId: v.string(), nudgedAt: v.number() },
  handler: async (ctx, args) => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task !== null) {
      await ctx.db.patch(task._id, { lastNudgedAt: args.nudgedAt });
    }
  },
});

/**
 * Active (queued or running) tasks joined with their latest event timestamp,
 * for the staleness cron. Queued tasks are included because a devbox that
 * dies after claiming but before posting "started" would otherwise leave the
 * task queued forever, unmonitored. `latestActivityMs` falls back to the
 * task's updatedAt when no events have been recorded yet.
 */
export const activeWithLatestEvent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const active = (
      await Promise.all(
        (["queued", "running"] as const).map((status) =>
          ctx.db
            .query("tasks")
            .withIndex("by_status", (q) => q.eq("status", status))
            .collect(),
        ),
      )
    ).flat();
    return await Promise.all(
      active.map(async (task) => {
        const latest = await ctx.db
          .query("taskEvents")
          .withIndex("by_task_id", (q) => q.eq("taskId", task.taskId))
          .order("desc")
          .first();
        return {
          taskId: task.taskId,
          title: task.title,
          devboxId: task.devboxId,
          slackChannel: task.slackChannel,
          slackThreadTs: task.slackThreadTs,
          lastNudgedAt: task.lastNudgedAt,
          latestActivityMs: latest?.ts ?? task.updatedAt,
        };
      }),
    );
  },
});

/**
 * Boot-time orphan check for gateways. A freshly started gateway owns no
 * sessions, so anything this returns was lost with the previous gateway
 * process — the gateway fails these loudly instead of letting them hang
 * silently. Two kinds of orphan:
 *
 *   1. `running` tasks assigned to this devbox — the session died mid-task.
 *   2. `queued` tasks assigned to this devbox whose `start` command has
 *      already left "pending" (claimed or acked). With the claim lifecycle a
 *      delivered command is never redelivered, so a gateway that claimed a
 *      `start` and then crashed before the session emitted "started" would
 *      otherwise strand the task as queued until the 15-min staleness cron.
 *      A still-"pending" start is *not* an orphan: it has not been delivered
 *      yet and this booting gateway will consume it normally.
 */
export const orphansForDevbox = query({
  args: { devboxId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!devboxSecretOk(args.secret)) {
      return [];
    }
    const running = (
      await ctx.db
        .query("tasks")
        .withIndex("by_status", (q) => q.eq("status", "running"))
        .collect()
    ).filter((task) => task.devboxId === args.devboxId);

    // Queued tasks whose start command was already delivered to a dead
    // process. A delivered start is one no longer "pending" (claimed/acked).
    const deliveredStartTaskIds = new Set<string>();
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_devbox_status", (q) => q.eq("devboxId", args.devboxId))
      .collect();
    for (const command of commands) {
      if (command.kind !== "start" || command.status === "pending") {
        continue;
      }
      try {
        const payload = JSON.parse(command.payload) as { taskId?: unknown };
        if (typeof payload.taskId === "string") {
          deliveredStartTaskIds.add(payload.taskId);
        }
      } catch {
        // A malformed payload can't be correlated to a task; skip it.
      }
    }
    const strandedQueued =
      deliveredStartTaskIds.size === 0
        ? []
        : (
            await ctx.db
              .query("tasks")
              .withIndex("by_status", (q) => q.eq("status", "queued"))
              .collect()
          ).filter(
            (task) =>
              task.devboxId === args.devboxId &&
              deliveredStartTaskIds.has(task.taskId),
          );

    return [...running, ...strandedQueued].map((task) => ({
      taskId: task.taskId,
      title: task.title,
    }));
  },
});

/**
 * Admin escape hatch for repairing task state (e.g. after an event-ordering
 * bug or a devbox lost mid-task):
 *   npx convex run tasks:forceStatus '{"taskId": "...", "status": "completed"}'
 */
export const forceStatus = internalMutation({
  args: { taskId: v.string(), status: taskStatusValidator },
  handler: async (ctx, args) => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return { ok: false };
    }
    await ctx.db.patch(task._id, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});
