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
 * Turns staged task files into DeliverableFiles for a devbox: just the metadata
 * plus the storage id (as a wire string). No public URL is minted — the gateway
 * fetches the bytes from the secret-gated GET /devbox/file endpoint, so a leaked
 * command payload grants no access. A blob pruned while the task sat queued is
 * NOT filtered here: the gateway's fetch 404s and it tells the session the file
 * couldn't be downloaded (no silent drop). Shared by hosts.dispatchTaskToSlot
 * (ephemeral start) and the orchestrator (steer).
 */
export function resolveDeliverableFiles(
  files: StoredFile[] | undefined,
): DeliverableFile[] {
  if (files === undefined || files.length === 0) {
    return [];
  }
  return files.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    storageId: file.storageId,
  }));
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
