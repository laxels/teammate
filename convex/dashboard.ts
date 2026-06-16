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
import type { Doc, Id } from "./_generated/dataModel";
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

// The task-details retro timeline (#70) folds in tool calls/results, so a
// busy computer-use task emits far more than the old ~6 status events. Take a
// generous chronological slice; screenshots ride as storageId references
// (resolved to URLs below), never inline bytes, so the payload stays bounded.
const MAX_DETAIL_EVENTS = 2000;

/** Every non-terminal task (queued/running/needs_input), newest first — the
 * dashboard's live board. Unpaginated: bounded by fleet capacity in practice. */
export const activeTasks = query({
  args: { secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return [];
    }
    const active = (
      await Promise.all(
        (["queued", "running", "needs_input"] as const).map((status) =>
          ctx.db
            .query("tasks")
            .withIndex("by_status", (q) => q.eq("status", status))
            .collect(),
        ),
      )
    ).flat();
    const sorted = active.sort((a, b) => b.createdAt - a.createdAt);
    return await Promise.all(
      sorted.map(async (task) => {
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
          ...publicTask(task),
          monitoringUrl:
            devbox === null ? null : monitoringUrl(devbox.gatewayUrl),
          devboxStatus: devbox?.status ?? null,
        };
      }),
    );
  },
});

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
    // Chronological (insertion-ordered) so the timeline reads start -> end and
    // aligns with the recording. Info events (#70) carry detail/tool plus an
    // optional screenshot, resolved to a URL here so the dashboard never sees a
    // raw storageId.
    const eventRows = await ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .order("asc")
      .take(MAX_DETAIL_EVENTS);
    const events = await Promise.all(
      eventRows.map(async (e) => ({
        type: e.type,
        summary: e.summary,
        ts: e.ts,
        detail: e.detail ?? null,
        tool: e.tool ?? null,
        imageUrl:
          e.imageStorageId === undefined
            ? null
            : await ctx.storage.getUrl(e.imageStorageId),
      })),
    );
    const devbox =
      task.devboxId === undefined
        ? null
        : await ctx.db
            .query("devboxes")
            .withIndex("by_devbox_id", (q) =>
              q.eq("devboxId", task.devboxId as string),
            )
            .unique();
    // Retro comments (#70), oldest first, each with its grabbed frame resolved
    // to a URL. Scoped by taskId, so a retry's comments never bleed in.
    const commentRows = await ctx.db
      .query("comments")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .collect();
    const comments = await Promise.all(
      commentRows
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(async (c) => ({
          id: c._id,
          videoTimeSec: c.videoTimeSec,
          text: c.text,
          imageUrl:
            c.imageStorageId === undefined
              ? null
              : await ctx.storage.getUrl(c.imageStorageId),
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
    );
    // Resolve the recording's storageId to a playable URL here (the dashboard
    // never sees a raw storageId). getUrl is null for a missing/pruned blob, so
    // an "available" recording whose blob vanished safely degrades to a
    // placeholder rather than a broken player. Absent `recording` => the task
    // predates the feature (the page shows "no recording available").
    const recording =
      task.recording === undefined
        ? null
        : {
            status: task.recording.status,
            url:
              task.recording.storageId === undefined
                ? null
                : await ctx.storage.getUrl(task.recording.storageId),
            bytes: task.recording.bytes ?? null,
            uploadedAt: task.recording.uploadedAt ?? null,
            // Wall-clock recorder start; lets the page map a comment's
            // video-relative seconds onto the absolute event timeline.
            startedAt: task.recording.startedAt ?? null,
          };
    return {
      task: { ...publicTask(task), prompt: task.prompt },
      recording,
      events,
      comments,
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
        await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
          taskId: args.taskId,
          text: `:octagonal_sign: *${task.title}* (\`${args.taskId}\`) was cancelled from the dashboard while still queued.`,
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
    // Attribute the stop in the thread — the eventual :octagonal_sign: update
    // doesn't say who asked.
    await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
      taskId: args.taskId,
      text: `:octagonal_sign: Stop requested from the dashboard for *${task.title}* (\`${args.taskId}\`) — a stopped update follows if a turn was in flight.`,
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
    // Keep the Slack thread the durable narrative: dashboard steers must
    // leave the same trace a thread-reply steer would.
    await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
      taskId: args.taskId,
      text: `:compass: Dashboard follow-up for *${task.title}* (\`${args.taskId}\`): ${args.text.slice(0, 300)}`,
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
    if (source.slackThreadTs === undefined) {
      // Pre-threading rows have no home thread: the retry's updates would
      // scatter as top-level messages. Re-asking in Slack creates an anchor.
      return {
        ok: false,
        reason:
          "this legacy task has no home Slack thread for the retry's updates — re-ask in Slack instead",
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
      // Re-run faithfully at the same effort the original was started with (#91);
      // absent => the gateway's xhigh default, same as the source.
      ...(source.effort === undefined ? {} : { effort: source.effort }),
      // Carry the original shared attachments by storageId. Safe to re-use even
      // if a blob was pruned since: the gateway's /devbox/file fetch 404s and
      // it tells the session the file couldn't be downloaded (no silent drop).
      ...(source.files === undefined ? {} : { files: source.files }),
    });
    const placement = await placeEphemeralTaskRow(ctx, retryTaskId);
    await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
      taskId: args.taskId,
      text: `:repeat: *${source.title}* (\`${args.taskId}\`) is being retried from the dashboard as \`${retryTaskId}\` — fresh devbox, same prompt. Status updates will follow in this thread.`,
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

// ---- Retro comments on a task's screen recording (#70) ----
// Capture + persist only: feeding comments back to the agent is a separate
// ticket. Authored anonymously under the shared DASHBOARD_SECRET, like every
// other dashboard mutation.

/** Hard cap on a comment's text so one row can't approach Convex's doc limit. */
const MAX_COMMENT_CHARS = 10_000;

type CommentResult =
  | { ok: true; commentId: Id<"comments"> }
  | { ok: false; reason: string };

/**
 * Pin a comment to a video-relative timestamp on a task's recording. The frame
 * grabbed at that timestamp (the host frame-grab endpoint) is referenced by
 * imageStorageId; absent when the grab failed, yielding a text-only comment.
 * Post-hoc only — the recording must be finalized ("available").
 */
export const createComment = mutation({
  args: {
    secret: v.string(),
    taskId: v.string(),
    videoTimeSec: v.number(),
    text: v.string(),
    imageStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args): Promise<CommentResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    const text = args.text.trim();
    if (text === "") {
      return { ok: false, reason: "comment is empty" };
    }
    if (!Number.isFinite(args.videoTimeSec) || args.videoTimeSec < 0) {
      return { ok: false, reason: "invalid timestamp" };
    }
    const task = await loadTask(ctx, args.taskId);
    if (task === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    if (task.recording?.status !== "available") {
      // Post-hoc only: nothing to anchor a timestamped comment to until the
      // recording is finalized and playable.
      return {
        ok: false,
        reason: "this task has no finalized recording to comment on",
      };
    }
    const now = Date.now();
    const commentId = await ctx.db.insert("comments", {
      taskId: args.taskId,
      videoTimeSec: args.videoTimeSec,
      text: text.slice(0, MAX_COMMENT_CHARS),
      ...(args.imageStorageId === undefined
        ? {}
        : { imageStorageId: args.imageStorageId }),
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, commentId };
  },
});

/**
 * Edit a comment's text. An empty edit deletes the comment (issue decision:
 * "saving an empty edit is equivalent to deleting"), so the semantic holds even
 * if a client forgets to route empties to deleteComment.
 */
export const editComment = mutation({
  args: { secret: v.string(), commentId: v.id("comments"), text: v.string() },
  handler: async (ctx, args): Promise<CommentResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      return { ok: false, reason: "comment not found" };
    }
    const text = args.text.trim();
    if (text === "") {
      await deleteCommentRow(ctx, comment);
      return { ok: true, commentId: args.commentId };
    }
    await ctx.db.patch(args.commentId, {
      text: text.slice(0, MAX_COMMENT_CHARS),
      updatedAt: Date.now(),
    });
    return { ok: true, commentId: args.commentId };
  },
});

export const deleteComment = mutation({
  args: { secret: v.string(), commentId: v.id("comments") },
  handler: async (ctx, args): Promise<CommentResult> => {
    if (!secretOk(args.secret)) {
      return { ok: false, reason: "unauthorized" };
    }
    const comment = await ctx.db.get(args.commentId);
    if (comment === null) {
      return { ok: false, reason: "comment not found" };
    }
    await deleteCommentRow(ctx, comment);
    return { ok: true, commentId: args.commentId };
  },
});

/** Delete a comment row plus its grabbed frame blob (best-effort — a missing
 * blob must not block the row delete). */
async function deleteCommentRow(
  ctx: MutationCtx,
  comment: Doc<"comments">,
): Promise<void> {
  if (comment.imageStorageId !== undefined) {
    await ctx.storage.delete(comment.imageStorageId).catch(() => undefined);
  }
  await ctx.db.delete(comment._id);
}
