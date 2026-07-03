import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DevboxEventType } from "../../shared/protocol";
import type { EventSender } from "./events";
import type { AgentQuery, QueryFn } from "./session";

/** Fetch stub that records every call and answers via `responder`. */
export function recordingFetch(responder: (url: string) => Response): {
  fetchFn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url));
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

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
      model: "claude-opus-4-8",
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

/** Assistant message whose only content is an AskUserQuestion tool call. */
export function askUserQuestionMessage(question: string): SDKAssistantMessage {
  const base = assistantMessage("");
  base.message.content = [
    {
      type: "tool_use",
      id: "toolu_test",
      name: "AskUserQuestion",
      input: { questions: [{ question }] },
    },
  ];
  return base;
}

/** Assistant message with optional leading text plus one tool_use block (#70). */
export function assistantWithToolUse(opts: {
  text?: string;
  toolName: string;
  toolUseId: string;
  input: unknown;
}): SDKAssistantMessage {
  const base = assistantMessage(opts.text ?? "");
  base.message.content = [
    ...(opts.text !== undefined && opts.text !== ""
      ? ([{ type: "text", text: opts.text, citations: null }] as const)
      : []),
    {
      type: "tool_use",
      id: opts.toolUseId,
      name: opts.toolName,
      input: opts.input,
    },
  ];
  return base;
}

/** User message carrying a single tool_result block, with optional text and a
 * base64 image (the shape computer-use screenshots arrive in) (#70). */
export function toolResultMessage(opts: {
  toolUseId: string;
  text?: string;
  imageBase64?: string;
  parentToolUseId?: string | null;
}): SDKUserMessage {
  const inner: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: "image/png"; data: string };
      }
  > = [];
  if (opts.text !== undefined) inner.push({ type: "text", text: opts.text });
  if (opts.imageBase64 !== undefined) {
    inner.push({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: opts.imageBase64,
      },
    });
  }
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: opts.toolUseId, content: inner },
      ],
    },
    parent_tool_use_id: opts.parentToolUseId ?? null,
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
  detail?: string;
  tool?: string;
  imageStorageId?: string;
};

export function createEventRecorder(): {
  events: RecordedEvent[];
  emitEvent: EventSender;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emitEvent: async (taskId, type, summary, extra) => {
      events.push({ taskId, type, summary, ...extra });
    },
  };
}

export type FakeQueryControl = {
  calls: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }[];
  interrupts: number;
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
    });
    return query;
  };

  return { queryFn, control };
}

/** The result shape MCP tool handlers resolve with, as the tests consume it. */
export type ToolResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
};

/** Minimal structural view of an SDK tool definition; the real handler takes
 * `extra: unknown`, so any second argument is accepted. */
type McpTool = {
  name: string;
  handler: (args: never, extra: Record<string, unknown>) => Promise<unknown>;
};

export function findTool<T extends { name: string }>(
  tools: readonly T[],
  name: string,
): T {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

export async function call(
  tools: readonly McpTool[],
  name: string,
  args: unknown,
): Promise<ToolResult> {
  // Tools are a heterogeneous union, so handler's parameter collapses to
  // never; tests call handlers with args matching that tool's schema.
  return (await findTool(tools, name).handler(args as never, {})) as ToolResult;
}

/** Wrap a hand-written SDK message generator into the AgentQuery shape,
 * hiding the interrupt wiring every manual stub repeats. */
export function manualQueryFn(
  generate: (
    params: Parameters<QueryFn>[0],
  ) => AsyncGenerator<SDKMessage, void>,
  hooks: { onInterrupt?: () => void } = {},
): QueryFn {
  return (params) =>
    Object.assign(generate(params), {
      interrupt: async () => hooks.onInterrupt?.(),
    });
}

/** A single turn that hangs until interrupted, finishing normally only if the
 * interrupt never arrives — the stub both interrupt tests share. */
export function interruptGatedQueryFn(): QueryFn {
  const gate = Promise.withResolvers<void>();
  let interrupted = false;
  return manualQueryFn(
    async function* (params) {
      await params.prompt[Symbol.asyncIterator]().next();
      yield assistantMessage("working...");
      await gate.promise;
      if (!interrupted) yield resultSuccess("finished");
    },
    {
      onInterrupt: () => {
        interrupted = true;
        gate.resolve();
      },
    },
  );
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
