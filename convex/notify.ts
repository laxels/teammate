// Node runtime: postSlackMessage's retry backoff sleeps via setTimeout,
// which the default Convex runtime does not provide.
"use node";

import { v } from "convex/values";
import {
  EPHEMERAL_RETIRE_GRACE_MS,
  isTerminalTaskStatus,
  statusForEvent,
} from "../shared/protocol";
import {
  buildDevboxEventMessage,
  buildLocalAccessRequestMessage,
  buildStatusCard,
  monitoringUrl,
  replyHintFor,
} from "../src/orchestration";
import {
  addSlackReaction,
  deleteSlackMessage,
  postSlackMessage,
  updateSlackMessage,
} from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { devboxEventTypeValidator } from "./constants";

const RETIRE_GRACE_MIN = Math.round(EPHEMERAL_RETIRE_GRACE_MS / 60_000);

/** Status reactions on the task's anchor message: glanceable from the
 * channel scroll without opening the thread. Best-effort (needs the
 * reactions:write scope; silently skipped until the manifest is applied).
 * No `started` entry: the orchestrator's instant 🫡 (:blob_salute:) ack
 * already marks "I'm on it" on this same message, so a 👀 on start was
 * redundant and confusing (#110). */
const STATUS_REACTION: Partial<Record<string, string>> = {
  needs_input: "raising_hand",
  completed: "white_check_mark",
  failed: "x",
  stopped: "octagonal_sign",
};

/**
 * Posts an agent lifecycle event to the task's Slack channel (threaded when
 * the task lives in a thread). Scheduled from the /devbox/events HTTP action
 * (devboxId set), the /local/events HTTP action (#138, machineId set), and
 * from hosts.ts's terminal-failure paths (terminallyFailTask). Local-agent
 * events have no devbox: no monitoring link, no retire note.
 */
export const devboxEvent = internalAction({
  args: {
    devboxId: v.optional(v.string()),
    machineId: v.optional(v.string()),
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
    const devbox =
      args.devboxId === undefined
        ? null
        : await ctx.runQuery(internal.devboxes.getByDevboxId, {
            devboxId: args.devboxId,
          });
    const monitorUrl =
      devbox === null ? null : monitoringUrl(devbox.gatewayUrl);

    const renderCard = (row: typeof task) =>
      buildStatusCard({
        taskId: args.taskId,
        title: row.title,
        status: row.status,
        // Pair the row's status with the summary that produced it, not this
        // (possibly stale, raced) event's — a delayed progress action must not
        // paint its own summary under a terminal status. Fall back to the
        // event summary for legacy rows without the field.
        summary: row.lastSummary ?? args.summary,
        monitorUrl,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        replyHint: replyHintFor(row),
        localAgent: row.placement === "local",
      });

    // 1. The status card: posted on the task's first lifecycle event, then
    // chat.update'd in place — one glanceable message per task. The task row
    // already reflects this event (recordEvent ran before this action was
    // scheduled), so render from the row.
    let threadTs = task.slackThreadTs;
    let cardTs = task.slackCardTs;
    let adoptedThread = false;
    if (cardTs === undefined) {
      const postedTs = await postSlackMessage({
        botToken,
        channel: task.slackChannel,
        text: renderCard(task),
        threadTs,
      });
      if (postedTs !== null) {
        const claim = await ctx.runMutation(internal.tasks.setSlackCard, {
          taskId: args.taskId,
          cardTs: postedTs,
        });
        if (claim !== null) {
          cardTs = claim.cardTs;
          adoptedThread = threadTs === undefined;
          threadTs = claim.threadTs;
          if (!claim.won) {
            // Lost a concurrent first-event race: remove the stray duplicate
            // and fall in line behind the winner's card.
            await deleteSlackMessage({
              botToken,
              channel: task.slackChannel,
              ts: postedTs,
            });
          }
        }
      }
    } else {
      try {
        await updateSlackMessage({
          botToken,
          channel: task.slackChannel,
          ts: cardTs,
          text: renderCard(task),
        });
      } catch (error) {
        if (String(error).includes("message_not_found")) {
          // Card deleted by a human: forget it so the next event re-creates.
          await ctx.runMutation(internal.tasks.clearSlackCard, {
            taskId: args.taskId,
            cardTs,
          });
        } else {
          console.error("status card update failed:", error);
        }
      }
    }

    // Self-heal a stale overwrite: if the task moved on (e.g. the terminal
    // event applied while this delayed progress action was mid-flight), our
    // edit just painted outdated state — re-render once from the fresh row.
    const fresh = await ctx.runQuery(internal.tasks.getByTaskId, {
      taskId: args.taskId,
    });
    if (
      fresh !== null &&
      cardTs !== undefined &&
      fresh.status !== task.status
    ) {
      await updateSlackMessage({
        botToken,
        channel: task.slackChannel,
        ts: cardTs,
        text: renderCard(fresh),
      }).catch(() => undefined);
    }

    // 2. Detail thread replies for transitions worth a notification ping
    // (chat.update doesn't notify). progress only refreshes the card;
    // started is fully covered by the card's creation. When the thread was
    // just adopted (legacy task: the card IS the anchor), the requester
    // isn't a thread participant — @mention them so Slack notifies.
    if (args.type !== "progress" && args.type !== "started") {
      const text = buildDevboxEventMessage({
        type: args.type,
        taskId: args.taskId,
        title: task.title,
        summary: args.summary,
        monitorUrl,
        replyHint: replyHintFor(task),
      });
      const mention =
        (adoptedThread || task.slackThreadTs === task.slackCardTs) &&
        task.slackUser !== undefined
          ? `<@${task.slackUser}> `
          : "";
      // A terminal event sends the devbox into "retiring": warn that the
      // monitoring page is about to disappear with the VM. Every devbox is a
      // single-task VM now, so any terminal status retires it.
      const incomingStatus = statusForEvent(args.type);
      const retireNote =
        devbox !== null &&
        incomingStatus !== undefined &&
        isTerminalTaskStatus(incomingStatus)
          ? `\n_This devbox (and its monitoring page) retires in ~${RETIRE_GRACE_MIN} minutes._`
          : "";
      await postSlackMessage({
        botToken,
        channel: task.slackChannel,
        text: `${mention}${text}${retireNote}`,
        threadTs,
      });
    }

    // 3. Glanceable reaction on the anchor message (usually the user's
    // request). Reactions accumulate on top of the orchestrator's 🫡 ack
    // (then 🙋/✅/❌/🛑) — removal needs another scope round-trip and adds little.
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
 * The local-machine permission ask (#138): posted to the task's thread,
 * tagging the requester, when a cloud agent first requests local work on an
 * ungranted task (local.ts peerRequest). Mechanical — the orchestrator LLM
 * only enters the loop to interpret the user's reply (resolve_local_access).
 */
export const localAccessRequest = internalAction({
  args: { taskId: v.string(), reason: v.string() },
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
    const machines = await ctx.runQuery(internal.local.listMachines, {});
    const candidate =
      machines.find(
        (m) =>
          m.online &&
          (m.ownerSlackUser === undefined ||
            m.ownerSlackUser === task.slackUser),
      ) ?? machines[0];
    await postSlackMessage({
      botToken,
      channel: task.slackChannel,
      text: buildLocalAccessRequestMessage({
        taskId: args.taskId,
        title: task.title,
        slackUser: task.slackUser,
        machineName:
          candidate === undefined
            ? "your Mac"
            : (candidate.displayName ?? candidate.machineId),
        reason: args.reason,
      }),
      threadTs: task.slackThreadTs,
    });
    // Notification ping mirrors needs_input: the ask needs a human decision.
    if (task.slackThreadTs !== undefined) {
      await addSlackReaction({
        botToken,
        channel: task.slackChannel,
        messageTs: task.slackThreadTs,
        name: "lock",
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
