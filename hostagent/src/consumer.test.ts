import { expect, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import {
  type PendingHostCommand,
  selectNewCommands,
  startHostConsumer,
} from "./consumer";

function cmd(id: string, createdAt: number): PendingHostCommand {
  return {
    commandId: id,
    kind: "provision_vm",
    payload: '{"devboxId":"dev-1"}',
    createdAt,
  };
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

// Stub at the network boundary only: a duck-typed ConvexClient that records
// mutations and lets the test drive subscription updates. claim resolves true
// so the consumer proceeds to execute (the persisted claim race is exercised
// by the stateful fakeServer tests below).
function fakeClient() {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  let subscriber: ((commands: PendingHostCommand[]) => void) | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      _args: unknown,
      callback: (commands: PendingHostCommand[]) => void,
    ) => {
      subscriber = callback;
      return () => {};
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
      const name = getFunctionName(ref as any);
      mutations.push({ name, args });
      return name === "hosts:claim" ? true : undefined;
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingHostCommand[]) => {
    subscriber?.(commands);
  };
  return { client, mutations, push };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// A stateful fake of the Convex command queue: models the pending -> running
// -> acked lifecycle and only offers "pending" rows to subscribers, exactly
// like commands.pendingFor + claim + ack. Lets a test drive a consumer
// restart against shared server state.
function fakeServer(initial: PendingHostCommand[]) {
  type Row = {
    cmd: PendingHostCommand;
    status: "pending" | "running" | "acked";
  };
  const rows = new Map<string, Row>(
    initial.map((cmd) => [cmd.commandId, { cmd, status: "pending" }]),
  );
  const subscribers = new Set<(commands: PendingHostCommand[]) => void>();
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
        callback: (commands: PendingHostCommand[]) => void,
      ) => {
        subscribers.add(callback);
        callback(pending());
        return () => subscribers.delete(callback);
      },
      mutation: async (ref: unknown, args: Record<string, unknown>) => {
        // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
        const name = getFunctionName(ref as any);
        const id = args.commandId as string;
        if (name === "hosts:claim") {
          const row = rows.get(id);
          if (row !== undefined && row.status === "pending") {
            row.status = "running";
            notify();
            return true;
          }
          return false;
        }
        if (name === "hosts:ack") {
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

test("executes serially, acks even on failure, ignores re-delivery", async () => {
  const { client, mutations, push } = fakeClient();
  const executed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const stop = startHostConsumer({
    client,
    hostId: "host-1",
    secret: "s",
    execute: async (command) => {
      if (command.commandId === "a") {
        await gate; // holds the chain: "b" must wait
      }
      executed.push(command.commandId);
      if (command.commandId === "b") {
        throw new Error("provision exploded");
      }
    },
  });

  push([cmd("a", 1), cmd("b", 2)]);
  push([cmd("a", 1), cmd("b", 2)]); // re-delivered pending set
  await tick();
  expect(executed).toEqual([]); // "a" still gated, "b" queued behind it

  release();
  await tick();
  await tick();
  expect(executed).toEqual(["a", "b"]); // exactly once each, in order

  // Both acked despite "b" throwing; heartbeat fired on start.
  const acks = mutations.filter((m) => m.name === "hosts:ack");
  expect(acks.map((m) => m.args.commandId)).toEqual(["a", "b"]);
  expect(acks.every((m) => m.args.secret === "s")).toBe(true);
  expect(
    mutations.filter((m) => m.name === "hosts:heartbeat").length,
  ).toBeGreaterThanOrEqual(1);

  stop();
});

// The acceptance test for #52: a consumer that crashes between the side effect
// and the ack must not re-execute the command after restart. provision_vm is
// not idempotent (a replay double-allocates a VM), so this is the regression
// the claim lifecycle prevents.
test("a crash between side effect and ack does not replay across restart", async () => {
  const server = fakeServer([cmd("a", 1)]);
  const executed: string[] = [];

  // Process 1: claims + runs the side effect, then "crashes" before the ack
  // (modeled by blocking forever right after the side effect, then dropping the
  // consumer).
  let sideEffectRan!: () => void;
  const ran = new Promise<void>((resolve) => {
    sideEffectRan = resolve;
  });
  const stop1 = startHostConsumer({
    client: server.makeClient(),
    hostId: "host-1",
    secret: "s",
    execute: async (command) => {
      executed.push(command.commandId);
      sideEffectRan();
      await new Promise<void>(() => {}); // never resolves: the ack never fires
    },
  });
  await ran;
  expect(executed).toEqual(["a"]); // ran exactly once in process 1
  expect(server.statusOf("a")).toBe("running"); // claimed, never acked
  stop1(); // process 1 dies mid-flight

  // Process 2: a fresh consumer with an empty in-memory `seen` set. The command
  // is still "running" on the server, so pendingFor never re-offers it.
  const stop2 = startHostConsumer({
    client: server.makeClient(),
    hostId: "host-1",
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

// Belt-and-suspenders: even if two incarnations overlap (a graceful restart's
// old + new process both see the same pending command before either claims),
// only the claim winner runs the side effect.
test("overlapping incarnations: only the claim winner executes", async () => {
  const server = fakeServer([cmd("a", 1)]);
  const executed: string[] = [];
  const start = () =>
    startHostConsumer({
      client: server.makeClient(),
      hostId: "host-1",
      secret: "s",
      execute: async (command) => {
        executed.push(command.commandId);
      },
    });

  // Both subscribe before either's claim mutation resolves, so both enqueue a
  // claim for "a".
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
  let subscriber: ((commands: PendingHostCommand[]) => void) | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      _args: unknown,
      cb: (commands: PendingHostCommand[]) => void,
    ) => {
      subscriber = cb;
      return () => {};
    },
    mutation: async (ref: unknown, _args: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
      const name = getFunctionName(ref as any);
      if (name === "hosts:claim") {
        calls.claim++;
        if (remaining > 0) {
          remaining--;
          throw new Error("convex transient");
        }
        return claimResult;
      }
      if (name === "hosts:ack") {
        calls.ack++;
      }
      return undefined;
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingHostCommand[]) => subscriber?.(commands);
  return { client, calls, push };
}

const drain = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

test("a transient claim failure is retried in-band, then the command executes", async () => {
  const { client, calls, push } = flakyClaimClient(2); // fail twice, then win
  const executed: string[] = [];
  const stop = startHostConsumer({
    client,
    hostId: "host-1",
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

// #89: the host reports the golden its new ephemerals clone, so a golden-refresh
// can confirm the host picked up the new tag after the agent restart.
test("heartbeat reports the configured goldenImage", async () => {
  const { client, mutations } = fakeClient();
  const stop = startHostConsumer({
    client,
    hostId: "host-1",
    secret: "s",
    goldenImage: "golden-v5",
    execute: async () => {},
  });
  await tick();
  const hb = mutations.find((m) => m.name === "hosts:heartbeat");
  expect(hb?.args.goldenImage).toBe("golden-v5");
  stop();
});

test("heartbeat omits goldenImage when none is configured", async () => {
  const { client, mutations } = fakeClient();
  const stop = startHostConsumer({
    client,
    hostId: "host-1",
    secret: "s",
    execute: async () => {},
  });
  await tick();
  const hb = mutations.find((m) => m.name === "hosts:heartbeat");
  expect(hb).toBeDefined();
  expect("goldenImage" in (hb?.args ?? {})).toBe(false);
  stop();
});

test("a claim that never succeeds gives up without executing (no wedge, no run)", async () => {
  const { client, calls, push } = flakyClaimClient(99); // always rejects
  const executed: string[] = [];
  const stop = startHostConsumer({
    client,
    hostId: "host-1",
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
