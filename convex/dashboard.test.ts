import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { TaskEffort, TaskStatus } from "../shared/protocol";
import { api } from "./_generated/api";
import schema from "./schema";
import { drainScheduled } from "./test.helpers";

// Hand-built module map (bun has no import.meta.glob). retryTask reaches
// hosts.placeEphemeralTaskRow and schedules notify.taskNote at 0ms, so both
// must be resolvable; notify no-ops without SLACK_BOT_TOKEN.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./dashboard.ts": () => import("./dashboard"),
  "./hosts.ts": () => import("./hosts"),
  "./notify.ts": () => import("./notify"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "dash-secret";
let savedSlackToken: string | undefined;

beforeEach(() => {
  process.env.DASHBOARD_SECRET = SECRET;
  process.env.DEVBOX_SHARED_SECRET = "s3cret";
  process.env.TAILNET_SUFFIX = "ts.example.com";
  // Delete SLACK_BOT_TOKEN in-process (so the guard holds regardless of cwd)
  // so the drained notify.taskNote takes its no-token early return instead of
  // hitting a real Slack API. bun loads the repo's `.env` (real token) into the
  // test process, and a token can also be exported into the shell.
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  delete process.env.DASHBOARD_SECRET;
  delete process.env.DEVBOX_SHARED_SECRET;
  delete process.env.TAILNET_SUFFIX;
  if (savedSlackToken !== undefined) {
    process.env.SLACK_BOT_TOKEN = savedSlackToken;
  }
});

/** Seeds a terminal ephemeral task (the retry source). slackThreadTs is set so
 * retryTask doesn't bail on the legacy-no-thread guard. */
async function seedTerminalSource(
  t: Tester,
  taskId: string,
  effort?: TaskEffort,
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: "Original task",
      prompt: "do the thing",
      status: "failed",
      placement: "ephemeral",
      slackChannel: "C1",
      slackThreadTs: "100.0",
      slackUser: "U1",
      ...(effort === undefined ? {} : { effort }),
      createdAt: now,
      updatedAt: now,
    });
  });
}

function loadTask(t: Tester, taskId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

/** Seeds a task with an explicit status and archived flag (#122 tests). */
async function seedTask(
  t: Tester,
  taskId: string,
  opts: { status: TaskStatus; archived?: boolean },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: taskId,
      prompt: "do the thing",
      status: opts.status,
      placement: "ephemeral",
      slackChannel: "C1",
      slackThreadTs: "100.0",
      slackUser: "U1",
      ...(opts.archived === undefined ? {} : { archived: opts.archived }),
      createdAt: now,
      updatedAt: now,
    });
  });
}

const ALL_PAGES = { numItems: 50, cursor: null };

function listTaskIds(
  t: Tester,
  args: { status?: TaskStatus; archived?: boolean },
) {
  return t
    .query(api.dashboard.listTasks, {
      secret: SECRET,
      paginationOpts: ALL_PAGES,
      ...args,
    })
    .then((r) => r.page.map((task) => task.taskId).sort());
}

test("setTaskArchived archives and unarchives a terminal task (#122)", async () => {
  const t = newT();
  await seedTask(t, "task-done", { status: "completed" });

  const archive = await t.mutation(api.dashboard.setTaskArchived, {
    secret: SECRET,
    taskId: "task-done",
    archived: true,
  });
  expect(archive.ok).toBe(true);
  expect((await loadTask(t, "task-done"))?.archived).toBe(true);

  const unarchive = await t.mutation(api.dashboard.setTaskArchived, {
    secret: SECRET,
    taskId: "task-done",
    archived: false,
  });
  expect(unarchive.ok).toBe(true);
  expect((await loadTask(t, "task-done"))?.archived).toBe(false);
});

test("setTaskArchived refuses to archive a non-terminal task (#122)", async () => {
  const t = newT();
  await seedTask(t, "task-live", { status: "running" });

  const result = await t.mutation(api.dashboard.setTaskArchived, {
    secret: SECRET,
    taskId: "task-live",
    archived: true,
  });
  expect(result.ok).toBe(false);
  expect((await loadTask(t, "task-live"))?.archived).toBeUndefined();
});

test("setTaskArchived rejects an unknown task and a bad secret (#122)", async () => {
  const t = newT();
  await seedTask(t, "task-done", { status: "completed" });

  const missing = await t.mutation(api.dashboard.setTaskArchived, {
    secret: SECRET,
    taskId: "nope",
    archived: true,
  });
  expect(missing.ok).toBe(false);

  const unauthorized = await t.mutation(api.dashboard.setTaskArchived, {
    secret: "wrong",
    taskId: "task-done",
    archived: true,
  });
  expect(unauthorized.ok).toBe(false);
  // The bad-secret call must not have mutated the row.
  expect((await loadTask(t, "task-done"))?.archived).toBeUndefined();
});

test("listTasks hides archived tasks from the default and status filters (#122)", async () => {
  const t = newT();
  await seedTask(t, "live-archived", { status: "completed", archived: true });
  await seedTask(t, "live-plain", { status: "completed", archived: false });
  await seedTask(t, "legacy-plain", { status: "failed" }); // archived absent

  // Default ("all") filter: archived row excluded, the rest present.
  expect(await listTaskIds(t, {})).toEqual(["legacy-plain", "live-plain"]);
  // Status filter: still excludes the archived "completed" row.
  expect(await listTaskIds(t, { status: "completed" })).toEqual(["live-plain"]);
});

test("listTasks archived:true returns only archived tasks (#122)", async () => {
  const t = newT();
  await seedTask(t, "a1", { status: "completed", archived: true });
  await seedTask(t, "a2", { status: "failed", archived: true });
  await seedTask(t, "plain", { status: "completed", archived: false });

  expect(await listTaskIds(t, { archived: true })).toEqual(["a1", "a2"]);
});

// #91: a dashboard retry must re-run faithfully, including the effort level the
// original was started with — otherwise a "low effort" task silently reverts to
// the xhigh default on retry.
test("retryTask carries the source task's effort onto the new run (#91)", async () => {
  const t = newT();
  await seedTerminalSource(t, "task-src", "low");

  const result = await t.mutation(api.dashboard.retryTask, {
    secret: SECRET,
    taskId: "task-src",
  });
  await drainScheduled(t);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect((await loadTask(t, result.taskId))?.effort).toBe("low");
});

test("retryTask leaves effort unset when the source had none (#91)", async () => {
  const t = newT();
  await seedTerminalSource(t, "task-src");

  const result = await t.mutation(api.dashboard.retryTask, {
    secret: SECRET,
    taskId: "task-src",
  });
  await drainScheduled(t);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect((await loadTask(t, result.taskId))?.effort).toBeUndefined();
});
