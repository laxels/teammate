import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

// http.ts registers the router for t.fetch; recordings.ts holds the mutation
// the /devbox/recording route runs. (getUrl/generateUploadUrl aren't simulated
// by convex-test, so the upload-URL success path + taskDetail's URL resolution
// are verified live, not here.)
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./recordings.ts": () => import("./recordings"),
};

function newT() {
  return convexTest(schema, modules);
}

const SECRET = "devbox-secret";
let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.DEVBOX_SHARED_SECRET;
  process.env.DEVBOX_SHARED_SECRET = SECRET;
});

afterEach(() => {
  process.env.DEVBOX_SHARED_SECRET = savedSecret;
});

type T = ReturnType<typeof newT>;

async function insertTask(t: T, taskId: string): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: "task",
      prompt: "prompt",
      status: "running",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function readRecording(
  t: T,
  taskId: string,
): Promise<Doc<"tasks">["recording"] | null> {
  return await t.run(async (ctx) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique();
    return task?.recording ?? null;
  });
}

function postRecording(
  t: T,
  body: Record<string, unknown>,
  secret = SECRET,
): Promise<Response> {
  return t.fetch("/devbox/recording", {
    method: "POST",
    headers: { "content-type": "application/json", "x-devbox-secret": secret },
    body: JSON.stringify(body),
  });
}

test("/devbox/recording/upload-url rejects a missing/wrong shared secret", async () => {
  const t = newT();
  const res = await t.fetch("/devbox/recording/upload-url", {
    method: "POST",
    headers: { "x-devbox-secret": "wrong" },
  });
  expect(res.status).toBe(401);
});

test("/devbox/recording rejects a missing/wrong shared secret", async () => {
  const t = newT();
  const res = await postRecording(
    t,
    { taskId: "t", status: "recording" },
    "no",
  );
  expect(res.status).toBe(401);
});

test("/devbox/recording rejects an invalid status / missing taskId", async () => {
  const t = newT();
  expect(
    (await postRecording(t, { taskId: "t", status: "bogus" })).status,
  ).toBe(400);
  expect((await postRecording(t, { status: "recording" })).status).toBe(400);
});

test("status 'available' without a storageId is rejected", async () => {
  const t = newT();
  await insertTask(t, "task-1");
  const res = await postRecording(t, { taskId: "task-1", status: "available" });
  expect(res.status).toBe(400);
  expect(await readRecording(t, "task-1")).toBeNull();
});

test("records recording -> uploading -> available on the task row", async () => {
  const t = newT();
  await insertTask(t, "task-1");

  expect(
    (await postRecording(t, { taskId: "task-1", status: "recording" })).status,
  ).toBe(200);
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "recording",
  });

  await postRecording(t, { taskId: "task-1", status: "uploading" });
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "uploading",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])])),
  );
  await postRecording(t, {
    taskId: "task-1",
    status: "available",
    storageId,
    bytes: 4096,
  });
  const recording = await readRecording(t, "task-1");
  expect(recording).toMatchObject({
    status: "available",
    storageId,
    bytes: 4096,
  });
  expect(typeof recording?.uploadedAt).toBe("number");
});

test("an 'available' recording is never regressed by a late earlier-phase post", async () => {
  const t = newT();
  await insertTask(t, "task-1");
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([5])])),
  );
  await postRecording(t, { taskId: "task-1", status: "available", storageId });

  // A stale "uploading" racing the available transition must not erase it.
  const res = await postRecording(t, { taskId: "task-1", status: "uploading" });
  expect(res.status).toBe(200);
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "available",
    storageId,
  });
});

test("setStatus is a no-op for an unknown task", async () => {
  const t = newT();
  const result = await t.mutation(internal.recordings.setStatus, {
    taskId: "ghost",
    status: "recording",
  });
  expect(result).toEqual({ applied: false });
});

test("setStatus refuses to regress an available recording (unit)", async () => {
  const t = newT();
  await insertTask(t, "task-1");
  const storageId = (await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1])])),
  )) as Id<"_storage">;
  await t.mutation(internal.recordings.setStatus, {
    taskId: "task-1",
    status: "available",
    storageId,
  });
  const result = await t.mutation(internal.recordings.setStatus, {
    taskId: "task-1",
    status: "failed",
  });
  expect(result).toEqual({ applied: false });
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "available",
  });
});

// #70: startedAt rides the first "recording" post and must survive every later
// transition (the "uploading"/"available" posts don't resend it). Without this,
// the task-details page can't map a comment's video seconds to event time.
test("startedAt is set once and preserved across transitions", async () => {
  const t = newT();
  await insertTask(t, "task-1");
  await postRecording(t, {
    taskId: "task-1",
    status: "recording",
    startedAt: 1700,
  });
  expect(await readRecording(t, "task-1")).toMatchObject({ startedAt: 1700 });

  // A later post that omits startedAt must not erase it.
  await postRecording(t, { taskId: "task-1", status: "uploading" });
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "uploading",
    startedAt: 1700,
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([9])])),
  );
  await postRecording(t, { taskId: "task-1", status: "available", storageId });
  expect(await readRecording(t, "task-1")).toMatchObject({
    status: "available",
    startedAt: 1700,
  });
});

test("recordings.signedUrl is null for an unknown or not-yet-available recording", async () => {
  const t = newT();
  await insertTask(t, "task-1"); // no recording yet
  expect(
    await t.query(internal.recordings.signedUrl, { taskId: "task-1" }),
  ).toBeNull();
  expect(
    await t.query(internal.recordings.signedUrl, { taskId: "ghost" }),
  ).toBeNull();

  await postRecording(t, { taskId: "task-1", status: "uploading" });
  expect(
    await t.query(internal.recordings.signedUrl, { taskId: "task-1" }),
  ).toBeNull();
});
