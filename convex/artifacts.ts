// Node runtime, mirroring notify.ts (the other Slack-posting action): keeps all
// outbound Slack HTTP on one runtime. uploadSlackFile itself uses only fetch +
// web APIs, so this could run on the default runtime, but parity avoids any
// per-runtime fetch/global surprises.
"use node";

import { v } from "convex/values";
import { uploadSlackFile } from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

/**
 * Posts a devbox artifact (screenshot, log, result file) into its task's Slack
 * thread via the external-upload flow, then deletes the staged storage blob —
 * Slack hosts the file afterwards, so the copy in Convex storage is transient
 * (there is no outbound retention sweep, so the blob MUST be deleted on every
 * exit). Best-effort: a failure to post must never crash anything (the devbox
 * already finished producing it); we log and still clean up the blob.
 */
export const uploadToSlack = internalAction({
  args: {
    taskId: v.string(),
    storageId: v.id("_storage"),
    filename: v.string(),
    title: v.optional(v.string()),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // finally guarantees the blob is freed even if a query/storage read throws:
    // scheduled actions are not auto-retried here, so a leak would be permanent.
    try {
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (botToken === undefined) {
        console.error("SLACK_BOT_TOKEN is not set; dropping artifact");
        return;
      }
      const task = await ctx.runQuery(internal.tasks.getByTaskId, {
        taskId: args.taskId,
      });
      if (task === null) {
        console.error(`artifact for unknown task ${args.taskId}; dropping`);
        return;
      }
      const blob = await ctx.storage.get(args.storageId);
      if (blob === null) {
        console.error(`artifact blob for ${args.taskId} missing; dropping`);
        return;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await uploadSlackFile({
        botToken,
        channel: task.slackChannel,
        threadTs: task.slackThreadTs,
        filename: args.filename,
        bytes,
        title: args.title,
        initialComment: args.comment,
      });
      if (!result.ok) {
        console.error(
          `artifact upload for ${args.taskId} failed: ${result.error}`,
        );
      }
    } finally {
      await ctx.storage.delete(args.storageId).catch(() => undefined);
    }
  },
});
