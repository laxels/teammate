import { describe, expect, test } from "bun:test";
import {
  type PlayerState,
  playerState,
  type RecordingInfo,
  UPLOAD_GRACE_MS,
} from "./recording";

const NOW = 1_000_000_000;

function state(
  recording: RecordingInfo,
  opts: Partial<{ taskTerminal: boolean; finishedAt: number | null }> = {},
): PlayerState {
  return playerState(recording, {
    taskTerminal: opts.taskTerminal ?? true,
    finishedAt: opts.finishedAt ?? NOW,
    now: NOW,
  });
}

describe("playerState", () => {
  test("a task with no recording (pre-feature) is unavailable", () => {
    expect(state(null)).toBe("unavailable");
  });

  test("an available recording with a URL is playable", () => {
    expect(
      state({
        status: "available",
        url: "https://x/v",
        bytes: 1,
        uploadedAt: NOW,
      }),
    ).toBe("available");
  });

  test("an available recording whose blob is gone (no URL) is unavailable", () => {
    expect(
      state({ status: "available", url: null, bytes: 1, uploadedAt: NOW }),
    ).toBe("unavailable");
  });

  test("a failed recording is unavailable", () => {
    expect(
      state({ status: "failed", url: null, bytes: null, uploadedAt: null }),
    ).toBe("unavailable");
  });

  test("a running task mid-capture shows recording in progress", () => {
    expect(
      state(
        { status: "recording", url: null, bytes: null, uploadedAt: null },
        { taskTerminal: false },
      ),
    ).toBe("recording");
  });

  test("a terminal task still marked 'recording' is unavailable (VM died)", () => {
    expect(
      state(
        { status: "recording", url: null, bytes: null, uploadedAt: null },
        { taskTerminal: true },
      ),
    ).toBe("unavailable");
  });

  test("a fresh upload shows uploading/processing", () => {
    expect(
      state(
        { status: "uploading", url: null, bytes: null, uploadedAt: null },
        { finishedAt: NOW - 30_000 },
      ),
    ).toBe("uploading");
  });

  test("an upload stuck past the grace window is presumed lost", () => {
    expect(
      state(
        { status: "uploading", url: null, bytes: null, uploadedAt: null },
        { finishedAt: NOW - UPLOAD_GRACE_MS - 1 },
      ),
    ).toBe("unavailable");
  });
});
