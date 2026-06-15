import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { TaskEffort } from "../shared/protocol";
import { api } from "./_generated/api";
import schema from "./schema";

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

beforeEach(() => {
  process.env.DASHBOARD_SECRET = SECRET;
  process.env.DEVBOX_SHARED_SECRET = "s3cret";
  process.env.TAILNET_SUFFIX = "ts.example.com";
  // SLACK_BOT_TOKEN stays unset (stripped by scripts/test-preload.ts) so the
  // drained notify.taskNote takes its no-token early return instead of hitting
  // a real Slack API.
});

afterEach(() => {
  delete process.env.DASHBOARD_SECRET;
  delete process.env.DEVBOX_SHARED_SECRET;
  delete process.env.TAILNET_SUFFIX;
});

async function drainScheduled(t: Tester): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

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
