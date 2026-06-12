// Renders a persisted SDK transcript (raw SDKMessage array, JSON) into
// readable lines for the dashboard's detail panel. Tolerates unknown message
// shapes — transcripts outlive protocol versions.

export type TranscriptLine = {
  role: "user" | "assistant" | "tool" | "meta";
  text: string;
};

type Block = {
  type?: string;
  text?: string;
  name?: string;
  content?: unknown;
};

type Message = {
  type?: string;
  message?: { role?: string; content?: unknown };
};

function blockLines(
  blocks: unknown,
  role: "user" | "assistant",
): TranscriptLine[] {
  if (typeof blocks === "string") {
    return blocks.trim() === "" ? [] : [{ role, text: blocks }];
  }
  if (!Array.isArray(blocks)) {
    return [];
  }
  const lines: TranscriptLine[] = [];
  for (const raw of blocks as Block[]) {
    if (
      raw.type === "text" &&
      typeof raw.text === "string" &&
      raw.text !== ""
    ) {
      lines.push({ role, text: raw.text });
    } else if (raw.type === "tool_use" && typeof raw.name === "string") {
      lines.push({ role: "tool", text: `→ ${raw.name}` });
    }
    // tool_result / thinking / images: skipped — the Slack-facing summaries
    // and the prompt already tell that part of the story.
  }
  return lines;
}

export function extractTranscriptLines(json: string): TranscriptLine[] {
  let messages: unknown;
  try {
    messages = JSON.parse(json);
  } catch {
    return [{ role: "meta", text: "transcript is not valid JSON" }];
  }
  if (!Array.isArray(messages)) {
    return [{ role: "meta", text: "transcript has an unexpected shape" }];
  }
  const lines: TranscriptLine[] = [];
  for (const raw of messages as Message[]) {
    if (raw.type === "assistant") {
      lines.push(...blockLines(raw.message?.content, "assistant"));
    } else if (raw.type === "user") {
      lines.push(...blockLines(raw.message?.content, "user"));
    }
    // system/init, stream events, results: structural noise here.
  }
  return lines;
}
