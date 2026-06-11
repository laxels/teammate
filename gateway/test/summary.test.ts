import { describe, expect, test } from "bun:test";
import {
  excerpt,
  extractAssistantText,
  mapResultMessage,
} from "../src/summary";
import { assistantMessage, resultError, resultSuccess } from "./helpers";

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

  test("summaries respect the 300-char cap", () => {
    const mapped = mapResultMessage(resultSuccess("y".repeat(1000)));
    expect(mapped.summary.length).toBeLessThanOrEqual(300);
  });
});
