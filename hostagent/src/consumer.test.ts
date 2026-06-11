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
// mutations and lets the test drive subscription updates.
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
      mutations.push({ name: getFunctionName(ref as any), args });
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingHostCommand[]) => {
    subscriber?.(commands);
  };
  return { client, mutations, push };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
