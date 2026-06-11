// Minimal Slack Web API client used by the Convex actions. Kept in src/ so
// both the default-runtime actions (notifications, cron) and the Node action
// (orchestrator) can share it.

export type PostMessageArgs = {
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string | undefined;
};

/**
 * Posts a message via chat.postMessage. Throws on transport errors or a
 * non-ok Slack response so callers can decide how to surface the failure.
 */
export async function postSlackMessage(args: PostMessageArgs): Promise<void> {
  const body: Record<string, string> = {
    channel: args.channel,
    text: args.text,
  };
  if (args.threadTs !== undefined) {
    body.thread_ts = args.threadTs;
  }
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${args.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`chat.postMessage HTTP ${response.status}`);
  }
  const result = (await response.json()) as { ok?: boolean; error?: string };
  if (result.ok !== true) {
    throw new Error(`chat.postMessage failed: ${result.error ?? "unknown"}`);
  }
}
