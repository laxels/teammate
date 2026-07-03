import { describe, expect, test } from "bun:test";
import { buildTimeline, type RawEvent } from "./timeline";

function ev(
  partial: Partial<RawEvent> & { type: string; ts: number },
): RawEvent {
  return {
    summary: "",
    detail: null,
    tool: null,
    imageUrl: null,
    ...partial,
  };
}

describe("buildTimeline", () => {
  test("is empty for no events (the prompt is rendered separately now)", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  test("drops throttled progress echoes (superseded by assistant_text)", () => {
    const rows = buildTimeline([
      ev({ type: "progress", ts: 2, summary: "working" }),
      ev({
        type: "assistant_text",
        ts: 2,
        summary: "working",
        detail: "working in full",
      }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["assistant"]);
  });

  test("assistant rows carry the full detail text, not the excerpt", () => {
    const rows = buildTimeline([
      ev({
        type: "assistant_text",
        ts: 2,
        summary: "short excerpt…",
        detail: "the complete narration",
      }),
    ]);
    expect(rows[0]).toEqual({
      kind: "assistant",
      ts: 2,
      text: "the complete narration",
      local: false,
    });
  });

  test("assistant falls back to summary when there is no detail", () => {
    const rows = buildTimeline([
      ev({ type: "assistant_text", ts: 2, summary: "only summary" }),
    ]);
    expect(rows[0]).toEqual({
      kind: "assistant",
      ts: 2,
      text: "only summary",
      local: false,
    });
  });

  test("folds a tool_call and its tool_result into one combined pill", () => {
    const rows = buildTimeline([
      ev({
        type: "tool_call",
        ts: 3,
        tool: "left_click",
        summary: "left_click",
        detail: '{"coordinate":[1,2]}',
      }),
      ev({
        type: "tool_result",
        ts: 4,
        tool: "left_click",
        summary: "Left-clicked.",
        detail: "Left-clicked (1, 2).",
        imageUrl: "https://blob/shot.png",
      }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        ts: 3,
        tool: "left_click",
        params: '{"coordinate":[1,2]}',
        result: "Left-clicked (1, 2).",
        imageUrl: "https://blob/shot.png",
        local: false,
      },
    ]);
  });

  test("pairs interleaved calls/results by tool name, oldest first", () => {
    const rows = buildTimeline([
      ev({ type: "tool_call", ts: 1, tool: "Bash", detail: "b1" }),
      ev({ type: "tool_call", ts: 2, tool: "Read", detail: "r1" }),
      ev({ type: "tool_result", ts: 3, tool: "Read", detail: "read done" }),
      ev({ type: "tool_result", ts: 4, tool: "Bash", detail: "bash done" }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        ts: 1,
        tool: "Bash",
        params: "b1",
        result: "bash done",
        imageUrl: null,
        local: false,
      },
      {
        kind: "tool",
        ts: 2,
        tool: "Read",
        params: "r1",
        result: "read done",
        imageUrl: null,
        local: false,
      },
    ]);
  });

  test("an orphan tool_result renders as a result-only pill", () => {
    const rows = buildTimeline([
      ev({
        type: "tool_result",
        ts: 4,
        tool: "left_click",
        detail: "clicked",
        imageUrl: "https://blob/shot.png",
      }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        ts: 4,
        tool: "left_click",
        params: null,
        result: "clicked",
        imageUrl: "https://blob/shot.png",
        local: false,
      },
    ]);
  });

  test("tolerates older-backend events missing the new fields", () => {
    // A pre-#70 backend emits only { type, summary, ts }.
    const old = [
      { type: "tool_call", summary: "left_click", ts: 3 },
      { type: "tool_result", summary: "clicked", ts: 4 },
      { type: "assistant_text", summary: "thinking", ts: 5 },
    ] as unknown as RawEvent[];
    const rows = buildTimeline(old);
    // call + result fold into one pill with the generic "tool" fallback name.
    expect(rows).toEqual([
      {
        kind: "tool",
        ts: 3,
        tool: "tool",
        params: null,
        result: null,
        imageUrl: null,
        local: false,
      },
      { kind: "assistant", ts: 5, text: "thinking", local: false },
    ]);
  });

  test("attributes rows to the local agent and never folds results across agents (#138)", () => {
    const rows = buildTimeline([
      ev({
        type: "tool_call",
        ts: 1,
        tool: "Bash",
        detail: "cloud call",
        source: "cloud",
      }),
      ev({
        type: "tool_call",
        ts: 2,
        tool: "Bash",
        detail: "local call",
        source: "local",
      }),
      // The local result must fold into the LOCAL call even though the cloud
      // call with the same tool name is older.
      ev({
        type: "tool_result",
        ts: 3,
        tool: "Bash",
        detail: "local done",
        source: "local",
      }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        ts: 1,
        tool: "Bash",
        params: "cloud call",
        result: null,
        imageUrl: null,
        local: false,
      },
      {
        kind: "tool",
        ts: 2,
        tool: "Bash",
        params: "local call",
        result: "local done",
        imageUrl: null,
        local: true,
      },
    ]);
  });

  test("renders peer-channel traffic as peer rows (#138)", () => {
    const rows = buildTimeline([
      ev({
        type: "peer_request",
        ts: 1,
        summary: "check my notes",
        detail: "Open Notes and find X",
      }),
      ev({ type: "peer_reply", ts: 2, summary: "found it", detail: "X = 42" }),
    ]);
    expect(rows).toEqual([
      {
        kind: "peer",
        ts: 1,
        direction: "request",
        text: "Open Notes and find X",
      },
      { kind: "peer", ts: 2, direction: "reply", text: "X = 42" },
    ]);
  });

  test("keeps only needs_input/failed/stopped statuses; hides started/completed", () => {
    const rows = buildTimeline([
      ev({ type: "started", ts: 2, summary: "Started" }),
      ev({ type: "needs_input", ts: 3, summary: "Need a hand" }),
      ev({ type: "mystery_future_type", ts: 4, summary: "?" }),
      ev({ type: "completed", ts: 5, summary: "Done" }),
      ev({ type: "failed", ts: 6, summary: "Boom" }),
    ]);
    expect(rows.map((r) => (r.kind === "status" ? r.status : r.kind))).toEqual([
      "needs_input",
      "failed",
    ]);
  });
});
