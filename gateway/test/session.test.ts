import { describe, expect, test } from "bun:test";
import type {
  McpServerConfig,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type QueryFn, SessionManager } from "../src/session";
import {
  askUserQuestionMessage,
  assistantMessage,
  createEchoQueryFn,
  createEventRecorder,
  resultError,
  resultSuccess,
  until,
} from "./helpers";

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
    expect(options?.model).toBe("claude-fable-5");
    expect(options?.effort).toBe("xhigh");
    expect(options?.permissionMode).toBe("bypassPermissions");
    expect(options?.allowDangerouslySkipPermissions).toBe(true);
    expect(options?.cwd).toBe("/tmp/project");
    expect(options?.fallbackModel).toBeUndefined();
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
    const gate = Promise.withResolvers<void>();
    let interrupted = false;
    const queryFn: QueryFn = (params) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistantMessage("working...");
        await gate.promise; // a long-running turn
        if (!interrupted) yield resultSuccess("finished");
      }
      return Object.assign(generate(), {
        interrupt: async () => {
          interrupted = true;
          gate.resolve();
        },
        setPermissionMode: async () => {},
      });
    };
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "long job" });
    await until(() => events.some((e) => e.type === "progress"));

    expect(await session.stop()).toBe(true);
    await until(() => !session.status().running);

    expect(events.map((e) => e.type)).toEqual([
      "started",
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

  test("progress events are throttled to one per window", async () => {
    const clock = { t: 0 };
    const queryFn: QueryFn = (params) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistantMessage("first");
        yield assistantMessage("second"); // same instant: suppressed
        clock.t = 30_000;
        yield assistantMessage("third"); // window elapsed: emitted
        yield resultSuccess("done");
      }
      return Object.assign(generate(), {
        interrupt: async () => {},
        setPermissionMode: async () => {},
      });
    };
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

  test("a crash in the SDK stream emits failed and frees the session", async () => {
    const queryFn: QueryFn = (params) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistantMessage("about to crash");
        throw new Error("subprocess exploded");
      }
      return Object.assign(generate(), {
        interrupt: async () => {},
        setPermissionMode: async () => {},
      });
    };
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "kaboom" });
    await until(() => !session.status().running);

    const failed = events.find((e) => e.type === "failed");
    expect(failed?.summary).toContain("subprocess exploded");
    expect(session.start({ taskId: "task-2", prompt: "retry" })).toBe(true);
  });

  test("setPermissionMode forwards to the live query", async () => {
    const { queryFn, control } = createEchoQueryFn();
    const { session } = makeSession(queryFn);

    expect(await session.setPermissionMode("plan")).toBe(false);

    session.start({ taskId: "task-1", prompt: "task" });
    expect(await session.setPermissionMode("plan")).toBe(true);
    expect(control.permissionModes).toEqual(["plan"]);
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

  test("init watchdog fails a session with no SDK messages and recycles it", async () => {
    const clock = { t: 0 };
    let interrupts = 0;
    const neverYields: QueryFn = (params) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        // Simulates the observed first-turn hang: the subprocess produces
        // nothing, and even reading the input stalls.
        await new Promise<void>(() => {});
        void params;
        yield assistantMessage("unreachable");
      }
      return Object.assign(generate(), {
        interrupt: async () => {
          interrupts += 1;
        },
        setPermissionMode: async () => {},
      });
    };
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
    const stallsAfterOne: QueryFn = (params) => {
      async function* generate(): AsyncGenerator<SDKMessage, void> {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield assistantMessage("working...");
        await gate.promise; // never resolves: mid-task stall
      }
      return Object.assign(generate(), {
        interrupt: async () => {
          gate.resolve();
        },
        setPermissionMode: async () => {},
      });
    };
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
