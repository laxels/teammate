import { describe, expect, test } from "bun:test";
import type { SteerServerMessage } from "../../shared/protocol";
import {
  initialState,
  reduce,
  type TranscriptAction,
  type TranscriptState,
} from "./transcript";

function run(
  actions: readonly TranscriptAction[],
  from: TranscriptState = initialState,
): TranscriptState {
  return actions.reduce(reduce, from);
}

function server(message: SteerServerMessage): TranscriptAction {
  return { kind: "server", message };
}

function sdk(message: unknown): TranscriptAction {
  return server({ type: "sdk_message", message });
}

function assistantMessage(id: string | undefined, content: unknown[]): unknown {
  return { type: "assistant", message: { id, content } };
}

const userHello = {
  type: "user",
  message: { content: [{ type: "text", text: "hello" }] },
};

const assistantGreeting = assistantMessage("msg_1", [
  { type: "text", text: "Hi! Let me look around." },
  { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
]);

describe("history replay", () => {
  test("builds the transcript from SDK messages", () => {
    const state = run([
      server({ type: "history", messages: [userHello, assistantGreeting] }),
    ]);
    expect(state.items.map((i) => i.kind)).toEqual([
      "user",
      "assistant_text",
      "tool_use",
    ]);
    expect(state.items[0]).toMatchObject({ text: "hello" });
    expect(state.items[2]).toMatchObject({
      name: "Bash",
      input: { command: "ls" },
    });
  });

  test("is idempotent: replaying the same history does not duplicate", () => {
    const history = server({
      type: "history",
      messages: [userHello, assistantGreeting],
    });
    const once = run([history]);
    const twice = run([history], once);
    expect(twice.items).toEqual([...once.items]);
  });

  test("replaces live items accumulated before reconnect", () => {
    const state = run([
      sdk(userHello),
      sdk(assistantGreeting),
      server({ type: "history", messages: [userHello, assistantGreeting] }),
    ]);
    expect(state.items).toHaveLength(3);
  });
});

describe("assistant block accumulation", () => {
  test("a later message with the same id replaces earlier blocks in place", () => {
    const partial = assistantMessage("msg_1", [
      { type: "text", text: "Working on" },
    ]);
    const complete = assistantMessage("msg_1", [
      { type: "text", text: "Working on it." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "x" } },
    ]);
    const state = run([sdk(userHello), sdk(partial), sdk(complete)]);
    expect(state.items.map((i) => i.kind)).toEqual([
      "user",
      "assistant_text",
      "tool_use",
    ]);
    expect(state.items[1]).toMatchObject({ text: "Working on it." });
  });

  test("replacement preserves position relative to later messages", () => {
    const first = assistantMessage("msg_1", [{ type: "text", text: "one" }]);
    const second = assistantMessage("msg_2", [{ type: "text", text: "two" }]);
    const firstAgain = assistantMessage("msg_1", [
      { type: "text", text: "one (edited)" },
    ]);
    const state = run([sdk(first), sdk(second), sdk(firstAgain)]);
    expect(
      state.items.map((i) => (i.kind === "assistant_text" ? i.text : "?")),
    ).toEqual(["one (edited)", "two"]);
  });

  test("messages with different ids append separately", () => {
    const state = run([
      sdk(assistantMessage("msg_1", [{ type: "text", text: "one" }])),
      sdk(assistantMessage("msg_2", [{ type: "text", text: "two" }])),
    ]);
    expect(state.items).toHaveLength(2);
  });

  test("empty text blocks and unknown block types are skipped", () => {
    const state = run([
      sdk(
        assistantMessage("msg_1", [
          { type: "text", text: "" },
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "visible" },
          "not-an-object",
        ]),
      ),
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "visible" });
  });
});

describe("status transitions and thinking indicator", () => {
  test("status drives running and taskId", () => {
    const state = run([
      server({ type: "status", running: true, taskId: "task-1" }),
    ]);
    expect(state.running).toBe(true);
    expect(state.taskId).toBe("task-1");
  });

  test("thinking turns on when a turn starts and off on assistant output", () => {
    let state = run([server({ type: "status", running: true, taskId: "t" })]);
    expect(state.thinking).toBe(true);
    state = run(
      [sdk(assistantMessage("msg_1", [{ type: "text", text: "hi" }]))],
      state,
    );
    expect(state.thinking).toBe(false);
  });

  test("thinking turns on after a local user message and off on result", () => {
    let state = run([
      server({ type: "status", running: true, taskId: "t" }),
      sdk(assistantMessage("msg_1", [{ type: "text", text: "hi" }])),
      { kind: "local_user", text: "do more" },
    ]);
    expect(state.thinking).toBe(true);
    state = run([sdk({ type: "result", subtype: "success" })], state);
    expect(state.thinking).toBe(false);
  });

  test("thinking never shows while not running", () => {
    const state = run([
      server({ type: "status", running: true, taskId: "t" }),
      server({ type: "status", running: false, taskId: null }),
    ]);
    expect(state.thinking).toBe(false);
    expect(state.running).toBe(false);
  });
});

describe("local user echo", () => {
  test("local message renders immediately and dedupes the SDK echo", () => {
    const state = run([{ kind: "local_user", text: "hello" }, sdk(userHello)]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "hello" });
  });

  test("a different user message is not deduped", () => {
    const state = run([
      { kind: "local_user", text: "hello" },
      sdk({
        type: "user",
        message: { content: [{ type: "text", text: "other" }] },
      }),
    ]);
    expect(state.items).toHaveLength(2);
  });

  test("tool_result-only user messages are not rendered", () => {
    const state = run([
      sdk({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1" }],
        },
      }),
    ]);
    expect(state.items).toHaveLength(0);
  });

  test("string content user messages are rendered", () => {
    const state = run([sdk({ type: "user", message: { content: "plain" } })]);
    expect(state.items[0]).toMatchObject({ kind: "user", text: "plain" });
  });
});

describe("unknown-type tolerance", () => {
  test("unknown SDK message types are ignored without crashing", () => {
    const weird: unknown[] = [
      null,
      42,
      "string",
      [],
      {},
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { delta: {} } },
      { type: "assistant" }, // missing message
      { type: "assistant", message: { content: "not-an-array" } },
      { type: "user", message: null },
      { type: "user" },
    ];
    const state = run(weird.map(sdk));
    expect(state.items).toHaveLength(0);
  });

  test("unknown server message types are ignored", () => {
    const bogus = {
      type: "totally_new_thing",
      payload: 1,
    } as unknown as SteerServerMessage;
    const state = run([server(bogus)]);
    expect(state).toEqual(initialState);
  });

  test("error messages surface in lastError", () => {
    const state = run([server({ type: "error", message: "boom" })]);
    expect(state.lastError).toBe("boom");
    expect(state.items).toHaveLength(0);
  });

  test("history containing junk still yields the valid items", () => {
    const state = run([
      server({
        type: "history",
        messages: [null, { type: "nope" }, userHello, 7],
      }),
    ]);
    expect(state.items).toHaveLength(1);
  });
});
