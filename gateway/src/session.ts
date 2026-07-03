import { homedir } from "node:os";
import {
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { DETAIL_MAX_CHARS, type StartTaskRequest } from "../../shared/protocol";
import type { EventExtra, EventSender, ScreenshotUploader } from "./events";
import { createRingBuffer, type RingBuffer } from "./history";
import { DEVBOX_SYSTEM_PROMPT } from "./prompt";
import type { ScreenRecorder } from "./recorder";
import {
  clip,
  excerpt,
  extractAskUserQuestion,
  extractAssistantText,
  extractToolResults,
  extractToolUses,
  mapResultMessage,
  prettyToolName,
  stringifyToolInput,
} from "./summary";
import { createThrottler, type Throttler } from "./throttle";

/**
 * The slice of the SDK `Query` interface the gateway depends on. Tests stub
 * the SDK at exactly this boundary; the real `query()` satisfies it.
 */
export type AgentQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<void>;
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
  /** Built fresh per task so in-process MCP servers carry no session state.
   * Receives the task id so tools (e.g. share_file) can attribute their work. */
  createMcpServers?: (taskId: string) => Record<string, McpServerConfig>;
  queryFn?: QueryFn;
  now?: () => number;
  progressIntervalMs?: number;
  historyCapacity?: number;
  /** Uploads a tool-result screenshot to Convex storage, returning its
   * storageId (or null on failure) for a tool_result timeline event (#70).
   * Best-effort; absent in tests that don't exercise screenshots. */
  uploadScreenshot?: ScreenshotUploader;
  /** Screen-recording lifecycle, started when the task's agent loop starts and
   * finished at its FIRST terminal status (a finished-but-steerable session
   * keeps running, but the task's recording is done). Best-effort. */
  recorder?: Pick<ScreenRecorder, "start" | "finish">;
  /** Hang detection thresholds (tests tighten these). */
  watchdog?: { initMs?: number; stallMs?: number; intervalMs?: number };
};

export const HISTORY_CAPACITY = 500;
/** How long an AskUserQuestion waits for a human answer before the session
 * is told to proceed on its own judgment. */
const ANSWER_TIMEOUT_MS = 30 * 60_000;
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
// Default reasoning effort. xhigh maximizes accuracy (model policy); a task can
// override it per-request when the user explicitly asks for another level (#91).
const DEFAULT_EFFORT = "xhigh";

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
  #createMcpServers:
    | ((taskId: string) => Record<string, McpServerConfig>)
    | null;
  #progressIntervalMs: number;
  #history: RingBuffer<SDKMessage>;
  #historyCapacity: number = HISTORY_CAPACITY;
  #uploadScreenshot: ScreenshotUploader | null = null;
  /** tool_use id -> pretty tool name, so a tool_result event can name the tool
   * that produced it. Reset per task; bounded by the task's tool-call count. */
  #toolUseNames = new Map<string, string>();
  /** Serializes tool-result emissions (each awaits a screenshot upload) and the
   * terminal event behind them, so a fast finish neither drops the last
   * screenshot nor reorders it past `completed`. Reset per task. */
  #toolResultTail: Promise<void> = Promise.resolve();
  #recorder: Pick<ScreenRecorder, "start" | "finish"> | null = null;
  /** True between a task's recording start and its (once-only) finish. */
  #recordingActive = false;

  #running = false;
  #taskId: string | null = null;
  #interrupted = false;
  /** True while a queued user message has not yet produced a result. */
  #turnInFlight = false;
  /** True once the current task reported a terminal status (the session may
   * outlive it as finished-but-steerable; see terminalEmitted()). */
  #terminalEmitted = false;
  /** A blocked AskUserQuestion awaiting a human answer (canUseTool). */
  #pendingQuestion: {
    input: Record<string, unknown>;
    resolve: (result: PermissionResult) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
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
    this.#historyCapacity = deps.historyCapacity ?? HISTORY_CAPACITY;
    this.#history = createRingBuffer<SDKMessage>(this.#historyCapacity);
    this.#uploadScreenshot = deps.uploadScreenshot ?? null;
    this.#recorder = deps.recorder ?? null;
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

  /**
   * True once the current task has reported completed/failed. Slack-relayed
   * steers (POST /message) must be dropped then — a late message would start
   * a new turn on a finished task and could regress its terminal record —
   * while monitoring-page steering of the finished-but-steerable session
   * stays allowed (it goes through /ws/steer, not /message).
   */
  terminalEmitted(): boolean {
    return this.#terminalEmitted;
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
    this.#terminalEmitted = false;
    // Per-task buffer: history replay never carries a previous task's tail.
    this.#history = createRingBuffer<SDKMessage>(this.#historyCapacity);
    this.#throttle = createThrottler(this.#progressIntervalMs, this.#deps.now);
    this.#toolUseNames.clear();
    this.#toolResultTail = Promise.resolve();

    const queue = createAsyncQueue<SDKUserMessage>();
    queue.push(userMessage(request.prompt));
    this.#queue = queue;

    const options: Options = {
      model: MODEL,
      effort: request.effort ?? DEFAULT_EFFORT,
      // The session's only standing instruction (the SDK default is an empty
      // system prompt): how to wait on an external event in-turn rather than
      // ending the turn and being reaped mid-task (#69). The per-task spec
      // rides in as the first user message.
      systemPrompt: DEVBOX_SYSTEM_PROMPT,
      permissionMode: "bypassPermissions",
      // AskUserQuestion is the one tool bypassPermissions can't auto-allow
      // (requiresUserInteraction): without this callback the CLI fails the
      // call instantly and the "answer by replying in the thread" flow is
      // dead. Everything else passes straight through.
      canUseTool: async (toolName, input) => {
        if (toolName !== "AskUserQuestion") {
          return { behavior: "allow", updatedInput: input };
        }
        return await this.#awaitAnswer(input);
      },
      allowDangerouslySkipPermissions: true,
      cwd: request.cwd ?? homedir(),
      // Subprocess stderr into the gateway log: hung sessions must leave
      // evidence (a first-turn hang on 2026-06-12 left none).
      stderr: (data: string) => {
        const line = data.trimEnd();
        if (line.length > 0) console.error("[gateway] sdk-stderr:", line);
      },
      // In-process MCP servers (desktop computer use, file sharing) — every
      // task gets GUI control and a Slack-file path; no per-task flag.
      ...(this.#createMcpServers !== null
        ? { mcpServers: this.#createMcpServers(request.taskId) }
        : {}),
    };
    // Auth: CLAUDE_CODE_OAUTH_TOKEN is inherited from process.env (we do not
    // pass `options.env`, so the SDK subprocess inherits the full environment).
    const query = this.#queryFn({ prompt: queue.iterable, options });
    this.#query = query;

    this.#emit("started", `Started task: ${excerpt(request.prompt)}`);
    // Record the devbox screen for the lifetime of this task (best-effort).
    this.#recorder?.start(request.taskId);
    this.#recordingActive = true;
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
   * seconds and streams messages continuously thereafter. Only turns in
   * flight are policed: a finished-but-steerable session sits legitimately
   * silent (a devbox idles, steerable, until it retires), and its task already
   * reported a terminal status that a late "failed" would regress. */
  #checkWatchdog(taskId: string): void {
    if (!this.#running || !this.#turnInFlight) return;
    // A session blocked on AskUserQuestion is waiting for a human, not hung
    // (the turn IS in flight while canUseTool blocks).
    if (this.#pendingQuestion !== null) return;
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
    this.#terminalEmitted = true;
    this.#emit("failed", excerpt(`Session watchdog: ${reason}`), taskId);
    this.#finishRecording(taskId);
    void this.stop();
    // A subprocess hung badly enough to trip the watchdog may also ignore the
    // interrupt, leaving #run blocked forever — which would wedge the gateway
    // (retire polls /health until the slot frees). Last resort: exit for a
    // clean launchd relaunch. unref so tests never hang on it.
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

  /** Blocks an AskUserQuestion until a steered user message answers it (or
   * the timeout tells the session to use its own judgment). The watchdog
   * treats a pending question as healthy — waiting on a human is not a hang. */
  #awaitAnswer(input: Record<string, unknown>): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#resolvePendingQuestion({
          behavior: "deny",
          message:
            "No answer arrived within 30 minutes — proceed with your best judgment, or finish up and report what you'd need.",
        });
      }, ANSWER_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingQuestion = { input, timer, resolve };
    });
  }

  #resolvePendingQuestion(result: PermissionResult): boolean {
    const pending = this.#pendingQuestion;
    if (pending === null) return false;
    this.#pendingQuestion = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  /** Push a follow-up user message into the live session. A pending
   * AskUserQuestion consumes the message as its answer instead of starting a
   * new turn. */
  pushUserMessage(text: string): boolean {
    if (!this.#running || this.#queue === null) return false;
    if (this.#pendingQuestion !== null) {
      // Preserve the tool's original input (its schema requires `questions`)
      // and attach the human's freeform answer.
      return this.#resolvePendingQuestion({
        behavior: "allow",
        updatedInput: { ...this.#pendingQuestion.input, response: text },
      });
    }
    this.#turnInFlight = true;
    // Restart the stall clock: the previous turn may have finished long ago,
    // and the new turn earns a fresh stallMs budget. Leave a null untouched
    // so a steer before the first SDK message keeps init-hang detection.
    if (this.#lastMessageAt !== null) this.#lastMessageAt = this.#deps.now();
    this.#queue.push(userMessage(text));
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
    this.#resolvePendingQuestion({
      behavior: "deny",
      message: "The session is being stopped.",
    });
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
      // Only report "failed" when the error actually cut a turn short: a
      // finished-but-steerable session keeps the stream open while idle, and
      // its task already reported a terminal status that a late "failed"
      // would regress (terminal-to-terminal transitions apply in Convex).
      if (!this.#interrupted && this.#turnInFlight) {
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
      // The recording finishes on any session wind-down too — covering an
      // interrupt of a finished-but-steerable session whose terminal result
      // already fired #finishRecording (idempotent) and the rare wind-down
      // that reached neither a result nor the stopped branch.
      this.#finishRecording(taskId);
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

  /** Stop + upload the task's screen recording, exactly once, at its first
   * terminal status. Unlike the transcript (re-sent on every result so a
   * steered follow-up refreshes it), the recording is finalized once: the
   * task is done, and a finished-but-steerable session is no longer the
   * recording's subject. Fire-and-forget; the upload races the VM-reclaim
   * grace window. */
  #finishRecording(taskId: string | null = this.#taskId): void {
    if (!this.#recordingActive || this.#recorder === null || taskId === null) {
      return;
    }
    this.#recordingActive = false;
    void this.#recorder.finish(taskId);
  }

  #handleLifecycle(message: SDKMessage): void {
    if (this.#interrupted) return;
    if (message.type === "assistant") {
      // Skip subagent chatter; the timeline + summaries come from the main
      // thread (the screen recording is of the main agent's desktop too).
      if (message.parent_tool_use_id !== null) return;
      // AskUserQuestion = the session is blocked on a human answer. Bypasses
      // the progress throttle: this is exactly the event the user must see.
      const question = extractAskUserQuestion(message);
      if (question !== null) {
        // #114: the question is assistant text the user must read to answer —
        // emit it in full, clipped only for size.
        this.#emit("needs_input", clip(question, DETAIL_MAX_CHARS));
        return;
      }
      const text = extractAssistantText(message);
      if (text !== null) {
        // #114: assistant text is never summarized — emit the whole response so
        // the user sees all of it everywhere (the dashboard timeline AND the
        // Slack thread). Clip only to stay under the per-row / Slack size cap;
        // whitespace is preserved, so there is no separate `detail` excerpt.
        const full = clip(text, DETAIL_MAX_CHARS);
        // Full narration for the retro timeline (#70): every turn, un-throttled,
        // info-only. The dashboard renders this as the assistant's words and
        // hides the throttled `progress` echo below to avoid duplication.
        this.#emit("assistant_text", full);
        // The throttled echo drives the Slack thread + "running" liveness.
        if (this.#throttle.tryAcquire()) this.#emit("progress", full);
      }
      // Each tool the model invoked this turn -> a collapsible timeline entry.
      for (const use of extractToolUses(message)) {
        const name = prettyToolName(use.name);
        // Remember the name so the matching tool_result can label itself.
        this.#toolUseNames.set(use.id, name);
        // AskUserQuestion is already surfaced as needs_input above.
        if (use.name === "AskUserQuestion") continue;
        this.#emitInfo("tool_call", name, {
          tool: name,
          detail: clip(stringifyToolInput(use.input), DETAIL_MAX_CHARS),
        });
      }
      return;
    }
    if (message.type === "user") {
      // Tool results (computer-use returns a screenshot after each action).
      // Subagent results are skipped, like subagent assistant text.
      if (message.parent_tool_use_id !== null) return;
      const taskId = this.#taskId;
      if (taskId === null) return;
      // Serialize on the tail so the (async, screenshot-uploading) emission
      // ORDERS before the terminal event and, crucially, carries the taskId
      // captured NOW — the SDK can yield `result` right after this message and
      // wind the session down (clearing #taskId) before the upload resolves.
      this.#toolResultTail = this.#toolResultTail.then(() =>
        this.#emitToolResults(message, taskId),
      );
      return;
    }
    if (message.type === "result") {
      this.#turnInFlight = false;
      this.#terminalEmitted = true;
      const terminal = mapResultMessage(message);
      const taskId = this.#taskId;
      // Drain in-flight tool-result emissions (screenshot uploads) BEFORE the
      // terminal status, so a fast-finishing task can't drop its last
      // screenshot/result and the timeline stays in order. taskId is captured
      // because the session may have wound down by the time the tail resolves.
      this.#toolResultTail = this.#toolResultTail.then(() => {
        if (taskId !== null) {
          void this.#deps.emitEvent(taskId, terminal.type, terminal.summary);
        }
      });
      this.#finishRecording();
    }
  }

  /** Emit each tool_result as a timeline event, uploading any screenshot to
   * Convex storage first so the event can reference it by storageId (#70).
   * Runs on #toolResultTail (serialized), with the taskId captured by the
   * caller so a wound-down session never drops the event. */
  async #emitToolResults(
    message: SDKUserMessage,
    taskId: string,
  ): Promise<void> {
    for (const result of extractToolResults(message)) {
      if (this.#interrupted) return;
      // Never let one emission reject: #toolResultTail is a bare .then chain,
      // so an escaped rejection would skip every later callback — silently
      // dropping the remaining results AND the terminal event queued behind
      // them. (The production uploader never rejects by contract, but that
      // invariant is enforced nowhere else.) Log and continue.
      try {
        const tool = this.#toolUseNames.get(result.toolUseId);
        let imageStorageId: string | undefined;
        const firstImage = result.images[0];
        if (firstImage !== undefined && this.#uploadScreenshot !== null) {
          const bytes = Uint8Array.from(Buffer.from(firstImage.data, "base64"));
          const id = await this.#uploadScreenshot(bytes, firstImage.mimeType);
          if (id !== null) imageStorageId = id;
        }
        const summary =
          result.text !== ""
            ? excerpt(result.text)
            : imageStorageId !== undefined
              ? "Screenshot"
              : "Tool result";
        void this.#deps.emitEvent(taskId, "tool_result", summary, {
          ...(tool === undefined ? {} : { tool }),
          ...(result.text === ""
            ? {}
            : { detail: clip(result.text, DETAIL_MAX_CHARS) }),
          ...(imageStorageId === undefined ? {} : { imageStorageId }),
        });
      } catch (error) {
        console.error("[gateway] tool-result emission failed:", error);
      }
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

  /** Emit an info event (#70) for the current task, with its enrichment. Info
   * events always belong to the live task, so there is no taskId override. */
  #emitInfo(
    type: Parameters<EventSender>[1],
    summary: string,
    extra: EventExtra,
  ): void {
    if (this.#taskId === null) return;
    void this.#deps.emitEvent(this.#taskId, type, summary, extra);
  }
}
