import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

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
    // Process asynchronously — the HTTP handler must ack within 3 seconds.
    await ctx.scheduler.runAfter(0, internal.orchestrator.processSlackEvent, {
      eventId: args.eventId,
    });
    return { duplicate: false };
  },
});

export const getEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("slackEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
  },
});

export const markProcessed = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("slackEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (event !== null && !event.processed) {
      await ctx.db.patch(event._id, { processed: true });
    }
  },
});
