import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./commands.ts": () => import("./commands"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "s3cret";

beforeEach(() => {
  process.env.DEVBOX_SHARED_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.DEVBOX_SHARED_SECRET;
});

async function seedPending(t: Tester, commandId: string): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("commands", {
      commandId,
      devboxId: "devbox-1",
      kind: "start",
      payload: JSON.stringify({ taskId: "task-1", prompt: "go" }),
      status: "pending",
      createdAt: Date.now(),
    });
  });
}

function statusOf(t: Tester, commandId: string): Promise<string | undefined> {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("commands")
      .withIndex("by_command_id", (q) => q.eq("commandId", commandId))
      .unique();
    return row?.status;
  });
}

// The headline guarantee: the claim transition is the persisted idempotency
// key. A consumer that lost its in-memory `seen` set (crash/restart) re-runs
// claim; the second claim must lose, so the side effect never replays.
test("claim wins once (pending -> running), then loses forever", async () => {
  const t = newT();
  await seedPending(t, "cmd-1");

  const first = await t.mutation(api.commands.claim, {
    commandId: "cmd-1",
    secret: SECRET,
  });
  expect(first).toBe(true);
  expect(await statusOf(t, "cmd-1")).toBe("running");
  // claimedAt is stamped so a future sweep can spot wedged "running" rows.
  const claimedAt = await t.run(async (ctx) => {
    const row = await ctx.db
      .query("commands")
      .withIndex("by_command_id", (q) => q.eq("commandId", "cmd-1"))
      .unique();
    return row?.claimedAt;
  });
  expect(typeof claimedAt).toBe("number");

  // Restart with an empty `seen` set: the same command is re-offered, but the
  // claim now loses — no replay.
  const second = await t.mutation(api.commands.claim, {
    commandId: "cmd-1",
    secret: SECRET,
  });
  expect(second).toBe(false);
  expect(await statusOf(t, "cmd-1")).toBe("running");
});

test("ack finalizes a running command (running -> acked)", async () => {
  const t = newT();
  await seedPending(t, "cmd-1");
  await t.mutation(api.commands.claim, { commandId: "cmd-1", secret: SECRET });

  await t.mutation(api.commands.ack, { commandId: "cmd-1", secret: SECRET });
  expect(await statusOf(t, "cmd-1")).toBe("acked");

  // An acked command can never be re-claimed.
  expect(
    await t.mutation(api.commands.claim, {
      commandId: "cmd-1",
      secret: SECRET,
    }),
  ).toBe(false);
});

test("pendingFor stops offering a claimed command (no redelivery)", async () => {
  const t = newT();
  await seedPending(t, "cmd-1");

  const before = await t.query(api.commands.pendingFor, {
    devboxId: "devbox-1",
    secret: SECRET,
  });
  expect(before.map((c) => c.commandId)).toEqual(["cmd-1"]);

  await t.mutation(api.commands.claim, { commandId: "cmd-1", secret: SECRET });

  const after = await t.query(api.commands.pendingFor, {
    devboxId: "devbox-1",
    secret: SECRET,
  });
  expect(after).toEqual([]);
});

test("claim and ack no-op on a wrong secret", async () => {
  const t = newT();
  await seedPending(t, "cmd-1");

  expect(
    await t.mutation(api.commands.claim, { commandId: "cmd-1", secret: "no" }),
  ).toBe(false);
  expect(await statusOf(t, "cmd-1")).toBe("pending");

  // A real claim, then a wrong-secret ack must not finalize it.
  await t.mutation(api.commands.claim, { commandId: "cmd-1", secret: SECRET });
  await t.mutation(api.commands.ack, { commandId: "cmd-1", secret: "no" });
  expect(await statusOf(t, "cmd-1")).toBe("running");
});
