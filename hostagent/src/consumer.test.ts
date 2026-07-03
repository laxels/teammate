import { expect, spyOn, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { type PendingHostCommand, startHostConsumer } from "./consumer";

// The claim/ack/retry semantics live in shared/commandConsumer.ts and are
// tested there; this covers only the hostagent-specific wiring — the hosts:*
// function names, the heartbeat payload (goldenImage/canProvisionHosts), and
// the first-heartbeat log that adopt-host.sh tails.

function cmd(id: string, createdAt: number): PendingHostCommand {
  return {
    commandId: id,
    kind: "provision_vm",
    payload: '{"devboxId":"dev-1"}',
    createdAt,
  };
}

// Stub at the network boundary only: records mutations and answers claims
// with true so the consumer proceeds to execute.
function fakeClient() {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  let subscriber: ((commands: PendingHostCommand[]) => void) | undefined;
  let subscriptionArgs: Record<string, unknown> | undefined;
  const client = {
    onUpdate: (
      _ref: unknown,
      args: Record<string, unknown>,
      callback: (commands: PendingHostCommand[]) => void,
    ) => {
      subscriptionArgs = args;
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
  return { client, mutations, push, subscriptionArgs: () => subscriptionArgs };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("subscribes, claims, and acks through the hosts:* functions for this host", async () => {
  const { client, mutations, push, subscriptionArgs } = fakeClient();
  const executed: string[] = [];
  const stop = startHostConsumer({
    client,
    hostId: "host-1",
    secret: "s",
    execute: async (command) => {
      executed.push(command.commandId);
    },
  });

  push([cmd("a", 1)]);
  await tick();
  await tick();

  expect(executed).toEqual(["a"]);
  expect(subscriptionArgs()).toEqual({ hostId: "host-1", secret: "s" });
  const claim = mutations.find((m) => m.name === "hosts:claim");
  expect(claim?.args).toEqual({ commandId: "a", secret: "s" });
  const ack = mutations.find((m) => m.name === "hosts:ack");
  expect(ack?.args).toEqual({ commandId: "a", secret: "s" });
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
  expect(hb?.args).toEqual({
    hostId: "host-1",
    canProvisionHosts: false,
    goldenImage: "golden-v5",
    secret: "s",
  });
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

// adopt-host.sh tails the agent log for the first-heartbeat line to learn the
// host self-registered in Convex; later heartbeats must stay quiet.
test("logs the first successful heartbeat only", async () => {
  const { client, mutations } = fakeClient();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const stop = startHostConsumer({
      client,
      hostId: "host-1",
      secret: "s",
      heartbeatIntervalMs: 1,
      execute: async () => {},
    });
    // Wait for at least a second heartbeat so "only once" is meaningful.
    while (mutations.filter((m) => m.name === "hosts:heartbeat").length < 2) {
      await tick();
    }
    await tick();
    stop();
    const firstHeartbeatLogs = log.mock.calls.filter(([line]) =>
      String(line).includes("first heartbeat acknowledged for host-1"),
    );
    expect(firstHeartbeatLogs.length).toBe(1);
  } finally {
    log.mockRestore();
  }
});
