import { afterEach, describe, expect, test } from "bun:test";
import type { SteerServerMessage } from "../../shared/protocol";
import { SteerClient } from "./steer";

// Real-socket tests: a throwaway Bun WebSocket server stands in for the
// gateway. No stubs — this exercises actual connect/reconnect/queue behavior.

type ServerHandle = {
  port: number;
  received: string[];
  stop: () => void;
};

function startServer(
  port: number,
  onOpen?: (send: (s: string) => void) => void,
): ServerHandle {
  const received: string[] = [];
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      return srv.upgrade(req)
        ? undefined
        : new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        onOpen?.((s) => ws.send(s));
      },
      message(_ws, raw) {
        received.push(String(raw));
      },
    },
  });
  return {
    port: server.port ?? port,
    received,
    stop: () => server.stop(true),
  };
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await Bun.sleep(20);
  }
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) {
    fn();
  }
  cleanup = [];
});

describe("SteerClient", () => {
  test("connects, receives messages, and reports connection state", async () => {
    const status: SteerServerMessage = {
      type: "status",
      running: true,
      taskId: "t1",
    };
    const server = startServer(0, (send) => send(JSON.stringify(status)));
    cleanup.push(() => server.stop());

    const messages: SteerServerMessage[] = [];
    const connections: boolean[] = [];
    const client = new SteerClient(`ws://127.0.0.1:${server.port}/ws/steer`, {
      onMessage: (m) => messages.push(m),
      onConnectionChange: (c) => connections.push(c),
    });
    cleanup.push(() => client.stop());
    client.start();

    await until(() => messages.length === 1);
    expect(messages[0]).toEqual(status);
    expect(connections).toEqual([true]);
  });

  test("queues messages sent while disconnected and flushes on connect", async () => {
    // Reserve a port, then release it so the first connection attempt fails.
    const probe = startServer(0);
    const port = probe.port;
    probe.stop();

    const client = new SteerClient(`ws://127.0.0.1:${port}/ws/steer`, {
      onMessage: () => {},
      onConnectionChange: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();
    client.send({ type: "user_message", text: "queued while down" });
    client.send({ type: "interrupt" });

    // Let the first attempt fail, then bring the server up; the client's
    // backoff retry should connect and flush the queue in order.
    await Bun.sleep(100);
    const server = startServer(port);
    cleanup.push(() => server.stop());

    await until(() => server.received.length === 2);
    expect(server.received.map((raw) => JSON.parse(raw))).toEqual([
      { type: "user_message", text: "queued while down" },
      { type: "interrupt" },
    ]);
  });

  test("reconnects after the server drops the connection", async () => {
    const hello: SteerServerMessage = { type: "history", messages: [] };
    let server = startServer(0, (send) => send(JSON.stringify(hello)));
    const port = server.port;

    const messages: SteerServerMessage[] = [];
    const connections: boolean[] = [];
    const client = new SteerClient(`ws://127.0.0.1:${port}/ws/steer`, {
      onMessage: (m) => messages.push(m),
      onConnectionChange: (c) => connections.push(c),
    });
    cleanup.push(() => client.stop());
    client.start();
    await until(() => messages.length === 1);

    server.stop();
    await until(() => connections.at(-1) === false);
    server = startServer(port, (send) => send(JSON.stringify(hello)));
    cleanup.push(() => server.stop());

    await until(() => messages.length === 2);
    expect(connections).toEqual([true, false, true]);
  });

  test("ignores frames that are not valid JSON protocol messages", async () => {
    const server = startServer(0, (send) => {
      send("not json {");
      send(JSON.stringify({ noType: true }));
      send(JSON.stringify({ type: "error", message: "real" }));
    });
    cleanup.push(() => server.stop());

    const messages: SteerServerMessage[] = [];
    const client = new SteerClient(`ws://127.0.0.1:${server.port}/ws/steer`, {
      onMessage: (m) => messages.push(m),
      onConnectionChange: () => {},
    });
    cleanup.push(() => client.stop());
    client.start();

    await until(() => messages.length === 1);
    expect(messages[0]).toEqual({ type: "error", message: "real" });
  });
});
