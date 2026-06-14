import { expect, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import {
  type PendingCommand,
  selectNewCommands,
  startCommandConsumer,
} from "./commands";

function cmd(id: string, createdAt: number): PendingCommand {
  return { commandId: id, kind: "start", payload: "{}", createdAt };
}

test("returns unseen commands in creation order and marks them seen", () => {
  const seen = new Set<string>();
  const out = selectNewCommands([cmd("b", 2), cmd("a", 1)], seen);
  expect(out.map((c) => c.commandId)).toEqual(["a", "b"]);
  expect(seen.has("a")).toBe(true);
  expect(seen.has("b")).toBe(true);
});

test("re-delivered pending sets do not double-execute", () => {
  const seen = new Set<string>();
  selectNewCommands([cmd("a", 1)], seen);
  // Subscription fires again with the same still-pending command plus a new one.
  const out = selectNewCommands([cmd("a", 1), cmd("c", 3)], seen);
  expect(out.map((c) => c.commandId)).toEqual(["c"]);
});

test("empty update yields nothing", () => {
  const seen = new Set<string>(["a"]);
  expect(selectNewCommands([], seen)).toEqual([]);
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A stateful fake of the Convex command queue: models the pending -> running
// -> acked lifecycle and only offers "pending" rows to subscribers, exactly
// like commands.pendingFor + claim + ack. Lets a test drive a gateway restart
// against shared server state.
function fakeServer(initial: PendingCommand[]) {
  type Row = { cmd: PendingCommand; status: "pending" | "running" | "acked" };
  const rows = new Map<string, Row>(
    initial.map((c) => [c.commandId, { cmd: c, status: "pending" }]),
  );
  const subscribers = new Set<(commands: PendingCommand[]) => void>();
  const pending = () =>
    [...rows.values()]
      .filter((r) => r.status === "pending")
      .map((r) => r.cmd)
      .sort((a, b) => a.createdAt - b.createdAt);
  const notify = () => {
    for (const cb of subscribers) cb(pending());
  };
  const makeClient = () =>
    ({
      onUpdate: (
        _ref: unknown,
        _args: unknown,
        callback: (commands: PendingCommand[]) => void,
      ) => {
        subscribers.add(callback);
        callback(pending());
        return () => subscribers.delete(callback);
      },
      mutation: async (ref: unknown, args: Record<string, unknown>) => {
        // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
        const name = getFunctionName(ref as any);
        const id = args.commandId as string;
        if (name === "commands:claim") {
          const row = rows.get(id);
          if (row !== undefined && row.status === "pending") {
            row.status = "running";
            notify();
            return true;
          }
          return false;
        }
        if (name === "commands:ack") {
          const row = rows.get(id);
          if (row !== undefined && row.status !== "acked") {
            row.status = "acked";
            notify();
          }
        }
        return undefined;
      },
      close: async () => {},
    }) as unknown as ConvexClient;
  return { makeClient, statusOf: (id: string) => rows.get(id)?.status };
}

// The acceptance test for #52: a gateway that crashes between the side effect
// and the ack must not re-execute the command after restart. A replayed
// `start` could evict a live session — the claim lifecycle prevents it.
test("a crash between side effect and ack does not replay across restart", async () => {
  const server = fakeServer([cmd("a", 1)]);
  const executed: string[] = [];

  let sideEffectRan!: () => void;
  const ran = new Promise<void>((resolve) => {
    sideEffectRan = resolve;
  });
  const stop1 = startCommandConsumer({
    client: server.makeClient(),
    devboxId: "devbox-1",
    secret: "s",
    execute: async (command) => {
      executed.push(command.commandId);
      sideEffectRan();
      await new Promise<void>(() => {}); // never resolves: the ack never fires
    },
  });
  await ran;
  expect(executed).toEqual(["a"]); // ran exactly once in the first process
  expect(server.statusOf("a")).toBe("running"); // claimed, never acked
  stop1(); // gateway dies mid-flight

  // Fresh gateway, empty in-memory `seen`. The command is still "running", so
  // pendingFor never re-offers it.
  const stop2 = startCommandConsumer({
    client: server.makeClient(),
    devboxId: "devbox-1",
    secret: "s",
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });
  await tick();
  await tick();
  expect(executed).toEqual(["a"]); // exactly once across the restart — no replay
  stop2();
});

test("overlapping incarnations: only the claim winner executes", async () => {
  const server = fakeServer([cmd("a", 1)]);
  const executed: string[] = [];
  const start = () =>
    startCommandConsumer({
      client: server.makeClient(),
      devboxId: "devbox-1",
      secret: "s",
      execute: async (command) => {
        executed.push(command.commandId);
      },
    });

  const stopA = start();
  const stopB = start();
  await tick();
  await tick();

  expect(executed).toEqual(["a"]); // claimed once, executed once
  expect(server.statusOf("a")).toBe("acked");
  stopA();
  stopB();
});

// Fake client whose claim mutation rejects a configurable number of times
// before succeeding, to exercise the in-band retry path (a transient claim
// failure leaves the row pending and the subscription won't necessarily
// re-fire, so the consumer must retry the claim itself).
function flakyClaimClient(failClaims: number, claimResult = true) {
  let remaining = failClaims;
  const calls = { claim: 0, ack: 0 };
  let subscriber: ((commands: PendingCommand[]) => void) | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      _args: unknown,
      cb: (commands: PendingCommand[]) => void,
    ) => {
      subscriber = cb;
      return () => {};
    },
    mutation: async (ref: unknown, _args: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
      const name = getFunctionName(ref as any);
      if (name === "commands:claim") {
        calls.claim++;
        if (remaining > 0) {
          remaining--;
          throw new Error("convex transient");
        }
        return claimResult;
      }
      if (name === "commands:ack") {
        calls.ack++;
      }
      return undefined;
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingCommand[]) => subscriber?.(commands);
  return { client, calls, push };
}

const drain = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

test("a transient claim failure is retried in-band, then the command executes", async () => {
  const { client, calls, push } = flakyClaimClient(2); // fail twice, then win
  const executed: string[] = [];
  const stop = startCommandConsumer({
    client,
    devboxId: "devbox-1",
    secret: "s",
    claimRetryDelaysMs: [0, 0, 0],
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });

  push([cmd("a", 1)]);
  await drain();

  expect(calls.claim).toBe(3); // 2 rejections + 1 success
  expect(executed).toEqual(["a"]); // ran once the claim finally landed
  expect(calls.ack).toBe(1);
  stop();
});

test("a claim that never succeeds gives up without executing (no wedge, no run)", async () => {
  const { client, calls, push } = flakyClaimClient(99); // always rejects
  const executed: string[] = [];
  const stop = startCommandConsumer({
    client,
    devboxId: "devbox-1",
    secret: "s",
    claimRetryDelaysMs: [0, 0], // initial try + 2 retries = 3 attempts, then give up
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });

  push([cmd("a", 1)]);
  await drain();

  expect(calls.claim).toBe(3); // bounded: never retries forever
  expect(executed).toEqual([]); // the side effect never runs on an unresolved claim
  expect(calls.ack).toBe(0);
  stop();
});
