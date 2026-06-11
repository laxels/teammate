"use node";

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import type { StartTaskRequest } from "../shared/protocol";
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
// than downgrade. (MODEL/SYSTEM_PROMPT/TOOLS are exported so smoke scripts
// can exercise the exact production request shape.)
export const MODEL = "claude-fable-5";
const MAX_TOOL_ITERATIONS = 12;

export const SYSTEM_PROMPT = `You are ultraclaude, a virtual teammate who orchestrates Claude Code devboxes for your team.

You receive Slack messages (DMs and @mentions). Either answer directly or use your tools:
- start_task delegates work to a Claude Code instance on a warm devbox. Write the prompt as a complete, self-contained spec: all context, constraints, and a clear definition of done up front. If no devbox is warm, say so plainly and suggest retrying later or stopping a running task.
- get_task / list_tasks answer questions about ongoing work.
- stop_task interrupts a running task.
- Steering a running task does NOT go through you: mid-task guidance happens on the task's monitoring page (linked in its status updates). Point users there.

Once a task starts, status updates and the monitoring link are posted to this conversation automatically — never promise to "report back" manually.

Formatting: concise Slack style — *bold*, _italic_, \`code\`, "-" bullets, <URL|label> links. No markdown headers, no **double asterisks**. Keep replies short: you are a teammate in chat, not an essayist.`;

export const TOOLS: Anthropic.Tool[] = [
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
      "Start a new Claude Code task on a warm devbox. Call this when the user asks for engineering work to be done. Fails when no devbox is warm.",
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
      },
      required: ["title", "prompt"],
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
      const claimed = await ctx.runMutation(internal.devboxes.claimWarm, {
        taskId,
      });
      if (claimed === null) {
        return toolError(
          "no warm devbox is available — all devboxes are busy or offline. Tell the user and suggest retrying later or stopping a running task.",
        );
      }
      try {
        const request: StartTaskRequest = { taskId, prompt };
        const response = await fetch(new URL("/task", claimed.gatewayUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        if (response.status !== 202) {
          await ctx.runMutation(internal.devboxes.release, {
            devboxId: claimed.devboxId,
          });
          return toolError(
            `devbox ${claimed.devboxId} rejected the task (HTTP ${response.status})`,
          );
        }
      } catch (error) {
        await ctx.runMutation(internal.devboxes.release, {
          devboxId: claimed.devboxId,
        });
        return toolError(
          `could not reach devbox ${claimed.devboxId}: ${String(error)}`,
        );
      }
      await ctx.runMutation(internal.tasks.create, {
        taskId,
        title,
        prompt,
        devboxId: claimed.devboxId,
        slackChannel: target.channel,
        ...(target.threadTs === undefined
          ? {}
          : { slackThreadTs: target.threadTs }),
      });
      return JSON.stringify({
        ok: true,
        taskId,
        devboxId: claimed.devboxId,
        monitoringUrl: monitoringUrl(claimed.gatewayUrl),
        note: "Status updates will be posted to this conversation automatically.",
      });
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
        return toolError(`task ${taskId} has no devbox assigned`);
      }
      const devbox = await ctx.runQuery(internal.devboxes.getByDevboxId, {
        devboxId: task.devboxId,
      });
      if (devbox === null) {
        return toolError(`devbox ${task.devboxId} is not registered`);
      }
      try {
        const response = await fetch(new URL("/interrupt", devbox.gatewayUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) {
          return toolError(
            `devbox ${devbox.devboxId} rejected the interrupt (HTTP ${response.status})`,
          );
        }
      } catch (error) {
        return toolError(
          `could not reach devbox ${devbox.devboxId}: ${String(error)}`,
        );
      }
      return JSON.stringify({
        ok: true,
        taskId,
        note: "interrupt sent — a 'stopped' status update will follow in the task's conversation",
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
