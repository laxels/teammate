import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
// provisionVmFailed schedules placeQueuedEphemeralTasks (hosts) and
// notify.devboxEvent at 0ms — both must be resolvable, or the scheduler logs
// "Could not find module" while the suite still passes. notify.devboxEvent
// no-ops without SLACK_BOT_TOKEN (unset here), so it drains cleanly.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./hosts.ts": () => import("./hosts"),
  "./notify.ts": () => import("./notify"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

/** Runs the 0ms scheduled follow-ups (placeQueuedEphemeralTasks,
 * notify.devboxEvent) so they execute inside the test and any error surfaces,
 * instead of erroring in the background after the suite goes green. */
async function drainScheduled(t: Tester): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

const SECRET = "s3cret";
let savedSlackToken: string | undefined;

beforeEach(() => {
  // secretOk() reads these; allocateEphemeralSlot needs TAILNET_SUFFIX to mint
  // a gateway URL once a slot is free.
  process.env.DEVBOX_SHARED_SECRET = SECRET;
  process.env.TAILNET_SUFFIX = "ts.example.com";
  // bun auto-loads .env.local, which carries a real SLACK_BOT_TOKEN. Unset it
  // so the drained notify.devboxEvent takes its no-token early return instead
  // of firing a real Slack API call from the test.
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  delete process.env.DEVBOX_SHARED_SECRET;
  delete process.env.TAILNET_SUFFIX;
  if (savedSlackToken !== undefined) {
    process.env.SLACK_BOT_TOKEN = savedSlackToken;
  }
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
      // dispatchTaskToSlot enqueues the gateway `start` command before the VM
      // exists; a failed provision must not strand it for the queue prune.
      await ctx.db.insert("commands", {
        commandId: `cmd-${n}`,
        devboxId,
        kind: "start",
        payload: "{}",
        status: "pending",
        createdAt: now,
      });
    }
  });
}

function commandDevboxes(t: Tester): Promise<string[]> {
  return t.run(async (ctx) =>
    (await ctx.db.query("commands").collect()).map((c) => c.devboxId).sort(),
  );
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
  await drainScheduled(t);

  // 1. No orphaned devbox row remains, and the dead task's pre-enqueued gateway
  // command is purged (only the sibling's survives) so a reused devboxId can't
  // pick it up.
  expect(await devboxIds(t)).toEqual(["devbox-2"]);
  expect(await commandDevboxes(t)).toEqual(["devbox-2"]);

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
  await drainScheduled(t);

  // The slot is still freed, but the terminal status is preserved.
  expect(await devboxIds(t)).toEqual(["devbox-2"]);
  expect((await getTask(t, "task-1"))?.status).toBe("stopped");
});

test("a provisioner restart mid-bootstrap frees the orphaned lock and a fresh bootstrap starts", async () => {
  const t = newT();
  // Recent enough that the orphan still counts as "in-flight" by the 90-min
  // stale window — i.e. without reconciliation it would hold the lock.
  const orphanRequestedAt = Date.now() - 60_000;
  await t.run(async (ctx) => {
    const now = Date.now();
    // The provisioner host, at its EULA cap of 2 VMs (so it can't place VMs but
    // still holds fleet credentials and bootstraps new hosts).
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: now,
      canProvisionHosts: true,
    });
    for (const n of [1, 2]) {
      await ctx.db.insert("devboxes", {
        devboxId: `devbox-${n}`,
        gatewayUrl: `http://devbox-${n}.ts.example.com:8787`,
        status: "busy",
        taskId: `busy-${n}`,
        hostId: "host-1",
        ephemeral: true,
        lastSeenAt: now,
      });
    }
    // The bootstrap host-1 kicked off, now orphaned by host-1's restart: a
    // "provisioning" row with no live bootstrap behind it.
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-2",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: orphanRequestedAt,
      provisionRequestedAt: orphanRequestedAt,
      provisionedBy: "host-1",
    });
    // A task stuck waiting on the stalled scale-up.
    await ctx.db.insert("tasks", {
      taskId: "task-q",
      title: "Queued task",
      prompt: "do the thing",
      status: "queued",
      placement: "ephemeral",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
    });
  });

  const provisioningRows = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("hosts").collect()).filter(
        (h) => h.status === "provisioning",
      ),
    );

  // Lock held: with the orphan in flight, a placement attempt does NOT request
  // a new bootstrap.
  await t.mutation(internal.hosts.placeQueuedEphemeralTasks, {});
  expect((await provisioningRows()).map((h) => h.provisionRequestedAt)).toEqual(
    [orphanRequestedAt],
  );

  // The restarted provisioner reconciles: fail the orphan it left dangling.
  const result = await t.mutation(api.hosts.failOrphanedProvisions, {
    provisionerHostId: "host-1",
    secret: SECRET,
  });
  expect(result.failed).toEqual(["ultraclaude-host-2"]);
  await drainScheduled(t);

  // A provision_failed event was recorded for the orphan...
  const events = await t.run(async (ctx) =>
    ctx.db
      .query("hostEvents")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .collect(),
  );
  expect(events.some((e) => e.type === "provision_failed")).toBe(true);

  // ...and the freed lock let placeQueuedEphemeralTasks request a FRESH
  // bootstrap (new provisioning row with a newer timestamp + provision_host
  // command to the provisioner) — well under the 90-min stale window.
  const after = await provisioningRows();
  expect(after).toHaveLength(1);
  expect(after[0]?.provisionRequestedAt ?? 0).toBeGreaterThan(
    orphanRequestedAt,
  );
  const hostCommands = await t.run(async (ctx) =>
    ctx.db.query("hostCommands").collect(),
  );
  expect(
    hostCommands.some(
      (c) => c.kind === "provision_host" && c.hostId === "host-1",
    ),
  ).toBe(true);
});

test("a stale-heartbeat provisioner still requests a replacement bootstrap on restart", async () => {
  const t = newT();
  const orphanRequestedAt = Date.now() - 60_000;
  // The agent was down longer than the freshness window (a crash-loop / slow
  // deploy / reboot), so its row is stale when it reconciles on restart.
  const staleSeenAt = Date.now() - 3 * 60_000;
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: staleSeenAt,
      canProvisionHosts: true,
    });
    for (const n of [1, 2]) {
      await ctx.db.insert("devboxes", {
        devboxId: `devbox-${n}`,
        gatewayUrl: `http://devbox-${n}.ts.example.com:8787`,
        status: "busy",
        taskId: `busy-${n}`,
        hostId: "host-1",
        ephemeral: true,
        lastSeenAt: now,
      });
    }
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-2",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: orphanRequestedAt,
      provisionRequestedAt: orphanRequestedAt,
      provisionedBy: "host-1",
    });
    await ctx.db.insert("tasks", {
      taskId: "task-q",
      title: "Queued task",
      prompt: "do the thing",
      status: "queued",
      placement: "ephemeral",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
    });
  });

  await t.mutation(api.hosts.failOrphanedProvisions, {
    provisionerHostId: "host-1",
    secret: SECRET,
  });
  await drainScheduled(t);

  // The reconcile refreshed the provisioner's lastSeenAt (it was the one
  // calling), so the re-drain picked it as a fresh provisioner and requested a
  // replacement bootstrap — rather than freeing the lock and stalling.
  const provisioning = await t.run(async (ctx) =>
    (await ctx.db.query("hosts").collect()).filter(
      (h) => h.status === "provisioning",
    ),
  );
  expect(provisioning).toHaveLength(1);
  expect(provisioning[0]?.provisionRequestedAt ?? 0).toBeGreaterThan(
    orphanRequestedAt,
  );
  const hostCommands = await t.run(async (ctx) =>
    ctx.db.query("hostCommands").collect(),
  );
  expect(
    hostCommands.some(
      (c) => c.kind === "provision_host" && c.hostId === "host-1",
    ),
  ).toBe(true);
});

test("failOrphanedProvisions only frees rows this provisioner owns", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: now,
      canProvisionHosts: true,
    });
    // A bootstrap owned by a DIFFERENT provisioner: host-1's restart must not
    // abandon another live provisioner's in-flight bootstrap.
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-9",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: now,
      provisionRequestedAt: now,
      provisionedBy: "host-other",
    });
  });

  // Nothing of host-1's to free, and the other provisioner's row is untouched.
  const result = await t.mutation(api.hosts.failOrphanedProvisions, {
    provisionerHostId: "host-1",
    secret: SECRET,
  });
  expect(result.failed).toEqual([]);
  const other = await t.run(async (ctx) =>
    ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-9"))
      .unique(),
  );
  expect(other?.status).toBe("provisioning");
});

test("failOrphanedProvisions is a no-op on a wrong secret", async () => {
  const t = newT();
  const requestedAt = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-2",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: requestedAt,
      provisionRequestedAt: requestedAt,
      provisionedBy: "host-1",
    });
  });
  const result = await t.mutation(api.hosts.failOrphanedProvisions, {
    provisionerHostId: "host-1",
    secret: "wrong",
  });
  expect(result.failed).toEqual([]);
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .unique(),
  );
  expect(row?.status).toBe("provisioning");
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
