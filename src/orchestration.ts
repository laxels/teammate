// Pure orchestration helpers shared by the Convex functions (convex/) and
// covered by `bun test`. No Convex runtime dependencies here.

import { excerpt, SUMMARY_MAX_CHARS } from "../shared/agentSummary";
import {
  DEVBOX_EVENT_TYPES,
  type DevboxEvent,
  type DevboxEventType,
  isTerminalTaskStatus,
  type LocalAccessStatus,
  type LocalAgentEvent,
  type TaskStatus,
} from "../shared/protocol";

// ---- Slack event filtering ----

/** A file shared on a Slack message, parsed from the event's `files` array.
 * The orchestrator downloads these (auth via bot token) and stages them for
 * the task; `isImage` marks the types it can also show its own model inline. */
export type SlackFileRef = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** url_private_download (preferred) or url_private — fetched with the bot
   * token. */
  urlPrivate: string;
  isImage: boolean;
};

/** A Slack event we should respond to (human DM or channel mention). */
export type SlackTrigger = {
  type: "message" | "app_mention";
  channel: string;
  user: string;
  text: string;
  ts: string;
  threadTs: string | undefined;
  /** Files shared on the message (downloaded + handed to the task). */
  files: SlackFileRef[];
  /** An un-mentioned reply inside a channel thread: only act on it when the
   * thread anchors one of our tasks (the orchestrator drops it otherwise). */
  channelThreadReply: boolean;
};

/** Image types the orchestrator can render to its own model inline (Anthropic
 * image-block media types). Other types are only handed to the devbox. */
const ORCHESTRATOR_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Parses the Slack event `files` array into SlackFileRefs. A real file with
 * no fetchable private URL (Slack Connect `file_access: "check_file_info"`,
 * whose metadata isn't in the event) is KEPT with an empty `urlPrivate` so the
 * orchestrator reports it as an attachment it couldn't access — silently
 * dropping it would make "inspect this screenshot" look like a fileless
 * message. Only entries that aren't real files (no id and no url) are dropped. */
export function parseSlackFiles(raw: unknown): SlackFileRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const files: SlackFileRef[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const f = item as Record<string, unknown>;
    const url =
      typeof f.url_private_download === "string"
        ? f.url_private_download
        : typeof f.url_private === "string"
          ? f.url_private
          : "";
    const id = typeof f.id === "string" ? f.id : "";
    if (url === "" && id === "") {
      continue;
    }
    const mimeType =
      typeof f.mimetype === "string" ? f.mimetype : "application/octet-stream";
    files.push({
      id,
      name: typeof f.name === "string" && f.name !== "" ? f.name : "file",
      mimeType,
      size: typeof f.size === "number" ? f.size : 0,
      urlPrivate: url,
      isImage: ORCHESTRATOR_IMAGE_MIMES.has(mimeType),
    });
  }
  return files;
}

/** Human-readable byte size for Slack status copy. */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
  // Channel messages: a bot mention arrives as BOTH app_mention and
  // message.channels — let app_mention own those. Un-mentioned THREAD
  // replies are accepted (flagged: they only matter inside a task's thread);
  // plain channel chatter stays invisible.
  let channelThreadReply = false;
  if (event.type === "message" && event.channel_type !== "im") {
    const text = typeof event.text === "string" ? event.text : "";
    if (botUserIds.some((id) => text.includes(`<@${id}>`))) {
      return ignore("channel mention (app_mention covers it)");
    }
    if (event.thread_ts === undefined) {
      return ignore("non-DM message without a mention");
    }
    channelThreadReply = true;
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
      user: event.user,
      text: event.text,
      ts: event.ts,
      threadTs: event.thread_ts,
      files: parseSlackFiles(event.files),
      channelThreadReply,
    },
  };
}

// ---- DevboxEvent (gateway -> /devbox/events) body validation ----

const DEVBOX_EVENT_TYPES_SET: ReadonlySet<string> = new Set(DEVBOX_EVENT_TYPES);

/**
 * Validates an already-JSON-parsed request body against the DevboxEvent wire
 * contract (shared/protocol.ts). Returns null when the body doesn't conform.
 * The optional info-event fields (detail/tool/imageStorageId) are carried
 * through only when present and well-typed; a malformed one is dropped, never a
 * rejection (the core event still records).
 */
/** The identity-agnostic core of the two agent-event wire validators: the
 * event body minus the devboxId/machineId key, or null when malformed. */
function parseAgentEventCore(
  body: Record<string, unknown>,
): Omit<DevboxEvent, "devboxId"> | null {
  if (
    typeof body.taskId !== "string" ||
    typeof body.type !== "string" ||
    !DEVBOX_EVENT_TYPES_SET.has(body.type) ||
    typeof body.summary !== "string" ||
    typeof body.ts !== "number"
  ) {
    return null;
  }
  return {
    taskId: body.taskId,
    type: body.type as DevboxEventType,
    summary: body.summary,
    ts: body.ts,
    ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
    ...(typeof body.tool === "string" ? { tool: body.tool } : {}),
    ...(typeof body.imageStorageId === "string"
      ? { imageStorageId: body.imageStorageId }
      : {}),
  };
}

export function parseDevboxEvent(payload: unknown): DevboxEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.devboxId !== "string") {
    return null;
  }
  const core = parseAgentEventCore(body);
  return core === null ? null : { devboxId: body.devboxId, ...core };
}

// ---- LocalAgentEvent (local daemon -> /local/events) body validation ----

/**
 * Validates an already-JSON-parsed request body against the LocalAgentEvent
 * wire contract (shared/protocol.ts) — parseDevboxEvent's sibling with
 * machineId in place of devboxId. Returns null when the body doesn't conform.
 */
export function parseLocalAgentEvent(payload: unknown): LocalAgentEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const body = payload as Record<string, unknown>;
  if (typeof body.machineId !== "string") {
    return null;
  }
  const core = parseAgentEventCore(body);
  return core === null ? null : { machineId: body.machineId, ...core };
}

// ---- Peer channel formatting (#138) ----

/** One-line preview for timeline summaries and Slack asks — the shared
 * agent-summary `excerpt` helper under the name convex/ modules import
 * (whitespace collapsed, ellipsis-in-budget, 300-char default). */
export const excerptLine = excerpt;

/** Peer request bodies originate from a cloud agent that has read untrusted
 * web content (the prompt-injection path #138 mitigates with hard bans and
 * re-asks); at minimum a crafted body must not forge or terminate the
 * <peer_request> wrapper the local session's protocol trusts. */
function neutralizePeerTags(text: string): string {
  return text.replace(/<(\/?)(peer_request)/gi, "&lt;$1$2");
}

/**
 * How a peer request is delivered into a live local session (a user_message
 * localCommand). The requestId rides inside so the agent can pair its
 * reply_to_cloud call.
 */
export function formatPeerRequestMessage(
  requestId: string,
  body: string,
): string {
  return [
    `<peer_request id="${requestId}">`,
    neutralizePeerTags(body),
    `</peer_request>`,
    `Handle this request, answer with the reply_to_cloud tool (requestId "${requestId}"), then end your turn and wait for the next request.`,
  ].join("\n");
}

/**
 * The start prompt for a split task's local helper agent, built mechanically
 * (the orchestrator LLM is out of the loop once permission is granted). The
 * standing rules — safety bans, backgrounding discipline, reply protocol —
 * live in the daemon's system prompt; this carries task context plus every
 * request that queued while permission was pending.
 */
export function buildLocalHelperPrompt(args: {
  taskId: string;
  title: string;
  requests: { requestId: string; body: string }[];
}): string {
  const intro = `You are the LOCAL agent for task "${args.title}" (${args.taskId}), running on the task owner's own Mac with background computer use. A cloud agent doing the main work sends you requests for things only this machine can do (local files, installed apps, signed-in sessions). Handle each <peer_request> and answer it with the reply_to_cloud tool, quoting its requestId, then end your turn — the next request arrives as a new message.`;
  if (args.requests.length === 0) {
    return `${intro}\n\nNo request is pending yet; requests will arrive as messages.`;
  }
  const blocks = args.requests.map((r) =>
    formatPeerRequestMessage(r.requestId, r.body),
  );
  return [intro, ...blocks].join("\n\n");
}

/**
 * The Slack ask posted (threaded, tagging the requester) when a cloud agent
 * first requests local work on an ungranted task. Mechanical — no LLM
 * involved; the user's reply flows through the orchestrator, which records
 * the decision via resolve_local_access.
 */
export function buildLocalAccessRequestMessage(args: {
  taskId: string;
  title: string;
  slackUser: string | undefined;
  machineName: string;
  reason: string;
}): string {
  const mention = args.slackUser === undefined ? "" : `<@${args.slackUser}> `;
  return (
    `${mention}:lock: *${args.title}* (\`${args.taskId}\`) wants to use your Mac (*${args.machineName}*) with background computer use for: _${excerptLine(args.reason, 400)}_\n` +
    `Reply *yes* to allow it for this task (whole machine, this task only — no standing access), or *no* to keep it cloud-only. ` +
    `A visible agent cursor shows whenever it drives your machine; it never touches terminals, admin prompts, or OS security dialogs, and it asks here first before anything sensitive.`
  );
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
  /** Per-task local-machine grant state (#138); undefined = never requested.
   * "requested" is the cue that a bare yes/no reply is answering the
   * permission ask (resolve_local_access). */
  localAccess?: LocalAccessStatus | undefined;
  /** True when a local agent serves this task (primary or split helper) —
   * the cue for steer_task's agent="local" routing. */
  hasLocalAgent?: boolean | undefined;
};

/**
 * Per-file status the orchestrator message reports, derived from the actual
 * staging outcome (not the raw Slack list) so the model is never told a file
 * is delivered or viewable when it isn't.
 */
export type AttachmentInfo = {
  name: string;
  mimeType: string;
  size: number;
  /** Downloaded + staged for the devbox. */
  available: boolean;
  /** An image block for this file is included in the message — only then may
   * the model be told it can see the image. */
  viewableInline: boolean;
};

/** Neutralizes the structural tags the orchestrator prompt trusts, so
 * untrusted Slack content can never forge or break out of a
 * <user_message>/<thread_context> block. */
function neutralizeStructuralTags(text: string): string {
  return text.replace(/<(\/?)(thread_context|user_message)/gi, "&lt;$1$2");
}

/** Field-safe variant for interpolated values (filenames, mimetypes): also
 * collapses whitespace so a crafted value can't span lines or pad structure. */
function neutralizeField(text: string): string {
  return neutralizeStructuralTags(text).replace(/\s+/g, " ").trim();
}

/**
 * Builds the single user message handed to the orchestrator model. When the
 * triggering message is a reply inside a thread that anchors one or more
 * tasks, a <thread_context> block names them so the model treats the message
 * as being about that work instead of asking which task is meant.
 *
 * Everything from Slack is untrusted: the message text goes inside its own
 * <user_message> block and attachment names/types are field-neutralized, so
 * neither prose nor a crafted filename can forge or break out of the
 * structural blocks (e.g. fabricate a thread-task association). The attachment
 * manifest reflects the staging OUTCOME — only successfully downloaded files
 * are described as delivered, and only files with an image block are marked
 * viewable inline.
 */
export function buildOrchestratorUserMessage(args: {
  trigger: SlackTrigger;
  threadTasks: ThreadTaskContext[];
  attachments?: AttachmentInfo[];
}): string {
  const { trigger, threadTasks } = args;
  const attachments = args.attachments ?? [];
  const source =
    trigger.type === "app_mention"
      ? `mention in channel ${trigger.channel}`
      : "direct message";
  const safeText = neutralizeStructuralTags(trigger.text);
  const parts = [
    `Slack ${source} from <@${trigger.user}>:`,
    `<user_message>\n${safeText}\n</user_message>`,
  ];
  if (attachments.length > 0) {
    const available = attachments.filter((a) => a.available);
    const unavailable = attachments.filter((a) => !a.available);
    const lines: string[] = [];
    if (available.length > 0) {
      lines.push(
        `[The user shared ${available.length} file(s), downloaded and handed to any task you start or steer (the devbox reads them from local paths):`,
      );
      for (const a of available) {
        lines.push(
          `- ${neutralizeField(a.name)} (${neutralizeField(a.mimeType)}, ${formatBytes(a.size)})${a.viewableInline ? " — image, shown to you inline in this message" : ""}`,
        );
      }
      lines.push("Inspect non-image types by delegating to a task.]");
    }
    if (unavailable.length > 0) {
      lines.push(
        `[${unavailable.length} shared file(s) could NOT be downloaded (${unavailable
          .map((a) => neutralizeField(a.name))
          .join(", ")}); tell the user if they matter for the request.]`,
      );
    }
    parts.push(lines.join("\n"));
  }
  if (threadTasks.length > 0) {
    const lines = threadTasks.map((t) => {
      const extras: string[] = [];
      if (t.localAccess !== undefined) {
        extras.push(`local access: ${t.localAccess}`);
      }
      if (t.hasLocalAgent === true) {
        extras.push("local agent active");
      }
      const suffix = extras.length > 0 ? ` · ${extras.join(" · ")}` : "";
      return `- ${t.taskId} "${t.title}" — status: ${t.status}${suffix}`;
    });
    const anyPendingAccess = threadTasks.some(
      (t) => t.localAccess === "requested",
    );
    parts.push(
      [
        "<thread_context>",
        "This message is a reply in the Slack thread of (newest first):",
        ...lines,
        "With one non-terminal task, treat the message as being about it. With several, prefer the one the message names, otherwise the newest non-terminal one — but ask before a stop_task that is ambiguous between running tasks.",
        "Relay mid-task guidance with steer_task, answer progress questions with get_task, stop with stop_task.",
        ...(anyPendingAccess
          ? [
              'A task above has a PENDING local-machine permission ask. If this message answers it (a yes/no or equivalent), record the decision with resolve_local_access — "granted" only on a clear yes from the user.',
            ]
          : []),
        "</thread_context>",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ---- Orchestrator reply gating ----

/**
 * Whether the model's final reply is its "stay silent" sentinel for
 * channel-thread chatter not addressed to us. Matched as a PREFIX (after
 * trimming), not by equality: the model intermittently appends trailing text
 * after the sentinel — `"NO_REPLY\n\nWait — actually this is a DM…"` — and an
 * equality check lets that through, posting the literal `NO_REPLY…` string into
 * Slack. Any reply that opens with the sentinel means stay silent.
 */
export function isNoReplySignal(finalText: string): boolean {
  return finalText.trim().startsWith("NO_REPLY");
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
 * when it can. The devbox.taskId check is load-bearing: a devbox whose row
 * has moved on to another task (retire races, stale commands) must never
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
 * Which registered local machine may serve a task (#138): recently
 * heartbeated, and either owned by the task's requester or unowned (another
 * user's machine is never picked — its owner hasn't consented). Owner match
 * wins over unowned; most recently seen breaks ties. Busy-ness is the
 * caller's concern (a busy machine can still be the target of a permission
 * grant). Follows src/hostPool.ts pickHost's shape: freshness injected, no
 * Convex imports.
 */
export function pickLocalMachine<
  M extends {
    ownerSlackUser?: string | undefined;
    lastSeenAt: number;
  },
>(
  machines: M[],
  opts: { preferOwner?: string | undefined; now: number; freshnessMs: number },
): M | null {
  const candidates = machines.filter(
    (m) =>
      opts.now - m.lastSeenAt <= opts.freshnessMs &&
      (m.ownerSlackUser === undefined || m.ownerSlackUser === opts.preferOwner),
  );
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const aOwned = a.ownerSlackUser === opts.preferOwner ? 1 : 0;
    const bOwned = b.ownerSlackUser === opts.preferOwner ? 1 : 0;
    if (aOwned !== bOwned) {
      return bOwned - aOwned;
    }
    return b.lastSeenAt - a.lastSeenAt;
  });
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  return candidates[0]!;
}

/**
 * Why a steering message cannot be delivered to this task's LOCAL agent, or
 * null when it can (#138). The machine.taskId check mirrors the devbox
 * crosstalk guard: a machine that moved on (task released, another task
 * spawned) must never receive messages aimed at its previous occupant.
 * Delivery while the start command is still queued is allowed, like the
 * devbox provisioning window.
 */
export function localSteerRejection(
  task: {
    taskId: string;
    status: TaskStatus;
    localMachineId?: string | undefined;
  },
  machine: { machineId: string; taskId?: string | undefined } | null,
): string | null {
  if (isTerminalTaskStatus(task.status)) {
    return `task ${task.taskId} is already ${task.status} — there is no live session to steer. Start a follow-up task instead (fold the new guidance into its prompt).`;
  }
  if (task.localMachineId === undefined) {
    return `task ${task.taskId} has no local agent — nothing local to steer (use the default cloud routing, or request local access first)`;
  }
  if (machine === null) {
    return `local machine ${task.localMachineId} is not registered`;
  }
  if (machine.taskId !== task.taskId) {
    return `local machine ${machine.machineId} is no longer serving task ${task.taskId} — refusing to message another task's session`;
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

const STALE_AFTER_MS = 30 * 60_000;

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
}): boolean {
  if (args.nowMs - args.latestActivityMs < STALE_AFTER_MS) {
    return false;
  }
  if (
    args.lastNudgedAtMs !== undefined &&
    args.nowMs - args.lastNudgedAtMs < STALE_AFTER_MS
  ) {
    return false;
  }
  return true;
}

// ---- Status card (the bot's first lifecycle message, edited in place) ----

const STATUS_EMOJI: Record<TaskStatus, string> = {
  queued: ":hourglass_flowing_sand:",
  running: ":hammer_and_wrench:",
  needs_input: ":raising_hand:",
  completed: ":white_check_mark:",
  failed: ":x:",
  stopped: ":octagonal_sign:",
};

export function formatDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Produces the concise `_Latest:_` line for a long summary, or null when it
 * can't (missing key, refusal, truncation) — see convex/notify.ts for the real
 * model-backed implementation. */
export type CardSummarizer = (text: string) => Promise<string | null>;

/** Prompt for the card-line summarizer (#145). The full report rides in an
 * XML block so instructions and payload can't blur together. */
export function buildCardSummaryPrompt(text: string): string {
  return [
    "Write the `Latest:` line of a Slack task status card. Summarize the agent report below as ONE plain sentence (aim for under 150 characters) capturing the essential outcome or current activity — what a teammate glancing at the card needs to know. No markdown, no quotes, no preamble.",
    "<report>",
    text,
    "</report>",
  ].join("\n");
}

/**
 * The status card's `_Latest:_` line (#145): an extremely concise, genuinely
 * intelligent summary of the latest progress — not the full text (#114 made
 * summaries full-length, which turned the card into a wall of text) and not a
 * naive truncation. Short summaries pass through verbatim (whitespace
 * collapsed to keep the card one line per field); long ones are compressed by
 * the injected summarizer. Any summarizer failure degrades to a plain excerpt
 * so a card repaint is never blocked on the model.
 */
export async function cardLatestLine(
  summary: string,
  summarize: CardSummarizer,
): Promise<string> {
  const collapsed = summary.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_CHARS) return collapsed;
  try {
    const line = await summarize(summary);
    if (line !== null) {
      const cleaned = excerpt(line);
      if (cleaned !== "") return cleaned;
    }
  } catch (error) {
    console.error("card summary failed; falling back to excerpt:", error);
  }
  return excerpt(summary);
}

/**
 * Renders the task's status card: one glanceable message per task, posted on
 * the first lifecycle event and chat.update'd in place on every later one.
 * Detail events still arrive as separate thread replies (edits don't notify).
 * `summary` is expected to be the concise card line (see cardLatestLine) —
 * this renderer shows it as-is.
 */
export function buildStatusCard(args: {
  taskId: string;
  title: string;
  status: TaskStatus;
  summary: string;
  monitorUrl: string | null;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  replyHint: ReplyHint;
  /** #138: the task's primary agent runs on the user's own Mac. */
  localAgent?: boolean | undefined;
}): string {
  const { taskId, title, status, summary, monitorUrl, replyHint } = args;
  const lines = [
    `${STATUS_EMOJI[status]} *${title}* (\`${taskId}\`) — ${status.replace("_", " ")}${args.localAgent === true ? " · :computer: on your Mac" : ""}`,
    `_Latest:_ ${summary}`,
  ];
  if (
    args.startedAt !== undefined &&
    args.finishedAt !== undefined &&
    isTerminalTaskStatus(status)
  ) {
    lines.push(`Ran ${formatDurationMs(args.finishedAt - args.startedAt)}.`);
  }
  if (monitorUrl !== null && !isTerminalTaskStatus(status)) {
    lines.push(`Monitor & steer: ${monitorUrl}`);
  }
  if (!isTerminalTaskStatus(status) && replyHint !== "none") {
    lines.push(
      `Reply in this thread${replyHint === "channel" ? " (mention me)" : ""} to steer or check on it.`,
    );
  }
  return lines.join("\n");
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
    default:
      // Info events (#70) never reach Slack (notify only fires on applied
      // status events), but keep this total over the widened DevboxEventType.
      return `*${title}*: ${summary}`;
  }
}

// ---- Orchestrator system-prompt sections (#138) ----
// The base identity/tool prompt is a constant in convex/orchestrator.ts;
// these dynamic sections are appended per turn so routing decisions see the
// current capability manifest and local-machine fleet.

/** The slice of a capability manifest the system prompt renders. */
export type CapabilityManifestContext = {
  goldenTag: string;
  generated: string;
  curated: string;
  updatedAt: number;
};

/**
 * What cloud devboxes are and are not capable of (installed apps, authed
 * accounts, tooling), keyed by golden image tag. Injected so the orchestrator
 * can route work the cloud can't do (local files, local-only apps, sessions
 * that can't transfer) to the local machine instead of watching a devbox
 * fail. Only a new bake updates it — devbox changes don't otherwise persist.
 */
export function buildCapabilitiesSection(
  manifest: CapabilityManifestContext | null,
): string {
  if (manifest === null) {
    return [
      "<devbox_capabilities>",
      "No capability manifest is recorded for the current golden image. Assume the static description above; when a task needs an authed account or app you cannot confirm exists on devboxes, say so and consider local-machine routing.",
      "</devbox_capabilities>",
    ].join("\n");
  }
  return [
    "<devbox_capabilities>",
    `Golden image: ${manifest.goldenTag} (manifest updated ${new Date(manifest.updatedAt).toISOString()}). What every devbox has — anything NOT listed here is NOT on a devbox (fresh VMs carry no state between tasks):`,
    manifest.curated.trim(),
    manifest.generated.trim(),
    "</devbox_capabilities>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/** The slice of a localMachines row the system prompt renders. */
export type LocalMachineContext = {
  machineId: string;
  displayName?: string | undefined;
  ownerSlackUser?: string | undefined;
  taskId?: string | undefined;
  online: boolean;
};

/**
 * The local-machine fleet plus the standing rules for using it: routing
 * (cloud default / local / split), the per-task permission model, and the
 * denial fallback. Rendered even when no machine is registered so the model
 * knows the mode exists and why it is unavailable.
 */
export function buildLocalMachinesSection(
  machines: LocalMachineContext[],
): string {
  const lines =
    machines.length === 0
      ? [
          "No local machine is registered (nobody is running the localagent daemon). Local-machine routing is unavailable — do not offer it.",
        ]
      : machines.map((m) => {
          const bits = [
            m.online ? "online" : "OFFLINE (daemon heartbeat stale)",
            m.taskId === undefined ? "free" : `busy with ${m.taskId}`,
          ];
          if (m.ownerSlackUser !== undefined) {
            bits.push(`owner <@${m.ownerSlackUser}>`);
          }
          const name =
            m.displayName === undefined ? "" : ` ("${m.displayName}")`;
          return `- ${m.machineId}${name}: ${bits.join(", ")}`;
        });
  return [
    "<local_machines>",
    ...lines,
    ...(machines.length === 0
      ? []
      : [
          "Local machines are the users' OWN Macs, driven with background computer use (no focus stealing; a visible agent cursor is the tell). They cover what devboxes cannot: the user's local files, apps installed only there, and signed-in sessions that don't transfer to cloud VMs.",
          'Routing: default to a cloud devbox. Route FULLY local (start_task target="local") only when the work inherently needs that machine AND the user has clearly consented in conversation — starting a local task IS a grant, so never do it on your own initiative. For mixed work, start the task on a devbox as usual: the cloud agent requests local help itself mid-task (a split task), which triggers the permission ask in the thread automatically — you don\'t pre-arrange it.',
          "Permission is per-task and whole-machine; there is NO standing allow. When a permission ask is pending, a clear user yes/no in the thread is recorded with resolve_local_access (\"granted\" only on an unambiguous yes from the machine's owner; anyone else's yes does not count). A user can also preempt — \"use my machine for this\" before being asked — which you record the same way. If access is denied or the user doesn't answer, the task continues cloud-only best-effort and its updates say so; don't re-ask.",
          "Local machines run ONE task at a time, are never queued for, and have no monitoring page or screen recording (privacy) — per-window screenshots appear in the dashboard timeline instead.",
        ]),
    "</local_machines>",
  ].join("\n");
}
