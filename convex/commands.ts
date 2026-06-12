import { v } from "convex/values";
import { timingSafeEqual } from "../src/slack";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";

export const commandKindValidator = v.union(
  v.literal("start"),
  v.literal("interrupt"),
);

/**
 * Gateways authenticate with the same shared secret used for /devbox/events,
 * passed as a function argument (gateways are Convex clients, so there are no
 * request headers). On mismatch the functions no-op rather than throw: a
 * misconfigured gateway sees an empty queue instead of generating error spam.
 * A console.warn still records the mismatch for diagnosability.
 */
function secretOk(secret: string): boolean {
  const expected = process.env.DEVBOX_SHARED_SECRET;
  const ok =
    expected !== undefined &&
    expected !== "" &&
    timingSafeEqual(secret, expected);
  if (!ok) {
    console.warn(
      "commands: devbox shared secret mismatch (or DEVBOX_SHARED_SECRET unset); ignoring request",
    );
  }
  return ok;
}

/** Reactive query a gateway subscribes to for its own pending commands. */
export const pendingFor = query({
  args: { devboxId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return [];
    }
    const rows = await ctx.db
      .query("commands")
      .withIndex("by_devbox_status", (q) =>
        q.eq("devboxId", args.devboxId).eq("status", "pending"),
      )
      .collect();
    return rows
      .map((row) => ({
        commandId: row.commandId,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const ack = mutation({
  args: { commandId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const row = await ctx.db
      .query("commands")
      .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
      .unique();
    if (row !== null && row.status === "pending") {
      await ctx.db.patch(row._id, { status: "acked" });
    }
  },
});

/** Liveness signal; claimWarm only hands tasks to recently-seen devboxes. */
export const heartbeat = mutation({
  args: { devboxId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox !== null) {
      await ctx.db.patch(devbox._id, { lastSeenAt: Date.now() });
    }
  },
});

/** Plain-function form so other mutations (hosts.ts placement) can enqueue
 * gateway commands inside their own transaction. */
export async function enqueueCommandRow(
  ctx: MutationCtx,
  args: { devboxId: string; kind: "start" | "interrupt"; payload: string },
): Promise<string> {
  const commandId = `cmd-${crypto.randomUUID().slice(0, 8)}`;
  await ctx.db.insert("commands", {
    commandId,
    devboxId: args.devboxId,
    kind: args.kind,
    payload: args.payload,
    status: "pending",
    createdAt: Date.now(),
  });
  return commandId;
}

export const enqueue = internalMutation({
  args: {
    devboxId: v.string(),
    kind: commandKindValidator,
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    return await enqueueCommandRow(ctx, args);
  },
});
