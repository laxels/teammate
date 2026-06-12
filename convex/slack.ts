import { v } from "convex/values";
import { shouldRetrySlackEvent } from "../src/orchestration";
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

/**
 * Atomically claims an event for processing (processed false -> true).
 * Returns false when the event is missing or already claimed, so racing
 * invocations (the original schedule vs a dead-letter retry) can never both
 * run the side-effecting tool loop for the same event.
 */
export const claimEvent = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const event = await ctx.db
      .query("slackEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (event === null || event.processed) {
      return false;
    }
    await ctx.db.patch(event._id, { processed: true });
    return true;
  },
});

const MAX_RETRIES_PER_SWEEP = 10;

/**
 * Dead-letter recovery (cron): re-schedules processing for events whose
 * action died before claiming them — a deploy restart, an OOM, a crash
 * before the claim. Anything that reached the claim is marked processed and
 * is never replayed, so this sweep can't duplicate tool side effects.
 * Slack's own retries can't recover these rows: they dedupe on event_id
 * without re-scheduling.
 */
export const retryUnprocessed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const candidates = await ctx.db
      .query("slackEvents")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .take(100);
    const retryable = candidates
      .filter((event) =>
        shouldRetrySlackEvent({
          nowMs: now,
          receivedAtMs: event.receivedAt,
          processed: event.processed,
        }),
      )
      .slice(0, MAX_RETRIES_PER_SWEEP);
    for (const event of retryable) {
      console.log(`retrying stranded slack event ${event.eventId}`);
      await ctx.scheduler.runAfter(0, internal.orchestrator.processSlackEvent, {
        eventId: event.eventId,
      });
    }
    return { retried: retryable.length };
  },
});
