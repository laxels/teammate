import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { MAX_OUTBOUND_FILE_BYTES } from "../shared/protocol";
import schema from "./schema";
import { drainScheduled } from "./test.helpers";

// Hand-built module map (bun has no import.meta.glob). http.ts registers the
// router for t.fetch; local.ts + capabilities.ts hold the mutations/queries
// the /local/*, /devbox/peer/*, and /fleet/capability-manifest endpoints call;
// notify.ts + artifacts.ts are the 0ms-scheduled follow-ups (both take their
// no-token early return without SLACK_BOT_TOKEN); tasks.ts backs
// artifacts.uploadToSlack's task lookup.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./local.ts": () => import("./local"),
  "./capabilities.ts": () => import("./capabilities"),
  "./artifacts.ts": () => import("./artifacts"),
  "./notify.ts": () => import("./notify"),
  "./tasks.ts": () => import("./tasks"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const LOCAL_SECRET = "local-secret";
const DEVBOX_SECRET = "s3cret";

const SAVED_KEYS = [
  "LOCAL_MACHINE_SECRET",
  "DEVBOX_SHARED_SECRET",
  "SLACK_BOT_TOKEN",
] as const;
let saved: Partial<Record<(typeof SAVED_KEYS)[number], string>> = {};

beforeEach(() => {
  saved = {};
  for (const key of SAVED_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      saved[key] = value;
    }
  }
  process.env.LOCAL_MACHINE_SECRET = LOCAL_SECRET;
  process.env.DEVBOX_SHARED_SECRET = DEVBOX_SECRET;
  // Drained notify/artifact follow-ups must take their no-token early return
  // instead of hitting real Slack (bun loads the repo's `.env` locally).
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function localPost(
  t: Tester,
  path: string,
  body: unknown,
  secret = LOCAL_SECRET,
) {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-local-secret": secret },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function devboxPost(
  t: Tester,
  path: string,
  body: unknown,
  secret = DEVBOX_SECRET,
) {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-devbox-secret": secret },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function seedTask(
  t: Tester,
  opts: {
    taskId: string;
    status: "queued" | "running";
    devboxId?: string;
    localMachineId?: string;
    placement?: "ephemeral" | "local";
  },
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: opts.taskId,
      title: opts.taskId,
      prompt: "go",
      status: opts.status,
      ...(opts.devboxId === undefined ? {} : { devboxId: opts.devboxId }),
      ...(opts.localMachineId === undefined
        ? {}
        : { localMachineId: opts.localMachineId }),
      ...(opts.placement === undefined ? {} : { placement: opts.placement }),
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

function readTask(t: Tester, taskId: string) {
  return t.run((ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

function scheduledNames(t: Tester) {
  return t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map(
      (f) => f.name,
    ),
  );
}

// The whole point of LOCAL_MACHINE_SECRET (#138): a leaked fleet credential
// must never grant the ability to drive a user's real machine, and vice versa.
test("the devbox secret does not open /local/* and the local secret does not open /devbox/*", async () => {
  const t = newT();
  // Fleet-wide devbox secret presented as the local tier: refused.
  expect(
    (await localPost(t, "/local/upload-url", {}, DEVBOX_SECRET)).status,
  ).toBe(401);
  // ...and presented under its own header name on a /local/* route: refused.
  const crossHeader = await t.fetch("/local/upload-url", {
    method: "POST",
    headers: { "x-devbox-secret": DEVBOX_SECRET },
  });
  expect(crossHeader.status).toBe(401);
  // Local secret presented as the devbox tier: refused on every plane.
  expect(
    (
      await devboxPost(
        t,
        "/devbox/peer/request",
        { taskId: "t", devboxId: "d", requestId: "r", body: "b" },
        LOCAL_SECRET,
      )
    ).status,
  ).toBe(401);
  const replyGet = await t.fetch("/devbox/peer/reply?taskId=t&requestId=r", {
    method: "GET",
    headers: { "x-devbox-secret": LOCAL_SECRET },
  });
  expect(replyGet.status).toBe(401);
  expect(
    (
      await devboxPost(
        t,
        "/fleet/capability-manifest",
        { goldenTag: "g" },
        LOCAL_SECRET,
      )
    ).status,
  ).toBe(401);
});

test("/local/events rejects a missing/wrong secret (401) and malformed bodies (400)", async () => {
  const t = newT();
  const event = {
    machineId: "mac-1",
    taskId: "task-lp",
    type: "started",
    summary: "s",
    ts: Date.now(),
  };
  const noHeader = await t.fetch("/local/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  expect(noHeader.status).toBe(401);
  expect((await localPost(t, "/local/events", event, "wrong")).status).toBe(
    401,
  );
  expect((await localPost(t, "/local/events", "{")).status).toBe(400);
  // machineId missing and an unknown event type are both rejected.
  expect(
    (
      await localPost(t, "/local/events", {
        taskId: "task-lp",
        type: "started",
        summary: "s",
        ts: Date.now(),
      })
    ).status,
  ).toBe(400);
  expect(
    (await localPost(t, "/local/events", { ...event, type: "bogus" })).status,
  ).toBe(400);
});

test("/local/events: a local-primary 'started' event flips the task to running and schedules the notify", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "queued",
    placement: "local",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-lp");

  const ts = Date.now();
  const res = await localPost(t, "/local/events", {
    machineId: "mac-1",
    taskId: "task-lp",
    type: "started",
    summary: "kicking off",
    ts,
  });
  expect(res.status).toBe(200);

  const task = await readTask(t, "task-lp");
  expect(task?.status).toBe("running");
  expect(task?.startedAt).toBe(ts);
  expect(task?.lastSummary).toBe("kicking off");
  expect(
    (await scheduledNames(t)).some((name) => name.includes("devboxEvent")),
  ).toBe(true);
  await drainScheduled(t); // notify no-ops without a Slack token
});

test("/local/events: an info event lands on the timeline with machineId and schedules nothing", async () => {
  const t = newT();
  await seedTask(t, {
    taskId: "task-lp",
    status: "running",
    placement: "local",
    localMachineId: "mac-1",
  });

  const res = await localPost(t, "/local/events", {
    machineId: "mac-1",
    taskId: "task-lp",
    type: "tool_call",
    summary: "Clicking the button",
    detail: '{"x":10,"y":20}',
    tool: "left_click",
    ts: Date.now(),
  });
  expect(res.status).toBe(200);

  const events = await t.run((ctx) =>
    ctx.db
      .query("taskEvents")
      .withIndex("by_task_id", (q) => q.eq("taskId", "task-lp"))
      .collect(),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "tool_call",
    machineId: "mac-1",
    tool: "left_click",
    detail: '{"x":10,"y":20}',
  });
  // Info events never drive status and never reach Slack.
  expect((await readTask(t, "task-lp"))?.status).toBe("running");
  expect(await scheduledNames(t)).toEqual([]);
});

test("/local/upload-url is gated by the local secret and returns an upload URL", async () => {
  const t = newT();
  expect((await localPost(t, "/local/upload-url", {}, "wrong")).status).toBe(
    401,
  );
  const ok = await localPost(t, "/local/upload-url", {});
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { url?: unknown };
  expect(typeof body.url).toBe("string");
});

test("/local/file serves staged blobs (401, 400 missing param, 404 missing blob, 200 bytes)", async () => {
  const t = newT();
  const get = (query: string, secret = LOCAL_SECRET) =>
    t.fetch(`/local/file${query}`, {
      method: "GET",
      headers: { "x-local-secret": secret },
    });
  expect(
    (await t.fetch("/local/file?storageId=x", { method: "GET" })).status,
  ).toBe(401);
  expect((await get("?storageId=x", "wrong")).status).toBe(401);
  expect((await get("")).status).toBe(400);
  expect((await get("?storageId=not-a-real-id")).status).toBe(404);

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([7, 8, 9])])),
  );
  const ok = await get(`?storageId=${storageId}`);
  expect(ok.status).toBe(200);
  expect(new Uint8Array(await ok.arrayBuffer())).toEqual(
    new Uint8Array([7, 8, 9]),
  );
});

function artifactForm(bytes: Uint8Array<ArrayBuffer>): FormData {
  const form = new FormData();
  form.set("taskId", "task-art");
  form.set("filename", "shot.png");
  form.set("file", new Blob([bytes]), "shot.png");
  return form;
}

function postArtifact(t: Tester, body: FormData, secret = LOCAL_SECRET) {
  return t.fetch("/local/artifact", {
    method: "POST",
    headers: { "x-local-secret": secret },
    body,
  });
}

test("/local/artifact: 401, 400 malformed, 413 oversize, 202 schedules the Slack upload", async () => {
  const t = newT();
  expect(
    (await postArtifact(t, artifactForm(new Uint8Array([1])), "wrong")).status,
  ).toBe(401);
  // Not multipart at all.
  expect(
    (await localPost(t, "/local/artifact", { taskId: "task-art" })).status,
  ).toBe(400);
  // Multipart but missing file/filename.
  const partial = new FormData();
  partial.set("taskId", "task-art");
  expect((await postArtifact(t, partial)).status).toBe(400);
  // Oversize payloads are refused before storage.
  const oversize = await postArtifact(
    t,
    artifactForm(new Uint8Array(MAX_OUTBOUND_FILE_BYTES + 1)),
  );
  expect(oversize.status).toBe(413);

  const ok = await postArtifact(t, artifactForm(new Uint8Array([1, 2, 3])));
  expect(ok.status).toBe(202);
  expect(
    (await scheduledNames(t)).some((name) => name.includes("uploadToSlack")),
  ).toBe(true);
  await drainScheduled(t); // uploadToSlack no-ops without a Slack token
});

test("/local/peer/reply: 401/400, then a valid reply returns ok and lands in peerMessages", async () => {
  const t = newT();
  const body = {
    machineId: "mac-1",
    taskId: "task-split",
    requestId: "req-1",
    body: "found it",
  };
  expect((await localPost(t, "/local/peer/reply", body, "wrong")).status).toBe(
    401,
  );
  expect((await localPost(t, "/local/peer/reply", "{")).status).toBe(400);
  expect(
    (
      await localPost(t, "/local/peer/reply", {
        machineId: "mac-1",
        taskId: "task-split",
      })
    ).status,
  ).toBe(400);

  // Split task: cloud primary (dev-1) + local helper (mac-1) answering.
  await seedTask(t, {
    taskId: "task-split",
    status: "running",
    devboxId: "dev-1",
    localMachineId: "mac-1",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("peerMessages", {
      messageId: "peer-1",
      taskId: "task-split",
      requestId: "req-1",
      kind: "request",
      body: "check the local file",
      createdAt: Date.now(),
    });
  });

  const ok = await localPost(t, "/local/peer/reply", body);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
  const replies = await t.run((ctx) =>
    ctx.db
      .query("peerMessages")
      .withIndex("by_request", (q) =>
        q.eq("requestId", "req-1").eq("kind", "reply"),
      )
      .collect(),
  );
  expect(replies.map((r) => r.body)).toEqual(["found it"]);
});

test("/devbox/peer/request: 401 and body validation (missing fields, bad requestId)", async () => {
  const t = newT();
  const body = {
    taskId: "task-c",
    devboxId: "dev-1",
    requestId: "req-1",
    body: "need local work",
  };
  expect(
    (await devboxPost(t, "/devbox/peer/request", body, "nope")).status,
  ).toBe(401);
  expect((await devboxPost(t, "/devbox/peer/request", "{")).status).toBe(400);
  expect(
    (
      await devboxPost(t, "/devbox/peer/request", {
        taskId: "task-c",
        requestId: "req-1",
        body: "b",
      })
    ).status,
  ).toBe(400);
  expect(
    (await devboxPost(t, "/devbox/peer/request", { ...body, requestId: "" }))
      .status,
  ).toBe(400);
  expect(
    (
      await devboxPost(t, "/devbox/peer/request", {
        ...body,
        requestId: "r".repeat(65),
      })
    ).status,
  ).toBe(400);
  expect(
    (await devboxPost(t, "/devbox/peer/request", { ...body, body: "" })).status,
  ).toBe(400);
});

test("/devbox/peer/request records the request and starts the permission flow", async () => {
  const t = newT();
  await seedTask(t, { taskId: "task-c", status: "running", devboxId: "dev-1" });
  await seedMachine(t, "mac-1");

  const res = await devboxPost(t, "/devbox/peer/request", {
    taskId: "task-c",
    devboxId: "dev-1",
    requestId: "req-1",
    body: "need the file only your Mac has",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    requestId: "req-1",
    state: "permission_requested",
  });

  // The per-task grant ask is now pending and the Slack ask is scheduled.
  expect((await readTask(t, "task-c"))?.localAccess?.status).toBe("requested");
  const requests = await t.run((ctx) =>
    ctx.db
      .query("peerMessages")
      .withIndex("by_request", (q) =>
        q.eq("requestId", "req-1").eq("kind", "request"),
      )
      .collect(),
  );
  expect(requests).toHaveLength(1);
  expect(
    (await scheduledNames(t)).some((name) =>
      name.includes("localAccessRequest"),
    ),
  ).toBe(true);
  await drainScheduled(t);
});

test("GET /devbox/peer/reply: 401/400, reply is null until a reply row exists", async () => {
  const t = newT();
  const get = (query: string, secret = DEVBOX_SECRET) =>
    t.fetch(`/devbox/peer/reply${query}`, {
      method: "GET",
      headers: { "x-devbox-secret": secret },
    });
  expect((await get("?taskId=t&requestId=r", "nope")).status).toBe(401);
  expect((await get("?taskId=t")).status).toBe(400);
  expect((await get("?requestId=r")).status).toBe(400);

  await seedTask(t, {
    taskId: "task-c",
    status: "running",
    devboxId: "dev-1",
    localMachineId: "mac-1",
  });
  await seedMachine(t, "mac-1", "task-c");
  await t.run(async (ctx) => {
    await ctx.db.insert("peerMessages", {
      messageId: "peer-1",
      taskId: "task-c",
      requestId: "req-1",
      kind: "request",
      body: "q",
      createdAt: Date.now(),
    });
  });

  const pending = await get("?taskId=task-c&requestId=req-1");
  expect(pending.status).toBe(200);
  expect(await pending.json()).toEqual({
    reply: null,
    localAccess: null,
    agentActive: true,
  });

  await t.run(async (ctx) => {
    await ctx.db.insert("peerMessages", {
      messageId: "peer-2",
      taskId: "task-c",
      requestId: "req-1",
      kind: "reply",
      body: "answer: 42",
      createdAt: Date.now(),
    });
  });
  const answered = (await (
    await get("?taskId=task-c&requestId=req-1")
  ).json()) as { reply: string | null };
  expect(answered.reply).toBe("answer: 42");
});

test("/fleet/capability-manifest: 401/400, then 200 upserts one row per goldenTag", async () => {
  const t = newT();
  expect(
    (
      await devboxPost(
        t,
        "/fleet/capability-manifest",
        { goldenTag: "golden-1" },
        "nope",
      )
    ).status,
  ).toBe(401);
  expect((await devboxPost(t, "/fleet/capability-manifest", "{")).status).toBe(
    400,
  );
  expect((await devboxPost(t, "/fleet/capability-manifest", {})).status).toBe(
    400,
  );
  expect(
    (await devboxPost(t, "/fleet/capability-manifest", { goldenTag: "" }))
      .status,
  ).toBe(400);

  const first = await devboxPost(t, "/fleet/capability-manifest", {
    goldenTag: "golden-1",
    generated: "apps: A",
    curated: "notes: v1",
  });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ goldenTag: "golden-1" });

  // Same tag again: an update in place, never a second row.
  const second = await devboxPost(t, "/fleet/capability-manifest", {
    goldenTag: "golden-1",
    generated: "apps: A, B",
    curated: "notes: v2",
  });
  expect(second.status).toBe(200);
  const rows = await t.run((ctx) =>
    ctx.db.query("capabilityManifests").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    goldenTag: "golden-1",
    generated: "apps: A, B",
    curated: "notes: v2",
  });
});
