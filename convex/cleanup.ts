import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Append-mostly tables get pruned past these windows (daily cron, see
 * crons.ts). Rows are scanned via the built-in by_creation_time index;
 * every row's domain timestamp (receivedAt/createdAt/ts) is written as
 * Date.now() in the inserting mutation, so _creationTime is equivalent.
 *
 * Windows are sized off the table's longest-lookback reader:
 *
 * - slackEvents: dead-letter replay (slack.retryUnprocessed) re-schedules
 *   unprocessed rows 2 min – 24 h old. 7 days is 7x that lookback, so a row
 *   old enough to prune is one the replay cron permanently gave up on.
 *   Dedup by_event_id only matters across Slack's redeliveries (minutes).
 * - commands / hostCommands: pending rows are consumed by live gateway /
 *   host-agent subscriptions within seconds; acked rows are never read
 *   again. A week-old pending command targets a devbox or host that is
 *   long gone — delivering it would be wrong, not just useless.
 * - taskEvents: read per-task by the dashboard detail view (the retro
 *   timeline — up to MAX_DETAIL_EVENTS), the orchestrator's get_task tool
 *   (last 10), and the staleness cron (latest
 *   event per *active* task, falling back to task.updatedAt when none
 *   remain — a running task with no event in 30 days was already maximally
 *   stale, so nudging behavior is unchanged).
 * - hostEvents: only read as the fleet snapshot's recent tail (last 15).
 *
 * inboundFiles is pruned separately (below) because each row owns a storage
 * blob that must be deleted with it.
 */
export const QUEUE_RETENTION_MS = 7 * DAY_MS;
export const EVENT_RETENTION_MS = 30 * DAY_MS;
/** Inbound Slack files staged in storage. A task normally places within
 * minutes (up to ~45 min if it sits queued), but a saturated/no-provisioner
 * fleet can hold it longer — so match the queue/command retention (7 days)
 * rather than racing it. Past that a queued task is effectively abandoned; if
 * its blob is gone, the gateway's /devbox/file fetch 404s and the session is
 * told the file couldn't be downloaded (no silent loss). */
export const INBOUND_FILE_RETENTION_MS = QUEUE_RETENTION_MS;

export const PRUNE_TABLES = [
  { table: "slackEvents", retentionMs: QUEUE_RETENTION_MS },
  { table: "commands", retentionMs: QUEUE_RETENTION_MS },
  { table: "hostCommands", retentionMs: QUEUE_RETENTION_MS },
  // #138: the local daemon's command queue and the peer channel age out with
  // the other queues — peer replies are consumed by the awaiting cloud agent
  // within its own turn, never read weeks later. capabilityManifests is
  // deliberately NOT pruned (one long-lived row per golden tag).
  { table: "localCommands", retentionMs: QUEUE_RETENTION_MS },
  { table: "peerMessages", retentionMs: QUEUE_RETENTION_MS },
  { table: "taskEvents", retentionMs: EVENT_RETENTION_MS },
  { table: "hostEvents", retentionMs: EVENT_RETENTION_MS },
] as const;

/** Per table per invocation; 5 tables x 500 keeps one transaction well
 * under Convex's read/write caps. A full batch means there may be more, so
 * the mutation re-schedules itself until every table comes up short. */
export const PRUNE_BATCH_SIZE = 500;

export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const deleted: Record<string, number> = {};
    let more = false;
    for (const { table, retentionMs } of PRUNE_TABLES) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_creation_time", (q) =>
          q.lt("_creationTime", now - retentionMs),
        )
        .take(PRUNE_BATCH_SIZE);
      for (const row of rows) {
        // Some pruned rows own a storage blob (taskEvents tool-result
        // screenshots, #70): delete it first so the 30-day sweep doesn't leak
        // storage. .catch so a missing blob can't roll back the whole batch.
        const blobId = (row as { imageStorageId?: Id<"_storage"> })
          .imageStorageId;
        if (blobId !== undefined) {
          await ctx.storage.delete(blobId).catch(() => undefined);
        }
        await ctx.db.delete(row._id);
      }
      if (rows.length > 0) {
        deleted[table] = rows.length;
      }
      more ||= rows.length === PRUNE_BATCH_SIZE;
    }

    // inboundFiles each own a storage blob: delete the blob, then the row.
    const staleFiles = await ctx.db
      .query("inboundFiles")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - INBOUND_FILE_RETENTION_MS),
      )
      .take(PRUNE_BATCH_SIZE);
    for (const row of staleFiles) {
      // .catch so a missing/failed blob can't roll back the whole prune
      // transaction and wedge the sweep on the same row forever; the bookkeeping
      // row is still removed (mirrors artifacts.uploadToSlack's cleanup).
      await ctx.storage.delete(row.storageId).catch(() => undefined);
      await ctx.db.delete(row._id);
    }
    if (staleFiles.length > 0) {
      deleted.inboundFiles = staleFiles.length;
    }
    more ||= staleFiles.length === PRUNE_BATCH_SIZE;

    if (Object.keys(deleted).length > 0) {
      console.log(`pruned expired rows: ${JSON.stringify(deleted)}`);
    }
    if (more) {
      await ctx.scheduler.runAfter(0, internal.cleanup.pruneExpired, {});
    }
    return { deleted, rescheduled: more };
  },
});
