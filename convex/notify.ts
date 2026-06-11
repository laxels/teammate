import { v } from "convex/values";
import { buildDevboxEventMessage, monitoringUrl } from "../src/orchestration";
import { postSlackMessage } from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { devboxEventTypeValidator } from "./devboxes";

/**
 * Posts a devbox lifecycle event to the task's Slack channel (threaded when
 * the task lives in a thread). Scheduled from the /devbox/events HTTP action.
 */
export const devboxEvent = internalAction({
  args: {
    devboxId: v.string(),
    taskId: v.string(),
    type: devboxEventTypeValidator,
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken === undefined) {
      console.error("SLACK_BOT_TOKEN is not set; dropping notification");
      return;
    }
    const task = await ctx.runQuery(internal.tasks.getByTaskId, {
      taskId: args.taskId,
    });
    if (task === null) {
      return;
    }
    const devbox = await ctx.runQuery(internal.devboxes.getByDevboxId, {
      devboxId: args.devboxId,
    });
    const text = buildDevboxEventMessage({
      type: args.type,
      taskId: args.taskId,
      title: task.title,
      summary: args.summary,
      monitorUrl: devbox === null ? null : monitoringUrl(devbox.gatewayUrl),
    });
    await postSlackMessage({
      botToken,
      channel: task.slackChannel,
      text,
      threadTs: task.slackThreadTs,
    });
  },
});
