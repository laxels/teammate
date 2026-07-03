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
      /** Wire `uuid` of the assistant frame this block came from (see
       * applyAssistantMessage). Used to dedupe re-delivered frames. */
      frameId: string | null;
      text: string;
    }
  | {
      kind: "tool_use";
      key: string;
      frameId: string | null;
      toolUseId: string | null;
      name: string;
      input: unknown;
      /** Result text, folded in from the matching tool_result user message so
       * the pill can show call + result together (#113). Null until it lands. */
      result: string | null;
      /** A screenshot attached to the result (computer-use), as a data URL. */
      imageUrl: string | null;
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
  // The CLI emits ONE assistant frame per content block: a turn that thinks,
  // says something, then calls a tool arrives as three separate `assistant`
  // messages. Every frame of one model response shares the same API
  // `message.id`, but each carries a unique wire `uuid`. Accumulation must key
  // on the per-frame `uuid` so the distinct blocks append; keying on
  // `message.id` made each tool_use frame overwrite the mid-turn text that
  // preceded it (issue #64). Fall back to `message.id`, then a minted key, for
  // frames that predate `uuid` (older histories, tests).
  const frameId =
    typeof msg.uuid === "string"
      ? msg.uuid
      : typeof apiMessage.id === "string"
        ? apiMessage.id
        : null;
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
          key: frameId !== null ? `${frameId}:${fresh.length}` : `a${seq}`,
          frameId,
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
            (frameId !== null ? `${frameId}:${fresh.length}` : `t${seq}`),
          frameId,
          toolUseId,
          name,
          input: block.input,
          result: null,
          imageUrl: null,
        });
        seq += 1;
      }
    }
    // thinking/unknown blocks: ignored.
  }

  // Idempotency: a re-delivered frame (same uuid) replaces its own prior items
  // in place; distinct frames accumulate. With unique per-frame uuids this only
  // fires on an exact duplicate send — never across the separate blocks of one
  // model response, which is what lets mid-turn text survive a later tool_use.
  let items: TranscriptItem[];
  if (frameId !== null) {
    const firstIndex = state.items.findIndex(
      (item) => item.kind !== "user" && item.frameId === frameId,
    );
    if (firstIndex >= 0) {
      const kept = state.items.filter(
        (item) => item.kind === "user" || item.frameId !== frameId,
      );
      // Everything before firstIndex is by construction retained, so
      // firstIndex is the insertion point within kept.
      items = [
        ...kept.slice(0, firstIndex),
        ...fresh,
        ...kept.slice(firstIndex),
      ];
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
  // A user message carries either tool results (fold them into their pills) or
  // a steer/prompt (rendered as a bubble) — never both in practice.
  const withResults = attachToolResults(state, apiMessage.content);
  const text = extractUserText(apiMessage.content);
  if (text === null || text.length === 0) {
    // tool_result-only user messages and other plumbing: not rendered as a row,
    // but their results have been folded into the matching tool pills above.
    return withResults;
  }
  state = withResults;
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

/** A tool result read off a user message, keyed back to its tool_use. */
type ParsedToolResult = {
  toolUseId: string;
  text: string;
  imageUrl: string | null;
};

/**
 * Fold every tool_result block in a user message into the matching tool_use
 * item (by tool_use_id), attaching its text + first screenshot. Unmatched
 * results (no such pill in view) are simply dropped — the same graceful no-op
 * the prior reducer had for tool_result-only messages.
 */
function attachToolResults(
  state: TranscriptState,
  content: unknown,
): TranscriptState {
  if (!Array.isArray(content)) {
    return state;
  }
  const byId = new Map<string, ParsedToolResult>();
  for (const rawBlock of content) {
    const parsed = readToolResult(asRecord(rawBlock));
    if (parsed !== null) byId.set(parsed.toolUseId, parsed);
  }
  if (byId.size === 0) {
    return state;
  }
  let changed = false;
  const items = state.items.map((item) => {
    if (item.kind !== "tool_use" || item.toolUseId === null) return item;
    const parsed = byId.get(item.toolUseId);
    if (parsed === undefined) return item;
    changed = true;
    return {
      ...item,
      result: parsed.text !== "" ? parsed.text : item.result,
      imageUrl: parsed.imageUrl ?? item.imageUrl,
    };
  });
  return changed ? { ...state, items } : state;
}

/** Parse a single block as a tool_result; null if it isn't one. */
function readToolResult(
  block: Record<string, unknown> | null,
): ParsedToolResult | null {
  if (block === null || block.type !== "tool_result") return null;
  if (typeof block.tool_use_id !== "string") return null;
  const content = block.content;
  if (typeof content === "string") {
    return { toolUseId: block.tool_use_id, text: content, imageUrl: null };
  }
  if (!Array.isArray(content)) {
    return { toolUseId: block.tool_use_id, text: "", imageUrl: null };
  }
  const parts: string[] = [];
  let imageUrl: string | null = null;
  for (const rawBlock of content) {
    const cb = asRecord(rawBlock);
    if (cb === null) continue;
    if (cb.type === "text" && typeof cb.text === "string") {
      parts.push(cb.text);
    } else if (cb.type === "image" && imageUrl === null) {
      const source = asRecord(cb.source);
      if (
        source !== null &&
        source.type === "base64" &&
        typeof source.media_type === "string" &&
        typeof source.data === "string"
      ) {
        imageUrl = `data:${source.media_type};base64,${source.data}`;
      }
    }
  }
  return { toolUseId: block.tool_use_id, text: parts.join("\n"), imageUrl };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
