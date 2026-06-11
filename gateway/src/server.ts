import { resolve } from "node:path";
import type { Server } from "bun";
import type {
  GatewayHealth,
  StartTaskRequest,
  SteerServerMessage,
} from "../../shared/protocol";
import type { GatewayConfig } from "./config";
import { createEventSender, type FetchLike } from "./events";
import { type QueryFn, SessionManager, type SessionStatus } from "./session";
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
  vncHost?: string;
  vncPort?: number;
  webDistDir?: string;
  progressIntervalMs?: number;
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
  if (candidate.chrome !== undefined && typeof candidate.chrome !== "boolean") {
    return null;
  }
  return {
    taskId: candidate.taskId,
    prompt: candidate.prompt,
    ...(typeof candidate.cwd === "string" ? { cwd: candidate.cwd } : {}),
    ...(candidate.chrome === true ? { chrome: true } : {}),
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

  const emitEvent = createEventSender(
    config,
    options.fetchFn ?? fetch,
    options.now ?? Date.now,
  );

  const send = (message: SteerServerMessage): string => JSON.stringify(message);

  // `server` is assigned below; the callbacks only run once it is listening.
  let server: Server<WsData>;

  const session = new SessionManager({
    emitEvent,
    onMessage: (message) =>
      server.publish(STEER_TOPIC, send({ type: "sdk_message", message })),
    onStatusChange: (status: SessionStatus) =>
      server.publish(
        STEER_TOPIC,
        send({
          type: "status",
          running: status.running,
          taskId: status.taskId,
        }),
      ),
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
        (url.pathname === "/task" || url.pathname === "/interrupt")
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
        if (!session.start(startRequest)) {
          return Response.json(
            {
              error: "a task is already running",
              taskId: session.status().taskId,
            },
            { status: 409 },
          );
        }
        return Response.json({ accepted: true }, { status: 202 });
      }

      if (request.method === "POST" && url.pathname === "/interrupt") {
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
