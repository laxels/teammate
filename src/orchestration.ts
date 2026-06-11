// Pure orchestration helpers shared by the Convex functions (convex/) and
// covered by `bun test`. No Convex runtime dependencies here.

import type { DevboxEvent, DevboxEventType } from "../shared/protocol";

// ---- Slack event filtering ----

/** A Slack event we should respond to (human DM or channel mention). */
export type SlackTrigger = {
  type: "message" | "app_mention";
  channel: string;
  /** "im" for DMs; absent on app_mention events. */
  channelType: string | undefined;
  user: string;
  text: string;
  ts: string;
  threadTs: string | undefined;
};

export type SlackEventClassification =
  | { kind: "trigger"; trigger: SlackTrigger }
  | { kind: "ignore"; reason: string };

type SlackEventEnvelope = {
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
  };
  authorizations?: { user_id?: string }[];
};

function ignore(reason: string): SlackEventClassification {
  return { kind: "ignore", reason };
}

/**
 * Decides whether a stored Slack event payload should trigger the
 * orchestrator. Filters out our own messages (bot echoes), message subtypes
 * (edits, joins, bot_message), and channel chatter that doesn't mention us.
 */
export function classifySlackEvent(
  payloadJson: string,
): SlackEventClassification {
  let envelope: SlackEventEnvelope;
  try {
    envelope = JSON.parse(payloadJson) as SlackEventEnvelope;
  } catch {
    return ignore("payload is not valid JSON");
  }
  const event = envelope.event;
  if (typeof event !== "object" || event === null) {
    return ignore("no event in payload");
  }
  if (event.type !== "message" && event.type !== "app_mention") {
    return ignore(`unsupported event type: ${event.type}`);
  }
  if (event.bot_id !== undefined) {
    return ignore("bot message (bot_id set)");
  }
  if (event.subtype !== undefined) {
    return ignore(`message subtype: ${event.subtype}`);
  }
  if (typeof event.user !== "string") {
    return ignore("no user on event");
  }
  const botUserIds = (envelope.authorizations ?? [])
    .map((a) => a.user_id)
    .filter((id): id is string => typeof id === "string");
  if (botUserIds.includes(event.user)) {
    return ignore("message from the bot user itself");
  }
  // Only message.im is subscribed, but be defensive: never react to plain
  // channel messages — channels are mention-only (app_mention).
  if (event.type === "message" && event.channel_type !== "im") {
    return ignore("non-DM message without a mention");
  }
  if (
    typeof event.channel !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.text !== "string"
  ) {
    return ignore("missing channel/ts/text");
  }
  return {
    kind: "trigger",
    trigger: {
      type: event.type,
      channel: event.channel,
      channelType: event.channel_type,
      user: event.user,
      text: event.text,
      ts: event.ts,
      threadTs: event.thread_ts,
    },
  };
}

// ---- DevboxEvent (gateway -> /devbox/events) body validation ----

const DEVBOX_EVENT_TYPES: ReadonlySet<string> = new Set([
  "started",
  "progress",
  "needs_input",
  "completed",
  "failed",
  "stopped",
] satisfies DevboxEventType[]);

/**
 * Validates an already-JSON-parsed request body against the DevboxEvent wire
 * contract (shared/protocol.ts). Returns null when the body doesn't conform.
 */
export function parseDevboxEvent(payload: unknown): DevboxEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  if (
    typeof body.devboxId !== "string" ||
    typeof body.taskId !== "string" ||
    typeof body.type !== "string" ||
    !DEVBOX_EVENT_TYPES.has(body.type) ||
    typeof body.summary !== "string" ||
    typeof body.ts !== "number"
  ) {
    return null;
  }
  return {
    devboxId: body.devboxId,
    taskId: body.taskId,
    type: body.type as DevboxEventType,
    summary: body.summary,
    ts: body.ts,
  };
}

// ---- Thread-target resolution ----

export type ThreadTarget = {
  channel: string;
  threadTs: string | undefined;
};

/**
 * Where replies (and task status updates) should go. DMs are answered
 * top-level unless the user was already in a thread; channel mentions are
 * always answered in a thread anchored at the triggering message.
 */
export function resolveThreadTarget(trigger: SlackTrigger): ThreadTarget {
  if (trigger.channelType === "im") {
    return { channel: trigger.channel, threadTs: trigger.threadTs };
  }
  return {
    channel: trigger.channel,
    threadTs: trigger.threadTs ?? trigger.ts,
  };
}

// ---- Monitoring-URL derivation ----

/**
 * Derives the monitoring page URL (`https://{devboxHost}/`) from a devbox
 * gateway URL. The page is fronted by Tailscale Serve on 443: noVNC needs a
 * secure context (crypto.subtle is unavailable over plain http, which breaks
 * the VNC auth handshake). Returns null when the gateway URL can't be parsed.
 */
export function monitoringUrl(gatewayUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    return null;
  }
  if (parsed.hostname === "") {
    return null;
  }
  return `https://${parsed.hostname}/`;
}

// ---- Staleness predicate ----

export const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * True when a running task deserves a proactive check-in: its latest devbox
 * event is older than 30 minutes AND we haven't already nudged the thread in
 * the last 30 minutes.
 */
export function shouldNudge(args: {
  nowMs: number;
  /** Timestamp of the latest task event (fall back to task.updatedAt). */
  latestActivityMs: number;
  lastNudgedAtMs?: number;
  thresholdMs?: number;
}): boolean {
  const threshold = args.thresholdMs ?? STALE_AFTER_MS;
  if (args.nowMs - args.latestActivityMs < threshold) {
    return false;
  }
  if (
    args.lastNudgedAtMs !== undefined &&
    args.nowMs - args.lastNudgedAtMs < threshold
  ) {
    return false;
  }
  return true;
}

// ---- Slack message formatting for devbox events ----

/**
 * Renders a DevboxEvent as a Slack message. "started" carries the monitoring
 * link; completed/failed/needs_input are written to be clearly actionable.
 */
export function buildDevboxEventMessage(args: {
  type: DevboxEventType;
  taskId: string;
  title: string;
  summary: string;
  monitorUrl: string | null;
}): string {
  const { type, taskId, title, summary, monitorUrl } = args;
  const monitorLine =
    monitorUrl === null ? "" : `\nMonitor & steer: ${monitorUrl}`;
  switch (type) {
    case "started":
      return `:rocket: *${title}* (\`${taskId}\`) started.\n${summary}${monitorLine}`;
    case "progress":
      return `:hammer_and_wrench: *${title}*: ${summary}`;
    case "needs_input":
      return `:raising_hand: *${title}* needs your input: ${summary}\nPlease respond on the monitoring page${monitorUrl === null ? "" : `: ${monitorUrl}`}`;
    case "completed":
      return `:white_check_mark: *${title}* completed: ${summary}\nReview the result — reply here or mention me if follow-up work is needed.`;
    case "failed":
      return `:x: *${title}* failed: ${summary}\nCheck the session for details${monitorUrl === null ? "" : ` (${monitorUrl})`} or ask me to start a fresh attempt.`;
    case "stopped":
      return `:octagonal_sign: *${title}* was stopped. ${summary}`;
  }
}
