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
  buildStatusCard,
  monitoringUrl,
  replyHintFor,
} from "../src/orchestration";
import {
  addSlackReaction,
  postSlackMessage,
  updateSlackMessage,
} from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { devboxEventTypeValidator } from "./constants";

const RETIRE_GRACE_MIN = Math.round(EPHEMERAL_RETIRE_GRACE_MS / 60_000);

/**
 * Posts a devbox lifecycle event to the task's Slack channel (threaded when
 * the task lives in a thread). Scheduled from the /devbox/events HTTP action.
 */
/** Status reactions on the task's anchor message: glanceable from the
 * channel scroll without opening the thread. Best-effort (needs the
 * reactions:write scope; silently skipped until the manifest is applied). */
const STATUS_REACTION: Partial<Record<string, string>> = {
  started: "eyes",
  needs_input: "raising_hand",
  completed: "white_check_mark",
  failed: "x",
  stopped: "octagonal_sign",
};

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
    const monitorUrl =
      devbox === null ? null : monitoringUrl(devbox.gatewayUrl);

    // 1. The status card: posted on the task's first lifecycle event, then
    // chat.update'd in place — one glanceable message per task. The task row
    // already reflects this event (recordEvent ran before this action was
    // scheduled), so render from the row.
    const card = buildStatusCard({
      taskId: args.taskId,
      title: task.title,
      status: task.status,
      summary: args.summary,
      monitorUrl,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      replyHint: replyHintFor(task),
    });
    // Concurrent first events can race to create the card; setSlackCard is
    // set-if-absent, so the first writer wins and a losing duplicate post
    // degrades to a plain status line.
    let threadTs = task.slackThreadTs;
    if (task.slackCardTs === undefined) {
      const cardTs = await postSlackMessage({
        botToken,
        channel: task.slackChannel,
        text: card,
        threadTs,
      });
      if (cardTs !== null) {
        await ctx.runMutation(internal.tasks.setSlackCard, {
          taskId: args.taskId,
          cardTs,
        });
        // Legacy threadless task: the card becomes the thread anchor.
        threadTs = threadTs ?? cardTs;
      }
    } else {
      // Card edits must not block the detail post below.
      await updateSlackMessage({
        botToken,
        channel: task.slackChannel,
        ts: task.slackCardTs,
        text: card,
      }).catch((error) => {
        console.error("status card update failed:", error);
      });
    }

    // 2. Detail thread replies for transitions worth a notification ping
    // (chat.update doesn't notify). progress only refreshes the card;
    // started is fully covered by the card's creation.
    if (args.type !== "progress" && args.type !== "started") {
      const text = buildDevboxEventMessage({
        type: args.type,
        taskId: args.taskId,
        title: task.title,
        summary: args.summary,
        monitorUrl,
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
        threadTs,
      });
    }

    // 3. Glanceable reaction on the anchor message (usually the user's
    // request). Reactions accumulate (👀 then ✅) — removal needs another
    // scope and adds nothing.
    const reaction = STATUS_REACTION[args.type];
    if (reaction !== undefined && threadTs !== undefined) {
      await addSlackReaction({
        botToken,
        channel: task.slackChannel,
        messageTs: threadTs,
        name: reaction,
      });
    }
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
