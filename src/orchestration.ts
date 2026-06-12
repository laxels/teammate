// Pure orchestration helpers shared by the Convex functions (convex/) and
// covered by `bun test`. No Convex runtime dependencies here.

import {
  type DevboxEvent,
  type DevboxEventType,
  isTerminalTaskStatus,
  type TaskStatus,
} from "../shared/protocol";

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
  /** Slack attachments on the message; we can't fetch their contents yet. */
  fileCount: number;
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
    files?: unknown[];
  };
  authorizations?: { user_id?: string }[];
};

// Human messages worth reacting to despite carrying a subtype: replies with
// attachments (file_share) and "also send to channel" replies
// (thread_broadcast) — both common shapes inside a task's thread.
const ALLOWED_MESSAGE_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "thread_broadcast",
]);

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
  if (
    event.subtype !== undefined &&
    !ALLOWED_MESSAGE_SUBTYPES.has(event.subtype)
  ) {
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
      fileCount: Array.isArray(event.files) ? event.files.length : 0,
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
  threadTs: string;
};

/**
 * Where replies (and task status updates) should go: always a thread anchored
 * at the triggering message (or the thread it was already in). One request =
 * one thread, so concurrent tasks never interleave in the channel/DM scroll,
 * and a task started from this exchange inherits the thread as its home.
 */
export function resolveThreadTarget(trigger: SlackTrigger): ThreadTarget {
  return {
    channel: trigger.channel,
    threadTs: trigger.threadTs ?? trigger.ts,
  };
}

// ---- Orchestrator conversation building ----

/** The slice of a task the orchestrator needs to interpret a thread reply. */
export type ThreadTaskContext = {
  taskId: string;
  title: string;
  status: TaskStatus;
};

/**
 * Builds the single user message handed to the orchestrator model. When the
 * triggering message is a reply inside a thread that anchors one or more
 * tasks, a <thread_context> block names them so the model treats the message
 * as being about that work instead of asking which task is meant.
 *
 * The Slack text is untrusted: it goes inside its own <user_message> block,
 * and tag sequences that could forge or break out of the structural blocks
 * are neutralized so prose can never fabricate a thread-task association.
 */
export function buildOrchestratorUserMessage(args: {
  trigger: SlackTrigger;
  threadTasks: ThreadTaskContext[];
}): string {
  const { trigger, threadTasks } = args;
  const source =
    trigger.type === "app_mention"
      ? `mention in channel ${trigger.channel}`
      : "direct message";
  const safeText = trigger.text.replace(
    /<(\/?)(thread_context|user_message)/gi,
    "&lt;$1$2",
  );
  const parts = [
    `Slack ${source} from <@${trigger.user}>:`,
    `<user_message>\n${safeText}\n</user_message>`,
  ];
  if (trigger.fileCount > 0) {
    parts.push(
      `[The user attached ${trigger.fileCount} file(s). You cannot view Slack attachments yet — if they matter for the request, say so instead of guessing their contents.]`,
    );
  }
  if (threadTasks.length > 0) {
    const lines = threadTasks.map(
      (t) => `- ${t.taskId} "${t.title}" — status: ${t.status}`,
    );
    parts.push(
      [
        "<thread_context>",
        "This message is a reply in the Slack thread of (newest first):",
        ...lines,
        "With one non-terminal task, treat the message as being about it. With several, prefer the one the message names, otherwise the newest non-terminal one — but ask before a stop_task that is ambiguous between running tasks.",
        "Relay mid-task guidance with steer_task, answer progress questions with get_task, stop with stop_task.",
        "</thread_context>",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ---- Steer/stop authorization ----

/**
 * Whether this requester may steer or stop this task: the task's owner may
 * from anywhere; anyone may from inside the task's own thread (Slack channel
 * membership is the sharing boundary). Tasks from before ownership was
 * recorded are unrestricted. Returns the rejection reason, or null when
 * allowed. This is the deterministic backstop behind the model's tool calls —
 * prose in a Slack message can name any taskId, so the tool layer must check.
 */
export function taskActionAuthorization(args: {
  task: {
    taskId: string;
    slackUser?: string | undefined;
    slackChannel: string;
    slackThreadTs?: string | undefined;
  };
  requester: string;
  target: ThreadTarget;
}): string | null {
  const { task, requester, target } = args;
  if (task.slackUser === undefined || task.slackUser === requester) {
    return null;
  }
  if (
    task.slackThreadTs !== undefined &&
    task.slackChannel === target.channel &&
    task.slackThreadTs === target.threadTs
  ) {
    return null;
  }
  return `task ${task.taskId} was started by <@${task.slackUser}> in another conversation — only its owner (from anywhere) or a reply in the task's own thread may steer or stop it.`;
}

// ---- Steer/stop preflight guards ----

type TaskForGuard = {
  taskId: string;
  status: TaskStatus;
  devboxId?: string | undefined;
};

type DevboxForGuard = {
  devboxId: string;
  taskId?: string | undefined;
} | null;

/**
 * Why a steering message cannot be delivered to this task's session, or null
 * when it can. The devbox.taskId check is load-bearing: a devbox that moved
 * on to another task (permanent devbox reuse, retire races) must never
 * receive messages aimed at its previous occupant.
 */
export function steerRejection(
  task: TaskForGuard,
  devbox: DevboxForGuard,
): string | null {
  if (isTerminalTaskStatus(task.status)) {
    return `task ${task.taskId} is already ${task.status} — there is no live session to steer. Start a follow-up task instead (fold the new guidance into its prompt).`;
  }
  if (task.devboxId === undefined) {
    return `task ${task.taskId} is still queued (no devbox yet) — there is no session to steer. To change the work before it starts, stop this task and start one with an updated prompt.`;
  }
  if (devbox === null) {
    return `devbox ${task.devboxId} is not registered (it may already be destroyed)`;
  }
  if (devbox.taskId !== task.taskId) {
    return `devbox ${devbox.devboxId} is no longer running task ${task.taskId} — refusing to message another task's session`;
  }
  return null;
}

/**
 * Why an interrupt must not be sent for this task, or null when it may.
 * Same crosstalk guard as steerRejection; additionally refuses terminal
 * tasks loudly (an interrupt for an already-finished task would either
 * no-op silently or, worse, hit a devbox that moved on).
 */
export function stopRejection(
  task: TaskForGuard,
  devbox: DevboxForGuard,
): string | null {
  if (isTerminalTaskStatus(task.status)) {
    return `task ${task.taskId} is already ${task.status} — nothing to stop`;
  }
  if (devbox === null) {
    return `devbox ${task.devboxId ?? "(none)"} is not registered (it may already be destroyed)`;
  }
  if (devbox.taskId !== task.taskId) {
    return `devbox ${devbox.devboxId} is no longer running task ${task.taskId} — refusing to interrupt another task's session`;
  }
  return null;
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

// ---- Slack-event dead-letter recovery predicate ----

/** Old enough that the original scheduled run clearly isn't in flight. */
export const SLACK_EVENT_RETRY_MIN_AGE_MS = 2 * 60_000;
/** Too old to be worth replaying (and a backstop against infinite retry). */
export const SLACK_EVENT_RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Whether a stored Slack event deserves a re-scheduled processing run.
 * Events are claimed (marked processed) BEFORE any side-effecting work, so
 * an unprocessed-but-old event means its action died before doing anything —
 * replaying it is safe. Slack's own delivery retries can't recover these:
 * they hit the event_id dedupe, which never re-schedules.
 */
export function shouldRetrySlackEvent(args: {
  nowMs: number;
  receivedAtMs: number;
  processed: boolean;
}): boolean {
  if (args.processed) {
    return false;
  }
  const age = args.nowMs - args.receivedAtMs;
  return (
    age >= SLACK_EVENT_RETRY_MIN_AGE_MS && age <= SLACK_EVENT_RETRY_MAX_AGE_MS
  );
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
 * Which reply affordance a task's Slack updates may truthfully advertise.
 * Channel threads need a mention (only app_mention is subscribed there: an
 * un-mentioned channel reply never reaches us); tasks with no home thread
 * (pre-threading rows) can't resolve thread replies at all, so their copy
 * must not invite them.
 */
export type ReplyHint = "dm" | "channel" | "none";

export function replyHintFor(task: {
  slackChannel: string;
  slackThreadTs?: string | undefined;
}): ReplyHint {
  if (task.slackThreadTs === undefined) {
    return "none";
  }
  // Slack DM (im) channel ids start with "D"; channels/groups with "C"/"G".
  return task.slackChannel.startsWith("D") ? "dm" : "channel";
}

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
  replyHint: ReplyHint;
}): string {
  const { type, taskId, title, summary, monitorUrl, replyHint } = args;
  const monitorLine =
    monitorUrl === null ? "" : `\nMonitor & steer: ${monitorUrl}`;
  const mention = replyHint === "channel" ? " (mention me)" : "";
  switch (type) {
    case "started": {
      const steerHint =
        replyHint === "none"
          ? ""
          : `\nReply in this thread${mention} to steer the task or ask how it's going.`;
      return `:rocket: *${title}* (\`${taskId}\`) started.\n${summary}${monitorLine}${steerHint}`;
    }
    case "progress":
      return `:hammer_and_wrench: *${title}*: ${summary}`;
    case "needs_input": {
      const ask =
        replyHint === "none"
          ? `Please respond on the monitoring page${monitorUrl === null ? "" : `: ${monitorUrl}`}`
          : `Reply in this thread${mention} to answer${monitorUrl === null ? "" : `, or respond on the monitoring page: ${monitorUrl}`}.`;
      return `:raising_hand: *${title}* needs your input: ${summary}\n${ask}`;
    }
    case "completed":
      return `:white_check_mark: *${title}* completed: ${summary}\nReview the result — reply here or mention me if follow-up work is needed.`;
    case "failed":
      return `:x: *${title}* failed: ${summary}\nCheck the session for details${monitorUrl === null ? "" : ` (${monitorUrl})`} or ask me to start a fresh attempt.`;
    case "stopped":
      return `:octagonal_sign: *${title}* was stopped. ${summary}`;
  }
}
