import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { recordingStatusValidator } from "./schema";

/**
 * Resolves a task's stored recording to a short-lived signed storage URL, or
 * null when the task/recording is missing, not yet "available", or its blob was
 * pruned. The fleet host's frame-grab endpoint (#70) calls this — via the
 * secret-gated /devbox/recording-url route — so it can ffmpeg-seek the recording
 * WITHOUT the browser ever supplying a URL or seeing a raw storageId.
 */
export const signedUrl = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    const storageId = task?.recording?.storageId;
    if (task?.recording?.status !== "available" || storageId === undefined) {
      return null;
    }
    return await ctx.storage.getUrl(storageId);
  },
});

/**
 * Records a devbox screen-recording lifecycle transition on the task row (see
 * gateway/src/recorder.ts and shared/protocol.ts RecordingStatus). Posted by
 * the gateway via the secret-gated /devbox/recording endpoint:
 *   "recording" at task start, "uploading" once it ends, then "available"
 *   (with the stored storageId) or "failed".
 *
 * "available" is the success terminal: once set it is never regressed, so a
 * late/out-of-order "uploading" can't strand a playable recording, and a
 * duplicate POST is a no-op. A missing task is ignored (the VM may outlive a
 * pruned row); nothing else in the system depends on this write.
 */
export const setStatus = internalMutation({
  args: {
    taskId: v.string(),
    status: recordingStatusValidator,
    storageId: v.optional(v.id("_storage")),
    bytes: v.optional(v.number()),
    // Recorder wall-clock start (ms), sent with the first "recording" post (#70).
    startedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    if (task === null) {
      return { applied: false };
    }
    // Never regress a playable recording: the upload succeeded, so a stale
    // earlier-phase POST racing it must not erase the storageId.
    if (task.recording?.status === "available") {
      return { applied: false };
    }
    // startedAt is set once (with the first "recording" post) and preserved
    // across every later transition — the "uploading"/"available" posts don't
    // resend it, so carry forward whatever was already stored.
    const startedAt = args.startedAt ?? task.recording?.startedAt;
    await ctx.db.patch(task._id, {
      recording: {
        status: args.status,
        ...(args.storageId === undefined ? {} : { storageId: args.storageId }),
        ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
        ...(args.status === "available" ? { uploadedAt: Date.now() } : {}),
        ...(startedAt === undefined ? {} : { startedAt }),
      },
    });
    return { applied: true };
  },
});
