import { v } from "convex/values";
import type { DeliverableFile } from "../shared/protocol";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

/** The slice of a task's staged file the resolver needs (see
 * schema.taskFileValidator). */
export type StoredFile = {
  name: string;
  mimeType: string;
  size: number;
  storageId: Id<"_storage">;
};

/**
 * Turns staged task files (Convex storage ids) into DeliverableFiles the
 * devbox can fetch, resolving each storage id to a public URL. Files whose
 * blob has already been pruned (getUrl -> null) are dropped silently — the
 * gateway simply receives fewer files. Shared by hosts.dispatchTaskToSlot
 * (ephemeral start) and the orchestrator (permanent start / steer).
 */
export async function resolveDeliverableFiles(
  storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> },
  files: StoredFile[] | undefined,
): Promise<DeliverableFile[]> {
  if (files === undefined || files.length === 0) {
    return [];
  }
  const resolved = await Promise.all(
    files.map(async (file) => {
      const url = await storage.getUrl(file.storageId);
      return url === null
        ? null
        : { name: file.name, mimeType: file.mimeType, size: file.size, url };
    }),
  );
  return resolved.filter((file): file is DeliverableFile => file !== null);
}

/**
 * Bookkeeping row for an inbound Slack file staged in storage, so the daily
 * cleanup cron can delete the blob past its retention window (see
 * cleanup.pruneExpired). The orchestrator action calls this after storing.
 */
export const recordInbound = internalMutation({
  args: { storageId: v.id("_storage"), eventId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("inboundFiles", {
      storageId: args.storageId,
      eventId: args.eventId,
      createdAt: Date.now(),
    });
  },
});
