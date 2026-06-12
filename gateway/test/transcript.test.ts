import { describe, expect, test } from "bun:test";
import { MAX_TRANSCRIPT_BYTES } from "../../shared/protocol";
import { fitTranscript } from "../src/events";

const utf8 = new TextEncoder();

function bytesOf(upload: unknown): number {
  return utf8.encode(JSON.stringify(upload)).byteLength;
}

describe("fitTranscript", () => {
  test("small transcripts pass through untouched", () => {
    const upload = {
      devboxId: "devbox-test",
      taskId: "task-1",
      messages: [{ type: "assistant", text: "hello" }],
    };
    expect(fitTranscript(upload)).toEqual(upload);
  });

  test("drops oldest messages until the UTF-8 BYTE size fits (multibyte regression)", () => {
    // 3 bytes per char in UTF-8, 1 UTF-16 unit per char: a .length check
    // would accept ~3x the real wire size.
    const cjk = "断".repeat(5_000);
    const upload = {
      devboxId: "devbox-test",
      taskId: "task-1",
      messages: Array.from({ length: 120 }, (_, i) => ({ i, text: cjk })),
    };
    expect(bytesOf(upload)).toBeGreaterThan(MAX_TRANSCRIPT_BYTES);
    const fitted = fitTranscript(upload);
    expect(bytesOf(fitted)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(fitted.messages.length).toBeGreaterThan(0);
    // Newest messages survive (drop is from the front).
    const last = fitted.messages.at(-1) as { i: number };
    expect(last.i).toBe(119);
  });

  test("a single oversized message degrades to an explanatory marker, never an empty transcript", () => {
    const upload = {
      devboxId: "devbox-test",
      taskId: "task-1",
      messages: [{ text: "断".repeat(400_000) }],
    };
    const fitted = fitTranscript(upload);
    expect(fitted.messages.length).toBe(1);
    expect(JSON.stringify(fitted.messages[0])).toContain(
      "transcript too large",
    );
    expect(bytesOf(fitted)).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
  });
});
