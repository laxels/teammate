import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
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

export const create = internalMutation({
  args: {
    taskId: v.string(),
    title: v.string(),
    prompt: v.string(),
    // Absent for ephemeral tasks: hosts.placeEphemeralTask assigns the devbox
    // (immediately when a slot is free, or after a scale-up when not).
    devboxId: v.optional(v.string()),
    placement: v.optional(
      v.union(v.literal("ephemeral"), v.literal("permanent")),
    ),
    slackChannel: v.string(),
    slackThreadTs: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
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
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Cancels a task that is still waiting for ephemeral placement (no devbox
 * assigned, nothing to interrupt). Returns false when the task has already
 * been placed — the caller should interrupt the devbox instead.
 */
export const cancelQueued = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (
      task === null ||
      task.devboxId !== undefined ||
      task.status !== "queued"
    ) {
      return false;
    }
    await ctx.db.patch(task._id, { status: "stopped", updatedAt: Date.now() });
    return true;
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
