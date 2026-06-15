// Pure geometry for the Notion-style comment rail (#70). The component measures
// the rendered event rows and the comment-block heights and feeds them here; the
// math (timestamp alignment, crowding/stacking, focus-priority reflow) lives
// here so it can be unit-tested without a DOM.

/** A measured timeline row the rail aligns against: its wall-clock event time
 * and its vertical extent (px from the top of the shared timeline container). */
export type EventAnchor = { ts: number; top: number; bottom: number };

/** Maps a comment's video-relative seconds onto the absolute event timeline.
 * Null when the recording has no stored start (pre-#70 recordings) — the rail
 * then falls back to a plain stacked order. */
export function commentEventTime(
  startedAt: number | null,
  videoTimeSec: number,
): number | null {
  return startedAt === null ? null : startedAt + videoTimeSec * 1000;
}

/**
 * The vertical center a comment "wants", aligned to the gap between the event
 * before and the event after its timestamp (issue: "The center of the comment
 * block is aligned with the space between events before and after its
 * timestamp"). Anchors must be sorted by ts ascending.
 *
 * - Between two events -> the midpoint of the gap between them.
 * - Before the first / after the last -> just outside that event by `pad`.
 * - No anchors at all -> 0 (top of the rail).
 */
export function desiredCenterForTime(
  timeMs: number,
  anchors: EventAnchor[],
  pad = 24,
): number {
  if (anchors.length === 0) return 0;
  let before: EventAnchor | null = null;
  let after: EventAnchor | null = null;
  for (const a of anchors) {
    if (a.ts <= timeMs) before = a;
    else {
      after = a;
      break;
    }
  }
  if (before !== null && after !== null) return (before.bottom + after.top) / 2;
  if (before !== null) return before.bottom + pad;
  // after is non-null here (anchors non-empty and nothing was <= timeMs).
  return (after as EventAnchor).top - pad;
}

/** Where a seek-bar marker's hover preview anchors so it never overflows the
 * player: right-align near the right edge (it extends left), left-align near the
 * left edge, otherwise center it on the marker. `edge` is the % band at each
 * side that triggers a shift. */
export type PreviewAlign = "left" | "center" | "right";
export function previewAlign(leftPct: number, edge = 15): PreviewAlign {
  if (leftPct <= edge) return "left";
  if (leftPct >= 100 - edge) return "right";
  return "center";
}

export type RailItem = {
  id: string;
  /** Where this comment's center would ideally sit (from desiredCenterForTime). */
  desiredCenter: number;
  /** Measured rendered height (taller when focused/expanded). */
  height: number;
};

/**
 * Resolves desired centers into non-overlapping `top` offsets.
 *
 * Default (no focus) — "first wins": walk top-to-bottom placing each block as
 * close to its desired center as possible without overlapping the one above,
 * so a later comment crowding the same timestamp is pushed DOWN.
 *
 * Focused — the focused comment gets alignment priority: it's pinned to its
 * exact desired center, blocks below cascade down from it, and blocks above are
 * shifted UP (out of their own alignment) to make room, reverting to first-wins
 * once unfocused.
 *
 * Items may arrive in any order; they're sorted by desiredCenter. Returns a map
 * of id -> top (px).
 */
export function layoutComments(
  items: RailItem[],
  focusedId: string | null,
  gap = 12,
): Map<string, number> {
  const sorted = [...items].sort(
    (a, b) => a.desiredCenter - b.desiredCenter || a.id.localeCompare(b.id),
  );
  const tops = new Map<string, number>();
  const focusIndex = sorted.findIndex((i) => i.id === focusedId);

  if (focusIndex === -1) {
    // First-wins greedy stack.
    let prevBottom = Number.NEGATIVE_INFINITY;
    for (const item of sorted) {
      const top = Math.max(
        item.desiredCenter - item.height / 2,
        prevBottom + gap,
      );
      tops.set(item.id, top);
      prevBottom = top + item.height;
    }
    return tops;
  }

  // Pin the focused block to its exact desired center.
  const focused = sorted[focusIndex] as RailItem;
  const focusedTop = focused.desiredCenter - focused.height / 2;
  tops.set(focused.id, focusedTop);

  // Below the focused block: cascade down.
  let prevBottom = focusedTop + focused.height;
  for (let i = focusIndex + 1; i < sorted.length; i++) {
    const item = sorted[i] as RailItem;
    const top = Math.max(
      item.desiredCenter - item.height / 2,
      prevBottom + gap,
    );
    tops.set(item.id, top);
    prevBottom = top + item.height;
  }

  // Above the focused block: cascade UP, shifting earlier comments off their
  // alignment so the focused one can hold its place.
  let nextTop = focusedTop;
  for (let i = focusIndex - 1; i >= 0; i--) {
    const item = sorted[i] as RailItem;
    const top = Math.min(
      item.desiredCenter - item.height / 2,
      nextTop - gap - item.height,
    );
    tops.set(item.id, top);
    nextTop = top;
  }

  return tops;
}
