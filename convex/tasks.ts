import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

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
    devboxId: v.string(),
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
      devboxId: args.devboxId,
      slackChannel: args.slackChannel,
      ...(args.slackThreadTs === undefined
        ? {}
        : { slackThreadTs: args.slackThreadTs }),
      createdAt: now,
      updatedAt: now,
    });
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
 * Running tasks joined with their latest event timestamp, for the staleness
 * cron. `latestActivityMs` falls back to the task's updatedAt when no events
 * have been recorded yet.
 */
export const runningWithLatestEvent = internalQuery({
  args: {},
  handler: async (ctx) => {
    const running = await ctx.db
      .query("tasks")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
    return await Promise.all(
      running.map(async (task) => {
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
