// Pure transform from the raw taskDetail events into the rendered task-details
// timeline rows. Kept pure for unit testing.
//
// #113 reshaped the timeline:
//   - The prompt is rendered above the timeline (not as a row here anymore).
//   - `started`/`completed` status events are dropped; only the noteworthy
//     `needs_input`/`failed`/`stopped` statuses survive, as centered pills.
//   - A `tool_call` and its `tool_result` collapse into ONE combined tool row
//     (params + result in one pill), matching the steering sidebar.
//   - Assistant text is a single full-text row (no summary/detail split).

export type RawEvent = {
  type: string;
  summary: string;
  ts: number;
  detail: string | null;
  tool: string | null;
  imageUrl: string | null;
};

export type ToolRow = {
  kind: "tool";
  ts: number;
  tool: string;
  /** Pretty-printed call parameters (null on older events without `detail`). */
  params: string | null;
  /** Result text, filled when the matching tool_result is folded in. */
  result: string | null;
  /** Result screenshot, filled from the matching tool_result. */
  imageUrl: string | null;
};

export type TimelineRow =
  | { kind: "status"; ts: number; status: string; summary: string }
  | { kind: "assistant"; ts: number; text: string }
  | ToolRow;

// Only these statuses render (as distinct, color-coded pills). `started` and
// `completed` are intentionally hidden (#113); unknown types are ignored so an
// older dashboard bundle degrades gracefully against a newer backend.
const SHOWN_STATUS_TYPES = new Set(["needs_input", "failed", "stopped"]);

/** Take the oldest unpaired tool row that matches `toolName` (or just the
 * oldest, when the result names no tool), removing it from the queue. */
function takeMatch(
  unpaired: ToolRow[],
  toolName: string | null,
): ToolRow | null {
  if (unpaired.length === 0) return null;
  const idx =
    toolName === null ? -1 : unpaired.findIndex((r) => r.tool === toolName);
  const [row] = unpaired.splice(idx === -1 ? 0 : idx, 1);
  return row ?? null;
}

/**
 * Build the rendered timeline. `events` is expected chronological (the query
 * returns them ascending). A `tool_result` folds into the matching earlier
 * `tool_call`; an orphan result (no matching call in the window) renders as a
 * result-only tool row so nothing is lost.
 */
export function buildTimeline(events: RawEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  // Tool rows still awaiting their result, oldest first.
  const unpaired: ToolRow[] = [];
  for (const e of events) {
    switch (e.type) {
      // Throttled Slack echo of the assistant text; the full assistant_text
      // below carries the same narration losslessly. Hidden to avoid dupes.
      case "progress":
        continue;
      // The new fields are coerced with ?? null so an older backend's events
      // (which lack detail/tool/imageUrl) never render as literal "undefined".
      case "assistant_text":
        rows.push({ kind: "assistant", ts: e.ts, text: e.detail ?? e.summary });
        break;
      case "tool_call": {
        const row: ToolRow = {
          kind: "tool",
          ts: e.ts,
          tool: e.tool ?? "tool",
          params: e.detail ?? null,
          result: null,
          imageUrl: null,
        };
        rows.push(row);
        unpaired.push(row);
        break;
      }
      case "tool_result": {
        const match = takeMatch(unpaired, e.tool);
        if (match !== null) {
          match.result = e.detail ?? null;
          match.imageUrl = e.imageUrl ?? null;
        } else {
          // Orphan result (its call predates the event window, or was a hidden
          // call like AskUserQuestion): show it as a result-only pill.
          rows.push({
            kind: "tool",
            ts: e.ts,
            tool: e.tool ?? "tool",
            params: null,
            result: e.detail ?? null,
            imageUrl: e.imageUrl ?? null,
          });
        }
        break;
      }
      default:
        if (SHOWN_STATUS_TYPES.has(e.type)) {
          rows.push({
            kind: "status",
            ts: e.ts,
            status: e.type,
            summary: e.summary,
          });
        }
    }
  }
  return rows;
}
