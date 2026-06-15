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
  test("prepends the prompt as the first row", () => {
    const rows = buildTimeline([], "do the thing", 1000);
    expect(rows).toEqual([{ kind: "prompt", ts: 1000, text: "do the thing" }]);
  });

  test("drops throttled progress echoes (superseded by assistant_text)", () => {
    const rows = buildTimeline(
      [
        ev({ type: "progress", ts: 2, summary: "working" }),
        ev({
          type: "assistant_text",
          ts: 2,
          summary: "working",
          detail: "working in full",
        }),
      ],
      "p",
      1,
    );
    expect(rows.map((r) => r.kind)).toEqual(["prompt", "assistant"]);
  });

  test("shapes tool calls/results with their tool name + image", () => {
    const rows = buildTimeline(
      [
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
      ],
      "p",
      1,
    );
    expect(rows[1]).toEqual({
      kind: "tool_call",
      ts: 3,
      tool: "left_click",
      summary: "left_click",
      detail: '{"coordinate":[1,2]}',
    });
    expect(rows[2]).toMatchObject({
      kind: "tool_result",
      tool: "left_click",
      imageUrl: "https://blob/shot.png",
    });
  });

  test("keeps status events and ignores unknown types", () => {
    const rows = buildTimeline(
      [
        ev({ type: "started", ts: 2, summary: "Started" }),
        ev({ type: "mystery_future_type", ts: 3, summary: "?" }),
        ev({ type: "completed", ts: 4, summary: "Done" }),
      ],
      "p",
      1,
    );
    expect(rows.map((r) => r.kind)).toEqual(["prompt", "status", "status"]);
    expect(
      rows
        .filter((r) => r.kind === "status")
        .map((r) => (r as { status: string }).status),
    ).toEqual(["started", "completed"]);
  });
});
