import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
// Only hosts.ts is exercised directly; the mutation's scheduled follow-ups
// (placeQueuedEphemeralTasks, notify.devboxEvent) are never run by these
// tests, so their modules don't need to be listed.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./hosts.ts": () => import("./hosts"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "s3cret";

beforeEach(() => {
  // secretOk() reads these; allocateEphemeralSlot needs TAILNET_SUFFIX to mint
  // a gateway URL once a slot is free.
  process.env.DEVBOX_SHARED_SECRET = SECRET;
  process.env.TAILNET_SUFFIX = "ts.example.com";
});

afterEach(() => {
  delete process.env.DEVBOX_SHARED_SECRET;
  delete process.env.TAILNET_SUFFIX;
});

/** A host at its EULA cap of 2 VMs, both held by provisioning ephemeral rows —
 * the exact state a fresh provision_vm leaves behind before it has booted. */
async function seedFullHost(t: Tester): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: now,
    });
    for (const n of [1, 2]) {
      const taskId = `task-${n}`;
      const devboxId = `devbox-${n}`;
      await ctx.db.insert("tasks", {
        taskId,
        title: `Task ${n}`,
        prompt: "do the thing",
        status: "queued",
        placement: "ephemeral",
        devboxId,
        slackChannel: "C1",
        slackThreadTs: "100.0",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("devboxes", {
        devboxId,
        gatewayUrl: `http://${devboxId}.ts.example.com:8787`,
        status: "provisioning",
        taskId,
        hostId: "host-1",
        ephemeral: true,
        lastSeenAt: now,
      });
    }
  });
}

function devboxIds(t: Tester): Promise<string[]> {
  return t.run(async (ctx) =>
    (await ctx.db.query("devboxes").collect()).map((d) => d.devboxId).sort(),
  );
}

function getTask(t: Tester, taskId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

test("a failed provision drops the leaked row, fails the task, and reclaims the slot", async () => {
  const t = newT();
  await seedFullHost(t);

  // The leak condition: both EULA slots are held by provisioning rows, so the
  // host accepts no new work — allocation returns null.
  const beforeAlloc = await t.mutation(internal.hosts.allocateEphemeral, {
    taskId: "task-new",
  });
  expect(beforeAlloc).toBeNull();

  await t.mutation(api.hosts.provisionVmFailed, {
    devboxId: "devbox-1",
    summary: "Provisioning failed: dev never got an IP",
    secret: SECRET,
  });

  // 1. No orphaned devbox row remains.
  expect(await devboxIds(t)).toEqual(["devbox-2"]);

  // 2. The task is terminally failed (visible in Slack/dashboard), with a
  // failure event and a finishedAt stamp — not an eternal silent stall.
  const failed = await getTask(t, "task-1");
  expect(failed?.status).toBe("failed");
  expect(typeof failed?.finishedAt).toBe("number");
  const events = await t.run(async (ctx) =>
    ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", "task-1"))
      .collect(),
  );
  expect(events.map((e) => e.type)).toEqual(["failed"]);
  expect(events[0]?.summary).toBe("Provisioning failed: dev never got an IP");

  // The sibling task is untouched.
  expect((await getTask(t, "task-2"))?.status).toBe("queued");

  // 3. The slot is reclaimed: the host now has spare capacity again.
  const afterAlloc = await t.mutation(internal.hosts.allocateEphemeral, {
    taskId: "task-new",
  });
  expect(afterAlloc?.hostId).toBe("host-1");
});

test("provisionVmFailed never regresses a task that already reached terminal", async () => {
  const t = newT();
  await seedFullHost(t);
  // The user stopped task-1 (e.g. cancelled) before the provision failed.
  await t.run(async (ctx) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", "task-1"))
      .unique();
    await ctx.db.patch(task!._id as Id<"tasks">, { status: "stopped" });
  });

  await t.mutation(api.hosts.provisionVmFailed, {
    devboxId: "devbox-1",
    summary: "Provisioning failed: boom",
    secret: SECRET,
  });

  // The slot is still freed, but the terminal status is preserved.
  expect(await devboxIds(t)).toEqual(["devbox-2"]);
  expect((await getTask(t, "task-1"))?.status).toBe("stopped");
});

test("provisionVmFailed is a no-op on a wrong secret or a missing row", async () => {
  const t = newT();
  await seedFullHost(t);

  await t.mutation(api.hosts.provisionVmFailed, {
    devboxId: "devbox-1",
    summary: "nope",
    secret: "wrong",
  });
  // Wrong secret: nothing freed, nothing failed.
  expect(await devboxIds(t)).toEqual(["devbox-1", "devbox-2"]);
  expect((await getTask(t, "task-1"))?.status).toBe("queued");

  // Unknown devbox: idempotent no-op, no throw.
  await t.mutation(api.hosts.provisionVmFailed, {
    devboxId: "devbox-gone",
    summary: "nope",
    secret: SECRET,
  });
  expect(await devboxIds(t)).toEqual(["devbox-1", "devbox-2"]);
});
