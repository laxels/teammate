// Fleet-dashboard API: the only public Convex surface besides the gateway
// command queue. The dashboard SPA is served tailnet-only (host-1, Tailscale
// Serve) and authenticates with DASHBOARD_SECRET — a separate trust tier from
// DEVBOX_SHARED_SECRET (operator vs gateway), passed as a function argument
// like commands.pendingFor. Unset/empty secret denies everything.

import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  type InterruptPayload,
  isTerminalTaskStatus,
  type UserMessagePayload,
} from "../shared/protocol";
import {
  monitoringUrl,
  steerRejection,
  stopRejection,
} from "../src/orchestration";
import { timingSafeEqual } from "../src/slack";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { enqueueCommandRow } from "./commands";
import { fleetSnapshotData, placeEphemeralTaskRow } from "./hosts";
import { taskStatusValidator } from "./schema";
import { cancelQueuedRow, insertTaskRow } from "./tasks";

function secretOk(secret: string): boolean {
  const expected = process.env.DASHBOARD_SECRET;
  const ok =
    expected !== undefined &&
    expected !== "" &&
    timingSafeEqual(secret, expected);
  if (!ok) {
    console.warn(
      "dashboard: secret mismatch (or DASHBOARD_SECRET unset); denying request",
    );
  }
  return ok;
}

/** The slice of a task row the dashboard renders. */
function publicTask(task: Doc<"tasks">) {
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    placement: task.placement,
    devboxId: task.devboxId,
    slackChannel: task.slackChannel,
    slackThreadTs: task.slackThreadTs,
    slackUser: task.slackUser,
    slackPermalink: task.slackPermalink,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

const MAX_DETAIL_EVENTS = 50;

/** Paginated task list, newest first, optionally filtered by status. */
export const listTasks = query({
  args: {
    secret: v.string(),
    paginationOpts: paginationOptsValidator,
    status: v.optional(taskStatusValidator),
  },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const results =
      args.status === undefined
        ? await ctx.db
            .query("tasks")
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("tasks")
            .withIndex("by_status", (q) =>
              q.eq("status", args.status as Doc<"tasks">["status"]),
            )
            .order("desc")
            .paginate(args.paginationOpts);
    return { ...results, page: results.page.map(publicTask) };
  },
});

/** One task with its event trail and (when alive) monitoring link. */
export const taskDetail = query({
  args: { secret: v.string(), taskId: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return null;
    }
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
      .take(MAX_DETAIL_EVENTS);
    const devbox =
      task.devboxId === undefined
        ? null
        : await ctx.db
            .query("devboxes")
            .withIndex("by_devbox_id", (q) =>
              q.eq("devboxId", task.devboxId as string),
            )
            .unique();
    return {
      task: { ...publicTask(task), prompt: task.prompt },
      events: events.reverse().map((e) => ({
        type: e.type,
        summary: e.summary,
        ts: e.ts,
      })),
      // The devbox row's existence is the liveness signal: rows are deleted
      // when the VM is destroyed, and the monitoring page dies with the VM.
      monitoringUrl: devbox === null ? null : monitoringUrl(devbox.gatewayUrl),
      devboxStatus: devbox?.status ?? null,
    };
  },
});

export const fleet = query({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return null;
    }
    return await fleetSnapshotData(ctx);
  },
});

type ActionResult =
  | { ok: true; taskId: string; note: string }
  | { ok: false; reason: string };

async function loadTask(
  ctx: MutationCtx,
  taskId: string,
): Promise<Doc<"tasks"> | null> {
  return await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
}

async function loadDevbox(ctx: MutationCtx, devboxId: string | undefined) {
  return devboxId === undefined
    ? null
    : await ctx.db
        .query("devboxes")
        .withIndex("by_devbox_id", (q) => q.eq("devboxId", devboxId))
        .unique();
}

/**
 * Stop a task: cancels in place while queued, otherwise enqueues a
 * taskId-guarded interrupt. Same guards as the orchestrator's stop_task —
 * terminal tasks and devboxes that moved on are refused, never interrupted.
 */
export const stopTask = mutation({
  args: { secret: v.string(), taskId: v.string() },
  handler: async (ctx, args): Promise<ActionResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    const task = await loadTask(ctx, args.taskId);
    if (task === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    if (isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        reason: `task is already ${task.status} — nothing to stop`,
      };
    }
    if (task.devboxId === undefined) {
      if (await cancelQueuedRow(ctx, args.taskId)) {
        await ctx.scheduler.runAfter(0, internal.notify.taskCancelled, {
          taskId: args.taskId,
        });
        return {
          ok: true,
          taskId: args.taskId,
          note: "cancelled while queued (no devbox was assigned yet)",
        };
      }
      return { ok: false, reason: "task state changed underneath — try again" };
    }
    const devbox = await loadDevbox(ctx, task.devboxId);
    const rejection = stopRejection(task, devbox);
    if (rejection !== null || devbox === null) {
      return { ok: false, reason: rejection ?? "devbox is missing" };
    }
    const payload: InterruptPayload = { taskId: args.taskId };
    await enqueueCommandRow(ctx, {
      devboxId: devbox.devboxId,
      kind: "interrupt",
      payload: JSON.stringify(payload),
    });
    return {
      ok: true,
      taskId: args.taskId,
      note: "interrupt queued — a 'stopped' update will follow if a turn was in flight",
    };
  },
});

/**
 * Follow-up: relay a message into the live session (same primitive as the
 * monitoring page's steering box and Slack thread replies).
 */
export const steerTask = mutation({
  args: { secret: v.string(), taskId: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<ActionResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    if (args.text.trim() === "") {
      return { ok: false, reason: "message is empty" };
    }
    const task = await loadTask(ctx, args.taskId);
    if (task === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    const devbox = await loadDevbox(ctx, task.devboxId);
    const rejection = steerRejection(task, devbox);
    if (rejection !== null || devbox === null) {
      return { ok: false, reason: rejection ?? "devbox is missing" };
    }
    const payload: UserMessagePayload = {
      taskId: args.taskId,
      text: args.text,
    };
    await enqueueCommandRow(ctx, {
      devboxId: devbox.devboxId,
      kind: "user_message",
      payload: JSON.stringify(payload),
    });
    return {
      ok: true,
      taskId: args.taskId,
      note: "message queued for the live session (dropped if the task finishes first)",
    };
  },
});

/**
 * Retry: a NEW task with the same prompt on a fresh ephemeral devbox,
 * sharing the original's Slack thread so its updates land in the same story.
 * Honest semantics — the original VM and session are gone; this is a re-run,
 * not a resume.
 */
export const retryTask = mutation({
  args: { secret: v.string(), taskId: v.string() },
  handler: async (ctx, args): Promise<ActionResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    const source = await loadTask(ctx, args.taskId);
    if (source === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    if (!isTerminalTaskStatus(source.status)) {
      return {
        ok: false,
        reason: `task is still ${source.status} — stop it first or send a follow-up instead`,
      };
    }
    const retryTaskId = `task-${crypto.randomUUID().slice(0, 8)}`;
    await insertTaskRow(ctx, {
      taskId: retryTaskId,
      title: source.title,
      prompt: source.prompt,
      placement: "ephemeral",
      slackChannel: source.slackChannel,
      ...(source.slackThreadTs === undefined
        ? {}
        : { slackThreadTs: source.slackThreadTs }),
      ...(source.slackUser === undefined
        ? {}
        : { slackUser: source.slackUser }),
      ...(source.slackPermalink === undefined
        ? {}
        : { slackPermalink: source.slackPermalink }),
    });
    const placement = await placeEphemeralTaskRow(ctx, retryTaskId);
    await ctx.scheduler.runAfter(0, internal.notify.taskRetried, {
      taskId: args.taskId,
      retryTaskId,
    });
    return {
      ok: true,
      taskId: retryTaskId,
      note: placement.placed
        ? "retry placed on a fresh devbox (~1-2 min to provision)"
        : "retry queued — every VM slot is busy (the fleet may be scaling up)",
    };
  },
});
