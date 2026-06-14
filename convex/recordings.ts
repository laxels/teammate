import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { recordingStatusValidator } from "./schema";

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
    await ctx.db.patch(task._id, {
      recording: {
        status: args.status,
        ...(args.storageId === undefined ? {} : { storageId: args.storageId }),
        ...(args.bytes === undefined ? {} : { bytes: args.bytes }),
        ...(args.status === "available" ? { uploadedAt: Date.now() } : {}),
      },
    });
    return { applied: true };
  },
});
