import { v } from "convex/values";
import {
  DEVBOX_EVENT_TO_TASK_STATUS,
  EPHEMERAL_RETIRE_GRACE_MS,
  shouldApplyTaskStatus,
} from "../shared/protocol";
import { shouldRetireEphemeralDevbox } from "../src/hostPool";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { devboxEventTypeValidator, HEARTBEAT_FRESHNESS_MS } from "./constants";

/** Devbox statuses that mean "occupied by a task". */
const BUSY_EVENT_TYPES = new Set(["started", "progress", "needs_input"]);

/**
 * v1 manual registration — call from the Convex dashboard or CLI after
 * provisioning a devbox VM:
 *   npx convex run devboxes:registerDevbox '{"devboxId": "...", "gatewayUrl": "http://<tailnet-host>:8787"}'
 * Upserts by devboxId and resets the devbox to warm.
 */
export const registerDevbox = internalMutation({
  args: {
    devboxId: v.string(),
    gatewayUrl: v.string(),
    // The Mac host whose VM slots this devbox occupies. Without it the
    // capacity accounting in hosts.allocateEphemeral cannot see the VM and
    // may oversubscribe the host (Apple EULA: 2 VMs max).
    hostId: v.optional(v.string()),
  },
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
        ...(args.hostId === undefined ? {} : { hostId: args.hostId }),
      });
      return { created: false };
    }
    await ctx.db.insert("devboxes", {
      devboxId: args.devboxId,
      gatewayUrl: args.gatewayUrl,
      status: "warm",
      lastSeenAt: Date.now(),
      ...(args.hostId === undefined ? {} : { hostId: args.hostId }),
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
 * claims forever (freshness window: HEARTBEAT_FRESHNESS_MS in constants.ts).
 */
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
      // Events for a task that is NOT the devbox's current assignment must
      // not clobber the devbox row (e.g. a late event from a previous task
      // racing a new claim). Any event still proves liveness, so lastSeenAt
      // is always refreshed. "retiring" is a one-way street: nothing short of
      // destruction takes a devbox out of it.
      const isCurrentAssignment =
        devbox.taskId === undefined || devbox.taskId === args.taskId;
      const eligible = devbox.status !== "retiring" && isCurrentAssignment;
      const retire =
        eligible &&
        shouldRetireEphemeralDevbox({
          ephemeral: devbox.ephemeral,
          statusApplied: applied,
          incomingStatus,
        });
      if (retire) {
        // Ephemeral devboxes never return to the warm pool — no task ever
        // runs on a previous task's VM. The VM stays up (monitoring page,
        // final event flush) for the grace period, then the host agent gets
        // the destroy command.
        await ctx.db.patch(devbox._id, {
          status: "retiring",
          taskId: undefined,
          lastSeenAt: Date.now(),
        });
        await ctx.scheduler.runAfter(
          EPHEMERAL_RETIRE_GRACE_MS,
          internal.hosts.retireDevbox,
          { devboxId: args.devboxId },
        );
      } else if (eligible && (applied || task === null)) {
        const busy = BUSY_EVENT_TYPES.has(args.type);
        if (busy || devbox.ephemeral !== true) {
          await ctx.db.patch(devbox._id, {
            status: busy ? "busy" : "warm",
            taskId: busy ? args.taskId : undefined,
            lastSeenAt: Date.now(),
          });
        } else {
          // Non-busy event on an ephemeral devbox that didn't qualify for
          // retire (e.g. its task row is missing): never park it as
          // claimable "warm".
          await ctx.db.patch(devbox._id, { lastSeenAt: Date.now() });
        }
      } else {
        await ctx.db.patch(devbox._id, { lastSeenAt: Date.now() });
      }
    }

    return { taskFound: task !== null, applied };
  },
});
