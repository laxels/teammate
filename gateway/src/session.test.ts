import { describe, expect, test } from "bun:test";
import type {
  McpServerConfig,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEVBOX_SYSTEM_PROMPT } from "./prompt";
import { type QueryFn, SessionManager } from "./session";
import {
  askUserQuestionMessage,
  assistantMessage,
  createEchoQueryFn,
  createEventRecorder,
  interruptGatedQueryFn,
  manualQueryFn,
  resultError,
  resultSuccess,
  until,
  userMessageText,
} from "./test-helpers";

function makeSession(
  queryFn: QueryFn,
  extra: { now?: () => number } = {},
): {
  session: SessionManager;
  events: ReturnType<typeof createEventRecorder>["events"];
  broadcasts: SDKMessage[];
} {
  const { events, emitEvent } = createEventRecorder();
  const broadcasts: SDKMessage[] = [];
  const session = new SessionManager({
    emitEvent,
    onMessage: (message) => broadcasts.push(message),
    queryFn,
    ...extra,
  });
  return { session, events, broadcasts };
}

describe("SessionManager", () => {
  test("AskUserQuestion emits needs_input with the question, bypassing the progress throttle", async () => {
    const { queryFn } = createEchoQueryFn((text) => [
      assistantMessage(`working on: ${text}`),
      askUserQuestionMessage("Should I use staging or prod?"),
      resultSuccess(`done: ${text}`),
    ]);
    const { session, events } = makeSession(queryFn);
    session.start({ taskId: "task-1", prompt: "deploy" });
    await until(() => events.some((e) => e.type === "completed"));
    const needsInput = events.find((e) => e.type === "needs_input");
    expect(needsInput?.summary).toBe("Should I use staging or prod?");
    // The progress event from the same turn still flowed (throttle untouched).
    expect(events.some((e) => e.type === "progress")).toBe(true);
  });

  test("start feeds the prompt through streaming input and reports lifecycle events", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session, events, broadcasts } = makeSession(queryFn);

    expect(
      session.start({
        taskId: "task-1",
        prompt: "build the thing",
        cwd: "/tmp/project",
      }),
    ).toBe(true);
    expect(session.status()).toEqual({ running: true, taskId: "task-1" });

    await until(() => events.some((e) => e.type === "completed"));

    // The streaming input delivered the original prompt to the SDK.
    const completed = events.find((e) => e.type === "completed");
    expect(completed?.summary).toBe("done: build the thing");
    expect(completed?.taskId).toBe("task-1");

    // started came first, progress carries the assistant text.
    expect(events[0]?.type).toBe("started");
    expect(events[0]?.summary).toContain("build the thing");
    expect(events.find((e) => e.type === "progress")?.summary).toBe(
      "working on: build the thing",
    );

    // Every SDK message was broadcast and kept in history.
    expect(broadcasts.map((m) => m.type)).toEqual(["assistant", "result"]);
    expect(session.historySnapshot()).toEqual(broadcasts);

    // The session options conform to the devbox contract.
    const options = control.calls[0]?.options;
    expect(options?.model).toBe("claude-opus-4-8");
    expect(options?.effort).toBe("xhigh");
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.cwd).toBe("/tmp/project");
    expect(options?.fallbackModel).toBeUndefined();
    // Every devbox session carries the wait-on-external-event discipline as its
    // system prompt — the SDK default is empty, so without this the agent has no
    // standing guidance and hallucinates a poller (#69).
    expect(options?.systemPrompt).toBe(DEVBOX_SYSTEM_PROMPT);
  });

  test("an explicit request effort overrides the xhigh default (#91)", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "quick job", effort: "low" });

    expect(control.calls[0]?.options?.effort).toBe("low");
  });

  test("starts the screen recorder on launch and finishes it once at terminal", async () => {
    const { queryFn } = createEchoQueryFn();
    const { emitEvent } = createEventRecorder();
    const starts: string[] = [];
    const finishes: string[] = [];
    const session = new SessionManager({
      emitEvent,
      queryFn,
      recorder: {
        start: (taskId) => starts.push(taskId),
        finish: async (taskId) => {
          finishes.push(taskId);
        },
      },
    });

    session.start({ taskId: "task-1", prompt: "go" });
    // Recording begins the moment the agent loop starts.
    expect(starts).toEqual(["task-1"]);

    await until(() => finishes.length > 0);
    expect(finishes).toEqual(["task-1"]);

    // A steered follow-up on the finished-but-steerable session must not begin
    // a second recording, and must not re-finish (the recording is done once).
    expect(session.pushUserMessage("again")).toBe(true);
    await until(
      () =>
        session.historySnapshot().filter((m) => m.type === "result").length >=
        2,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(starts).toEqual(["task-1"]);
    expect(finishes).toEqual(["task-1"]);
  });

  test("finishes the screen recording when a task is interrupted", async () => {
    const queryFn = interruptGatedQueryFn();
    const { emitEvent } = createEventRecorder();
    const finishes: string[] = [];
    const session = new SessionManager({
      emitEvent,
      queryFn,
      recorder: {
        start: () => {},
        finish: async (taskId) => {
          finishes.push(taskId);
        },
      },
    });

    session.start({ taskId: "task-1", prompt: "long job" });
    await session.stop();
    await until(() => !session.status().running);

    expect(finishes).toEqual(["task-1"]);
  });

  test("rejects a second task while one is running", async () => {
    const { queryFn } = createEchoQueryFn();
    const { session } = makeSession(queryFn);
    expect(session.start({ taskId: "task-1", prompt: "one" })).toBe(true);
    expect(session.start({ taskId: "task-2", prompt: "two" })).toBe(false);
    expect(session.status().taskId).toBe("task-1");
  });

  test("follow-up user messages join the live session", async () => {
    const { queryFn } = createEchoQueryFn();
    const { session, events, broadcasts } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "first" });
    await until(() => events.some((e) => e.summary === "done: first"));

    expect(session.pushUserMessage("second")).toBe(true);
    await until(() => events.some((e) => e.summary === "done: second"));

    // Same session: one query() call served both turns.
    expect(broadcasts.filter((m) => m.type === "result")).toHaveLength(2);
    expect(session.status().running).toBe(true);
  });

  test("pushUserMessage returns false with no live session", () => {
    const { queryFn } = createEchoQueryFn();
    const { session } = makeSession(queryFn);
    expect(session.pushUserMessage("hello?")).toBe(false);
  });

  test("interrupt mid-turn emits stopped (and no completed)", async () => {
    const { session, events } = makeSession(interruptGatedQueryFn());

    session.start({ taskId: "task-1", prompt: "long job" });
    await until(() => events.some((e) => e.type === "progress"));

    expect(await session.stop()).toBe(true);
    await until(() => !session.status().running);

    // A single assistant turn now yields both a full, un-throttled
    // assistant_text (retro timeline, #70) and the throttled progress excerpt
    // (Slack), in that order, before the interrupt's stopped.
    expect(events.map((e) => e.type)).toEqual([
      "started",
      "assistant_text",
      "progress",
      "stopped",
    ]);
  });

  test("interrupt after a completed turn does not regress the task to stopped", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "quick job" });
    await until(() => events.some((e) => e.type === "completed"));

    expect(await session.stop()).toBe(true);
    await until(() => !session.status().running);

    expect(control.interrupts).toBe(1);
    expect(events.some((e) => e.type === "stopped")).toBe(false);
    expect(session.start({ taskId: "task-2", prompt: "next" })).toBe(true);
  });

  test("a long, multi-line assistant response is emitted in full, never excerpted (#114)", async () => {
    // A retrieval-style turn: the assistant's text IS the output. It is longer
    // than the old 300-char Slack excerpt and carries newlines + indentation
    // that whitespace-collapsing used to destroy.
    const body = `Here are the results:\n${Array.from(
      { length: 40 },
      (_, i) => `  ${i}. item number ${i}`,
    ).join("\n")}`;
    expect(body.length).toBeGreaterThan(300); // would have been cut before #114
    const { queryFn } = createEchoQueryFn(() => [
      assistantMessage(body),
      resultSuccess(body),
    ]);
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "retrieve everything" });
    await until(() => events.some((e) => e.type === "completed"));

    // assistant_text (dashboard timeline), progress (Slack thread), and
    // completed (Slack) all carry the full text verbatim — whitespace intact.
    expect(events.find((e) => e.type === "assistant_text")?.summary).toBe(body);
    expect(events.find((e) => e.type === "progress")?.summary).toBe(body);
    expect(events.find((e) => e.type === "completed")?.summary).toBe(body);
  });

  test("progress events are throttled to one per window", async () => {
    const clock = { t: 0 };
    const queryFn = manualQueryFn(async function* (params) {
      const iterator = params.prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield assistantMessage("first");
      yield assistantMessage("second"); // same instant: suppressed
      clock.t = 30_000;
      yield assistantMessage("third"); // window elapsed: emitted
      yield resultSuccess("done");
    });
    const { session, events } = makeSession(queryFn, { now: () => clock.t });

    session.start({ taskId: "task-1", prompt: "chatty" });
    await until(() => events.some((e) => e.type === "completed"));

    expect(
      events.filter((e) => e.type === "progress").map((e) => e.summary),
    ).toEqual(["first", "third"]);
  });

  test("subagent assistant messages do not produce progress events", async () => {
    const { queryFn } = createEchoQueryFn(() => [
      assistantMessage("subagent chatter", "toolu_123"),
      resultSuccess("done"),
    ]);
    const { session, events, broadcasts } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "delegate" });
    await until(() => events.some((e) => e.type === "completed"));

    expect(events.some((e) => e.type === "progress")).toBe(false);
    // ...but the raw message is still broadcast to steer clients.
    expect(broadcasts.some((m) => m.type === "assistant")).toBe(true);
  });

  test("an error result maps to a failed event", async () => {
    const { queryFn } = createEchoQueryFn(() => [
      resultError("error_max_turns", ["too many turns"]),
    ]);
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "doomed" });
    await until(() => events.some((e) => e.type === "failed"));

    const failed = events.find((e) => e.type === "failed");
    expect(failed?.summary).toContain("error_max_turns");
    expect(events.some((e) => e.type === "completed")).toBe(false);
  });

  test("a stream error on an idle finished-but-steerable session does not regress the task to failed", async () => {
    // The SDK subprocess dies while the session idles AFTER its result: the
    // task already reported its terminal status, and a late "failed" would
    // overwrite it (Convex applies terminal-to-terminal transitions).
    const crash = Promise.withResolvers<void>();
    const queryFn = manualQueryFn(async function* (params) {
      const iterator = params.prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield assistantMessage("working");
      yield resultSuccess("done");
      await crash.promise; // idle, finished-but-steerable
      throw new Error("subprocess died while idle");
    });
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "quick job" });
    await until(() => events.some((e) => e.type === "completed"));

    crash.resolve();
    await until(() => !session.status().running);

    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  test("a crash in the SDK stream emits failed and frees the session", async () => {
    const queryFn = manualQueryFn(async function* (params) {
      const iterator = params.prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield assistantMessage("about to crash");
      throw new Error("subprocess exploded");
    });
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "kaboom" });
    await until(() => !session.status().running);

    const failed = events.find((e) => e.type === "failed");
    expect(failed?.summary).toContain("subprocess exploded");
    expect(session.start({ taskId: "task-2", prompt: "retry" })).toBe(true);
  });

  test("in-process MCP servers are rebuilt and passed to the SDK per task", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { emitEvent } = createEventRecorder();
    let factoryCalls = 0;
    const session = new SessionManager({
      emitEvent,
      queryFn,
      createMcpServers: () => {
        factoryCalls += 1;
        return {
          "computer-use": {
            type: "sdk",
            name: "computer-use",
            instance: {},
          } as unknown as McpServerConfig,
        };
      },
    });

    session.start({ taskId: "task-1", prompt: "first" });
    await until(() => control.calls.length > 0);
    expect(control.calls[0]?.options?.mcpServers).toHaveProperty(
      "computer-use",
    );

    await session.stop();
    await until(() => !session.status().running);
    session.start({ taskId: "task-2", prompt: "second" });
    expect(factoryCalls).toBe(2);
  });

  test("a steered reply answers a pending AskUserQuestion instead of starting a turn", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session, events } = makeSession(queryFn);
    session.start({ taskId: "task-1", prompt: "work" });
    await until(() => events.some((e) => e.type === "completed"));

    const canUseTool = control.calls[0]?.options?.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool not wired");
    const input = { questions: [{ question: "Which env?" }] };
    const pending = canUseTool("AskUserQuestion", input, {
      signal: new AbortController().signal,
      toolUseID: "toolu_test",
    });

    const eventsBefore = events.length;
    expect(session.pushUserMessage("use staging")).toBe(true);
    expect(await pending).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [{ question: "Which env?" }],
        response: "use staging",
      },
    });
    // The answer fed the tool call — it must not have queued a new turn.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.length).toBe(eventsBefore);
  });

  test("canUseTool passes every other tool straight through", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session, events } = makeSession(queryFn);
    session.start({ taskId: "task-1", prompt: "work" });
    await until(() => events.some((e) => e.type === "completed"));
    const canUseTool = control.calls[0]?.options?.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool not wired");
    expect(
      await canUseTool(
        "Bash",
        { command: "ls" },
        { signal: new AbortController().signal, toolUseID: "toolu_test" },
      ),
    ).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
  });

  test("stall watchdog treats a session blocked on AskUserQuestion as healthy", async () => {
    const clock = { t: 0 };
    const gate = Promise.withResolvers<void>();
    let captured: Parameters<QueryFn>[0] | null = null;
    const oneMessageThenSilence = manualQueryFn(async function* (params) {
      captured = params;
      yield assistantMessage("starting");
      await gate.promise; // mid-task silence (waiting on the human)
    });
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn: oneMessageThenSilence,
      now: () => clock.t,
      watchdog: { initMs: 60_000, stallMs: 1_000, intervalMs: 5 },
    });
    session.start({ taskId: "task-1", prompt: "ask me things" });
    await until(() => events.some((e) => e.type === "started"));

    // Block on a question, then push the clock far past stallMs.
    const canUseTool = (captured as Parameters<QueryFn>[0] | null)?.options
      ?.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool not wired");
    const pending = canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Proceed?" }] },
      { signal: new AbortController().signal, toolUseID: "toolu_test" },
    );
    clock.t = 10_000;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events.some((e) => e.type === "failed")).toBe(false);

    // The answer unblocks; after that the stall clock applies again.
    session.pushUserMessage("yes");
    await pending;
    gate.resolve();
  });

  test("init watchdog fails a session with no SDK messages and recycles it", async () => {
    const clock = { t: 0 };
    let interrupts = 0;
    const neverYields = manualQueryFn(
      // Simulates the observed first-turn hang: the subprocess produces
      // nothing, and even reading the input stalls.
      async function* () {
        await new Promise<void>(() => {});
        yield assistantMessage("unreachable");
      },
      {
        onInterrupt: () => {
          interrupts += 1;
        },
      },
    );
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn: neverYields,
      now: () => clock.t,
      watchdog: { initMs: 1_000, stallMs: 60_000, intervalMs: 5 },
    });

    session.start({ taskId: "task-1", prompt: "doomed to hang" });
    clock.t = 1_500; // past initMs with no first message
    await until(() => events.some((e) => e.type === "failed"));

    const failed = events.find((e) => e.type === "failed");
    expect(failed?.summary).toContain("no SDK message at all");
    await until(() => interrupts >= 1);
    // The interrupt-path "stopped" event is suppressed: failed is terminal.
    expect(events.some((e) => e.type === "stopped")).toBe(false);
  });

  test("stall watchdog fails a session that goes silent mid-task", async () => {
    const clock = { t: 0 };
    const gate = Promise.withResolvers<void>();
    const stallsAfterOne = manualQueryFn(
      async function* (params) {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistantMessage("working...");
        await gate.promise; // never resolves: mid-task stall
      },
      { onInterrupt: () => gate.resolve() },
    );
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn: stallsAfterOne,
      now: () => clock.t,
      watchdog: { initMs: 60_000, stallMs: 1_000, intervalMs: 5 },
    });

    session.start({ taskId: "task-1", prompt: "stalls midway" });
    await until(() => events.some((e) => e.type === "progress"));
    clock.t = 2_000; // past stallMs since the last message
    await until(() => events.some((e) => e.type === "failed"));

    expect(events.find((e) => e.type === "failed")?.summary).toContain(
      "no SDK messages for",
    );
    await until(() => !session.status().running);
    expect(events.some((e) => e.type === "stopped")).toBe(false);
  });

  test("stall watchdog does not fail a finished-but-steerable idle session", async () => {
    const clock = { t: 0 };
    const { queryFn } = createEchoQueryFn();
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn,
      now: () => clock.t,
      watchdog: { initMs: 60_000, stallMs: 1_000, intervalMs: 5 },
    });

    session.start({ taskId: "task-1", prompt: "quick job" });
    await until(() => events.some((e) => e.type === "completed"));

    // A finished-but-steerable session idles far past stallMs; the
    // completed task must not be regressed to failed.
    clock.t = 5_000;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(events.some((e) => e.type === "failed")).toBe(false);
    expect(session.status().running).toBe(true);
  });

  test("a steer after a long finished idle gets a fresh stall budget", async () => {
    const clock = { t: 0 };
    const gate = Promise.withResolvers<void>();
    let turns = 0;
    const gatedSecondTurn = manualQueryFn(async function* (params) {
      for await (const message of params.prompt) {
        turns += 1;
        // The steered turn starts "thinking" without emitting anything yet.
        if (turns === 2) await gate.promise;
        yield resultSuccess(`done: ${userMessageText(message)}`);
      }
    });
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn: gatedSecondTurn,
      now: () => clock.t,
      watchdog: { initMs: 60_000, stallMs: 1_000, intervalMs: 5 },
    });

    session.start({ taskId: "task-1", prompt: "first" });
    await until(() => events.some((e) => e.summary === "done: first"));

    // Steer long after the previous turn's last message: the stall clock must
    // restart at the steer, not measure from the stale timestamp.
    clock.t = 5_000;
    expect(session.pushUserMessage("follow-up")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((e) => e.type === "failed")).toBe(false);

    gate.resolve();
    await until(() => events.some((e) => e.summary === "done: follow-up"));
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  test("watchdog stays quiet on a healthy session", async () => {
    const { queryFn } = createEchoQueryFn();
    const { events, emitEvent } = createEventRecorder();
    const session = new SessionManager({
      emitEvent,
      queryFn,
      watchdog: { initMs: 1_000, stallMs: 1_000, intervalMs: 5 },
    });
    session.start({ taskId: "task-1", prompt: "healthy" });
    await until(() => events.some((e) => e.type === "completed"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  test("history is capped at the configured capacity", async () => {
    const { emitEvent } = createEventRecorder();
    const turns = Array.from({ length: 8 }, (_, i) =>
      assistantMessage(`message ${i}`),
    );
    const { queryFn } = createEchoQueryFn(() => [
      ...turns,
      resultSuccess("ok"),
    ]);
    const session = new SessionManager({
      emitEvent,
      queryFn,
      historyCapacity: 4,
    });

    session.start({ taskId: "task-1", prompt: "fill history" });
    await until(() => session.historySnapshot().length >= 4);
    await until(() =>
      session.historySnapshot().some((m) => m.type === "result"),
    );

    const snapshot = session.historySnapshot();
    expect(snapshot).toHaveLength(4);
    expect(snapshot[3]?.type).toBe("result");
  });
});
