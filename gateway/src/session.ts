import { homedir } from "node:os";
import {
  type McpServerConfig,
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
  /** Built fresh per task so in-process MCP servers carry no session state. */
  createMcpServers?: () => Record<string, McpServerConfig>;
  queryFn?: QueryFn;
  now?: () => number;
  progressIntervalMs?: number;
  historyCapacity?: number;
  /** Hang detection thresholds (tests tighten these). */
  watchdog?: { initMs?: number; stallMs?: number; intervalMs?: number };
};

export const HISTORY_CAPACITY = 500;
export const PROGRESS_INTERVAL_MS = 30_000;

// Watchdog defaults: the SDK emits its init message within seconds of spawn
// (well before the first model response), so a long first-message silence
// means the subprocess or its first API call is hung — observed live on
// 2026-06-12: a session stalled before its first response for 35 min with
// zero signals. Mid-session, tool results and assistant messages flow
// continuously; prolonged silence is a stall (xhigh thinking pauses included,
// 10 min is generous).
export const INIT_WATCHDOG_MS = 2 * 60_000;
export const STALL_WATCHDOG_MS = 10 * 60_000;
export const WATCHDOG_INTERVAL_MS = 10_000;

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
  #createMcpServers: (() => Record<string, McpServerConfig>) | null;
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
  #watchdogConfig: { initMs: number; stallMs: number; intervalMs: number };
  #watchdogTimer: ReturnType<typeof setInterval> | null = null;
  #sessionStartedAt = 0;
  /** null until the first SDK message of the current session arrives. */
  #lastMessageAt: number | null = null;

  constructor(deps: SessionManagerDeps) {
    this.#deps = {
      emitEvent: deps.emitEvent,
      now: deps.now ?? Date.now,
      ...(deps.onMessage ? { onMessage: deps.onMessage } : {}),
      ...(deps.onStatusChange ? { onStatusChange: deps.onStatusChange } : {}),
    };
    this.#queryFn = deps.queryFn ?? (sdkQuery as QueryFn);
    this.#createMcpServers = deps.createMcpServers ?? null;
    this.#progressIntervalMs = deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.#history = createRingBuffer<SDKMessage>(
      deps.historyCapacity ?? HISTORY_CAPACITY,
    );
    this.#throttle = createThrottler(this.#progressIntervalMs, this.#deps.now);
    this.#watchdogConfig = {
      initMs: deps.watchdog?.initMs ?? INIT_WATCHDOG_MS,
      stallMs: deps.watchdog?.stallMs ?? STALL_WATCHDOG_MS,
      intervalMs: deps.watchdog?.intervalMs ?? WATCHDOG_INTERVAL_MS,
    };
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
      // Subprocess stderr into the gateway log: hung sessions must leave
      // evidence (a first-turn hang on 2026-06-12 left none).
      stderr: (data: string) => {
        const line = data.trimEnd();
        if (line.length > 0) console.error("[gateway] sdk-stderr:", line);
      },
      // In-process MCP servers (desktop computer use) — every task gets GUI
      // control; no per-task flag.
      ...(this.#createMcpServers !== null
        ? { mcpServers: this.#createMcpServers() }
        : {}),
    };
    // Auth: CLAUDE_CODE_OAUTH_TOKEN is inherited from process.env (we do not
    // pass `options.env`, so the SDK subprocess inherits the full environment).
    const query = this.#queryFn({ prompt: queue.iterable, options });
    this.#query = query;

    this.#emit("started", `Started task: ${excerpt(request.prompt)}`);
    this.#deps.onStatusChange?.(this.status());
    this.#sessionStartedAt = this.#deps.now();
    this.#lastMessageAt = null;
    this.#watchdogTimer = setInterval(
      () => this.#checkWatchdog(request.taskId),
      this.#watchdogConfig.intervalMs,
    );
    void this.#run(query, request.taskId);
    return true;
  }

  /** Hang detection: a healthy session emits its SDK init message within
   * seconds and streams messages continuously thereafter. */
  #checkWatchdog(taskId: string): void {
    if (!this.#running) return;
    const now = this.#deps.now();
    const sinceStart = now - this.#sessionStartedAt;
    const sinceLast =
      this.#lastMessageAt === null ? null : now - this.#lastMessageAt;
    const reason =
      this.#lastMessageAt === null && sinceStart > this.#watchdogConfig.initMs
        ? `no SDK message at all ${Math.round(sinceStart / 1000)}s after session start (subprocess or first API call hung)`
        : sinceLast !== null && sinceLast > this.#watchdogConfig.stallMs
          ? `no SDK messages for ${Math.round(sinceLast / 1000)}s (session stalled mid-task)`
          : null;
    if (reason === null) return;
    console.error(
      `[gateway] session watchdog tripped for ${taskId}: ${reason}`,
    );
    // One trip is final.
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
    // Emit the terminal status FIRST (recycles ephemeral devboxes via the
    // normal retire flow), then wind the session down. Suppress the
    // interrupt-path "stopped" event so it cannot overwrite "failed".
    this.#turnInFlight = false;
    this.#emit("failed", excerpt(`Session watchdog: ${reason}`), taskId);
    void this.stop();
    // A subprocess hung badly enough to trip the watchdog may also ignore the
    // interrupt, leaving #run blocked forever — which would wedge a permanent
    // devbox's gateway (eviction polls /health until free). Last resort:
    // exit for a clean launchd relaunch. unref so tests never hang on it.
    const hardExit = setTimeout(() => {
      if (this.#running) {
        console.error(
          "[gateway] watchdog: session did not wind down 30s after interrupt; exiting for a clean relaunch",
        );
        process.exit(1);
      }
    }, 30_000);
    hardExit.unref?.();
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
        this.#lastMessageAt = this.#deps.now();
        // Type-only breadcrumb so a hung/stalled session is diagnosable from
        // the gateway log alone (content still goes to steer clients only).
        console.log(`[gateway] sdk message: ${message.type}`);
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
      if (this.#watchdogTimer !== null) {
        clearInterval(this.#watchdogTimer);
        this.#watchdogTimer = null;
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
