import { describe, expect, test } from "bun:test";
import {
  commentEventTime,
  desiredCenterForTime,
  type EventAnchor,
  layoutComments,
  previewAlign,
  type RailItem,
} from "./commentLayout";

describe("previewAlign", () => {
  test("shifts away from the edges, centers in the middle", () => {
    expect(previewAlign(5)).toBe("left");
    expect(previewAlign(50)).toBe("center");
    expect(previewAlign(95)).toBe("right");
    // Exactly on the band boundary counts as an edge.
    expect(previewAlign(15)).toBe("left");
    expect(previewAlign(85)).toBe("right");
  });
});

describe("commentEventTime", () => {
  test("maps video seconds onto the absolute timeline", () => {
    expect(commentEventTime(1_000_000, 12.5)).toBe(1_012_500);
  });
  test("null when the recording has no stored start", () => {
    expect(commentEventTime(null, 5)).toBeNull();
  });
});

describe("desiredCenterForTime", () => {
  const anchors: EventAnchor[] = [
    { ts: 100, top: 0, bottom: 40 },
    { ts: 200, top: 80, bottom: 120 },
    { ts: 300, top: 160, bottom: 200 },
  ];

  test("centers in the gap between the bracketing events", () => {
    // 250 is between event@200 (bottom 120) and event@300 (top 160) -> 140.
    expect(desiredCenterForTime(250, anchors)).toBe(140);
  });

  test("before the first event sits just above it", () => {
    expect(desiredCenterForTime(50, anchors, 24)).toBe(0 - 24);
  });

  test("after the last event sits just below it", () => {
    expect(desiredCenterForTime(999, anchors, 24)).toBe(200 + 24);
  });

  test("no anchors -> top of the rail", () => {
    expect(desiredCenterForTime(123, [])).toBe(0);
  });
});

describe("layoutComments", () => {
  test("non-crowded comments sit exactly at their desired center", () => {
    const items: RailItem[] = [
      { id: "a", desiredCenter: 100, height: 40 },
      { id: "b", desiredCenter: 400, height: 40 },
    ];
    const tops = layoutComments(items, null, 12);
    expect(tops.get("a")).toBe(80); // 100 - 40/2
    expect(tops.get("b")).toBe(380);
  });

  test("crowding stacks downward, first comment wins its alignment", () => {
    const items: RailItem[] = [
      { id: "a", desiredCenter: 100, height: 40 },
      { id: "b", desiredCenter: 100, height: 40 },
    ];
    const tops = layoutComments(items, null, 12);
    expect(tops.get("a")).toBe(80); // aligned
    expect(tops.get("b")).toBe(132); // pushed down: 80 + 40 + 12
  });

  test("focusing a pushed-down comment gives it alignment priority, shifting earlier ones up", () => {
    const items: RailItem[] = [
      { id: "a", desiredCenter: 100, height: 40 },
      { id: "b", desiredCenter: 100, height: 40 },
    ];
    const tops = layoutComments(items, "b", 12);
    // b reclaims its exact center; a is shoved up out of alignment.
    expect(tops.get("b")).toBe(80);
    expect(tops.get("a")).toBe(28); // min(80, 80 - 12 - 40)
  });

  test("focus reverts to first-wins when unfocused", () => {
    const items: RailItem[] = [
      { id: "a", desiredCenter: 100, height: 40 },
      { id: "b", desiredCenter: 100, height: 40 },
    ];
    expect(layoutComments(items, null, 12)).toEqual(
      layoutComments(items, "missing", 12),
    );
  });

  test("a taller (focused/expanded) block still avoids overlap below", () => {
    const items: RailItem[] = [
      { id: "a", desiredCenter: 100, height: 120 }, // expanded
      { id: "b", desiredCenter: 140, height: 40 },
    ];
    const tops = layoutComments(items, null, 12);
    const aBottom = (tops.get("a") as number) + 120;
    expect(tops.get("b") as number).toBeGreaterThanOrEqual(aBottom + 12);
  });
});
