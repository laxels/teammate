import { describe, expect, test } from "bun:test";
import { extractTranscriptLines } from "./transcriptView";

describe("extractTranscriptLines", () => {
  test("renders user text, assistant text, and tool calls; skips noise", () => {
    const json = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "user", message: { role: "user", content: "fix the bug" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Looking at the failing test." },
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    expect(extractTranscriptLines(json)).toEqual([
      { role: "user", text: "fix the bug" },
      { role: "assistant", text: "Looking at the failing test." },
      { role: "tool", text: "→ Bash" },
    ]);
  });

  test("degrades gracefully on malformed input", () => {
    expect(extractTranscriptLines("{nope")[0]?.role).toBe("meta");
    expect(extractTranscriptLines('{"a":1}')[0]?.role).toBe("meta");
  });
});
