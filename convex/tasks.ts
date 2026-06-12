import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { taskStatusValidator } from "./schema";

const MAX_LISTED_TASKS = 50;
const MAX_TASK_EVENTS = 10;

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
    return await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
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
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
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
 * get theirs from /devbox/events).
 */
/** Plain-function form so dashboard.stop can cancel inside its own
 * transaction. */
export async function cancelQueuedRow(
  ctx: MutationCtx,
  taskId: string,
): Promise<boolean> {
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
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

export const cancelQueued = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await cancelQueuedRow(ctx, args.taskId);
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
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
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
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (task !== null && task.slackCardTs === args.cardTs) {
      await ctx.db.patch(task._id, { slackCardTs: undefined });
    }
  },
});

export const markNudged = internalMutation({
  args: { taskId: v.string(), nudgedAt: v.number() },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
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
 * Admin escape hatch for repairing task state (e.g. after an event-ordering
 * bug or a devbox lost mid-task):
 *   npx convex run tasks:forceStatus '{"taskId": "...", "status": "completed"}'
 */
export const forceStatus = internalMutation({
  args: { taskId: v.string(), status: taskStatusValidator },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
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
