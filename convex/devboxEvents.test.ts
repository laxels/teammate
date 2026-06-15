import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { DevboxEvent } from "../shared/protocol";
import schema from "./schema";

// /devbox/events -> devboxes.recordEvent. Info events (#70) must record on the
// timeline without ever touching task status; status events keep their existing
// behavior. notify.ts is a scheduled action; without a Slack token it no-ops.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./devboxes.ts": () => import("./devboxes"),
  "./notify.ts": () => import("./notify"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "devbox-secret";
let savedSlackToken: string | undefined;

beforeEach(() => {
  process.env.DEVBOX_SHARED_SECRET = SECRET;
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  delete process.env.DEVBOX_SHARED_SECRET;
  if (savedSlackToken !== undefined)
    process.env.SLACK_BOT_TOKEN = savedSlackToken;
});

async function seedRunningTask(t: Tester, taskId: string): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId,
      title: "task",
      prompt: "p",
      status: "running",
      devboxId: "dev-1",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
    });
  });
}

function postEvent(
  t: Tester,
  event: Omit<Partial<DevboxEvent>, "type"> & { type: string },
): Promise<Response> {
  return t.fetch("/devbox/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-devbox-secret": SECRET },
    body: JSON.stringify({
      devboxId: "dev-1",
      taskId: "task-1",
      summary: "s",
      ts: Date.now(),
      ...event,
    }),
  });
}

function readTask(t: Tester, taskId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

function readEvents(t: Tester, taskId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .collect(),
  );
}

test("a tool_result after completion records on the timeline but never regresses status", async () => {
  const t = newT();
  await seedRunningTask(t, "task-1");

  // Task completes.
  expect(
    (await postEvent(t, { type: "completed", summary: "done" })).status,
  ).toBe(200);
  expect((await readTask(t, "task-1"))?.status).toBe("completed");

  // A late tool_result info event arrives — it must be recorded, with its
  // enrichment, but must NOT change the (terminal) task status.
  const res = await postEvent(t, {
    type: "tool_result",
    summary: "Screenshot",
    tool: "left_click",
    detail: "Left-clicked (10, 20).",
    ts: Date.now() + 1,
  });
  expect(res.status).toBe(200);
  expect((await readTask(t, "task-1"))?.status).toBe("completed");

  const events = await readEvents(t, "task-1");
  const info = events.find((e) => e.type === "tool_result");
  expect(info).toMatchObject({
    type: "tool_result",
    tool: "left_click",
    detail: "Left-clicked (10, 20).",
  });
});

test("an assistant_text info event on a fresh task records without driving status", async () => {
  const t = newT();
  // No task row at all: an info event must still be accepted (200) and recorded.
  const res = await postEvent(t, {
    type: "assistant_text",
    summary: "Thinking about it",
    detail: "Here is my full reasoning about the task...",
  });
  expect(res.status).toBe(200);
  const events = await readEvents(t, "task-1");
  expect(events.map((e) => e.type)).toEqual(["assistant_text"]);
  expect(events[0]?.detail).toContain("full reasoning");
});

test("info-event types are accepted by the /devbox/events validator", async () => {
  const t = newT();
  for (const type of ["assistant_text", "tool_call", "tool_result"]) {
    expect((await postEvent(t, { type })).status).toBe(200);
  }
  // A genuinely unknown type is still rejected.
  expect((await postEvent(t, { type: "bogus" })).status).toBe(400);
});
