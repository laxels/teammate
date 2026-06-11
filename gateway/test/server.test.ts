import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DevboxEvent,
  GatewayHealth,
  SteerServerMessage,
} from "../../shared/protocol";
import type { GatewayConfig } from "../src/config";
import type { FetchLike } from "../src/events";
import { createGatewayServer, type GatewayServer } from "../src/server";
import { createEchoQueryFn, until } from "./helpers";

const config: GatewayConfig = {
  devboxId: "devbox-test",
  port: 0,
  convexSiteUrl: "https://convex.example",
  convexUrl: "https://convex-cloud.example",
  devboxSharedSecret: "shhh",
};

// POST /task and /interrupt require the shared secret header.
const auth = { "x-devbox-secret": config.devboxSharedSecret };

type Harness = {
  server: GatewayServer;
  base: string;
  events: DevboxEvent[];
  eventHeaders: Record<string, string>[];
  control: ReturnType<typeof createEchoQueryFn>["control"];
};

const servers: GatewayServer[] = [];

function makeHarness(
  overrides: Partial<Parameters<typeof createGatewayServer>[0]> = {},
): Harness {
  const { queryFn, control } = createEchoQueryFn();
  const events: DevboxEvent[] = [];
  const eventHeaders: Record<string, string>[] = [];
  const fetchStub: FetchLike = async (_url, init) => {
    events.push(JSON.parse(String(init?.body)) as DevboxEvent);
    eventHeaders.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("ok");
  };

  const server = createGatewayServer({
    config,
    queryFn,
    fetchFn: fetchStub,
    port: 0,
    webDistDir: join(tmpdir(), "gateway-test-no-such-dist"),
    ...overrides,
  });
  servers.push(server);
  return {
    server,
    base: `http://127.0.0.1:${server.port}`,
    events,
    eventHeaders,
    control,
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

function openWs(url: string): {
  ws: WebSocket;
  frames: SteerServerMessage[];
  opened: Promise<void>;
  closed: Promise<void>;
} {
  const ws = new WebSocket(url);
  const frames: SteerServerMessage[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      frames.push(JSON.parse(event.data) as SteerServerMessage);
    }
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  const closed = new Promise<void>((resolve) => {
    ws.addEventListener("close", () => resolve());
  });
  return { ws, frames, opened, closed };
}

describe("HTTP API", () => {
  test("GET /health reports devbox identity and task state", async () => {
    const { base } = makeHarness();
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as GatewayHealth;
    expect(health).toEqual({
      devboxId: "devbox-test",
      running: false,
      taskId: null,
    });
  });

  test("POST /task starts a session (202), rejects a concurrent one (409)", async () => {
    const { base, events, eventHeaders } = makeHarness();

    const accepted = await fetch(`${base}/task`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ taskId: "task-1", prompt: "do the work" }),
    });
    expect(accepted.status).toBe(202);

    const health = (await (
      await fetch(`${base}/health`)
    ).json()) as GatewayHealth;
    expect(health.running).toBe(true);
    expect(health.taskId).toBe("task-1");

    const conflict = await fetch(`${base}/task`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ taskId: "task-2", prompt: "me too" }),
    });
    expect(conflict.status).toBe(409);

    // Lifecycle events reached the (stubbed) Convex endpoint with the secret.
    await until(() => events.some((e) => e.type === "completed"));
    expect(events[0]?.type).toBe("started");
    expect(events[0]?.devboxId).toBe("devbox-test");
    expect(events[0]?.taskId).toBe("task-1");
    expect(typeof events[0]?.ts).toBe("number");
    expect(eventHeaders[0]?.["x-devbox-secret"]).toBe("shhh");
  });

  test("POST /task validates the body", async () => {
    const { base } = makeHarness();
    const bad = await fetch(`${base}/task`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ taskId: "x" }),
    });
    expect(bad.status).toBe(400);
    const notJson = await fetch(`${base}/task`, {
      method: "POST",
      headers: auth,
      body: "{",
    });
    expect(notJson.status).toBe(400);
  });

  test("POST /task and /interrupt reject a missing or wrong secret (401)", async () => {
    const { base } = makeHarness();
    const missing = await fetch(`${base}/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "task-1", prompt: "work" }),
    });
    expect(missing.status).toBe(401);
    const wrong = await fetch(`${base}/interrupt`, {
      method: "POST",
      headers: { "x-devbox-secret": "wrong" },
    });
    expect(wrong.status).toBe(401);
    // The unauthorized /task did not start a session.
    const health = (await (
      await fetch(`${base}/health`)
    ).json()) as GatewayHealth;
    expect(health.running).toBe(false);
  });

  test("POST /interrupt returns 200 and is idempotent", async () => {
    const { base } = makeHarness();
    expect(
      (await fetch(`${base}/interrupt`, { method: "POST", headers: auth }))
        .status,
    ).toBe(200);

    await fetch(`${base}/task`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ taskId: "task-1", prompt: "work" }),
    });
    expect(
      (await fetch(`${base}/interrupt`, { method: "POST", headers: auth }))
        .status,
    ).toBe(200);
    await until(async () => {
      const health = (await (
        await fetch(`${base}/health`)
      ).json()) as GatewayHealth;
      return !health.running;
    });
  });

  test("unknown routes 404 when no web dist exists", async () => {
    const { base } = makeHarness();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("static file serving", () => {
  test("serves files from the web dist with SPA fallback", async () => {
    const dist = await mkdtemp(join(tmpdir(), "gateway-dist-"));
    await writeFile(join(dist, "index.html"), "<html>monitor</html>");
    await writeFile(join(dist, "app.js"), "console.log('app')");
    const { base } = makeHarness({ webDistDir: dist });

    expect(await (await fetch(`${base}/`)).text()).toBe("<html>monitor</html>");
    expect(await (await fetch(`${base}/app.js`)).text()).toBe(
      "console.log('app')",
    );
    // SPA fallback for client-side routes.
    expect(await (await fetch(`${base}/tasks/123`)).text()).toBe(
      "<html>monitor</html>",
    );
    // Path traversal cannot escape the dist directory.
    const traversal = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain("root:");
  });
});

describe("/ws/steer", () => {
  test("sends history then status on connect, broadcasts sdk messages, accepts steering", async () => {
    const { base, server, events } = makeHarness();
    const { ws, frames, opened } = openWs(
      `ws://127.0.0.1:${server.port}/ws/steer`,
    );
    await opened;

    await until(() => frames.length >= 2);
    expect(frames[0]).toEqual({ type: "history", messages: [] });
    expect(frames[1]).toEqual({ type: "status", running: false, taskId: null });

    await fetch(`${base}/task`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ taskId: "task-1", prompt: "stream me" }),
    });

    // Status flips to running and every SDK message is broadcast.
    await until(() =>
      frames.some(
        (f) => f.type === "status" && f.running && f.taskId === "task-1",
      ),
    );
    await until(() =>
      frames.some(
        (f) =>
          f.type === "sdk_message" &&
          (f.message as { type: string }).type === "result",
      ),
    );

    // Steering: a follow-up user message reaches the live session.
    ws.send(JSON.stringify({ type: "user_message", text: "extra request" }));
    await until(() => events.some((e) => e.summary === "done: extra request"));

    // Invalid frames get an error reply.
    ws.send("not json");
    await until(() => frames.some((f) => f.type === "error"));

    // Late joiners receive the accumulated history.
    const late = openWs(`ws://127.0.0.1:${server.port}/ws/steer`);
    await late.opened;
    await until(() => late.frames.length >= 2);
    const history = late.frames[0];
    if (history?.type !== "history") throw new Error("expected history first");
    expect(history.messages.length).toBeGreaterThanOrEqual(4);

    ws.close();
    late.ws.close();
  });

  test("interrupt over the websocket stops the session", async () => {
    const { base, server, control } = makeHarness();
    const { ws, opened } = openWs(`ws://127.0.0.1:${server.port}/ws/steer`);
    await opened;

    await fetch(`${base}/task`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ taskId: "task-1", prompt: "work" }),
    });
    ws.send(JSON.stringify({ type: "interrupt" }));

    await until(() => control.interrupts === 1);
    await until(async () => {
      const health = (await (
        await fetch(`${base}/health`)
      ).json()) as GatewayHealth;
      return !health.running;
    });
    ws.close();
  });
});

describe("/ws/vnc", () => {
  test("bridges raw bytes both ways and propagates close from the TCP side", async () => {
    const received: number[] = [];
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("RFB 003.008\n"); // VNC servers speak first
        },
        data(socket, data) {
          received.push(...data);
          socket.write(data); // echo
          if (data.includes(0xff)) socket.end(); // 0xff = "hang up" for the test
        },
      },
    });

    const { server } = makeHarness({ vncHost: "127.0.0.1", vncPort: tcp.port });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/vnc`);
    ws.binaryType = "arraybuffer";
    const binaryFrames: Uint8Array[] = [];
    let closed = false;
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        binaryFrames.push(new TextEncoder().encode(event.data));
      } else {
        binaryFrames.push(new Uint8Array(event.data as ArrayBuffer));
      }
    });
    ws.addEventListener("close", () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });

    // Server-initiated greeting reaches the websocket client untouched.
    await until(() => binaryFrames.length >= 1);
    expect(new TextDecoder().decode(binaryFrames[0])).toBe("RFB 003.008\n");

    // Client bytes (sent immediately, possibly before the TCP leg opened)
    // reach the VNC server and the echo comes back.
    ws.send(new Uint8Array([1, 2, 3]));
    await until(() => received.length >= 3);
    expect(received).toEqual([1, 2, 3]);
    await until(() => binaryFrames.length >= 2);
    expect([...(binaryFrames[1] ?? [])]).toEqual([1, 2, 3]);

    // TCP close propagates to the websocket.
    ws.send(new Uint8Array([0xff]));
    await until(() => closed);

    tcp.stop(true);
  });

  test("propagates close from the websocket side to the TCP server", async () => {
    let tcpClosed = false;
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() {},
        data() {},
        close() {
          tcpClosed = true;
        },
      },
    });

    const { server } = makeHarness({ vncHost: "127.0.0.1", vncPort: tcp.port });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/vnc`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    ws.close();
    await until(() => tcpClosed);

    tcp.stop(true);
  });
});
