// localagent daemon (#138): the local-machine sibling of the devbox gateway.
// Runs on the user's own Mac as a LaunchAgent, fully outbound (no HTTP
// surface — the cloud never dials a user's machine): it self-registers via
// heartbeat, consumes the localCommands queue, and runs Agent SDK sessions
// with cua-driver background computer use under the hard-ban tool gate.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import {
  createAgentEventSender,
  createAgentScreenshotUploader,
} from "../../shared/agentEvents";
import {
  buildInboundFilePromptSuffix,
  downloadInboundFiles,
  removeTaskInbox,
} from "../../shared/agentFiles";
import { AgentSessionManager } from "../../shared/agentSession";
import {
  type DeliverableFile,
  type InterruptPayload,
  parseTaskEffort,
  type StartTaskRequest,
  type UserMessagePayload,
} from "../../shared/protocol";
import { loadConfig } from "./config";
import {
  type PendingLocalCommand,
  reconcileOrphansRef,
  startLocalConsumer,
} from "./consumer";
import { createLocalMcpServers } from "./mcp";
import { LOCAL_SYSTEM_PROMPT } from "./prompt";
import { createHardBanGate } from "./safety";

const config = loadConfig();

if (process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined) {
  // Not fatal: on the user's own Mac the SDK subprocess can also use the
  // machine's existing Claude Code login (keychain).
  console.warn(
    "[localagent] CLAUDE_CODE_OAUTH_TOKEN is not set; sessions will rely on this machine's own Claude Code login",
  );
}
if (!existsSync(config.cuaDriverBin)) {
  console.warn(
    `[localagent] cua-driver binary not found at ${config.cuaDriverBin} — computer-use tools will fail. Run scripts/setup-localagent.sh.`,
  );
}

const authHeader = { "x-local-secret": config.localMachineSecret };
const inboxBaseDir = join(homedir(), ".ultraclaude", "local-inbox");

// One sender for the session AND the out-of-session failure events below
// (deliveries serialize on its queue either way).
const emitEvent = createAgentEventSender({
  convexSiteUrl: config.convexSiteUrl,
  endpointPath: "/local/events",
  authHeader,
  identity: { machineId: config.machineId },
  logPrefix: "localagent",
});

const session = new AgentSessionManager({
  emitEvent,
  uploadScreenshot: createAgentScreenshotUploader({
    convexSiteUrl: config.convexSiteUrl,
    uploadUrlPath: "/local/upload-url",
    authHeader,
    logPrefix: "localagent",
  }),
  systemPrompt: LOCAL_SYSTEM_PROMPT,
  logPrefix: "localagent",
  toolGate: createHardBanGate(),
  createMcpServers: (taskId) => createLocalMcpServers(config, taskId),
  onStatusChange: (status) => {
    if (!status.running && lastTaskId !== null) {
      void removeTaskInbox(inboxBaseDir, lastTaskId);
    }
    lastTaskId = status.taskId;
  },
  // No recorder: the user's machine is never screen-recorded (privacy, per
  // #138) — per-window screenshots on the timeline are the observability.
});
let lastTaskId: string | null = null;

let downloadBatch = 0;
async function stagedPromptSuffix(
  taskId: string,
  files: DeliverableFile[] | undefined,
): Promise<string> {
  if (files === undefined || files.length === 0) {
    return "";
  }
  downloadBatch += 1;
  const downloaded = await downloadInboundFiles(files, taskId, inboxBaseDir, {
    convexSiteUrl: config.convexSiteUrl,
    endpointPath: "/local/file",
    authHeader,
    subdir: `batch-${downloadBatch}`,
  });
  return buildInboundFilePromptSuffix(downloaded);
}

function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function executeStart(payload: string): Promise<void> {
  const body = parseJson(payload);
  if (
    body === null ||
    typeof body.taskId !== "string" ||
    typeof body.prompt !== "string"
  ) {
    console.error("[localagent] malformed start payload; dropping");
    return;
  }
  const taskId = body.taskId;
  if (session.status().running) {
    // A FINISHED session legitimately lingers (finished-but-steerable, and a
    // stopped session's subprocess takes a moment to wind down): evict it and
    // wait — the machine was only marked free because its task ended. A
    // genuinely mid-task session is a placement bug; fail the newcomer loudly
    // rather than fight for the slot (mirrors the gateway's 409 handling).
    if (session.terminalEmitted()) {
      await session.stop();
    }
    if (!session.terminalEmitted() || !(await waitForIdle())) {
      console.error(
        `[localagent] start for ${taskId} rejected: a session is already running`,
      );
      await emitFailed(
        taskId,
        "The local machine's agent is busy with another session — the task was rejected. Retry once the machine frees.",
      );
      return;
    }
  }
  const suffix = await stagedPromptSuffix(
    taskId,
    Array.isArray(body.files) ? (body.files as DeliverableFile[]) : undefined,
  );
  const effort = parseTaskEffort(body.effort);
  const request: StartTaskRequest = {
    taskId,
    prompt: `${body.prompt}${suffix}`,
    cwd: config.cwd,
    ...(effort === undefined ? {} : { effort }),
  };
  if (!session.start(request)) {
    await emitFailed(taskId, "The local agent could not start a session.");
  }
}

async function executeUserMessage(payload: string): Promise<void> {
  const body = parseJson(payload);
  if (
    body === null ||
    typeof body.taskId !== "string" ||
    typeof body.text !== "string"
  ) {
    console.error("[localagent] malformed user_message payload; dropping");
    return;
  }
  const message = body as unknown as UserMessagePayload;
  // taskId crosstalk guard (a stale message must never reach a later task's
  // session). Unlike the gateway's POST /message, delivery after a terminal
  // result is allowed: a split task's helper handles each peer request as a
  // fresh turn on its finished-but-steerable session.
  if (session.status().taskId !== message.taskId) {
    console.warn(
      `[localagent] dropping user_message for ${message.taskId}: no live session for it`,
    );
    return;
  }
  const suffix = await stagedPromptSuffix(message.taskId, message.files);
  if (!session.pushUserMessage(`${message.text}${suffix}`)) {
    console.warn(
      `[localagent] user_message for ${message.taskId} not delivered (session wound down)`,
    );
  }
}

async function executeInterrupt(payload: string): Promise<void> {
  const body = parseJson(payload) ?? {};
  const guard = (body as InterruptPayload).taskId;
  if (guard !== undefined && session.status().taskId !== guard) {
    console.log(
      `[localagent] ignoring interrupt for ${guard}: current session is ${session.status().taskId ?? "idle"}`,
    );
    return;
  }
  await session.stop();
  // Drain the wind-down before acking: the next serialized command may be a
  // start for this just-freed machine.
  await waitForIdle();
}

async function emitFailed(taskId: string, summary: string): Promise<void> {
  // One-off event outside the session (which never started for this task).
  await emitEvent(taskId, "failed", summary);
}

/** Wait for the session's wind-down to finish. session.stop() resolves once
 * the interrupt is REQUESTED; #running clears only when the SDK subprocess
 * stream actually ends, typically a moment later. The serialized command
 * chain executes an interrupt then the next start back-to-back, so without
 * this wait a start placed on the just-freed machine would busy-reject. */
async function waitForIdle(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (session.status().running) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

async function execute(command: PendingLocalCommand): Promise<void> {
  switch (command.kind) {
    case "start":
      await executeStart(command.payload);
      return;
    case "user_message":
      await executeUserMessage(command.payload);
      return;
    case "interrupt":
      await executeInterrupt(command.payload);
      return;
    default:
      // Forward-compat: let the consumer ack unknown kinds.
      console.warn(
        `[localagent] unknown command kind ${(command as { kind: string }).kind}`,
      );
  }
}

const client = new ConvexClient(config.convexUrl);

// A freshly started daemon owns no sessions: whatever this machine was
// running died with the previous process. Reconcile before consuming so an
// orphaned task fails loudly (and the machine frees) instead of hanging.
try {
  const result = (await client.mutation(reconcileOrphansRef, {
    machineId: config.machineId,
    secret: config.localMachineSecret,
  })) as { reconciled: number };
  if (result.reconciled > 0) {
    console.log(
      `[localagent] reconciled ${result.reconciled} orphaned task(s) from a previous daemon process`,
    );
  }
} catch (error) {
  console.error("[localagent] orphan reconcile failed:", error);
}

const stopConsumer = startLocalConsumer({
  client,
  machineId: config.machineId,
  secret: config.localMachineSecret,
  displayName: config.displayName,
  ownerSlackUser: config.ownerSlackUser,
  getSessionTaskId: () => session.status().taskId,
  execute,
});

const shutdown = async (): Promise<void> => {
  stopConsumer();
  await session.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log(
  `[localagent] up as ${config.machineId} (cua-driver: ${config.cuaDriverBin}); awaiting commands`,
);
