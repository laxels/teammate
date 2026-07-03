// Agent-session summary/extraction helpers, shared by the devbox gateway and
// the localagent daemon (#138) — the session/event layer both reuse.
import type {
  SDKAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DETAIL_MAX_CHARS, type DevboxEventType } from "./protocol";

export const SUMMARY_MAX_CHARS = 300;

/**
 * Collapse whitespace and truncate to `maxChars` (ellipsis included in the
 * budget) so the result is safe to post to Slack as a one-line summary.
 */
export function excerpt(
  text: string,
  maxChars: number = SUMMARY_MAX_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

/**
 * Truncate to `maxChars` WITHOUT collapsing whitespace — for the expandable
 * `detail` body of a timeline event (#70), where line breaks and indentation in
 * an assistant turn or tool I/O are worth preserving.
 */
export function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/** Concatenated text blocks of an assistant message, or null if it has none. */
export function extractAssistantText(
  message: SDKAssistantMessage,
): string | null {
  const parts: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n");
}

export type TerminalEvent = {
  type: Extract<DevboxEventType, "completed" | "failed">;
  summary: string;
};

/** Map an SDK result message to the lifecycle event the orchestrator expects. */
export function mapResultMessage(result: SDKResultMessage): TerminalEvent {
  if (result.subtype === "success") {
    // #114: the assistant's final response is shown in full, never excerpted —
    // for a retrieval task it IS the deliverable. Clip only so a giant answer
    // stays under the per-row / Slack size limit; whitespace is preserved.
    const summary = clip(result.result, DETAIL_MAX_CHARS) || "Task finished.";
    return result.is_error
      ? { type: "failed", summary }
      : { type: "completed", summary };
  }
  const detail =
    result.errors.length > 0 ? `: ${result.errors.join("; ")}` : "";
  return {
    type: "failed",
    summary: excerpt(`Task failed (${result.subtype})${detail}`),
  };
}

/**
 * The question text when an assistant message calls AskUserQuestion, else
 * null. The devbox session is blocked on a human answer at that point — the
 * gateway emits needs_input so the Slack thread (and dashboard) can surface
 * it; the user answers by steering.
 */
export function extractAskUserQuestion(
  message: SDKAssistantMessage,
): string | null {
  for (const block of message.message.content) {
    if (block.type === "tool_use" && block.name === "AskUserQuestion") {
      const input = block.input as {
        questions?: { question?: unknown }[];
      } | null;
      const question = input?.questions?.[0]?.question;
      return typeof question === "string" && question.length > 0
        ? question
        : "The session is asking for your input.";
    }
  }
  return null;
}

// ---- Tool call / result extraction for the retro timeline (#70) ----

export type ToolUse = { id: string; name: string; input: unknown };

/** Every tool the model invoked in this assistant turn (in order). */
export function extractToolUses(message: SDKAssistantMessage): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const block of message.message.content) {
    if (block.type === "tool_use") {
      uses.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return uses;
}

export type ToolResultImage = { data: string; mimeType: string };
export type ToolResultInfo = {
  toolUseId: string;
  text: string;
  images: ToolResultImage[];
  isError: boolean;
};

/**
 * Every tool_result block in a user message, split into its text and its
 * base64 images (computer-use returns a screenshot after each action). A user
 * message that is a plain steer/prompt (string content, or no tool_result
 * blocks) yields nothing, so the gateway's own pushed messages never produce
 * spurious events.
 */
export function extractToolResults(message: SDKUserMessage): ToolResultInfo[] {
  const content = message.message.content;
  if (!Array.isArray(content)) return [];
  const results: ToolResultInfo[] = [];
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const texts: string[] = [];
    const images: ToolResultImage[] = [];
    const inner = block.content;
    if (typeof inner === "string") {
      if (inner.length > 0) texts.push(inner);
    } else if (Array.isArray(inner)) {
      for (const part of inner) {
        if (part.type === "text") {
          texts.push(part.text);
        } else if (part.type === "image" && part.source.type === "base64") {
          images.push({
            data: part.source.data,
            mimeType: part.source.media_type,
          });
        }
      }
    }
    results.push({
      toolUseId: block.tool_use_id,
      text: texts.join("\n"),
      images,
      isError: block.is_error === true,
    });
  }
  return results;
}

/** Strip the in-process MCP namespace ("mcp__computer-use__left_click" ->
 * "left_click") so the timeline shows the bare action name. */
export function prettyToolName(name: string): string {
  const parts = name.split("__");
  return parts.length > 1 ? (parts.at(-1) as string) : name;
}

/** Best-effort one-line JSON of a tool's input for the collapsed `detail`. */
export function stringifyToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}
