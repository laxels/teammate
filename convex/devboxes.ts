import { v } from "convex/values";
import {
  DEVBOX_EVENT_TO_TASK_STATUS,
  shouldApplyTaskStatus,
} from "../shared/protocol";
import { internalMutation, internalQuery } from "./_generated/server";

export const devboxEventTypeValidator = v.union(
  v.literal("started"),
  v.literal("progress"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

/** Devbox statuses that mean "occupied by a task". */
const BUSY_EVENT_TYPES = new Set(["started", "progress", "needs_input"]);

/**
 * v1 manual registration — call from the Convex dashboard or CLI after
 * provisioning a devbox VM:
 *   npx convex run devboxes:registerDevbox '{"devboxId": "...", "gatewayUrl": "http://<tailnet-host>:8787"}'
 * Upserts by devboxId and resets the devbox to warm.
 */
export const registerDevbox = internalMutation({
  args: { devboxId: v.string(), gatewayUrl: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        gatewayUrl: args.gatewayUrl,
        status: "warm",
        taskId: undefined,
        lastSeenAt: Date.now(),
      });
      return { created: false };
    }
    await ctx.db.insert("devboxes", {
      devboxId: args.devboxId,
      gatewayUrl: args.gatewayUrl,
      status: "warm",
      lastSeenAt: Date.now(),
    });
    return { created: true };
  },
});

export const getByDevboxId = internalQuery({
  args: { devboxId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
  },
});

/**
 * Atomically claims a warm devbox for a task (marks it busy). Returns null
 * when no devbox is warm. Mutations are serialized, so two concurrent task
 * starts cannot claim the same devbox.
 */
/**
 * A devbox only counts as alive if its gateway heartbeated recently — task
 * delivery is via the command queue, so a dead gateway would otherwise accept
 * claims forever.
 */
export const HEARTBEAT_FRESHNESS_MS = 2 * 60_000;

export const claimWarm = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const devboxes = await ctx.db.query("devboxes").collect();
    const cutoff = Date.now() - HEARTBEAT_FRESHNESS_MS;
    const warm = devboxes.find(
      (d) => d.status === "warm" && d.lastSeenAt >= cutoff,
    );
    if (warm === undefined) {
      return null;
    }
    await ctx.db.patch(warm._id, {
      status: "busy",
      taskId: args.taskId,
      lastSeenAt: Date.now(),
    });
    return { devboxId: warm.devboxId, gatewayUrl: warm.gatewayUrl };
  },
});

/** Returns a claimed devbox to the warm pool (e.g. when /task POST fails). */
export const release = internalMutation({
  args: { devboxId: v.string() },
  handler: async (ctx, args) => {
    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox !== null) {
      await ctx.db.patch(devbox._id, { status: "warm", taskId: undefined });
    }
  },
});

/**
 * Records a DevboxEvent posted by a gateway: appends to taskEvents, moves the
 * task to the mapped TaskStatus, and refreshes the devbox row (lastSeenAt +
 * busy/warm). Returns whether the task exists so the caller can decide
 * whether to notify Slack.
 */
export const recordEvent = internalMutation({
  args: {
    devboxId: v.string(),
    taskId: v.string(),
    type: devboxEventTypeValidator,
    summary: v.string(),
    ts: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      devboxId: args.devboxId,
      type: args.type,
      summary: args.summary,
      ts: args.ts,
    });

    const incomingStatus = DEVBOX_EVENT_TO_TASK_STATUS[args.type];
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    // Events can arrive out of order (concurrent POSTs, retries): a late
    // non-terminal event must never regress a terminal task status, and must
    // not re-mark the devbox busy for an already-finished task.
    const applied =
      task !== null && shouldApplyTaskStatus(task.status, incomingStatus);
    if (task !== null && applied) {
      await ctx.db.patch(task._id, {
        status: incomingStatus,
        devboxId: args.devboxId,
        updatedAt: Date.now(),
      });
    }

    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox !== null) {
      if (applied || task === null) {
        const busy = BUSY_EVENT_TYPES.has(args.type);
        await ctx.db.patch(devbox._id, {
          status: busy ? "busy" : "warm",
          taskId: busy ? args.taskId : undefined,
          lastSeenAt: Date.now(),
        });
      } else {
        await ctx.db.patch(devbox._id, { lastSeenAt: Date.now() });
      }
    }

    return { taskFound: task !== null, applied };
  },
});
