// Capability manifests for golden devbox images (#138): what cloud agents
// are limited to (installed apps, authed accounts, tooling). Uploaded by
// scripts/upload-capability-manifest.sh (standalone, and as a bake-golden.sh
// step) via POST /fleet/capability-manifest; the latest row is injected into
// the orchestrator's system prompt (buildCapabilitiesSection) so cloud/local
// routing is informed. Only a bake updates it — devbox changes don't
// otherwise persist, so a live-updated manifest would drift into fiction.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const record = internalMutation({
  args: {
    goldenTag: v.string(),
    generated: v.string(),
    curated: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("capabilityManifests")
      .withIndex("by_tag", (q) => q.eq("goldenTag", args.goldenTag))
      .unique();
    const row = {
      goldenTag: args.goldenTag,
      generated: args.generated,
      curated: args.curated,
      updatedAt: Date.now(),
    };
    if (existing === null) {
      await ctx.db.insert("capabilityManifests", row);
    } else {
      await ctx.db.patch(existing._id, row);
    }
    return { goldenTag: args.goldenTag };
  },
});

/** The most recently updated manifest — the fleet converges on one golden
 * (scripts/refresh-golden.sh), so "latest uploaded" tracks "what's serving"
 * without joining host heartbeats. Null until the first upload. Indexed:
 * this runs on every orchestrator turn. */
export const current = internalQuery({
  args: {},
  handler: async (ctx) => {
    const latest = await ctx.db
      .query("capabilityManifests")
      .withIndex("by_updated")
      .order("desc")
      .first();
    if (latest === null) {
      return null;
    }
    return {
      goldenTag: latest.goldenTag,
      generated: latest.generated,
      curated: latest.curated,
      updatedAt: latest.updatedAt,
    };
  },
});
