// Presentational transcript primitives shared by BOTH the task monitoring /
// steering sidebar (web/) and the task-details timeline (dashboard/). Issue #113
// asks these two surfaces to render assistant text and tool calls identically,
// so they live here and are imported by each Vite app (which supplies its own
// React + the shared CSS variables in its :root). Pure + props-only: no app
// state, no data fetching.

import "./transcriptUi.css";

/** Assistant narration: just the text, always shown in full, never collapsible
 * (issue #113 — drop the "Assistant" header and the show-more toggle). */
export function AssistantText({ text }: { text: string }) {
  return <div className="tx-assistant">{text}</div>;
}

export type ToolPillProps = {
  /** Pretty tool name shown in the always-visible summary. */
  name: string;
  /** Pretty-printed call parameters, shown first when expanded. */
  params: string;
  /** Tool result text, shown below the params when expanded (combined pill). */
  result?: string | null;
  /** A screenshot attached to the result (computer-use), shown below the text. */
  imageUrl?: string | null;
  /** Notified when the pill expands/collapses — lets a host re-measure layout
   * (timeline anchor reflow) or re-stick autoscroll (sidebar). */
  onToggle?: () => void;
};

/**
 * One combined tool pill: a gear + name summary that expands to show the call
 * parameters and, below them, the tool result (text and/or screenshot). Native
 * <details> so the host needs no expand state; `onToggle` fires on every toggle.
 */
export function ToolPill({
  name,
  params,
  result,
  imageUrl,
  onToggle,
}: ToolPillProps) {
  const hasText = result !== undefined && result !== null && result !== "";
  const hasImage = imageUrl !== undefined && imageUrl !== null;
  const hasResult = hasText || hasImage;
  return (
    <details className="tx-tool" onToggle={onToggle}>
      <summary className="tx-tool-summary">
        <span className="tx-tool-gear" aria-hidden="true">
          {"⚙"}
        </span>
        <span className="tx-tool-name">{name}</span>
      </summary>
      <div className="tx-tool-body">
        <pre className="tx-tool-params">{params}</pre>
        {hasResult && (
          <div className="tx-tool-result">
            {hasText && <pre className="tx-tool-result-text">{result}</pre>}
            {hasImage && (
              <img
                className="tx-tool-shot"
                src={imageUrl}
                alt="tool result screenshot"
              />
            )}
          </div>
        )}
      </div>
    </details>
  );
}
