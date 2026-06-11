import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DevboxEventType } from "../../shared/protocol";
import type { EventSender } from "../src/events";
import type { AgentQuery, QueryFn } from "../src/session";

// Type-level filler for fields the gateway never reads.
const usageStub = {} as SDKAssistantMessage["message"]["usage"];
const resultUsageStub = {} as Extract<
  SDKResultMessage,
  { subtype: "success" }
>["usage"];

export function assistantMessage(
  text: string,
  parentToolUseId: string | null = null,
): SDKAssistantMessage {
  return {
    type: "assistant",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      content: [{ type: "text", text, citations: null }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      diagnostics: null,
      usage: usageStub,
    },
    parent_tool_use_id: parentToolUseId,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  };
}

export function resultSuccess(text: string, isError = false): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: isError,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: resultUsageStub,
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  };
}

export function resultError(
  subtype: Extract<SDKResultMessage, { errors: string[] }>["subtype"],
  errors: string[] = [],
): SDKResultMessage {
  return {
    type: "result",
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: resultUsageStub,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  };
}

export function userMessageText(message: SDKUserMessage): string {
  const content = message.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

export type RecordedEvent = {
  taskId: string;
  type: DevboxEventType;
  summary: string;
};

export function createEventRecorder(): {
  events: RecordedEvent[];
  emitEvent: EventSender;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emitEvent: async (taskId, type, summary) => {
      events.push({ taskId, type, summary });
    },
  };
}

export type FakeQueryControl = {
  calls: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }[];
  interrupts: number;
  permissionModes: string[];
};

/**
 * Stub of the SDK query() boundary that mimics streaming-input behavior:
 * for every user message read from the prompt iterable it emits the messages
 * produced by `turn(userText)`, and it finishes when the input ends or an
 * interrupt arrives.
 */
export function createEchoQueryFn(
  turn: (userText: string) => SDKMessage[] = (text) => [
    assistantMessage(`working on: ${text}`),
    resultSuccess(`done: ${text}`),
  ],
): { queryFn: QueryFn; control: FakeQueryControl } {
  const control: FakeQueryControl = {
    calls: [],
    interrupts: 0,
    permissionModes: [],
  };

  const queryFn: QueryFn = (params) => {
    control.calls.push(params);
    let interrupted = false;

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      for await (const message of params.prompt) {
        if (interrupted) return;
        for (const out of turn(userMessageText(message))) {
          yield out;
          if (interrupted) return;
        }
      }
    }

    const generator = generate();
    const query: AgentQuery = Object.assign(generator, {
      interrupt: async () => {
        control.interrupts += 1;
        interrupted = true;
      },
      setPermissionMode: async (mode: string) => {
        control.permissionModes.push(mode);
      },
      close: () => {
        interrupted = true;
      },
    });
    return query;
  };

  return { queryFn, control };
}

export async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
