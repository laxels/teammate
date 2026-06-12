import type {
  SDKAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DevboxEventType } from "../../shared/protocol";

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
    const summary = excerpt(result.result) || "Task finished.";
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
