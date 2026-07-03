import { expect, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { type PendingCommand, startCommandConsumer } from "./commands";

// The claim/ack/retry semantics live in shared/commandConsumer.ts and are
// tested there; this covers only the gateway-specific wiring — the commands:*
// function names and the devboxId args.

// Stub at the network boundary only: records mutations and answers claims
// with true so the consumer proceeds to execute.
function fakeClient() {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  let subscriber: ((commands: PendingCommand[]) => void) | undefined;
  let subscriptionArgs: Record<string, unknown> | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      args: Record<string, unknown>,
      callback: (commands: PendingCommand[]) => void,
    ) => {
      subscriptionArgs = args;
      subscriber = callback;
      return () => {};
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
      const name = getFunctionName(ref as any);
      mutations.push({ name, args });
      return name === "commands:claim" ? true : undefined;
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingCommand[]) => {
    subscriber?.(commands);
  };
  return { client, mutations, push, subscriptionArgs: () => subscriptionArgs };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("subscribes, claims, and acks through the commands:* functions for this devbox", async () => {
  const { client, mutations, push, subscriptionArgs } = fakeClient();
  const executed: string[] = [];
  const stop = startCommandConsumer({
    client,
    devboxId: "devbox-1",
    secret: "s",
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });

  push([{ commandId: "a", kind: "start", payload: "{}", createdAt: 1 }]);
  await tick();
  await tick();

  expect(executed).toEqual(["a"]);
  expect(subscriptionArgs()).toEqual({ devboxId: "devbox-1", secret: "s" });
  const claim = mutations.find((m) => m.name === "commands:claim");
  expect(claim?.args).toEqual({ commandId: "a", secret: "s" });
  const ack = mutations.find((m) => m.name === "commands:ack");
  expect(ack?.args).toEqual({ commandId: "a", secret: "s" });
  const heartbeat = mutations.find((m) => m.name === "commands:heartbeat");
  expect(heartbeat?.args).toEqual({ devboxId: "devbox-1", secret: "s" });
  stop();
});
