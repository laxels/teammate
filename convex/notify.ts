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
 * Posts the terminal note for a task cancelled while still queued. Devbox-path
 * stops are announced via /devbox/events; queue cancellations have no devbox,
 * so without this the task's thread would dangle without an outcome.
 */
export const taskCancelled = internalAction({
  args: { taskId: v.string() },
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
      text: `:octagonal_sign: *${task.title}* (\`${task.taskId}\`) was cancelled while still queued — no devbox had been assigned yet.`,
      threadTs: task.slackThreadTs,
    });
  },
});

/**
 * Announces a dashboard-initiated retry in the original task's thread (the
 * retry shares it, so its own status updates land there too).
 */
export const taskRetried = internalAction({
  args: { taskId: v.string(), retryTaskId: v.string() },
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
      text: `:repeat: *${task.title}* (\`${args.taskId}\`) is being retried from the dashboard as \`${args.retryTaskId}\` — fresh devbox, same prompt. Status updates will follow in this thread.`,
      threadTs: task.slackThreadTs,
    });
  },
});
