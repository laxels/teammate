"use node";

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import {
  type InterruptPayload,
  isTerminalTaskStatus,
  MAX_INBOUND_FILE_BYTES,
  MAX_ORCHESTRATOR_IMAGE_BYTES,
  MAX_ORCHESTRATOR_INLINE_TOTAL_BYTES,
  type StartTaskRequest,
  type UserMessagePayload,
} from "../shared/protocol";
import {
  type AttachmentInfo,
  buildOrchestratorUserMessage,
  classifySlackEvent,
  monitoringUrl,
  resolveThreadTarget,
  type SlackFileRef,
  steerRejection,
  stopRejection,
  type ThreadTarget,
  taskActionAuthorization,
} from "../src/orchestration";
import {
  downloadSlackFile,
  getSlackPermalink,
  postSlackMessage,
} from "../src/slackApi";
import { internal } from "./_generated/api";
import { type ActionCtx, internalAction } from "./_generated/server";
import { resolveDeliverableFiles, type StoredFile } from "./files";

// Model policy (ARCHITECTURE.md): claude-opus-4-8 at xhigh everywhere, no
// fallback model, no `fallbacks` parameter — flagged requests refuse rather
// than downgrade.
const MODEL = "claude-opus-4-8";
const MAX_TOOL_ITERATIONS = 12;

const SYSTEM_PROMPT = `You are ultraclaude, a virtual teammate who orchestrates Claude Code devboxes for your team.

Each devbox is a FULL macOS desktop, not a headless sandbox: Claude Code with terminal/file access, fast Playwright-based browser automation (accessibility-tree snapshots and element-targeted actions in a dedicated Chrome), plus complete GUI control of the desktop (screenshots, mouse, keyboard) via built-in computer-use tools. Every task can drive the browser and native apps — web apps, sites without APIs, web games, anything a person could do at a Mac — with no special flag. Never claim you cannot use a browser or a GUI: you personally cannot, but your devboxes can, so delegate.

You receive Slack messages (DMs and @mentions). Either answer directly or use your tools:
- start_task delegates work to a Claude Code instance on a devbox. By default every task gets a FRESH ephemeral devbox VM (~1-2 min to provision; no state left over from previous tasks). Write the prompt as a complete, self-contained spec: all context, constraints, and a clear definition of done up front. When the task involves the browser or another GUI app, say so in the prompt — the devbox decides on its own when to use its computer-use tools.
- When all VM slots are full, start_task queues the task and the fleet AUTOMATICALLY starts bootstrapping a new Mac host (the tool result tells you the host name and that this takes roughly 20-45 minutes). Relay that honestly. The permanent devbox devbox-1 may be idle as a faster fallback: offer it, but only use it when the user says so or explicitly asked for it up front (set use_permanent_devbox: true) — it can carry state between tasks, which is why ephemeral is the default.
- get_fleet shows the Mac hosts, VM slots, in-flight host bootstraps, queued tasks, and recent fleet events. Use it when the user asks about capacity/infrastructure or when debugging why a task hasn't started.
- get_task / list_tasks answer questions about ongoing work.
- steer_task relays mid-task guidance (corrections, extra context, answers to a task's questions) into the running Claude Code session — the same effect as typing into the monitoring page's steering box. Pass the user's guidance through faithfully. It works any time before the task finishes, including while its devbox is still provisioning (delivery is queued until the session starts).
- stop_task interrupts a running task (it also cancels a task still waiting in the queue).

Each task's home is the Slack thread of the request that started it; follow-up tasks started from that thread share it. Messages arriving in a task's thread include a <thread_context> block listing the task(s) anchored there — treat them as being about that work: steer with steer_task, report with get_task, stop with stop_task. With several tasks listed, prefer the one the message names, otherwise the newest non-terminal one; ask before a stop that is ambiguous between running tasks. A plain question ("how's it going?") deserves a status answer, not a steer. In channel threads you also see replies that aren't addressed to you (people talking to each other): when no action or answer is genuinely needed from you, respond with exactly NO_REPLY and nothing else. Steering/stopping via Slack is restricted to the task's owner or replies in its own thread — relay the tool's error honestly if it refuses. (The operator's tailnet dashboard can also steer/stop tasks; those actions announce themselves in the thread.)

Once a task starts, status updates and the monitoring link are posted to its thread automatically — never promise to "report back" manually. The monitoring page additionally offers live desktop viewing and the same steering.

Formatting: concise Slack style — *bold*, _italic_, \`code\`, "-" bullets, <URL|label> links. No markdown headers, no **double asterisks**. Keep replies short: you are a teammate in chat, not an essayist.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_tasks",
    description:
      "List recent tasks (id, title, status, devbox, timestamps). Call this when the user asks what is running or for an overview.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_task",
    description:
      "Get one task's details plus its last 10 lifecycle events and monitoring link. Call this when the user asks about a specific task's progress.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id, e.g. task-1a2b3c4d" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "start_task",
    description:
      "Start a new Claude Code task. Default: a fresh ephemeral devbox VM (provisioned in ~1-2 min, destroyed after the task). When every VM slot is busy the task is queued and a new Mac host bootstraps automatically (~20-45 min) — the result describes the situation so you can relay it and offer alternatives.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short human-readable title shown in status updates",
        },
        prompt: {
          type: "string",
          description:
            "Complete, self-contained task spec handed to Claude Code: context, constraints, and definition of done.",
        },
        use_permanent_devbox: {
          type: "boolean",
          description:
            "Run on the always-on permanent devbox (devbox-1) instead of an ephemeral VM. Only when the user explicitly asks for it, or approves it as a faster fallback while the fleet is scaling. State can persist between tasks there.",
        },
      },
      required: ["title", "prompt"],
    },
  },
  {
    name: "get_fleet",
    description:
      "Snapshot of the Mac host fleet: hosts with VM slot usage, in-flight new-host bootstraps (with elapsed time), devboxes, queued tasks awaiting placement, and recent fleet events. Call this for capacity/infrastructure questions or to debug a task stuck in the queue.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "steer_task",
    description:
      "Send a follow-up message into a running task's live Claude Code session (the Slack equivalent of the monitoring page's steering box). Use it to relay the user's mid-task guidance, corrections, or answers. Works until the task finishes, including while its devbox is provisioning (delivery is queued until the session starts). For finished tasks, start a follow-up task instead.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id to steer" },
        message: {
          type: "string",
          description:
            "The guidance to deliver to the session, written as if speaking to the Claude Code instance doing the work. Preserve the user's intent and constraints faithfully.",
        },
      },
      required: ["taskId", "message"],
    },
  },
  {
    name: "stop_task",
    description:
      "Interrupt a running task on its devbox. Call this when the user asks to stop or cancel a task.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id to interrupt" },
      },
      required: ["taskId"],
    },
  },
];

function toolError(message: string): string {
  return JSON.stringify({ error: message });
}

/** Result of downloading + staging a message's Slack attachments. */
type StagedFiles = {
  /** Storage ids + metadata persisted on the task row / handed to the devbox. */
  stored: StoredFile[];
  /** Images small enough for the orchestrator's own model to view inline. */
  imageBlocks: Anthropic.ImageBlockParam[];
  /** Per-file outcome the user message reports (status reflects reality, so
   * the model is never told a file is ready/viewable when it isn't). */
  attachments: AttachmentInfo[];
};

/**
 * Downloads each shared file with the bot token, stores the bytes in Convex
 * storage (the devbox later fetches them by storageId from the secret-gated
 * /devbox/file endpoint — the bot token never leaves the orchestrator), and
 * records a cleanup row. Images within the inline cap are also base64'd into
 * image blocks so the orchestrator can see them itself. Failures are collected,
 * not thrown: a bad attachment must not sink the turn.
 */
async function stageInboundFiles(
  ctx: ActionCtx,
  botToken: string,
  eventId: string,
  files: SlackFileRef[],
): Promise<StagedFiles> {
  const stored: StoredFile[] = [];
  const imageBlocks: Anthropic.ImageBlockParam[] = [];
  const attachments: AttachmentInfo[] = [];
  // Running total of raw bytes already inlined as image blocks, so a burst of
  // large screenshots can't push the request past Anthropic's 32 MB cap.
  let inlineBytesUsed = 0;
  for (const file of files) {
    // Slack Connect files arrive with no fetchable URL (file_access:
    // check_file_info); surface them as undownloadable rather than dropping.
    if (file.urlPrivate === "" || file.size > MAX_INBOUND_FILE_BYTES) {
      attachments.push({
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        available: false,
        viewableInline: false,
      });
      continue;
    }
    const download = await downloadSlackFile({
      botToken,
      urlPrivate: file.urlPrivate,
      maxBytes: MAX_INBOUND_FILE_BYTES,
      expectedMimeType: file.mimeType,
    });
    if (!download.ok) {
      attachments.push({
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        available: false,
        viewableInline: false,
      });
      continue;
    }
    const storageId = await ctx.storage.store(
      new Blob([download.bytes], { type: download.mimeType }),
    );
    await ctx.runMutation(internal.files.recordInbound, { storageId, eventId });
    stored.push({
      name: file.name,
      mimeType: file.mimeType,
      size: download.bytes.byteLength,
      storageId,
    });
    // Only mark viewable inline when an image block is ACTUALLY produced: an
    // image over the per-image cap, or one that would push the aggregate past
    // the request budget, is delivered to the devbox but unseen here.
    const viewableInline =
      file.isImage &&
      download.bytes.byteLength <= MAX_ORCHESTRATOR_IMAGE_BYTES &&
      inlineBytesUsed + download.bytes.byteLength <=
        MAX_ORCHESTRATOR_INLINE_TOTAL_BYTES;
    if (viewableInline) {
      inlineBytesUsed += download.bytes.byteLength;
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: file.mimeType as
            | "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp",
          data: Buffer.from(download.bytes).toString("base64"),
        },
      });
    }
    attachments.push({
      name: file.name,
      mimeType: file.mimeType,
      size: download.bytes.byteLength,
      available: true,
      viewableInline,
    });
  }
  return { stored, imageBlocks, attachments };
}

async function executeTool(
  ctx: ActionCtx,
  target: ThreadTarget,
  /** Slack user id of the message author — authorizes steer/stop. */
  requester: string,
  /** Files shared on the triggering message, staged for the task that this
   * call starts or steers. */
  inboundFiles: StoredFile[],
  block: Anthropic.ToolUseBlock,
): Promise<string> {
  const input = (block.input ?? {}) as Record<string, unknown>;
  switch (block.name) {
    case "list_tasks": {
      const tasks = await ctx.runQuery(internal.tasks.list, {});
      return JSON.stringify({ tasks });
    }

    case "get_task": {
      const taskId = input.taskId;
      if (typeof taskId !== "string") {
        return toolError("taskId (string) is required");
      }
      const result = await ctx.runQuery(internal.tasks.getWithEvents, {
        taskId,
      });
      if (result === null) {
        return toolError(`no task with id ${taskId}`);
      }
      const { task, events } = result;
      const devbox =
        task.devboxId === undefined
          ? null
          : await ctx.runQuery(internal.devboxes.getByDevboxId, {
              devboxId: task.devboxId,
            });
      return JSON.stringify({
        task: {
          taskId: task.taskId,
          title: task.title,
          prompt: task.prompt,
          status: task.status,
          devboxId: task.devboxId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
        monitoringUrl:
          devbox === null ? null : monitoringUrl(devbox.gatewayUrl),
        recentEvents: events.map((e) => ({
          type: e.type,
          summary: e.summary,
          ts: e.ts,
        })),
      });
    }

    case "start_task": {
      const { title, prompt } = input;
      if (typeof title !== "string" || typeof prompt !== "string") {
        return toolError("title (string) and prompt (string) are required");
      }
      const taskId = `task-${crypto.randomUUID().slice(0, 8)}`;
      // Deep link to the task's home thread, for the dashboard. Best-effort:
      // getSlackPermalink returns null on any failure.
      const permalink = await getSlackPermalink({
        botToken: process.env.SLACK_BOT_TOKEN ?? "",
        channel: target.channel,
        messageTs: target.threadTs,
      });
      const permalinkArgs =
        permalink === null ? {} : { slackPermalink: permalink };
      // Shared attachments ride along: stored on the task row (resolved for
      // the devbox at placement) and, for the permanent path, baked into the
      // start command here.
      const fileArgs = inboundFiles.length > 0 ? { files: inboundFiles } : {};
      const deliverable = resolveDeliverableFiles(inboundFiles);

      // Explicit opt-in: the always-on permanent devbox. State can persist
      // between tasks there, so this path is never chosen silently.
      if (input.use_permanent_devbox === true) {
        const claimed = await ctx.runMutation(internal.devboxes.claimWarm, {
          taskId,
        });
        if (claimed === null) {
          return toolError(
            "the permanent devbox is busy (or not heartbeating). Options: run the task on an ephemeral devbox instead (the default), or stop the task currently occupying it.",
          );
        }
        const request: StartTaskRequest = {
          taskId,
          prompt,
          ...(deliverable.length > 0 ? { files: deliverable } : {}),
        };
        await ctx.runMutation(internal.commands.enqueue, {
          devboxId: claimed.devboxId,
          kind: "start",
          payload: JSON.stringify(request),
        });
        await ctx.runMutation(internal.tasks.create, {
          taskId,
          title,
          prompt,
          devboxId: claimed.devboxId,
          placement: "permanent",
          slackChannel: target.channel,
          slackThreadTs: target.threadTs,
          slackUser: requester,
          ...permalinkArgs,
          ...fileArgs,
        });
        return JSON.stringify({
          ok: true,
          taskId,
          devboxId: claimed.devboxId,
          monitoringUrl: monitoringUrl(claimed.gatewayUrl),
          note: "Running on the permanent devbox as requested. Status updates will be posted to this conversation automatically.",
        });
      }

      // Default: a fresh ephemeral devbox. The task row is created first so
      // it can wait in the queue when every VM slot is taken; placement
      // (devbox assignment + start command + provision_vm) happens in
      // hosts.placeEphemeralTask — immediately when a slot is free, or from
      // placeQueuedEphemeralTasks when capacity arrives. Start commands are
      // enqueued BEFORE the VM exists (outbound-only control plane): the
      // freshly booted gateway picks them up on first subscription.
      await ctx.runMutation(internal.tasks.create, {
        taskId,
        title,
        prompt,
        placement: "ephemeral",
        slackChannel: target.channel,
        slackThreadTs: target.threadTs,
        slackUser: requester,
        ...permalinkArgs,
        ...fileArgs,
      });
      const placement = await ctx.runMutation(
        internal.hosts.placeEphemeralTask,
        {
          taskId,
        },
      );
      if (placement.placed) {
        return JSON.stringify({
          ok: true,
          taskId,
          devboxId: placement.devboxId,
          note: "A fresh ephemeral devbox VM is being provisioned for this task (~1-2 min before the 'started' update). Status updates will be posted to this conversation automatically.",
        });
      }
      const permanentIdle =
        (
          await ctx.runQuery(internal.devboxes.getByDevboxId, {
            devboxId: "devbox-1",
          })
        )?.status === "warm";
      return JSON.stringify({
        ok: true,
        taskId,
        queued: true,
        scaling: placement.scaling,
        queuedTasks: placement.queuedTasks,
        permanentDevboxIdle: permanentIdle,
        note:
          placement.scaling.kind === "no_provisioner"
            ? "All VM slots are busy AND no live host holds fleet credentials, so automatic scaling is unavailable — the task stays queued until a slot frees up. Tell the user; manual options: wait, stop a running task, or run scripts/provision-host.sh."
            : "All VM slots are busy. The task is queued and a new Mac host is bootstrapping automatically (roughly 20-45 min; it then serves this and future tasks). Tell the user about the wait. If the permanent devbox is idle (see permanentDevboxIdle), offer it as a faster alternative — only switch if the user agrees (stop this queued task, then start_task with use_permanent_devbox).",
      });
    }

    case "get_fleet": {
      const fleet = await ctx.runQuery(internal.hosts.fleetSnapshot, {});
      return JSON.stringify(fleet);
    }

    case "steer_task": {
      const { taskId, message } = input;
      if (typeof taskId !== "string" || typeof message !== "string") {
        return toolError("taskId (string) and message (string) are required");
      }
      const task = await ctx.runQuery(internal.tasks.getByTaskId, { taskId });
      if (task === null) {
        return toolError(`no task with id ${taskId}`);
      }
      const unauthorized = taskActionAuthorization({ task, requester, target });
      if (unauthorized !== null) {
        return toolError(unauthorized);
      }
      const devbox =
        task.devboxId === undefined
          ? null
          : await ctx.runQuery(internal.devboxes.getByDevboxId, {
              devboxId: task.devboxId,
            });
      const rejection = steerRejection(task, devbox);
      if (rejection !== null || devbox === null) {
        return toolError(rejection ?? `devbox ${task.devboxId} is missing`);
      }
      const deliverable = resolveDeliverableFiles(inboundFiles);
      const payload: UserMessagePayload = {
        taskId,
        text: message,
        ...(deliverable.length > 0 ? { files: deliverable } : {}),
      };
      await ctx.runMutation(internal.commands.enqueue, {
        devboxId: devbox.devboxId,
        kind: "user_message",
        payload: JSON.stringify(payload),
      });
      return JSON.stringify({
        ok: true,
        taskId,
        note: "message queued for the live session. If the task finishes before delivery it is dropped — the thread's latest status update is authoritative.",
      });
    }

    case "stop_task": {
      const taskId = input.taskId;
      if (typeof taskId !== "string") {
        return toolError("taskId (string) is required");
      }
      let task = await ctx.runQuery(internal.tasks.getByTaskId, { taskId });
      if (task === null) {
        return toolError(`no task with id ${taskId}`);
      }
      const unauthorized = taskActionAuthorization({ task, requester, target });
      if (unauthorized !== null) {
        return toolError(unauthorized);
      }
      if (isTerminalTaskStatus(task.status)) {
        return toolError(
          `task ${taskId} is already ${task.status} — nothing to stop`,
        );
      }
      if (task.devboxId === undefined) {
        // Still waiting for ephemeral placement: cancel in place.
        const cancelled = await ctx.runMutation(internal.tasks.cancelQueued, {
          taskId,
        });
        if (cancelled) {
          // Queue cancellations never reach /devbox/events, so the terminal
          // note for the task's thread is posted here.
          await ctx.scheduler.runAfter(0, internal.notify.taskNote, {
            taskId,
            text: `:octagonal_sign: *${task.title}* (\`${taskId}\`) was cancelled while still queued — no devbox had been assigned yet.`,
          });
          return JSON.stringify({
            ok: true,
            taskId,
            note: "task was still queued (no devbox yet) and has been cancelled",
          });
        }
        // Lost a race between the read and the cancel: re-read to see what
        // actually happened instead of guessing.
        task = await ctx.runQuery(internal.tasks.getByTaskId, { taskId });
        if (task === null) {
          return toolError(`no task with id ${taskId}`);
        }
        if (isTerminalTaskStatus(task.status)) {
          return toolError(
            `task ${taskId} is already ${task.status} — nothing to stop`,
          );
        }
        if (task.devboxId === undefined) {
          return toolError(
            `task ${taskId} could not be cancelled (status: ${task.status}) — try again`,
          );
        }
        // Placed while we were cancelling: fall through to the interrupt path.
      }
      const devbox = await ctx.runQuery(internal.devboxes.getByDevboxId, {
        devboxId: task.devboxId,
      });
      const rejection = stopRejection(task, devbox);
      if (rejection !== null || devbox === null) {
        return toolError(rejection ?? `devbox ${task.devboxId} is missing`);
      }
      const payload: InterruptPayload = { taskId };
      await ctx.runMutation(internal.commands.enqueue, {
        devboxId: devbox.devboxId,
        kind: "interrupt",
        payload: JSON.stringify(payload),
      });
      return JSON.stringify({
        ok: true,
        taskId,
        note: "interrupt queued — if a turn was in flight, a 'stopped' status update will follow in the task's thread",
      });
    }

    default:
      return toolError(`unknown tool: ${block.name}`);
  }
}

function finalTextOf(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Processes one ingested Slack event: filters out bot/self messages, claims
 * the event (at-most-once — see slack.claimEvent), runs the Opus 4.8 tool
 * loop, and posts the final reply in a thread under the triggering message.
 * Replies inside a task's thread get that task injected as context (see
 * buildOrchestratorUserMessage). Events stranded before the claim are
 * replayed by the slack.retryUnprocessed cron.
 */
export const processSlackEvent = internalAction({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const stored = await ctx.runQuery(internal.slack.getEvent, {
      eventId: args.eventId,
    });
    if (stored === null || stored.processed) {
      return;
    }

    const classification = classifySlackEvent(stored.payload);
    if (classification.kind === "ignore") {
      console.log(`ignoring ${args.eventId}: ${classification.reason}`);
      await ctx.runMutation(internal.slack.claimEvent, {
        eventId: args.eventId,
      });
      return;
    }
    const { trigger } = classification;
    const target = resolveThreadTarget(trigger);

    // Deliberately BEFORE the claim: a config failure leaves the event
    // unclaimed so the dead-letter sweep replays it once config is fixed.
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken === undefined) {
      throw new Error("SLACK_BOT_TOKEN is not set");
    }
    if (process.env.ANTHROPIC_API_KEY === undefined) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }

    // Claim before any side-effecting work. Processing is at-most-once: a
    // crash after this point can lose the reply (the user gets the :warning:
    // message), but a replay could double-run tools (duplicate tasks), which
    // is worse. Unclaimed events are replayed by slack.retryUnprocessed.
    const claimed = await ctx.runMutation(internal.slack.claimEvent, {
      eventId: args.eventId,
    });
    if (!claimed) {
      return;
    }
    const anthropic = new Anthropic();

    // A reply inside an existing thread may be about the task(s) anchored
    // there; hand the model that association instead of leaving it amnesiac.
    const threadTasks =
      trigger.threadTs === undefined
        ? []
        : await ctx.runQuery(internal.tasks.findByChannelThread, {
            slackChannel: trigger.channel,
            slackThreadTs: trigger.threadTs,
          });
    // An un-mentioned channel-thread reply only concerns us when the thread
    // anchors one of our tasks; otherwise it's other people's conversation.
    if (trigger.channelThreadReply && threadTasks.length === 0) {
      return; // already claimed above; nothing to do or say
    }

    // Download + stage any shared files before the tool loop: images go to the
    // orchestrator's own model inline, all files are handed to whatever task it
    // starts or steers in response. The attachment manifest reflects the actual
    // staging outcome (see buildOrchestratorUserMessage).
    const staged: StagedFiles =
      trigger.files.length > 0
        ? await stageInboundFiles(ctx, botToken, args.eventId, trigger.files)
        : { stored: [], imageBlocks: [], attachments: [] };
    const userText = buildOrchestratorUserMessage({
      trigger,
      threadTasks,
      attachments: staged.attachments,
    });
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          staged.imageBlocks.length > 0
            ? [{ type: "text", text: userText }, ...staged.imageBlocks]
            : userText,
      },
    ];

    let finalText = "";
    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          output_config: { effort: "xhigh" },
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        });

        const toolUses = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );
        if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
          finalText = finalTextOf(response);
          break;
        }

        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const toolUse of toolUses) {
          results.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: await executeTool(
              ctx,
              target,
              trigger.user,
              staged.stored,
              toolUse,
            ),
          });
        }
        messages.push({ role: "user", content: results });
      }

      if (finalText === "") {
        finalText =
          "I hit my orchestration step limit before finishing — please check `list_tasks` state with me again.";
      }
      // The model's explicit "stay silent" signal for thread chatter that
      // isn't addressed to us.
      if (finalText.trim() === "NO_REPLY") {
        return;
      }
    } catch (error) {
      // Best-effort: tell the user instead of failing silently, then rethrow
      // so the failure is visible in the Convex logs. Bystander channel-thread
      // chatter gets no apology — nobody asked us anything.
      if (trigger.channelThreadReply) {
        throw error;
      }
      await postSlackMessage({
        botToken,
        channel: target.channel,
        text: ":warning: I hit an internal error handling that message. Please try again.",
        threadTs: target.threadTs,
      }).catch(() => undefined);
      throw error;
    }

    await postSlackMessage({
      botToken,
      channel: target.channel,
      text: finalText,
      threadTs: target.threadTs,
    });
  },
});
