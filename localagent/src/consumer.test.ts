import { expect, spyOn, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { type PendingLocalCommand, startLocalConsumer } from "./consumer";

// The claim/ack/retry semantics live in shared/commandConsumer.ts and are
// tested there; this covers only the localagent-specific wiring — the local:*
// function names, the self-registering machine-identity heartbeat, and the
// first-heartbeat log that scripts/setup-localagent.sh tails.

function cmd(id: string, createdAt: number): PendingLocalCommand {
  return {
    commandId: id,
    kind: "start",
    payload: '{"taskId":"task-1"}',
    createdAt,
  };
}

// Stub at the network boundary only: records mutations and answers claims
// with true so the consumer proceeds to execute.
function fakeClient() {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  let subscriber: ((commands: PendingLocalCommand[]) => void) | undefined;
  let subscriptionArgs: Record<string, unknown> | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      args: Record<string, unknown>,
      callback: (commands: PendingLocalCommand[]) => void,
    ) => {
      subscriptionArgs = args;
      subscriber = callback;
      return () => {};
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      // biome-ignore lint/suspicious/noExplicitAny: duck-typed test stub
      const name = getFunctionName(ref as any);
      mutations.push({ name, args });
      return name === "local:claim" ? true : undefined;
    },
    close: async () => {},
  } as unknown as ConvexClient;
  const push = (commands: PendingLocalCommand[]) => {
    subscriber?.(commands);
  };
  return { client, mutations, push, subscriptionArgs: () => subscriptionArgs };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("subscribes, claims, and acks through the local:* functions for this machine", async () => {
  const { client, mutations, push, subscriptionArgs } = fakeClient();
  const executed: string[] = [];
  const stop = startLocalConsumer({
    client,
    machineId: "local-mac",
    secret: "s3cret",
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });

  push([cmd("a", 1)]);
  await tick();
  await tick();

  expect(executed).toEqual(["a"]);
  expect(subscriptionArgs()).toEqual({
    machineId: "local-mac",
    secret: "s3cret",
  });
  const claim = mutations.find((m) => m.name === "local:claim");
  expect(claim?.args).toEqual({ commandId: "a", secret: "s3cret" });
  const ack = mutations.find((m) => m.name === "local:ack");
  expect(ack?.args).toEqual({ commandId: "a", secret: "s3cret" });
  stop();
});

// The heartbeat is what self-registers the localMachines row, so it must
// carry the machine's Slack-facing identity when configured.
test("heartbeat reports the machine identity with its optional labels", async () => {
  const { client, mutations } = fakeClient();
  const stop = startLocalConsumer({
    client,
    machineId: "local-mac",
    secret: "s3cret",
    displayName: "Axel's MBP",
    ownerSlackUser: "U0AXEL",
    execute: async () => {},
  });
  await tick();
  const hb = mutations.find((m) => m.name === "local:heartbeat");
  expect(hb?.args).toEqual({
    machineId: "local-mac",
    displayName: "Axel's MBP",
    ownerSlackUser: "U0AXEL",
    secret: "s3cret",
  });
  stop();
});

test("heartbeat omits displayName/ownerSlackUser when unset", async () => {
  const { client, mutations } = fakeClient();
  const stop = startLocalConsumer({
    client,
    machineId: "local-mac",
    secret: "s3cret",
    execute: async () => {},
  });
  await tick();
  const hb = mutations.find((m) => m.name === "local:heartbeat");
  expect(hb?.args).toEqual({ machineId: "local-mac", secret: "s3cret" });
  stop();
});

// scripts/setup-localagent.sh tails ~/localagent.log for this exact line as
// its installation success gate; later heartbeats must stay quiet.
test("logs the first successful heartbeat only", async () => {
  const { client, mutations } = fakeClient();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const stop = startLocalConsumer({
      client,
      machineId: "local-mac",
      secret: "s3cret",
      heartbeatIntervalMs: 1,
      execute: async () => {},
    });
    // Wait for at least a second heartbeat so "only once" is meaningful.
    while (mutations.filter((m) => m.name === "local:heartbeat").length < 2) {
      await tick();
    }
    await tick();
    stop();
    const firstHeartbeatLogs = log.mock.calls.filter(([line]) =>
      String(line).includes("first heartbeat acknowledged for local-mac"),
    );
    expect(firstHeartbeatLogs.length).toBe(1);
  } finally {
    log.mockRestore();
  }
});
