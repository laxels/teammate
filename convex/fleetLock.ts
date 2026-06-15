import { v } from "convex/values";
import { clampTtlMs, decideAcquire } from "../src/fleetLock";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";

// Authoritative, cross-origin fleet lock (see src/fleetLock.ts + the fleetLocks
// table in schema.ts). These are internalMutations: the only external door is
// the secret-gated /fleet/lock/* HTTP endpoints (http.ts), so a caller without
// DEVBOX_SHARED_SECRET can't touch the lock. Convex serializes mutations, so
// the read-decide-write below has no race — exactly one contender wins an
// acquire/steal. The future #88 capacity monitor calls these directly.

// Read-only lookup, so it takes a QueryCtx and the mutations (whose ctx.db is a
// superset) can share it with the `get` query.
async function lockRow(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("fleetLocks")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

export type AcquireResult =
  | { acquired: true; holder: string; expiresAt: number; stolenFrom?: string }
  | { acquired: false; heldBy: string; expiresAt: number };

export const acquire = internalMutation({
  args: {
    name: v.string(),
    holder: v.string(),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AcquireResult> => {
    const now = Date.now();
    const expiresAt = now + clampTtlMs(args.ttlMs);
    const existing = await lockRow(ctx, args.name);
    const decision = decideAcquire({
      existing,
      holder: args.holder,
      nowMs: now,
    });
    if (decision.action === "reject") {
      return {
        acquired: false,
        heldBy: decision.heldBy,
        expiresAt: decision.expiresAt,
      };
    }
    if (existing === null) {
      await ctx.db.insert("fleetLocks", {
        name: args.name,
        holder: args.holder,
        acquiredAt: now,
        renewedAt: now,
        expiresAt,
      });
      return { acquired: true, holder: args.holder, expiresAt };
    }
    // renew (same holder) or steal (expired lease): adopt the row in place.
    await ctx.db.patch(existing._id, {
      holder: args.holder,
      acquiredAt: decision.action === "steal" ? now : existing.acquiredAt,
      renewedAt: now,
      expiresAt,
    });
    return {
      acquired: true,
      holder: args.holder,
      expiresAt,
      ...(decision.action === "steal"
        ? { stolenFrom: decision.stolenFrom }
        : {}),
    };
  },
});

export type RenewResult =
  | { renewed: true; expiresAt: number }
  | { renewed: false; heldBy: string | null };

export const renew = internalMutation({
  args: {
    name: v.string(),
    holder: v.string(),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RenewResult> => {
    const existing = await lockRow(ctx, args.name);
    // Only the current holder of a live row may renew. A holder whose lease was
    // already stolen (row gone, or owned by someone else) learns it lost the
    // lease instead of silently extending a lock it no longer owns.
    if (existing === null || existing.holder !== args.holder) {
      return { renewed: false, heldBy: existing?.holder ?? null };
    }
    const now = Date.now();
    const expiresAt = now + clampTtlMs(args.ttlMs);
    await ctx.db.patch(existing._id, { renewedAt: now, expiresAt });
    return { renewed: true, expiresAt };
  },
});

export const release = internalMutation({
  args: { name: v.string(), holder: v.string() },
  handler: async (ctx, args): Promise<{ released: boolean }> => {
    const existing = await lockRow(ctx, args.name);
    // Idempotent: releasing a lock we no longer own (already stolen/released)
    // is a no-op, never a delete of someone else's lease.
    if (existing === null || existing.holder !== args.holder) {
      return { released: false };
    }
    await ctx.db.delete(existing._id);
    return { released: true };
  },
});

/** Lock state for debugging / the future monitor; null when free. */
export const get = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const existing = await lockRow(ctx, args.name);
    if (existing === null) {
      return null;
    }
    return {
      name: existing.name,
      holder: existing.holder,
      acquiredAt: existing.acquiredAt,
      renewedAt: existing.renewedAt,
      expiresAt: existing.expiresAt,
    };
  },
});
