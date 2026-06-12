// Node runtime: postSlackMessage's retry backoff sleeps via setTimeout,
// which the default Convex runtime does not provide.
"use node";

import { v } from "convex/values";
import {
  DEVBOX_EVENT_TO_TASK_STATUS,
  EPHEMERAL_RETIRE_GRACE_MS,
  isTerminalTaskStatus,
} from "../shared/protocol";
import {
  buildDevboxEventMessage,
  monitoringUrl,
  replyHintFor,
} from "../src/orchestration";
import { postSlackMessage } from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { devboxEventTypeValidator } from "./constants";

const RETIRE_GRACE_MIN = Math.round(EPHEMERAL_RETIRE_GRACE_MS / 60_000);

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
      replyHint: replyHintFor(task),
    });
    // A terminal event sends an ephemeral devbox into "retiring": warn that
    // the monitoring page is about to disappear with the VM.
    const retireNote =
      devbox?.ephemeral === true &&
      isTerminalTaskStatus(DEVBOX_EVENT_TO_TASK_STATUS[args.type])
        ? `\n_This devbox (and its monitoring page) retires in ~${RETIRE_GRACE_MIN} minutes._`
        : "";
    await postSlackMessage({
      botToken,
      channel: task.slackChannel,
      text: `${text}${retireNote}`,
      threadTs: task.slackThreadTs,
    });
  },
});

/**
 * Posts an arbitrary note to a task's home thread — used for actions that
 * never reach /devbox/events (queue cancellations) and for dashboard actions
 * that should leave a trace in the durable Slack narrative (stop requests,
 * follow-ups, retries). Callers compose the message text.
 */
export const taskNote = internalAction({
  args: { taskId: v.string(), text: v.string() },
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
    await postSlackMessage({
      botToken,
      channel: task.slackChannel,
      text: args.text,
      threadTs: task.slackThreadTs,
    });
  },
});
