import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Idempotent ingestion: Slack redelivers events that aren't acked within 3s,
// and the same event can arrive on multiple retries (x-slack-retry-num).
export const recordEvent = internalMutation({
  args: {
    eventId: v.string(),
    type: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("slackEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing !== null) {
      return { duplicate: true };
    }
    await ctx.db.insert("slackEvents", {
      eventId: args.eventId,
      type: args.type,
      payload: args.payload,
      receivedAt: Date.now(),
      processed: false,
    });
    return { duplicate: false };
  },
});
