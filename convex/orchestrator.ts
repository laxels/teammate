"use node";

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import type { HostVmPayload, StartTaskRequest } from "../shared/protocol";
import {
  classifySlackEvent,
  monitoringUrl,
  resolveThreadTarget,
  type ThreadTarget,
} from "../src/orchestration";
import { postSlackMessage } from "../src/slackApi";
import { internal } from "./_generated/api";
import { type ActionCtx, internalAction } from "./_generated/server";

// Model policy (ARCHITECTURE.md): claude-fable-5 at xhigh everywhere, no
// fallback model, no `fallbacks` parameter — flagged requests refuse rather
// than downgrade.
const MODEL = "claude-fable-5";
const MAX_TOOL_ITERATIONS = 12;

const SYSTEM_PROMPT = `You are ultraclaude, a virtual teammate who orchestrates Claude Code devboxes for your team.

Each devbox is a FULL macOS desktop, not a headless sandbox: Claude Code with terminal/file access, plus complete GUI control of the desktop (screenshots, mouse, keyboard) via built-in computer-use tools. Every task can drive the browser and native apps — web apps, sites without APIs, web games, anything a person could do at a Mac — with no special flag. Never claim you cannot use a browser or a GUI: you personally cannot, but your devboxes can, so delegate.

You receive Slack messages (DMs and @mentions). Either answer directly or use your tools:
- start_task delegates work to a Claude Code instance on a devbox. By default every task gets a FRESH ephemeral devbox VM (~1-2 min to provision; no state left over from previous tasks). Write the prompt as a complete, self-contained spec: all context, constraints, and a clear definition of done up front. When the task involves the browser or another GUI app, say so in the prompt — the devbox decides on its own when to use its computer-use tools.
- When all VM slots are full, start_task queues the task and the fleet AUTOMATICALLY starts bootstrapping a new Mac host (the tool result tells you the host name and that this takes roughly 20-45 minutes). Relay that honestly. The permanent devbox devbox-1 may be idle as a faster fallback: offer it, but only use it when the user says so or explicitly asked for it up front (set use_permanent_devbox: true) — it can carry state between tasks, which is why ephemeral is the default.
- get_fleet shows the Mac hosts, VM slots, in-flight host bootstraps, queued tasks, and recent fleet events. Use it when the user asks about capacity/infrastructure or when debugging why a task hasn't started.
- get_task / list_tasks answer questions about ongoing work.
- stop_task interrupts a running task (it also cancels a task still waiting in the queue).
- Steering a running task does NOT go through you: mid-task guidance happens on the task's monitoring page (linked in its status updates). Point users there.

Once a task starts, status updates and the monitoring link are posted to this conversation automatically — never promise to "report back" manually.

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

async function executeTool(
  ctx: ActionCtx,
  target: ThreadTarget,
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
      const threadArgs =
        target.threadTs === undefined ? {} : { slackThreadTs: target.threadTs };

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
        const request: StartTaskRequest = { taskId, prompt };
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
          ...threadArgs,
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
        ...threadArgs,
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

    case "stop_task": {
      const taskId = input.taskId;
      if (typeof taskId !== "string") {
        return toolError("taskId (string) is required");
      }
      const task = await ctx.runQuery(internal.tasks.getByTaskId, { taskId });
      if (task === null) {
        return toolError(`no task with id ${taskId}`);
      }
      if (task.devboxId === undefined) {
        // Still waiting for ephemeral placement: cancel in place.
        const cancelled = await ctx.runMutation(internal.tasks.cancelQueued, {
          taskId,
        });
        return cancelled
          ? JSON.stringify({
              ok: true,
              taskId,
              note: "task was still queued (no devbox yet) and has been cancelled",
            })
          : toolError(`task ${taskId} has no devbox assigned`);
      }
      const devbox = await ctx.runQuery(internal.devboxes.getByDevboxId, {
        devboxId: task.devboxId,
      });
      if (devbox === null) {
        return toolError(`devbox ${task.devboxId} is not registered`);
      }
      await ctx.runMutation(internal.commands.enqueue, {
        devboxId: devbox.devboxId,
        kind: "interrupt",
        payload: "{}",
      });
      return JSON.stringify({
        ok: true,
        taskId,
        note: "interrupt queued — if a turn was in flight, a 'stopped' status update will follow in the task's conversation",
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
 * Processes one ingested Slack event: filters out bot/self messages, runs the
 * Fable 5 tool loop, posts the final reply to the originating channel
 * (threaded for channel mentions), and marks the event processed.
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
      await ctx.runMutation(internal.slack.markProcessed, {
        eventId: args.eventId,
      });
      return;
    }
    const { trigger } = classification;
    const target = resolveThreadTarget(trigger);

    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken === undefined) {
      throw new Error("SLACK_BOT_TOKEN is not set");
    }
    if (process.env.ANTHROPIC_API_KEY === undefined) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    const anthropic = new Anthropic();

    const source =
      trigger.type === "app_mention"
        ? `mention in channel ${trigger.channel}`
        : "direct message";
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Slack ${source} from <@${trigger.user}>:\n\n${trigger.text}`,
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
            content: await executeTool(ctx, target, toolUse),
          });
        }
        messages.push({ role: "user", content: results });
      }

      if (finalText === "") {
        finalText =
          "I hit my orchestration step limit before finishing — please check `list_tasks` state with me again.";
      }
    } catch (error) {
      // Best-effort: tell the user instead of failing silently, then rethrow
      // so the failure is visible in the Convex logs.
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
    await ctx.runMutation(internal.slack.markProcessed, {
      eventId: args.eventId,
    });
  },
});
