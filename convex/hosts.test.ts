import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { TaskEffort } from "../shared/protocol";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
// provisionVmFailed schedules placeQueuedEphemeralTasks (hosts) and
// notify.devboxEvent at 0ms — both must be resolvable, or the scheduler logs
// "Could not find module" while the suite still passes. notify.devboxEvent
// no-ops without SLACK_BOT_TOKEN (deleted in beforeEach), so it drains cleanly.
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
  // bun loads the repo's `.env` (which carries a real SLACK_BOT_TOKEN) into the
  // test process, and a token can also be exported into the shell. Delete it
  // here — in-process, so the guard holds regardless of cwd — so the drained
  // notify.devboxEvent takes its no-token early return instead of firing a real
  // Slack API call.
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
    if (!task) throw new Error("seedFullHost should have created task-1");
    await ctx.db.patch(task._id, { status: "stopped" });
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

function provisioningHosts(t: Tester) {
  return t.run(async (ctx) =>
    (await ctx.db.query("hosts").collect()).filter(
      (h) => h.status === "provisioning",
    ),
  );
}

function allHostCommands(t: Tester) {
  return t.run(async (ctx) => ctx.db.query("hostCommands").collect());
}

async function seedQueuedTask(
  t: Tester,
  taskId: string,
  effort?: TaskEffort,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: "Queued task",
      prompt: "do the thing",
      status: "queued",
      placement: "ephemeral",
      slackChannel: "C1",
      ...(effort === undefined ? {} : { effort }),
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** The gateway `start` commands enqueued for devboxes (the outbound control
 * plane the freshly booted gateway drains), with their payloads parsed. */
function startCommands(t: Tester) {
  return t.run(async (ctx) =>
    (await ctx.db.query("commands").collect())
      .filter((c) => c.kind === "start")
      .map((c) => JSON.parse(c.payload) as Record<string, unknown>),
  );
}

// #87: on-demand autoscale on task spillover is gated off. An unplaceable task
// must simply stay queued — no "provisioning" row pre-created, no host command
// enqueued. (Proactive growth moves to the #88 background monitor.)
test("an unplaceable task stays queued without auto-provisioning", async () => {
  const t = newT();
  await seedFullHost(t); // host-1 at its 2-VM cap
  await seedQueuedTask(t, "task-new");

  const result = await t.mutation(internal.hosts.placeEphemeralTask, {
    taskId: "task-new",
  });
  expect(result.placed).toBe(false);
  expect(result).toMatchObject({
    placed: false,
    scaling: { kind: "autoscale_disabled" },
  });
  // The trigger is gated: nothing was provisioned and nothing was enqueued.
  expect(await provisioningHosts(t)).toEqual([]);
  expect(await allHostCommands(t)).toEqual([]);
  expect((await getTask(t, "task-new"))?.status).toBe("queued");
});

test("placeQueuedEphemeralTasks leaves a task queued when full, enqueuing nothing", async () => {
  const t = newT();
  await seedFullHost(t);
  await seedQueuedTask(t, "task-new");

  await t.mutation(internal.hosts.placeQueuedEphemeralTasks, {});

  expect((await getTask(t, "task-new"))?.devboxId).toBeUndefined();
  expect(await provisioningHosts(t)).toEqual([]);
  expect(await allHostCommands(t)).toEqual([]);
});

test("placeQueuedEphemeralTasks drains a queued task into a free slot", async () => {
  const t = newT();
  // An active host with both slots free.
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
    });
  });
  await seedQueuedTask(t, "task-new");

  await t.mutation(internal.hosts.placeQueuedEphemeralTasks, {});

  // The task got a devbox, and the slot's host agent got a provision_vm command.
  expect((await getTask(t, "task-new"))?.devboxId).toBeDefined();
  const commands = await allHostCommands(t);
  expect(commands.map((c) => c.kind)).toEqual(["provision_vm"]);
});

// #91: a task's persisted effort rides the start command built at placement
// (dispatchTaskToSlot reads task.effort), since the start command is enqueued
// long after start_task returns. Absent effort leaves the field off the wire so
// the gateway applies its xhigh default.
test("placement threads a task's effort into the gateway start command (#91)", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
    });
  });
  await seedQueuedTask(t, "task-low", "low");
  await seedQueuedTask(t, "task-default");

  await t.mutation(internal.hosts.placeQueuedEphemeralTasks, {});

  const starts = await startCommands(t);
  const low = starts.find((p) => p.taskId === "task-low");
  const dflt = starts.find((p) => p.taskId === "task-default");
  expect(low?.effort).toBe("low");
  expect(dflt).toBeDefined();
  expect("effort" in (dflt ?? {})).toBe(false);
});

// #87 keeps the Convex decision/serialization machinery for the #88 monitor.
// requestHostProvision pre-creates a serialized "provisioning" row but — since
// GitHub Actions is the doer now — enqueues no host-agent command.
test("requestHostProvision reserves a serialized provisioning slot, no command", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
      canProvisionHosts: true,
    });
  });

  const first = await t.mutation(internal.hosts.requestHostProvision, {});
  expect(first.kind).toBe("provisioning_started");
  expect(await provisioningHosts(t)).toHaveLength(1);
  // GH Actions is the doer — nothing is enqueued to a host agent.
  expect(await allHostCommands(t)).toEqual([]);

  // Serialized: a second request rides the in-flight one.
  const second = await t.mutation(internal.hosts.requestHostProvision, {});
  expect(second.kind).toBe("already_provisioning");
  expect(await provisioningHosts(t)).toHaveLength(1);
});

test("requestHostProvision returns no_provisioner when none holds creds", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
      // canProvisionHosts absent → not a provisioner of record.
    });
  });

  const result = await t.mutation(internal.hosts.requestHostProvision, {});
  expect(result.kind).toBe("no_provisioner");
  expect(await provisioningHosts(t)).toEqual([]);
});

// The GH Actions provisioner / a laptop run reports a failed bootstrap via
// /fleet/event -> recordFleetEvent; a provision_failed drops the stale
// pre-created "provisioning" row so it stops counting as the in-flight scale-up.
test("recordFleetEvent provision_failed drops the stale provisioning row", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-2",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: now,
      provisionRequestedAt: now,
      provisionedBy: "host-1",
    });
    // An ACTIVE host must NOT be deleted by a stray provision_failed event.
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: now,
    });
  });

  await t.mutation(internal.hosts.recordFleetEvent, {
    hostId: "ultraclaude-host-2",
    type: "provision_failed",
    summary: "bootstrap exited 1",
  });

  expect(await provisioningHosts(t)).toEqual([]);
  const hosts = await t.run(async (ctx) => ctx.db.query("hosts").collect());
  expect(hosts.map((h) => h.hostId)).toEqual(["host-1"]); // active row untouched
  const events = await t.run(async (ctx) =>
    ctx.db
      .query("hostEvents")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .collect(),
  );
  expect(events.some((e) => e.type === "provision_failed")).toBe(true);
});

// The sole handoff that makes a GH-Actions-provisioned host usable: its first
// heartbeat flips the pre-created "provisioning" row to "active" AND drains the
// queue onto it.
test("a new host's first heartbeat flips provisioning->active and drains the queue", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "ultraclaude-host-2",
      maxVms: 2,
      status: "provisioning",
      lastSeenAt: now,
      provisionRequestedAt: now,
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

  await t.mutation(api.hosts.heartbeat, {
    hostId: "ultraclaude-host-2",
    secret: SECRET,
  });
  await drainScheduled(t);

  const host = await t.run(async (ctx) =>
    ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .unique(),
  );
  expect(host?.status).toBe("active");
  // The queued task placed onto the freshly online host...
  expect((await getTask(t, "task-q"))?.devboxId).toBeDefined();
  // ...with a provision_vm command enqueued to it, and an "online" event.
  const commands = await allHostCommands(t);
  expect(
    commands.some(
      (c) => c.kind === "provision_vm" && c.hostId === "ultraclaude-host-2",
    ),
  ).toBe(true);
  const events = await t.run(async (ctx) =>
    ctx.db
      .query("hostEvents")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .collect(),
  );
  expect(events.some((e) => e.type === "online")).toBe(true);
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

async function seedPendingHostCommand(
  t: Tester,
  commandId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("hostCommands", {
      commandId,
      hostId: "host-1",
      kind: "provision_vm",
      payload: JSON.stringify({ devboxId: "devbox-1" }),
      status: "pending",
      createdAt: Date.now(),
    });
  });
}

function hostCommandStatus(
  t: Tester,
  commandId: string,
): Promise<string | undefined> {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("hostCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", commandId))
      .unique();
    return row?.status;
  });
}

// Same persisted idempotency guard as commands.claim, against hostCommands: a
// replayed provision_vm would double-allocate a VM, so the claim must win only
// once even after the host agent's in-memory `seen` set is lost on restart.
test("host claim wins once then loses; ack finalizes; pendingFor drops it", async () => {
  const t = newT();
  await seedPendingHostCommand(t, "hostcmd-1");

  expect(
    await t.mutation(api.hosts.claim, {
      commandId: "hostcmd-1",
      secret: SECRET,
    }),
  ).toBe(true);
  expect(await hostCommandStatus(t, "hostcmd-1")).toBe("running");

  // Re-offered after a restart: the claim loses, so provision_vm never replays.
  expect(
    await t.mutation(api.hosts.claim, {
      commandId: "hostcmd-1",
      secret: SECRET,
    }),
  ).toBe(false);

  // The claimed command is no longer offered to the subscription.
  expect(
    await t.query(api.hosts.pendingFor, { hostId: "host-1", secret: SECRET }),
  ).toEqual([]);

  await t.mutation(api.hosts.ack, { commandId: "hostcmd-1", secret: SECRET });
  expect(await hostCommandStatus(t, "hostcmd-1")).toBe("acked");
});

test("host claim no-ops on a wrong secret", async () => {
  const t = newT();
  await seedPendingHostCommand(t, "hostcmd-1");
  expect(
    await t.mutation(api.hosts.claim, { commandId: "hostcmd-1", secret: "no" }),
  ).toBe(false);
  expect(await hostCommandStatus(t, "hostcmd-1")).toBe("pending");
});
