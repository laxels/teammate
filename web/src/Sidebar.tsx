import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { TranscriptItem, TranscriptState } from "./transcript";

const COMPOSER_MAX_HEIGHT_PX = 140;
const AUTOSCROLL_SLACK_PX = 80;

type SidebarProps = {
  state: TranscriptState;
  onSendMessage: (text: string) => void;
  onInterrupt: () => void;
};

export function Sidebar({ state, onSendMessage, onInterrupt }: SidebarProps) {
  return (
    <aside className="sidebar">
      <Header state={state} />
      <Transcript
        items={state.items}
        thinking={state.thinking}
        running={state.running}
      />
      <div className="sidebar-bottom">
        {state.running ? (
          <div className="stop-float">
            <button type="button" className="stop-button" onClick={onInterrupt}>
              <span className="stop-icon" aria-hidden="true" />
              Stop Claude
            </button>
          </div>
        ) : null}
        {state.lastError !== null ? (
          <div className="error-banner" role="alert">
            {state.lastError}
          </div>
        ) : null}
        <Composer onSend={onSendMessage} />
      </div>
    </aside>
  );
}

function Header({ state }: { state: TranscriptState }) {
  const devbox =
    window.location.hostname.length > 0 ? window.location.hostname : "devbox";
  const label = state.taskId !== null ? `${devbox} · ${state.taskId}` : devbox;
  return (
    <header className="sidebar-header">
      <span className="wordmark">Claude</span>
      <span className="task-label" title={label}>
        {label}
      </span>
      <span
        className={`status-dot ${state.connected ? "is-connected" : "is-disconnected"}`}
        role="status"
        aria-label={state.connected ? "connected" : "disconnected"}
        title={state.connected ? "connected" : "disconnected"}
      />
    </header>
  );
}

function Transcript({
  items,
  thinking,
  running,
}: {
  items: readonly TranscriptItem[];
  thinking: boolean;
  running: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Snap to the bottom, but only while the user is already following along.
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el !== null && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  // Follow the bottom of the transcript unless the user scrolled away. The
  // body only calls the stable callback, but items/thinking are real triggers:
  // re-run whenever the content grows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on content growth
  useEffect(() => {
    stickToBottom();
  }, [items, thinking, stickToBottom]);

  return (
    <div
      ref={scrollRef}
      // While running, the floating Stop button overlays the bottom of the
      // transcript; `is-running` reserves room so the last item clears it.
      className={running ? "transcript is-running" : "transcript"}
      onScroll={() => {
        const el = scrollRef.current;
        if (el !== null) {
          pinnedRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <
            AUTOSCROLL_SLACK_PX;
        }
      }}
    >
      {items.map((item) => (
        <TranscriptEntry key={item.key} item={item} onToggle={stickToBottom} />
      ))}
      {thinking ? <ThinkingIndicator /> : null}
    </div>
  );
}

function TranscriptEntry({
  item,
  onToggle,
}: {
  item: TranscriptItem;
  onToggle: () => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="row-user">
          <div className="user-bubble">{item.text}</div>
        </div>
      );
    case "assistant_text":
      return <div className="assistant-text">{item.text}</div>;
    case "tool_use":
      return (
        <ToolChip name={item.name} input={item.input} onToggle={onToggle} />
      );
  }
}

function ToolChip({
  name,
  input,
  onToggle,
}: {
  name: string;
  input: unknown;
  onToggle: () => void;
}) {
  let pretty: string;
  try {
    pretty = JSON.stringify(input, null, 2) ?? "null";
  } catch {
    pretty = String(input);
  }
  return (
    // Expanding a chip grows the transcript; re-stick so the freshly revealed
    // content stays in view instead of opening below the fold.
    <details className="tool-chip" onToggle={onToggle}>
      <summary>
        <span className="tool-gear" aria-hidden="true">
          {"⚙"}
        </span>
        {name}
      </summary>
      <pre>{pretty}</pre>
    </details>
  );
}

function ThinkingIndicator() {
  return (
    <div className="thinking" role="status" aria-label="Claude is thinking">
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </div>
  );
}

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
    }
  }, []);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    onSend(trimmed);
    setText("");
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
    }
  }, [text, onSend]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit],
  );

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        ref={textareaRef}
        className="composer-input"
        placeholder="Steer Claude…"
        rows={1}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          resize();
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="send-button"
        disabled={text.trim().length === 0}
        aria-label="Send"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M7 12V2M7 2L2.5 6.5M7 2l4.5 4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
