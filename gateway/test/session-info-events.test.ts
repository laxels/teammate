import { describe, expect, test } from "bun:test";
import type { ScreenshotUploader } from "../src/events";
import { type QueryFn, SessionManager } from "../src/session";
import {
  askUserQuestionMessage,
  assistantMessage,
  assistantWithToolUse,
  createEchoQueryFn,
  createEventRecorder,
  resultSuccess,
  toolResultMessage,
  until,
} from "./helpers";

const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

function makeSession(
  queryFn: QueryFn,
  uploadScreenshot?: ScreenshotUploader,
): {
  session: SessionManager;
  events: ReturnType<typeof createEventRecorder>["events"];
} {
  const { events, emitEvent } = createEventRecorder();
  const session = new SessionManager({
    emitEvent,
    queryFn,
    ...(uploadScreenshot ? { uploadScreenshot } : {}),
  });
  return { session, events };
}

describe("info-event streaming (#70)", () => {
  test("an assistant turn emits full assistant_text plus a tool_call per tool", async () => {
    const { queryFn } = createEchoQueryFn(() => [
      assistantWithToolUse({
        text: "I'll click the button now.",
        toolName: "mcp__computer-use__left_click",
        toolUseId: "tu-1",
        input: { coordinate: [12, 34] },
      }),
      resultSuccess("done"),
    ]);
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "go" });
    await until(() => events.some((e) => e.type === "completed"));

    const text = events.find((e) => e.type === "assistant_text");
    expect(text).toMatchObject({
      summary: "I'll click the button now.",
      detail: "I'll click the button now.",
    });

    const call = events.find((e) => e.type === "tool_call");
    // The MCP namespace is stripped; the full input rides as detail.
    expect(call?.tool).toBe("left_click");
    expect(call?.detail).toContain("coordinate");
    expect(call?.detail).toContain("12");
  });

  test("a tool_result uploads its screenshot and references it by storageId", async () => {
    const uploads: { contentType: string; bytes: number }[] = [];
    const uploadScreenshot: ScreenshotUploader = async (bytes, contentType) => {
      uploads.push({ contentType, bytes: bytes.byteLength });
      return "storage-shot-1";
    };
    const { queryFn } = createEchoQueryFn(() => [
      assistantWithToolUse({
        text: "clicking",
        toolName: "mcp__computer-use__left_click",
        toolUseId: "tu-1",
        input: { coordinate: [1, 2] },
      }),
      toolResultMessage({
        toolUseId: "tu-1",
        text: "Left-clicked (1, 2).",
        imageBase64: PNG_B64,
      }),
      resultSuccess("done"),
    ]);
    const { session, events } = makeSession(queryFn, uploadScreenshot);

    session.start({ taskId: "task-1", prompt: "go" });
    // tool_result emits after the (async) upload resolves, so wait for it.
    await until(() => events.some((e) => e.type === "tool_result"));

    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({
      tool: "left_click", // correlated from the matching tool_use id
      detail: "Left-clicked (1, 2).",
      imageStorageId: "storage-shot-1",
    });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.contentType).toBe("image/png");
    expect(uploads[0]?.bytes).toBeGreaterThan(0);
  });

  test("a tool_result with no uploader still records text, without an image", async () => {
    const { queryFn } = createEchoQueryFn(() => [
      assistantWithToolUse({
        toolName: "mcp__computer-use__type",
        toolUseId: "tu-1",
        input: { text: "hello" },
      }),
      toolResultMessage({ toolUseId: "tu-1", text: "Typed 5 characters." }),
      resultSuccess("done"),
    ]);
    const { session, events } = makeSession(queryFn); // no uploadScreenshot

    session.start({ taskId: "task-1", prompt: "go" });
    await until(() => events.some((e) => e.type === "tool_result"));

    const result = events.find((e) => e.type === "tool_result");
    expect(result?.detail).toBe("Typed 5 characters.");
    expect(result?.imageStorageId).toBeUndefined();
  });

  test("AskUserQuestion surfaces as needs_input, not a tool_call", async () => {
    const { queryFn } = createEchoQueryFn(() => [
      askUserQuestionMessage("Staging or prod?"),
      // The session blocks on the answer; no result this turn.
    ]);
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "go" });
    await until(() => events.some((e) => e.type === "needs_input"));

    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  test("subagent narration and tool results are skipped", async () => {
    // Subagent messages carry a non-null parent_tool_use_id; only the main
    // thread (whose desktop the recording shows) drives the timeline.
    const { queryFn } = createEchoQueryFn(() => [
      assistantMessage("subagent narration", "toolu_parent"),
      toolResultMessage({
        toolUseId: "sub-1",
        text: "subagent result",
        parentToolUseId: "toolu_parent",
      }),
      resultSuccess("done"),
    ]);
    const { session, events } = makeSession(queryFn);

    session.start({ taskId: "task-1", prompt: "go" });
    await until(() => events.some((e) => e.type === "completed"));

    // Nothing from the subagent reached the timeline.
    expect(events.some((e) => e.type === "assistant_text")).toBe(false);
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
  });
});
