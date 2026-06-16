import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "bun";
import {
  type DeliverableFile,
  type GatewayHealth,
  parseTaskEffort,
  type StartTaskRequest,
  type SteerServerMessage,
  type UserMessagePayload,
} from "../../shared/protocol";
import { BrowserSession } from "./browser/executor";
import { createBrowserMcpServer } from "./browser/mcp";
import { ComputerExecutor } from "./computer/executor";
import { createComputerUseMcpServer } from "./computer/mcp";
import type { GatewayConfig } from "./config";
import {
  createEventSender,
  createScreenshotUploader,
  type FetchLike,
} from "./events";
import {
  buildInboundFilePromptSuffix,
  downloadInboundFiles,
  removeBatchInbox,
  removeTaskInbox,
} from "./files";
import { createScreenRecorder, type ScreenRecorder } from "./recorder";
import { type QueryFn, SessionManager, type SessionStatus } from "./session";
import { createShareMcpServer } from "./share";
import { serveStatic } from "./static";
import { dispatchSteerMessage } from "./steer";
import {
  closeVncBridge,
  createVncWsData,
  forwardVncClientFrame,
  openVncBridge,
  type VncWsData,
} from "./vnc";

type SteerWsData = { kind: "steer" };
type WsData = SteerWsData | VncWsData;

const STEER_TOPIC = "steer";

export type GatewayServerOptions = {
  config: GatewayConfig;
  /** Override the SDK query() boundary (tests). */
  queryFn?: QueryFn;
  /** Override outbound HTTP (tests). */
  fetchFn?: FetchLike;
  /** Override the clock (tests). */
  now?: () => number;
  /** Override the listen port (tests use 0). Defaults to config.port. */
  port?: number;
  /** Inject the Playwright browser session (index.ts owns its shutdown). */
  browserSession?: BrowserSession;
  /** Inject the screen recorder (index.ts owns its shutdown/abort). */
  recorder?: ScreenRecorder;
  vncHost?: string;
  vncPort?: number;
  webDistDir?: string;
  progressIntervalMs?: number;
  /** Where inbound Slack files are staged; tests point this at a temp dir so
   * the cross-task wipe never touches the real ~/ultraclaude-inbox. */
  inboxDir?: string;
};

const DEFAULT_WEB_DIST = resolve(import.meta.dir, "../../web/dist");

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Validates the optional `files` array (DeliverableFile[]) on a start/steer
 * payload, dropping malformed entries. Returns undefined when absent/empty. */
function parseDeliverableFiles(raw: unknown): DeliverableFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: DeliverableFile[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (
      typeof f.name === "string" &&
      typeof f.mimeType === "string" &&
      typeof f.size === "number" &&
      typeof f.storageId === "string"
    ) {
      files.push({
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        storageId: f.storageId,
      });
    }
  }
  return files.length > 0 ? files : undefined;
}

function parseUserMessagePayload(body: unknown): UserMessagePayload | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.taskId !== "string" || candidate.taskId === "") {
    return null;
  }
  if (typeof candidate.text !== "string" || candidate.text.trim() === "") {
    return null;
  }
  const files = parseDeliverableFiles(candidate.files);
  return {
    taskId: candidate.taskId,
    text: candidate.text,
    ...(files === undefined ? {} : { files }),
  };
}

function parseStartTaskRequest(body: unknown): StartTaskRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.taskId !== "string" || candidate.taskId === "") {
    return null;
  }
  if (typeof candidate.prompt !== "string" || candidate.prompt === "") {
    return null;
  }
  if (candidate.cwd !== undefined && typeof candidate.cwd !== "string") {
    return null;
  }
  const files = parseDeliverableFiles(candidate.files);
  const effort = parseTaskEffort(candidate.effort);
  return {
    taskId: candidate.taskId,
    prompt: candidate.prompt,
    ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
    ...(effort === undefined ? {} : { effort }),
    ...(files === undefined ? {} : { files }),
  };
}

export type GatewayServer = Server<WsData>;

export function createGatewayServer(
  options: GatewayServerOptions,
): GatewayServer {
  const { config } = options;
  const vncHost = options.vncHost ?? "127.0.0.1";
  const vncPort = options.vncPort ?? 5900;
  const webDistDir = options.webDistDir ?? DEFAULT_WEB_DIST;
  const fetchFn = options.fetchFn ?? fetch;

  // Where inbound Slack files are downloaded before a session starts/steers.
  // Each task gets its OWN subdir (files.taskInboxDir), so cleaning up one task
  // never races another's downloads. Inbound Slack files are private, so the
  // accepted task's dir is removed when that task ends — they never linger
  // past the task that received them.
  const inboxDir = options.inboxDir ?? join(homedir(), "ultraclaude-inbox");
  /** The accepted task whose inbox dir to remove on teardown. */
  let activeInboxTaskId: string | null = null;
  /** Monotonic per-download batch id: each /task or /message download gets its
   * own subdir so repeated steers with the same filename don't clobber a path
   * an earlier turn was already told to use. */
  let inboxBatchSeq = 0;
  const augmentPromptWithFiles = async (
    taskId: string,
    basePrompt: string,
    files: DeliverableFile[] | undefined,
  ): Promise<{ prompt: string; cleanupBatch: () => Promise<void> }> => {
    if (files === undefined || files.length === 0) {
      return { prompt: basePrompt, cleanupBatch: async () => undefined };
    }
    const batch = String(++inboxBatchSeq);
    const downloaded = await downloadInboundFiles(files, taskId, inboxDir, {
      convexSiteUrl: config.convexSiteUrl,
      secret: config.devboxSharedSecret,
      subdir: batch,
      fetchFn,
    });
    return {
      prompt: basePrompt + buildInboundFilePromptSuffix(downloaded),
      // Remove ONLY this batch (not the task dir): a rejected duplicate-start
      // for the same taskId must never delete the accepted task's files.
      cleanupBatch: () => removeBatchInbox(inboxDir, taskId, batch),
    };
  };

  const emitEvent = createEventSender(config, fetchFn, options.now ?? Date.now);

  const send = (message: SteerServerMessage): string => JSON.stringify(message);

  // `server` is assigned below; the callbacks only run once it is listening.
  let server: Server<WsData>;

  // Uploads tool-result screenshots to Convex storage for the retro timeline (#70).
  const uploadScreenshot = createScreenshotUploader(config, fetchFn);

  // Records the devbox screen for each task and uploads it to Convex storage;
  // the SessionManager drives its start/finish around the task lifecycle.
  const recorder =
    options.recorder ?? createScreenRecorder({ config, fetchFn });

  // One browser for the gateway's lifetime, shared across tasks like the rest
  // of the desktop: Chrome launches lazily on first use and stays open, with
  // logins persisting in its profile. (Construction never launches anything.)
  const browserSession = options.browserSession ?? new BrowserSession();

  const session = new SessionManager({
    emitEvent,
    uploadScreenshot,
    recorder,
    createMcpServers: (taskId) => ({
      "computer-use": createComputerUseMcpServer(new ComputerExecutor()),
      browser: createBrowserMcpServer(browserSession),
      "share-file": createShareMcpServer({ config, taskId, fetchFn }),
    }),
    onMessage: (message) =>
      server.publish(STEER_TOPIC, send({ type: "sdk_message", message })),
    onStatusChange: (status: SessionStatus) => {
      // Task finished/stopped: drop its (and only its) downloaded inbound files.
      if (!status.running && activeInboxTaskId !== null) {
        void removeTaskInbox(inboxDir, activeInboxTaskId);
        activeInboxTaskId = null;
      }
      server.publish(
        STEER_TOPIC,
        send({
          type: "status",
          running: status.running,
          taskId: status.taskId,
        }),
      );
    },
    ...(options.queryFn ? { queryFn: options.queryFn } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.progressIntervalMs !== undefined
      ? { progressIntervalMs: options.progressIntervalMs }
      : {}),
  });

  server = Bun.serve<WsData>({
    hostname: "0.0.0.0",
    port: options.port ?? config.port,
    async fetch(request, srv) {
      const url = new URL(request.url);

      if (url.pathname === "/ws/steer") {
        const upgraded = srv.upgrade(request, {
          data: { kind: "steer" } satisfies SteerWsData,
        });
        return upgraded
          ? undefined
          : new Response("websocket upgrade required", { status: 400 });
      }

      if (url.pathname === "/ws/vnc") {
        const upgraded = srv.upgrade(request, { data: createVncWsData() });
        return upgraded
          ? undefined
          : new Response("websocket upgrade required", { status: 400 });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const status = session.status();
        const health: GatewayHealth = {
          devboxId: config.devboxId,
          running: status.running,
          taskId: status.taskId,
        };
        return Response.json(health);
      }

      // Tailscale Serve exposes this whole port to the tailnet, so the
      // control endpoints require the shared secret (same value gateways use
      // to authenticate with Convex).
      if (
        request.method === "POST" &&
        (url.pathname === "/task" ||
          url.pathname === "/message" ||
          url.pathname === "/interrupt")
      ) {
        const provided = request.headers.get("x-devbox-secret");
        if (
          provided === null ||
          !timingSafeEqual(provided, config.devboxSharedSecret)
        ) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      if (request.method === "POST" && url.pathname === "/task") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const startRequest = parseStartTaskRequest(body);
        if (startRequest === null) {
          return Response.json(
            { error: "expected { taskId, prompt, cwd? }" },
            { status: 400 },
          );
        }
        // Reject a concurrent/duplicate task BEFORE any download or cleanup, so
        // a rejected task never disturbs the running task's inbox. (index.ts
        // surfaces a 409 here as a failed task — a single-task VM should never
        // receive a second start.)
        if (session.status().running) {
          return Response.json(
            {
              error: "a task is already running",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        // Download this task's shared files into its OWN batch subdir and point
        // the prompt at them before the session starts. Blocks the 202 by
        // seconds; bounded by the download timeout.
        const { prompt, cleanupBatch } = await augmentPromptWithFiles(
          startRequest.taskId,
          startRequest.prompt,
          startRequest.files,
        );
        if (!session.start({ ...startRequest, prompt })) {
          // Lost a race during the download (now running): drop only THIS
          // request's batch. A same-taskId duplicate that won the race keeps
          // its own batch; a different task is in its own dir entirely.
          await cleanupBatch();
          return Response.json(
            {
              error: "a task is already running",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        activeInboxTaskId = startRequest.taskId;
        return Response.json({ accepted: true }, { status: 202 });
      }

      if (request.method === "POST" && url.pathname === "/message") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 });
        }
        const payload = parseUserMessagePayload(body);
        if (payload === null) {
          return Response.json(
            { error: "expected { taskId, text }" },
            { status: 400 },
          );
        }
        // The taskId match keeps a stale command (aimed at a previous
        // occupant of this devbox) out of the current session; the
        // terminalEmitted check drops steers that lost the race against task
        // completion (a late message must not re-open a finished task). Both
        // are checked BEFORE downloading any attachments, so a doomed steer
        // wastes no bandwidth.
        if (
          session.status().taskId !== payload.taskId ||
          session.terminalEmitted()
        ) {
          return Response.json(
            {
              error: "no live session for that task",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        const { prompt: text, cleanupBatch } = await augmentPromptWithFiles(
          payload.taskId,
          payload.text,
          payload.files,
        );
        if (!session.pushUserMessage(text)) {
          // The session ended during the download: drop this steer's batch.
          await cleanupBatch();
          return Response.json(
            {
              error: "no live session for that task",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        return Response.json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/interrupt") {
        // An interrupt may carry { taskId } (orchestrator stop_task): only
        // stop the session if it still belongs to that task, so a stale stop
        // never kills a later occupant. A bodyless/empty interrupt stays
        // unconditional — a defensive hard-stop fallback; its old caller
        // (index.ts's evict-and-retry) is gone, and live stops are task-scoped
        // (the /ws/steer Stop button interrupts over the socket, not here).
        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          // No/invalid body: unconditional interrupt.
        }
        const guardTaskId =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>).taskId
            : undefined;
        if (
          typeof guardTaskId === "string" &&
          session.status().taskId !== guardTaskId
        ) {
          return Response.json(
            {
              error: "no live session for that task",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        await session.stop();
        return Response.json({ ok: true });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const staticResponse = await serveStatic(webDistDir, url.pathname);
        if (staticResponse !== null) return staticResponse;
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "steer") {
          ws.send(
            send({ type: "history", messages: session.historySnapshot() }),
          );
          const status = session.status();
          ws.send(
            send({
              type: "status",
              running: status.running,
              taskId: status.taskId,
            }),
          );
          ws.subscribe(STEER_TOPIC);
          return;
        }
        openVncBridge(
          // Narrowing ws.data does not narrow ws itself; the bridge only
          // touches ws.data (VncWsData) and send/close.
          ws as typeof ws & { data: VncWsData },
          vncHost,
          vncPort,
        );
      },
      async message(ws, raw) {
        if (ws.data.kind === "steer") {
          const reply = await dispatchSteerMessage(
            typeof raw === "string" ? raw : raw.toString("utf8"),
            session,
          );
          if (reply !== null) ws.send(send(reply));
          return;
        }
        forwardVncClientFrame(
          ws.data,
          typeof raw === "string" ? raw : new Uint8Array(raw),
        );
      },
      close(ws) {
        if (ws.data.kind === "vnc") {
          closeVncBridge(ws.data);
        }
      },
    },
  });

  return server;
}
