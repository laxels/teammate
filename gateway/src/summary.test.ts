import { describe, expect, test } from "bun:test";
import { DETAIL_MAX_CHARS } from "../../shared/protocol";
import {
  clip,
  excerpt,
  extractAssistantText,
  extractToolResults,
  extractToolUses,
  mapResultMessage,
  prettyToolName,
  stringifyToolInput,
} from "./summary";
import {
  assistantMessage,
  assistantWithToolUse,
  resultError,
  resultSuccess,
  toolResultMessage,
} from "./test-helpers";

describe("excerpt", () => {
  test("collapses whitespace and trims", () => {
    expect(excerpt("  a\n\nb\tc  ")).toBe("a b c");
  });

  test("caps output at the budget including the ellipsis", () => {
    const long = "x".repeat(500);
    const result = excerpt(long, 300);
    expect(result.length).toBe(300);
    expect(result.endsWith("…")).toBe(true);
  });

  test("leaves short text untouched", () => {
    expect(excerpt("done", 300)).toBe("done");
  });
});

describe("extractAssistantText", () => {
  test("joins text blocks", () => {
    expect(extractAssistantText(assistantMessage("hello"))).toBe("hello");
  });

  test("returns null when there are no text blocks", () => {
    const message = assistantMessage("ignored");
    message.message.content = [];
    expect(extractAssistantText(message)).toBeNull();
  });
});

describe("mapResultMessage", () => {
  test("success -> completed with the result text as summary", () => {
    const mapped = mapResultMessage(resultSuccess("All tests green."));
    expect(mapped).toEqual({ type: "completed", summary: "All tests green." });
  });

  test("success with is_error -> failed", () => {
    const mapped = mapResultMessage(resultSuccess("something broke", true));
    expect(mapped.type).toBe("failed");
  });

  test("error subtype -> failed with subtype and error details", () => {
    const mapped = mapResultMessage(
      resultError("error_max_turns", ["ran out of turns"]),
    );
    expect(mapped.type).toBe("failed");
    expect(mapped.summary).toContain("error_max_turns");
    expect(mapped.summary).toContain("ran out of turns");
  });

  test("error subtype without details still produces a readable summary", () => {
    const mapped = mapResultMessage(resultError("error_during_execution"));
    expect(mapped).toEqual({
      type: "failed",
      summary: "Task failed (error_during_execution)",
    });
  });

  test("the success summary is the full result, not a 300-char excerpt (#114)", () => {
    // A retrieval-style final answer is the deliverable: show it whole.
    const long = "y".repeat(1000);
    expect(mapResultMessage(resultSuccess(long)).summary).toBe(long);
  });

  test("the success summary preserves whitespace and clips only at DETAIL_MAX_CHARS (#114)", () => {
    const multiline = "line one\n\nline two\n  indented";
    expect(mapResultMessage(resultSuccess(multiline)).summary).toBe(multiline);

    const huge = "z".repeat(DETAIL_MAX_CHARS + 500);
    const summary = mapResultMessage(resultSuccess(huge)).summary;
    expect(summary.length).toBe(DETAIL_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("clip", () => {
  test("preserves whitespace, unlike excerpt", () => {
    expect(clip("a\n  b", 100)).toBe("a\n  b");
  });

  test("truncates with an ellipsis past the budget", () => {
    const result = clip("x".repeat(50), 10);
    expect(result.length).toBe(10);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("prettyToolName", () => {
  test("strips the in-process MCP namespace", () => {
    expect(prettyToolName("mcp__computer-use__left_click")).toBe("left_click");
  });

  test("leaves a bare name untouched", () => {
    expect(prettyToolName("Read")).toBe("Read");
  });
});

describe("stringifyToolInput", () => {
  test("serializes an object input", () => {
    expect(stringifyToolInput({ coordinate: [1, 2] })).toBe(
      '{"coordinate":[1,2]}',
    );
  });

  test("empty for null/undefined", () => {
    expect(stringifyToolInput(undefined)).toBe("");
    expect(stringifyToolInput(null)).toBe("");
  });
});

describe("extractToolUses", () => {
  test("returns each tool_use block with id, name, input", () => {
    const message = assistantWithToolUse({
      text: "clicking",
      toolName: "mcp__computer-use__left_click",
      toolUseId: "tu-1",
      input: { coordinate: [3, 4] },
    });
    expect(extractToolUses(message)).toEqual([
      {
        id: "tu-1",
        name: "mcp__computer-use__left_click",
        input: { coordinate: [3, 4] },
      },
    ]);
  });

  test("empty for a plain text message", () => {
    expect(extractToolUses(assistantMessage("just text"))).toEqual([]);
  });
});

describe("extractToolResults", () => {
  test("splits a tool_result into text and base64 images", () => {
    const data = Buffer.from("png").toString("base64");
    const message = toolResultMessage({
      toolUseId: "tu-1",
      text: "Clicked.",
      imageBase64: data,
    });
    expect(extractToolResults(message)).toEqual([
      {
        toolUseId: "tu-1",
        text: "Clicked.",
        images: [{ data, mimeType: "image/png" }],
        isError: false,
      },
    ]);
  });

  test("a plain steer message (string content) yields nothing", () => {
    expect(
      extractToolResults({
        type: "user",
        message: { role: "user", content: "just a steer" },
        parent_tool_use_id: null,
      }),
    ).toEqual([]);
  });
});
