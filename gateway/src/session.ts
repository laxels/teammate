import { homedir } from "node:os";
import {
  type Options,
  type SDKMessage,
  type SDKUserMessage,
  type PermissionMode as SdkPermissionMode,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, StartTaskRequest } from "../../shared/protocol";
import type { EventSender } from "./events";
import { createRingBuffer, type RingBuffer } from "./history";
import { excerpt, extractAssistantText, mapResultMessage } from "./summary";
import { createThrottler, type Throttler } from "./throttle";

/**
 * The slice of the SDK `Query` interface the gateway depends on. Tests stub
 * the SDK at exactly this boundary; the real `query()` satisfies it.
 */
export type AgentQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  close(): void;
};

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AgentQuery;

export type SessionStatus = { running: boolean; taskId: string | null };

export type SessionManagerDeps = {
  emitEvent: EventSender;
  /** Called for every SDK message (broadcast to steer clients). */
  onMessage?: (message: SDKMessage) => void;
  onStatusChange?: (status: SessionStatus) => void;
  queryFn?: QueryFn;
  now?: () => number;
  progressIntervalMs?: number;
  historyCapacity?: number;
};

export const HISTORY_CAPACITY = 500;
export const PROGRESS_INTERVAL_MS = 30_000;

const MODEL = "claude-fable-5";
const EFFORT = "xhigh";

type AsyncQueue<T> = {
  push(item: T): void;
  end(): void;
  iterable: AsyncIterable<T>;
};

function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffered: T[] = [];
  let done = false;
  let notify: (() => void) | null = null;

  async function* iterate(): AsyncGenerator<T, void> {
    for (;;) {
      const next = buffered.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
  }

  return {
    push(item: T): void {
      buffered.push(item);
      notify?.();
    },
    end(): void {
      done = true;
      notify?.();
    },
    iterable: iterate(),
  };
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}

/**
 * Owns the single live Agent SDK session of this devbox.
 *
 * The session runs in streaming-input mode: the initial task prompt and any
 * follow-up steering messages are pushed onto an internal queue that backs
 * the `prompt` AsyncIterable, so follow-ups join the live conversation.
 *
 * Lifecycle events emitted to Convex:
 * - started: task accepted
 * - progress: throttled excerpt of the latest assistant text
 * - completed/failed: mapped from each SDK result message
 * - stopped: after an interrupt that cut short an in-flight turn
 */
export class SessionManager {
  #deps: Required<Pick<SessionManagerDeps, "emitEvent" | "now">> &
    Pick<SessionManagerDeps, "onMessage" | "onStatusChange">;
  #queryFn: QueryFn;
  #progressIntervalMs: number;
  #history: RingBuffer<SDKMessage>;

  #running = false;
  #taskId: string | null = null;
  #interrupted = false;
  /** True while a queued user message has not yet produced a result. */
  #turnInFlight = false;
  #queue: AsyncQueue<SDKUserMessage> | null = null;
  #query: AgentQuery | null = null;
  #throttle: Throttler;

  constructor(deps: SessionManagerDeps) {
    this.#deps = {
      emitEvent: deps.emitEvent,
      now: deps.now ?? Date.now,
      ...(deps.onMessage ? { onMessage: deps.onMessage } : {}),
      ...(deps.onStatusChange ? { onStatusChange: deps.onStatusChange } : {}),
    };
    this.#queryFn = deps.queryFn ?? (sdkQuery as QueryFn);
    this.#progressIntervalMs = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#history = createRingBuffer<SDKMessage>(
      deps.historyCapacity ?? HISTORY_CAPACITY,
    );
    this.#throttle = createThrottler(this.#progressIntervalMs, this.#deps.now);
  }

  status(): SessionStatus {
    return { running: this.#running, taskId: this.#taskId };
  }

  historySnapshot(): SDKMessage[] {
    return this.#history.snapshot();
  }

  /** Returns false (caller responds 409) if a session is already running. */
  start(request: StartTaskRequest): boolean {
    if (this.#running) return false;

    this.#running = true;
    this.#taskId = request.taskId;
    this.#interrupted = false;
    this.#turnInFlight = true;
    this.#throttle = createThrottler(this.#progressIntervalMs, this.#deps.now);

    const queue = createAsyncQueue<SDKUserMessage>();
    queue.push(userMessage(request.prompt));
    this.#queue = queue;

    const options: Options = {
      model: MODEL,
      effort: EFFORT,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: request.cwd ?? homedir(),
    };
    // Auth: CLAUDE_CODE_OAUTH_TOKEN is inherited from process.env (we do not
    // pass `options.env`, so the SDK subprocess inherits the full environment).
    const query = this.#queryFn({ prompt: queue.iterable, options });
    this.#query = query;

    this.#emit("started", `Started task: ${excerpt(request.prompt)}`);
    this.#deps.onStatusChange?.(this.status());
    void this.#run(query, request.taskId);
    return true;
  }

  /** Push a follow-up user message into the live session. */
  pushUserMessage(text: string): boolean {
    if (!this.#running || this.#queue === null) return false;
    this.#turnInFlight = true;
    this.#queue.push(userMessage(text));
    return true;
  }

  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (!this.#running || this.#query === null) return false;
    await this.#query.setPermissionMode(mode);
    return true;
  }

  /**
   * Interrupt the current turn and wind the session down. Resolves once the
   * interrupt has been requested; the run loop emits the final "stopped"
   * event when the SDK stream ends.
   */
  async stop(): Promise<boolean> {
    if (!this.#running || this.#query === null || this.#queue === null) {
      return false;
    }
    this.#interrupted = true;
    try {
      await this.#query.interrupt();
    } catch (error) {
      // Interrupting an idle session can reject; ending the input stream
      // below still winds the session down.
      console.error("[gateway] interrupt failed:", error);
    }
    this.#queue.end();
    return true;
  }

  async #run(query: AgentQuery, taskId: string): Promise<void> {
    try {
      for await (const message of query) {
        this.#history.push(message);
        this.#deps.onMessage?.(message);
        this.#handleLifecycle(message);
      }
    } catch (error) {
      console.error("[gateway] session error:", error);
      if (!this.#interrupted) {
        this.#emit(
          "failed",
          excerpt(
            `Session error: ${error instanceof Error ? error.message : String(error)}`,
          ),
          taskId,
        );
      }
    } finally {
      // Only report "stopped" when the interrupt actually cut a turn short;
      // an interrupt after a turn already completed/failed must not regress
      // the task's terminal status.
      if (this.#interrupted && this.#turnInFlight) {
        this.#emit("stopped", "Stopped by interrupt.", taskId);
      }
      this.#running = false;
      this.#taskId = null;
      this.#queue = null;
      this.#query = null;
      this.#deps.onStatusChange?.(this.status());
    }
  }

  #handleLifecycle(message: SDKMessage): void {
    if (message.type === "assistant") {
      // Skip subagent chatter; progress summaries come from the main thread.
      if (message.parent_tool_use_id !== null) return;
      const text = extractAssistantText(message);
      if (text !== null && !this.#interrupted && this.#throttle.tryAcquire()) {
        this.#emit("progress", excerpt(text));
      }
      return;
    }
    if (message.type === "result") {
      if (this.#interrupted) return; // "stopped" is emitted at session end.
      this.#turnInFlight = false;
      const terminal = mapResultMessage(message);
      this.#emit(terminal.type, terminal.summary);
    }
  }

  #emit(
    type: Parameters<EventSender>[1],
    summary: string,
    taskId: string | null = this.#taskId,
  ): void {
    if (taskId === null) return;
    void this.#deps.emitEvent(taskId, type, summary);
  }
}
