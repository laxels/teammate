// Pure transform from the raw taskDetail events into the rendered task-details
// timeline rows (#70): prepend the prompt as the first row, drop the throttled
// `progress` echoes (the full `assistant_text` supersedes them), and shape tool
// calls/results into collapsible entries. Kept pure for unit testing.

export type RawEvent = {
  type: string;
  summary: string;
  ts: number;
  detail: string | null;
  tool: string | null;
  imageUrl: string | null;
};

export type TimelineRow =
  | { kind: "prompt"; ts: number; text: string }
  | { kind: "status"; ts: number; status: string; summary: string }
  | { kind: "assistant"; ts: number; summary: string; detail: string | null }
  | {
      kind: "tool_call";
      ts: number;
      tool: string;
      summary: string;
      detail: string | null;
    }
  | {
      kind: "tool_result";
      ts: number;
      tool: string | null;
      summary: string;
      detail: string | null;
      imageUrl: string | null;
    };

const STATUS_TYPES = new Set([
  "started",
  "needs_input",
  "completed",
  "failed",
  "stopped",
]);

/**
 * Build the rendered timeline. `events` is expected chronological (the query
 * returns them ascending). Unknown event types are ignored so an older
 * dashboard bundle degrades gracefully against a newer backend.
 */
export function buildTimeline(
  events: RawEvent[],
  prompt: string,
  promptTs: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [{ kind: "prompt", ts: promptTs, text: prompt }];
  for (const e of events) {
    switch (e.type) {
      // Throttled Slack echo of the assistant text; the full assistant_text
      // below carries the same narration losslessly. Hidden to avoid dupes.
      case "progress":
        continue;
      // The new fields are coerced with ?? null so an older backend's events
      // (which lack detail/tool/imageUrl) never render as literal "undefined".
      case "assistant_text":
        rows.push({
          kind: "assistant",
          ts: e.ts,
          summary: e.summary,
          detail: e.detail ?? null,
        });
        break;
      case "tool_call":
        rows.push({
          kind: "tool_call",
          ts: e.ts,
          tool: e.tool ?? "tool",
          summary: e.summary,
          detail: e.detail ?? null,
        });
        break;
      case "tool_result":
        rows.push({
          kind: "tool_result",
          ts: e.ts,
          tool: e.tool ?? null,
          summary: e.summary,
          detail: e.detail ?? null,
          imageUrl: e.imageUrl ?? null,
        });
        break;
      default:
        if (STATUS_TYPES.has(e.type)) {
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
