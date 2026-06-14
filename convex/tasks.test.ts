import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./tasks.ts": () => import("./tasks"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "s3cret";
const DEVBOX = "devbox-1";

beforeEach(() => {
  process.env.DEVBOX_SHARED_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.DEVBOX_SHARED_SECRET;
});

type StartStatus = "pending" | "running" | "acked";

async function seedTask(
  t: Tester,
  opts: {
    taskId: string;
    status: "queued" | "running";
    devboxId?: string;
    /** Adds a `start` command for this task; absent = no command at all. */
    startStatus?: StartStatus;
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: opts.taskId,
      title: opts.taskId,
      prompt: "go",
      status: opts.status,
      ...(opts.devboxId !== undefined ? { devboxId: opts.devboxId } : {}),
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
    });
    if (opts.startStatus !== undefined && opts.devboxId !== undefined) {
      await ctx.db.insert("commands", {
        commandId: `cmd-${opts.taskId}`,
        devboxId: opts.devboxId,
        kind: "start",
        payload: JSON.stringify({ taskId: opts.taskId, prompt: "go" }),
        status: opts.startStatus,
        createdAt: now,
      });
    }
  });
}

async function orphanIds(t: Tester, devboxId: string): Promise<string[]> {
  const orphans = await t.query(api.tasks.orphansForDevbox, {
    devboxId,
    secret: SECRET,
  });
  return orphans.map((o) => o.taskId).sort();
}

test("returns running tasks and queued tasks whose start was delivered", async () => {
  const t = newT();
  // 1. A running task on this devbox: the session died mid-task.
  await seedTask(t, {
    taskId: "run-here",
    status: "running",
    devboxId: DEVBOX,
  });
  // 2. A queued task whose start was acked then the gateway crashed.
  await seedTask(t, {
    taskId: "q-acked",
    status: "queued",
    devboxId: DEVBOX,
    startStatus: "acked",
  });
  // 3. A queued task whose start was claimed (running) but never produced a
  //    "started" event — crashed between claim and the session starting.
  await seedTask(t, {
    taskId: "q-running",
    status: "queued",
    devboxId: DEVBOX,
    startStatus: "running",
  });
  // 4. A queued task whose start is still pending: NOT an orphan — this booting
  //    gateway will consume and run it normally. Must not be failed.
  await seedTask(t, {
    taskId: "q-pending",
    status: "queued",
    devboxId: DEVBOX,
    startStatus: "pending",
  });
  // 5. A running task on a different devbox: not ours.
  await seedTask(t, {
    taskId: "run-elsewhere",
    status: "running",
    devboxId: "devbox-2",
  });

  expect(await orphanIds(t, DEVBOX)).toEqual([
    "q-acked",
    "q-running",
    "run-here",
  ]);
});

test("a queued task with no start command at all is not an orphan", async () => {
  const t = newT();
  // Pre-placement / unassigned: queued with no devbox and no command.
  await seedTask(t, { taskId: "unplaced", status: "queued" });
  expect(await orphanIds(t, DEVBOX)).toEqual([]);
});

test("returns nothing on a wrong secret", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "run-here",
    status: "running",
    devboxId: DEVBOX,
  });
  const orphans = await t.query(api.tasks.orphansForDevbox, {
    devboxId: DEVBOX,
    secret: "wrong",
  });
  expect(orphans).toEqual([]);
});
