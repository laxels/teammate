import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { RecordingStatus } from "../shared/protocol";
import { api } from "./_generated/api";
import schema from "./schema";

// dashboard.ts holds the comment mutations + taskDetail query (#70). They live
// in the operator trust tier (DASHBOARD_SECRET), like every other dashboard
// mutation. Comments here are text-only so the in-memory store needs no getUrl.
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
});

afterEach(() => {
  delete process.env.DASHBOARD_SECRET;
});

/** A terminal task whose recording is in the given lifecycle state (no
 * storageId, so taskDetail never reaches getUrl). */
async function seedTask(
  t: Tester,
  taskId: string,
  recordingStatus: RecordingStatus | null = "available",
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: "task",
      prompt: "prompt",
      status: "completed",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
      ...(recordingStatus === null
        ? {}
        : { recording: { status: recordingStatus, startedAt: now } }),
    });
  });
}

function comments(t: Tester, taskId: string) {
  return t.query(api.dashboard.taskDetail, { secret: SECRET, taskId });
}

test("createComment rejects a wrong secret", async () => {
  const t = newT();
  await seedTask(t, "task-1");
  const res = await t.mutation(api.dashboard.createComment, {
    secret: "nope",
    taskId: "task-1",
    videoTimeSec: 3,
    text: "hi",
  });
  expect(res).toEqual({ ok: false, reason: "unauthorized" });
});

test("createComment rejects an empty comment and a negative timestamp", async () => {
  const t = newT();
  await seedTask(t, "task-1");
  expect(
    await t.mutation(api.dashboard.createComment, {
      secret: SECRET,
      taskId: "task-1",
      videoTimeSec: 3,
      text: "   ",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await t.mutation(api.dashboard.createComment, {
      secret: SECRET,
      taskId: "task-1",
      videoTimeSec: -1,
      text: "real",
    }),
  ).toMatchObject({ ok: false });
});

test("createComment refuses a task whose recording isn't available (post-hoc only)", async () => {
  const t = newT();
  await seedTask(t, "task-up", "uploading");
  await seedTask(t, "task-none", null);
  for (const taskId of ["task-up", "task-none"]) {
    expect(
      await t.mutation(api.dashboard.createComment, {
        secret: SECRET,
        taskId,
        videoTimeSec: 1,
        text: "x",
      }),
    ).toMatchObject({ ok: false });
  }
});

test("createComment persists and taskDetail returns it, oldest-first", async () => {
  const t = newT();
  await seedTask(t, "task-1");
  await t.mutation(api.dashboard.createComment, {
    secret: SECRET,
    taskId: "task-1",
    videoTimeSec: 12.5,
    text: "  first thoughts  ",
  });
  await t.mutation(api.dashboard.createComment, {
    secret: SECRET,
    taskId: "task-1",
    videoTimeSec: 4,
    text: "earlier in the video",
  });
  const detail = await comments(t, "task-1");
  expect(detail?.comments).toHaveLength(2);
  // Oldest-first by createdAt, not by videoTimeSec.
  expect(detail?.comments[0]).toMatchObject({
    videoTimeSec: 12.5,
    text: "first thoughts", // trimmed
  });
  expect(detail?.comments[1]?.videoTimeSec).toBe(4);
});

test("editComment updates text; an empty edit deletes the comment", async () => {
  const t = newT();
  await seedTask(t, "task-1");
  const created = await t.mutation(api.dashboard.createComment, {
    secret: SECRET,
    taskId: "task-1",
    videoTimeSec: 1,
    text: "original",
  });
  if (!created.ok) throw new Error(created.reason);

  await t.mutation(api.dashboard.editComment, {
    secret: SECRET,
    commentId: created.commentId,
    text: "edited",
  });
  expect((await comments(t, "task-1"))?.comments[0]?.text).toBe("edited");

  await t.mutation(api.dashboard.editComment, {
    secret: SECRET,
    commentId: created.commentId,
    text: "   ",
  });
  expect((await comments(t, "task-1"))?.comments).toHaveLength(0);
});

test("deleteComment removes the row", async () => {
  const t = newT();
  await seedTask(t, "task-1");
  const created = await t.mutation(api.dashboard.createComment, {
    secret: SECRET,
    taskId: "task-1",
    videoTimeSec: 1,
    text: "doomed",
  });
  if (!created.ok) throw new Error(created.reason);
  const res = await t.mutation(api.dashboard.deleteComment, {
    secret: SECRET,
    commentId: created.commentId,
  });
  expect(res).toMatchObject({ ok: true });
  expect((await comments(t, "task-1"))?.comments).toHaveLength(0);
});
