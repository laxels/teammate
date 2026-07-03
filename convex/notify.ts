// Node runtime: postSlackMessage's retry backoff sleeps via setTimeout,
// which the default Convex runtime does not provide.
"use node";

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import {
  DEFAULT_EFFORT,
  EPHEMERAL_RETIRE_GRACE_MS,
  isTerminalTaskStatus,
  MODEL,
  statusForEvent,
} from "../shared/protocol";
import {
  buildCardSummaryPrompt,
  buildDevboxEventMessage,
  buildLocalAccessRequestMessage,
  buildStatusCard,
  cardLatestLine,
  monitoringUrl,
  pickLocalMachine,
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
import { devboxEventTypeValidator, HEARTBEAT_FRESHNESS_MS } from "./constants";

const RETIRE_GRACE_MIN = Math.round(EPHEMERAL_RETIRE_GRACE_MS / 60_000);

/**
 * Model-backed summarizer behind the status card's `_Latest:_` line (#145).
 * Model policy applies (MODEL at DEFAULT_EFFORT, no fallback model). Returns
 * null when no usable line came back — missing key, safety refusal, or a
 * truncated/empty response — and the caller (cardLatestLine) degrades to a
 * plain excerpt instead of blocking the card repaint.
 */
async function summarizeCardLine(text: string): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY === undefined) {
    console.error(
      "ANTHROPIC_API_KEY is not set; card Latest: line falls back to an excerpt",
    );
    return null;
  }
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 1000,
      thinking: { type: "adaptive" },
      output_config: { effort: DEFAULT_EFFORT },
      messages: [{ role: "user", content: buildCardSummaryPrompt(text) }],
    },
    // A slow/hung call must not wedge the card repaint or the thread reply
    // queued behind it in this action; the timeout degrades to an excerpt.
    { timeout: 30_000, maxRetries: 1 },
  );
  // Anything but a clean finish (refusal, max_tokens truncation) is unusable
  // as a one-line card summary.
  if (response.stop_reason !== "end_turn") {
    console.error(
      `card summary stopped early (${response.stop_reason}); falling back to an excerpt`,
    );
    return null;
  }
  const line = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return line === "" ? null : line;
}

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
    // A split task's LOCAL-agent event carries no devboxId, but the card it
    // repaints belongs to a devbox-backed task — fall back to the task row's
    // devbox so the Monitor link never vanishes from the card mid-task.
    const devboxId = args.devboxId ?? task.devboxId;
    const devbox =
      devboxId === undefined
        ? null
        : await ctx.runQuery(internal.devboxes.getByDevboxId, {
            devboxId,
          });
    const monitorUrl =
      devbox === null ? null : monitoringUrl(devbox.gatewayUrl);

    // The card's `_Latest:_` line is a concise summary of the row's (full-
    // length since #114) lastSummary — full text still flows everywhere else
    // (thread replies, dashboard timeline). Memoized per source text so the
    // self-heal repaint below doesn't pay a second model call. (#145)
    const cardLines = new Map<string, string>();
    const latestLineFor = async (row: typeof task): Promise<string> => {
      // Pair the row's status with the summary that produced it, not this
      // (possibly stale, raced) event's — a delayed progress action must not
      // paint its own summary under a terminal status. Fall back to the
      // event summary for legacy rows without the field.
      const source = row.lastSummary ?? args.summary;
      const cached = cardLines.get(source);
      if (cached !== undefined) return cached;
      const line = await cardLatestLine(source, summarizeCardLine);
      cardLines.set(source, line);
      return line;
    };

    const renderCard = (row: typeof task, latest: string) =>
      buildStatusCard({
        taskId: args.taskId,
        title: row.title,
        status: row.status,
        summary: latest,
        monitorUrl,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        replyHint: replyHintFor(row),
        localAgent: row.placement === "local",
      });
    const taskCard = renderCard(task, await latestLineFor(task));

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
        text: taskCard,
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
          text: taskCard,
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

    // Self-heal a stale overwrite: if the task moved on while this action was
    // mid-flight (e.g. the terminal event applied during a delayed progress
    // action — or, now that painting waits on a model call, a same-status
    // progress event stamped a newer lastSummary), our edit just painted
    // outdated state — re-render from the fresh row. Loops because each
    // repaint's own model call reopens the window; bounded so a hot task
    // can't pin this action, and any drift past the bound is repaired by the
    // next event's action running the same check.
    let painted = task;
    for (let repaint = 0; repaint < 3 && cardTs !== undefined; repaint++) {
      const fresh = await ctx.runQuery(internal.tasks.getByTaskId, {
        taskId: args.taskId,
      });
      if (
        fresh === null ||
        (fresh.status === painted.status &&
          fresh.lastSummary === painted.lastSummary)
      ) {
        break;
      }
      await updateSlackMessage({
        botToken,
        channel: task.slackChannel,
        ts: cardTs,
        text: renderCard(fresh, await latestLineFor(fresh)),
      }).catch(() => undefined);
      painted = fresh;
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
    // Name the machine the grant would actually land on: the same picker
    // resolveAccess/peerRequest use (owner-preferring, freshness-gated).
    const machines = await ctx.runQuery(internal.local.listMachines, {});
    const candidate =
      pickLocalMachine(machines, {
        preferOwner: task.slackUser,
        now: Date.now(),
        freshnessMs: HEARTBEAT_FRESHNESS_MS,
      }) ?? machines[0];
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
