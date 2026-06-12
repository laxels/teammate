import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Upsert: the latest upload wins (a steered follow-up turn after completion
 * re-uploads a fresher snapshot). */
export const store = internalMutation({
  args: { taskId: v.string(), devboxId: v.string(), json: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("transcripts")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
    const row = {
      taskId: args.taskId,
      devboxId: args.devboxId,
      json: args.json,
      uploadedAt: Date.now(),
    };
    if (existing === null) {
      await ctx.db.insert("transcripts", row);
    } else {
      await ctx.db.replace(existing._id, row);
    }
  },
});

export const getByTaskId = internalQuery({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("transcripts")
      .withIndex("by_task_id", (q) => q.eq("taskId", args.taskId))
      .unique();
  },
});
