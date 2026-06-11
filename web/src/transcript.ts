// Pure reducer: SteerServerMessage stream -> sidebar UI state.
//
// Defensive by design: SDK messages arrive as `unknown` (forwarded verbatim
// from @anthropic-ai/claude-agent-sdk) and unknown shapes must never crash
// rendering — they are simply ignored.

import type { SteerServerMessage } from "../../shared/protocol";

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | {
      kind: "assistant_text";
      key: string;
      messageId: string | null;
      text: string;
    }
  | {
      kind: "tool_use";
      key: string;
      messageId: string | null;
      toolUseId: string | null;
      name: string;
      input: unknown;
    };

export type TranscriptState = {
  items: readonly TranscriptItem[];
  running: boolean;
  taskId: string | null;
  /** Show the animated thinking indicator. */
  thinking: boolean;
  /** /ws/steer connection status (drives the header dot). */
  connected: boolean;
  lastError: string | null;
  /**
   * Texts of locally-echoed user messages whose SDK echo has not arrived yet.
   * Used to dedupe the gateway's forwarded user message against our own
   * optimistic bubble.
   */
  pendingLocalTexts: readonly string[];
  /** Monotonic counter used to mint unique React keys. */
  seq: number;
};

export type TranscriptAction =
  | { kind: "server"; message: SteerServerMessage }
  | { kind: "local_user"; text: string }
  | { kind: "connection"; connected: boolean };

export const initialState: TranscriptState = {
  items: [],
  running: false,
  taskId: null,
  thinking: false,
  connected: false,
  lastError: null,
  pendingLocalTexts: [],
  seq: 0,
};

export function reduce(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.kind) {
    case "connection":
      return { ...state, connected: action.connected };
    case "local_user": {
      const text = action.text;
      return {
        ...state,
        items: [...state.items, { kind: "user", key: `u${state.seq}`, text }],
        pendingLocalTexts: [...state.pendingLocalTexts, text],
        thinking: true,
        seq: state.seq + 1,
      };
    }
    case "server":
      return applyServerMessage(state, action.message);
  }
}

function applyServerMessage(
  state: TranscriptState,
  message: SteerServerMessage,
): TranscriptState {
  // The wire type is a closed union, but the server may evolve; tolerate
  // anything we do not recognize.
  switch (message.type) {
    case "status": {
      const startedTurn = message.running && !state.running;
      return {
        ...state,
        running: message.running,
        taskId: message.taskId,
        thinking: message.running ? state.thinking || startedTurn : false,
      };
    }
    case "history": {
      // Authoritative replay: rebuild the transcript from scratch so that
      // receiving the same history twice (reconnects) is idempotent.
      let next: TranscriptState = {
        ...state,
        items: [],
        pendingLocalTexts: [],
        lastError: null,
        // The transcript is rebuilt from scratch, so key minting can restart;
        // this keeps replayed histories byte-identical (idempotent).
        seq: 0,
      };
      for (const sdkMessage of message.messages) {
        next = applySdkMessage(next, sdkMessage);
      }
      return next;
    }
    case "sdk_message":
      return applySdkMessage(state, message.message);
    case "error":
      return { ...state, lastError: message.message };
    default:
      return state;
  }
}

function applySdkMessage(
  state: TranscriptState,
  sdkMessage: unknown,
): TranscriptState {
  const msg = asRecord(sdkMessage);
  if (msg === null) {
    return state;
  }
  switch (msg.type) {
    case "assistant":
      return applyAssistantMessage(state, msg);
    case "user":
      return applyUserMessage(state, msg);
    case "result":
      // A result message ends the turn.
      return { ...state, thinking: false };
    default:
      // system/init, stream events, future message types: ignore.
      return state;
  }
}

function applyAssistantMessage(
  state: TranscriptState,
  msg: Record<string, unknown>,
): TranscriptState {
  const apiMessage = asRecord(msg.message);
  if (apiMessage === null) {
    return state;
  }
  const messageId = typeof apiMessage.id === "string" ? apiMessage.id : null;
  const content = apiMessage.content;
  if (!Array.isArray(content)) {
    return state;
  }

  let seq = state.seq;
  const fresh: TranscriptItem[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (block === null) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.length > 0) {
        fresh.push({
          kind: "assistant_text",
          key: messageId !== null ? `${messageId}:${fresh.length}` : `a${seq}`,
          messageId,
          text: block.text,
        });
        seq += 1;
      }
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : null;
      if (name !== null) {
        const toolUseId = typeof block.id === "string" ? block.id : null;
        fresh.push({
          kind: "tool_use",
          key:
            toolUseId ??
            (messageId !== null ? `${messageId}:${fresh.length}` : `t${seq}`),
          messageId,
          toolUseId,
          name,
          input: block.input,
        });
        seq += 1;
      }
    }
    // thinking/unknown blocks: ignored.
  }

  // Accumulation/idempotency: an assistant message with a known id replaces
  // any previously rendered items from the same message, in place.
  let items: TranscriptItem[];
  if (messageId !== null) {
    const firstIndex = state.items.findIndex(
      (item) => item.kind !== "user" && item.messageId === messageId,
    );
    if (firstIndex >= 0) {
      const kept = state.items.filter(
        (item) => item.kind === "user" || item.messageId !== messageId,
      );
      // Number of retained items that precede the replaced run.
      let insertAt = 0;
      for (let i = 0; i < firstIndex; i += 1) {
        const item = state.items[i];
        if (
          item !== undefined &&
          (item.kind === "user" || item.messageId !== messageId)
        ) {
          insertAt += 1;
        }
      }
      items = [...kept.slice(0, insertAt), ...fresh, ...kept.slice(insertAt)];
    } else {
      items = [...state.items, ...fresh];
    }
  } else {
    items = [...state.items, ...fresh];
  }

  return {
    ...state,
    items,
    thinking: fresh.length > 0 ? false : state.thinking,
    seq,
  };
}

function applyUserMessage(
  state: TranscriptState,
  msg: Record<string, unknown>,
): TranscriptState {
  const apiMessage = asRecord(msg.message);
  if (apiMessage === null) {
    return state;
  }
  const text = extractUserText(apiMessage.content);
  if (text === null || text.length === 0) {
    // tool_result-only user messages and other plumbing: not rendered.
    return state;
  }
  // Dedupe against our own optimistic echo.
  const pendingIndex = state.pendingLocalTexts.indexOf(text);
  if (pendingIndex >= 0) {
    return {
      ...state,
      pendingLocalTexts: state.pendingLocalTexts.filter(
        (_, i) => i !== pendingIndex,
      ),
    };
  }
  return {
    ...state,
    items: [...state.items, { kind: "user", key: `u${state.seq}`, text }],
    seq: state.seq + 1,
  };
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (
      block !== null &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
