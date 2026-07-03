import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import type { TaskStatus } from "../shared/protocol";
import { api, internal } from "./_generated/api";
import { EVENT_RETENTION_MS, QUEUE_RETENTION_MS } from "./cleanup";
import schema from "./schema";
import { drainScheduled } from "./test.helpers";

// Hand-built module map (bun has no import.meta.glob). tasks.stop,
// devboxes.recordEvent, dashboard.steerTask/retryTask, and
// cleanup.pruneExpired are under test; local.ts + hosts.ts back the
// release/placement helpers they reach; notify.ts is their 0ms-scheduled
// follow-up (no-ops without SLACK_BOT_TOKEN).
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./tasks.ts": () => import("./tasks"),
  "./devboxes.ts": () => import("./devboxes"),
  "./dashboard.ts": () => import("./dashboard"),
  "./local.ts": () => import("./local"),
  "./hosts.ts": () => import("./hosts"),
  "./cleanup.ts": () => import("./cleanup"),
  "./notify.ts": () => import("./notify"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const DASH_SECRET = "dash-secret";
let savedSlackToken: string | undefined;

beforeEach(() => {
  process.env.DASHBOARD_SECRET = DASH_SECRET;
  // Drained notify follow-ups must take their no-token early return instead
  // of hitting real Slack (bun loads the repo's `.env` locally).
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  delete process.env.DASHBOARD_SECRET;
  if (savedSlackToken !== undefined) {
    process.env.SLACK_BOT_TOKEN = savedSlackToken;
  }
  setSystemTime();
});

async function seedTask(
  t: Tester,
  opts: {
    taskId: string;
    status: TaskStatus;
    placement?: "ephemeral" | "local";
    devboxId?: string;
    localMachineId?: string;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: opts.taskId,
      title: opts.taskId,
      prompt: "do the thing",
      status: opts.status,
      ...(opts.placement === undefined ? {} : { placement: opts.placement }),
      ...(opts.devboxId === undefined ? {} : { devboxId: opts.devboxId }),
      ...(opts.localMachineId === undefined
        ? {}
        : { localMachineId: opts.localMachineId }),
      slackChannel: "C1",
      slackThreadTs: "100.0",
      slackUser: "U1",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function seedMachine(
  t: Tester,
  machineId: string,
  taskId?: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("localMachines", {
      machineId,
      lastSeenAt: Date.now(),
      ...(taskId === undefined ? {} : { taskId }),
    });
  });
}

async function seedDevbox(
  t: Tester,
  devboxId: string,
  taskId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("devboxes", {
      devboxId,
      gatewayUrl: `http://${devboxId}.ts.example.com:8787`,
      status: "busy",
      taskId,
      lastSeenAt: Date.now(),
    });
  });
}

async function seedPeerRequest(
  t: Tester,
  taskId: string,
  requestId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("peerMessages", {
      messageId: `peer-${requestId}`,
      taskId,
      requestId,
      kind: "request",
      body: "please check the local file",
      createdAt: Date.now(),
    });
  });
}

function loadTask(t: Tester, taskId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

function loadMachine(t: Tester, machineId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("localMachines")
      .withIndex("by_machine_id", (q) => q.eq("machineId", machineId))
      .unique(),
  );
}

function localCommands(t: Tester) {
  return t.run((ctx) => ctx.db.query("localCommands").collect());
}

function cloudCommands(t: Tester) {
  return t.run((ctx) => ctx.db.query("commands").collect());
}

function peerReplies(t: Tester, requestId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("peerMessages")
      .withIndex("by_request", (q) =>
        q.eq("requestId", requestId).eq("kind", "reply"),
      )
      .collect(),
  );
}

// ---- stopTaskCore local branches (via the internal.tasks.stop wrapper) ----

test("stop on a local-primary task (online machine) interrupts the daemon and unblocks peers, keeping the busy marker", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "running",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-lp");
  await seedPeerRequest(t, "task-lp", "req-1");

  const outcome = await t.mutation(internal.tasks.stop, {
    taskId: "task-lp",
    queuedCancelText: "cancelled while queued",
    interruptRequestedText: "stop requested",
  });
  expect(outcome).toEqual({ kind: "interrupted" });

  // The daemon gets a taskId-guarded interrupt, but the busy marker is NOT
  // eagerly cleared: the session is still winding down, and the daemon's own
  // signals (stopped event / heartbeat reconcile) free the machine. An eager
  // clear would let a new task be placed onto a still-live session and
  // erase the marker a daemon-reboot reconcile keys off.
  expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-lp");
  const commands = await localCommands(t);
  expect(commands.map((c) => c.kind)).toEqual(["interrupt"]);
  expect(JSON.parse(commands[0]?.payload ?? "{}")).toEqual({
    taskId: "task-lp",
  });
  // The task itself stays non-terminal until the daemon's stopped event.
  expect((await loadTask(t, "task-lp"))?.status).toBe("running");
  // The unanswered peer request got a synthetic reply so a blocked cloud
  // agent would unblock instead of waiting out its deadline.
  const replies = await peerReplies(t, "req-1");
  expect(replies.map((r) => r.body)).toEqual([
    "The task was stopped before this request was answered.",
  ]);
  await drainScheduled(t); // the attribution taskNote no-ops without a token
});

test("stop on a local-primary task with an OFFLINE daemon stops it terminally in place", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "running",
    placement: "local",
    localMachineId: "mac-1",
  });
  // Heartbeat far staler than HEARTBEAT_FRESHNESS_MS (2 min).
  await t.run(async (ctx) => {
    await ctx.db.insert("localMachines", {
      machineId: "mac-1",
      taskId: "task-lp",
      lastSeenAt: Date.now() - 10 * 60_000,
    });
  });

  const outcome = await t.mutation(internal.tasks.stop, {
    taskId: "task-lp",
    queuedCancelText: "cancelled while queued",
  });
  expect(outcome).toEqual({ kind: "interrupted" });

  // No daemon will ever post the "stopped" event: the task terminates in
  // place, with the terminal invariants (finishedAt + a history row) intact,
  // and the machine frees so it is placeable when the daemon returns.
  const task = await loadTask(t, "task-lp");
  expect(task?.status).toBe("stopped");
  expect(task?.finishedAt).toBeDefined();
  const events = await t.run((ctx) =>
    ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", "task-lp"))
      .collect(),
  );
  expect(events.map((e) => e.type)).toEqual(["stopped"]);
  expect((await loadMachine(t, "mac-1"))?.taskId).toBeUndefined();
  // The interrupt still queues, cleaning up a session that resurfaces.
  expect((await localCommands(t)).map((c) => c.kind)).toEqual(["interrupt"]);
});

test("stop rejects a local-primary task whose machine moved on", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "running",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-other");

  const outcome = await t.mutation(internal.tasks.stop, {
    taskId: "task-lp",
    queuedCancelText: "cancelled while queued",
  });
  expect(outcome).toMatchObject({ kind: "rejected" });
  if (outcome.kind !== "rejected") throw new Error("expected rejection");
  expect(outcome.reason).toContain("no longer serving");
  // Nothing was interrupted: not our machine's session anymore.
  expect(await localCommands(t)).toEqual([]);
  expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-other");
});

test("stop on a split task interrupts the devbox AND releases the local helper", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-split",
    status: "running",
    devboxId: "dev-1",
    localMachineId: "mac-1",
  });
  await seedDevbox(t, "dev-1", "task-split");
  await seedMachine(t, "mac-1", "task-split");
  await seedPeerRequest(t, "task-split", "req-2");

  const outcome = await t.mutation(internal.tasks.stop, {
    taskId: "task-split",
    queuedCancelText: "cancelled while queued",
  });
  expect(outcome).toEqual({ kind: "interrupted" });

  // Cloud primary interrupted...
  const devboxSide = await cloudCommands(t);
  expect(devboxSide.map((c) => [c.devboxId, c.kind])).toEqual([
    ["dev-1", "interrupt"],
  ]);
  // ...and the local helper released alongside it (session interrupted,
  // peers unblocked). The busy marker stays until the daemon's own signals
  // confirm the session ended (stopped event / heartbeat reconcile).
  expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-split");
  expect((await localCommands(t)).map((c) => c.kind)).toEqual(["interrupt"]);
  expect((await peerReplies(t, "req-2")).map((r) => r.body)).toEqual([
    "The task was stopped before this request was answered.",
  ]);
});

test("stop still cancels a plain queued cloud task (the local branch must not regress it)", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-q",
    status: "queued",
    placement: "ephemeral",
  });

  const outcome = await t.mutation(internal.tasks.stop, {
    taskId: "task-q",
    queuedCancelText: "cancelled while queued",
  });
  expect(outcome).toEqual({ kind: "cancelled_queued" });
  expect((await loadTask(t, "task-q"))?.status).toBe("stopped");
  const events = await t.run((ctx) =>
    ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", "task-q"))
      .collect(),
  );
  expect(events.map((e) => e.type)).toEqual(["stopped"]);
  await drainScheduled(t); // the queued-cancel taskNote no-ops without a token
});

// ---- Split-task teardown from the cloud side ----

test("a terminal cloud event on a split task releases the local helper", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-split",
    status: "running",
    devboxId: "dev-1",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-split");
  await seedPeerRequest(t, "task-split", "req-3");

  const result = await t.mutation(internal.devboxes.recordEvent, {
    devboxId: "dev-1",
    taskId: "task-split",
    type: "completed",
    summary: "all done",
    ts: Date.now(),
  });
  expect(result).toEqual({ taskFound: true, applied: true });

  expect((await loadTask(t, "task-split"))?.status).toBe("completed");
  // Helper teardown: idle session interrupted, peers unblocked. The busy
  // marker frees via the daemon's own signals (an interrupted IDLE helper
  // emits no stopped event, so the heartbeat reconcile is its release path).
  expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-split");
  expect((await localCommands(t)).map((c) => c.kind)).toEqual(["interrupt"]);
  expect((await peerReplies(t, "req-3")).map((r) => r.body)).toEqual([
    "The task ended (completed) before this request was answered.",
  ]);
});

// ---- Heartbeat reconcile: the busy-marker release path (#138 review fix) ----

test("a heartbeat reporting no session frees a stale busy marker unless a start is in flight", async () => {
  const t = newT();
  process.env.LOCAL_MACHINE_SECRET = "local-secret";
  try {
    await seedMachine(t, "mac-1", "task-done");

    // A start command still pending for the marked task: NOT stale — the
    // daemon just hasn't consumed it yet.
    await t.run(async (ctx) => {
      await ctx.db.insert("localCommands", {
        commandId: "lcmd-1",
        machineId: "mac-1",
        kind: "start",
        payload: JSON.stringify({ taskId: "task-done", prompt: "p" }),
        status: "pending",
        createdAt: Date.now(),
      });
    });
    await t.mutation(api.local.heartbeat, {
      machineId: "mac-1",
      secret: "local-secret",
    });
    expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-done");

    // Start consumed (acked) and the daemon reports an idle session: the
    // marker is stale — the session ended without a terminal event (e.g. an
    // interrupted idle helper) — and frees.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("localCommands")
        .withIndex("by_command_id", (q) => q.eq("commandId", "lcmd-1"))
        .unique();
      if (row !== null) {
        await ctx.db.patch(row._id, { status: "acked" });
      }
    });
    await t.mutation(api.local.heartbeat, {
      machineId: "mac-1",
      secret: "local-secret",
    });
    expect((await loadMachine(t, "mac-1"))?.taskId).toBeUndefined();

    // A heartbeat REPORTING the marked task never frees it.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("localMachines")
        .withIndex("by_machine_id", (q) => q.eq("machineId", "mac-1"))
        .unique();
      if (m !== null) {
        await ctx.db.patch(m._id, { taskId: "task-live" });
      }
    });
    await t.mutation(api.local.heartbeat, {
      machineId: "mac-1",
      secret: "local-secret",
      taskId: "task-live",
    });
    expect((await loadMachine(t, "mac-1"))?.taskId).toBe("task-live");
  } finally {
    delete process.env.LOCAL_MACHINE_SECRET;
  }
});

// ---- Dashboard steer routing (#138) ----

test("steerTask routes a local-primary follow-up to localCommands, not commands", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "running",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-lp");

  const result = await t.mutation(api.dashboard.steerTask, {
    secret: DASH_SECRET,
    taskId: "task-lp",
    text: "also check the calendar",
  });
  expect(result.ok).toBe(true);

  const commands = await localCommands(t);
  expect(commands.map((c) => [c.machineId, c.kind])).toEqual([
    ["mac-1", "user_message"],
  ]);
  expect(JSON.parse(commands[0]?.payload ?? "{}")).toEqual({
    taskId: "task-lp",
    text: "also check the calendar",
  });
  expect(await cloudCommands(t)).toEqual([]);
  await drainScheduled(t); // the dashboard-steer taskNote no-ops without a token
});

test("steerTask still routes a cloud task's follow-up to commands", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-c",
    status: "running",
    devboxId: "dev-1",
  });
  await seedDevbox(t, "dev-1", "task-c");

  const result = await t.mutation(api.dashboard.steerTask, {
    secret: DASH_SECRET,
    taskId: "task-c",
    text: "look again",
  });
  expect(result.ok).toBe(true);

  expect((await cloudCommands(t)).map((c) => [c.devboxId, c.kind])).toEqual([
    ["dev-1", "user_message"],
  ]);
  expect(await localCommands(t)).toEqual([]);
  await drainScheduled(t);
});

// ---- Dashboard retry of a terminal local task (#138) ----

test("retryTask re-places a terminal local task on its free machine with a fresh grant", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-src",
    status: "failed",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1"); // free and online

  const result = await t.mutation(api.dashboard.retryTask, {
    secret: DASH_SECRET,
    taskId: "task-src",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(result.taskId).not.toBe("task-src");

  // Clicking retry IS the consent: the new task is born with the grant.
  const retry = await loadTask(t, result.taskId);
  expect(retry).toMatchObject({
    placement: "local",
    localMachineId: "mac-1",
    prompt: "do the thing",
  });
  expect(retry?.localAccess?.status).toBe("granted");
  expect((await loadMachine(t, "mac-1"))?.taskId).toBe(result.taskId);

  const commands = await localCommands(t);
  expect(commands.map((c) => [c.machineId, c.kind])).toEqual([
    ["mac-1", "start"],
  ]);
  expect(JSON.parse(commands[0]?.payload ?? "{}")).toMatchObject({
    taskId: result.taskId,
    prompt: "do the thing",
  });
  await drainScheduled(t);
});

test("retryTask refuses a busy machine without stranding a task row", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-src",
    status: "failed",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-other");

  const result = await t.mutation(api.dashboard.retryTask, {
    secret: DASH_SECRET,
    taskId: "task-src",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected refusal");
  expect(result.reason).toContain("busy");

  // The refusal happened BEFORE the insert: no queued-forever row exists.
  const tasks = await t.run((ctx) => ctx.db.query("tasks").collect());
  expect(tasks.map((task) => task.taskId)).toEqual(["task-src"]);
  expect(await localCommands(t)).toEqual([]);
});

// ---- Retention (#138 tables in the daily prune) ----

const HOUR_MS = 60 * 60 * 1000;

/** Runs `fn` with the clock turned back `ageMs`, so inserted rows get a
 * backdated _creationTime (mirrors cleanup.test.ts's idiom). */
async function agedBy<T>(ageMs: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(Date.now() - ageMs));
  try {
    return await fn();
  } finally {
    setSystemTime();
  }
}

test("pruneExpired ages out localCommands + peerMessages but never capabilityManifests", async () => {
  const t = newT();

  // Oldest first: convex-test forces _creationTime to be monotonically
  // increasing. The manifest is older than EVERY retention window and must
  // still survive (one long-lived row per golden tag).
  await agedBy(EVENT_RETENTION_MS + HOUR_MS, () =>
    t.run(async (ctx) => {
      await ctx.db.insert("capabilityManifests", {
        goldenTag: "golden-old",
        generated: "gen",
        curated: "cur",
        updatedAt: Date.now(),
      });
    }),
  );
  await agedBy(QUEUE_RETENTION_MS + HOUR_MS, () =>
    t.run(async (ctx) => {
      await ctx.db.insert("localCommands", {
        commandId: "lcmd-old",
        machineId: "mac-1",
        kind: "user_message",
        payload: "{}",
        status: "acked",
        createdAt: Date.now(),
      });
      await ctx.db.insert("peerMessages", {
        messageId: "peer-old",
        taskId: "task-1",
        requestId: "req-old",
        kind: "request",
        body: "b",
        createdAt: Date.now(),
      });
    }),
  );
  await agedBy(QUEUE_RETENTION_MS - HOUR_MS, () =>
    t.run(async (ctx) => {
      await ctx.db.insert("localCommands", {
        commandId: "lcmd-new",
        machineId: "mac-1",
        kind: "user_message",
        payload: "{}",
        status: "pending",
        createdAt: Date.now(),
      });
      await ctx.db.insert("peerMessages", {
        messageId: "peer-new",
        taskId: "task-1",
        requestId: "req-new",
        kind: "reply",
        body: "b",
        createdAt: Date.now(),
      });
    }),
  );

  const result = await t.mutation(internal.cleanup.pruneExpired, {});
  expect(result.rescheduled).toBe(false);
  expect(result.deleted).toEqual({ localCommands: 1, peerMessages: 1 });

  const remaining = await t.run(async (ctx) => ({
    localCommands: (await ctx.db.query("localCommands").collect()).map(
      (r) => r.commandId,
    ),
    peerMessages: (await ctx.db.query("peerMessages").collect()).map(
      (r) => r.messageId,
    ),
    manifests: (await ctx.db.query("capabilityManifests").collect()).map(
      (r) => r.goldenTag,
    ),
  }));
  expect(remaining).toEqual({
    localCommands: ["lcmd-new"],
    peerMessages: ["peer-new"],
    manifests: ["golden-old"],
  });
});
