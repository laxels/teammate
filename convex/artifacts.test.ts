import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

// Hand-built module map (Bun has no import.meta.glob). http.ts registers the
// router for t.fetch; artifacts.ts + tasks.ts are the functions under test.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./artifacts.ts": () => import("./artifacts"),
  "./tasks.ts": () => import("./tasks"),
};

function newT() {
  return convexTest(schema, modules);
}

const SECRET = "devbox-secret";
let savedSecret: string | undefined;
let savedToken: string | undefined;
let savedFetch: typeof fetch;

beforeEach(() => {
  savedSecret = process.env.DEVBOX_SHARED_SECRET;
  savedToken = process.env.SLACK_BOT_TOKEN;
  savedFetch = globalThis.fetch;
  process.env.DEVBOX_SHARED_SECRET = SECRET;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

afterEach(() => {
  process.env.DEVBOX_SHARED_SECRET = savedSecret;
  process.env.SLACK_BOT_TOKEN = savedToken;
  globalThis.fetch = savedFetch;
});

function artifactForm(): FormData {
  const form = new FormData();
  form.set("taskId", "task-art");
  form.set("filename", "shot.png");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "shot.png");
  return form;
}

test("/devbox/artifact rejects a missing/wrong shared secret", async () => {
  const t = newT();
  const res = await t.fetch("/devbox/artifact", {
    method: "POST",
    headers: { "x-devbox-secret": "wrong" },
    body: artifactForm(),
  });
  expect(res.status).toBe(401);
});

test("/devbox/artifact stores the file and schedules the Slack upload", async () => {
  const t = newT();
  const res = await t.fetch("/devbox/artifact", {
    method: "POST",
    headers: { "x-devbox-secret": SECRET },
    body: artifactForm(),
  });
  expect(res.status).toBe(202);
  // A scheduled function (artifacts.uploadToSlack) is now pending.
  const scheduled = await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map(
      (f) => f.name,
    ),
  );
  expect(scheduled.some((name) => name.includes("uploadToSlack"))).toBe(true);
});

test("uploadToSlack posts the artifact into the task thread and deletes the blob", async () => {
  const t = newT();
  const storageId = await t.run(async (ctx) => {
    await ctx.db.insert("tasks", {
      taskId: "task-art",
      title: "Render the chart",
      prompt: "p",
      status: "running",
      slackChannel: "C0CHAN",
      slackThreadTs: "1749500000.000100",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return await ctx.storage.store(new Blob([new Uint8Array([9, 8, 7])]));
  });

  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("getUploadURLExternal")) {
      return Response.json({
        ok: true,
        upload_url: "https://files.slack.com/up/1",
        file_id: "F1",
      });
    }
    if (u.includes("completeUploadExternal")) {
      return Response.json({ ok: true });
    }
    return new Response("OK"); // the raw-bytes upload POST
  }) as unknown as typeof fetch;

  await t.action(internal.artifacts.uploadToSlack, {
    taskId: "task-art",
    storageId,
    filename: "chart.png",
  });

  // The 3-step external flow ran, threaded under the task's message.
  expect(calls.some((u) => u.includes("getUploadURLExternal"))).toBe(true);
  expect(calls.some((u) => u === "https://files.slack.com/up/1")).toBe(true);
  expect(calls.some((u) => u.includes("completeUploadExternal"))).toBe(true);

  // The staged blob is cleaned up after the post (Slack now hosts the file).
  const blobExists = await t.run(
    async (ctx) => (await ctx.storage.get(storageId)) !== null,
  );
  expect(blobExists).toBe(false);
});
