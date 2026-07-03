import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import { HEARTBEAT_FRESHNESS_MS } from "./constants";
import schema from "./schema";
import { drainScheduled } from "./test.helpers";

// Local machine mode (#138): registration/heartbeat, the localCommands claim
// lifecycle, the peerMessages request/reply state machine (permission flow,
// spawn/deliver, synthetic replies), local-primary vs helper status ownership
// in recordEvent, and the boot-time orphan reconcile.
//
// notify.ts must be in the module map: peerRequest schedules
// notify.localAccessRequest and reconcileOrphans schedules notify.devboxEvent;
// both no-op without SLACK_BOT_TOKEN.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./local.ts": () => import("./local"),
  "./notify.ts": () => import("./notify"),
};

function newT() {
  return convexTest(schema, modules);
}

type Tester = ReturnType<typeof newT>;

const SECRET = "local-secret";
const MACHINE = "mac-1";
const TASK = "task-1";
const DEVBOX = "dev-1";

let savedSlackToken: string | undefined;

beforeEach(() => {
  process.env.LOCAL_MACHINE_SECRET = SECRET;
  process.env.DEVBOX_SHARED_SECRET = "s3cret";
  savedSlackToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
});

afterEach(() => {
  delete process.env.LOCAL_MACHINE_SECRET;
  delete process.env.DEVBOX_SHARED_SECRET;
  if (savedSlackToken !== undefined)
    process.env.SLACK_BOT_TOKEN = savedSlackToken;
  setSystemTime();
});

// ---- Seeding + reading helpers ----

async function seedMachine(
  t: Tester,
  opts: {
    machineId?: string;
    lastSeenAt?: number;
    taskId?: string;
    ownerSlackUser?: string;
  } = {},
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("localMachines", {
      machineId: opts.machineId ?? MACHINE,
      lastSeenAt: opts.lastSeenAt ?? Date.now(),
      ...(opts.taskId === undefined ? {} : { taskId: opts.taskId }),
      ...(opts.ownerSlackUser === undefined
        ? {}
        : { ownerSlackUser: opts.ownerSlackUser }),
    });
  });
}

async function seedTask(
  t: Tester,
  opts: {
    taskId?: string;
    status?:
      | "queued"
      | "running"
      | "needs_input"
      | "completed"
      | "failed"
      | "stopped";
    devboxId?: string;
    localMachineId?: string;
    localAccess?: { status: "requested" | "granted" | "denied" };
    placement?: "local" | "ephemeral";
    slackUser?: string;
  } = {},
): Promise<void> {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("tasks", {
      taskId: opts.taskId ?? TASK,
      title: "task",
      prompt: "go",
      status: opts.status ?? "running",
      slackChannel: "C1",
      createdAt: now,
      updatedAt: now,
      ...(opts.devboxId === undefined ? {} : { devboxId: opts.devboxId }),
      ...(opts.localMachineId === undefined
        ? {}
        : { localMachineId: opts.localMachineId }),
      ...(opts.localAccess === undefined
        ? {}
        : { localAccess: opts.localAccess }),
      ...(opts.placement === undefined ? {} : { placement: opts.placement }),
      ...(opts.slackUser === undefined ? {} : { slackUser: opts.slackUser }),
    });
  });
}

async function seedRequest(
  t: Tester,
  requestId: string,
  body = "read ~/notes.txt",
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("peerMessages", {
      messageId: `peer-${requestId}`,
      taskId: TASK,
      requestId,
      kind: "request",
      body,
      createdAt: Date.now(),
    });
  });
}

function readTask(t: Tester, taskId = TASK) {
  return t.run((ctx) =>
    ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique(),
  );
}

function readMachine(t: Tester, machineId = MACHINE) {
  return t.run((ctx) =>
    ctx.db
      .query("localMachines")
      .withIndex("by_machine_id", (q) => q.eq("machineId", machineId))
      .unique(),
  );
}

function peerRows(t: Tester, taskId = TASK) {
  return t.run((ctx) =>
    ctx.db
      .query("peerMessages")
      .withIndex("by_task", (q) => q.eq("taskId", taskId))
      .collect(),
  );
}

function commandsFor(t: Tester, machineId = MACHINE) {
  return t.run(async (ctx) =>
    (await ctx.db.query("localCommands").collect()).filter(
      (c) => c.machineId === machineId,
    ),
  );
}

function taskEventTypes(t: Tester, taskId = TASK): Promise<string[]> {
  return t.run(async (ctx) =>
    (
      await ctx.db
        .query("taskEvents")
        .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
        .collect()
    ).map((e) => e.type),
  );
}

/** How many scheduled functions (any state) match `needle` by name. */
function scheduledCount(t: Tester, needle: string): Promise<number> {
  return t.run(
    async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes(needle),
      ).length,
  );
}

function commandStatus(
  t: Tester,
  commandId: string,
): Promise<string | undefined> {
  return t.run(async (ctx) => {
    const row = await ctx.db
      .query("localCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", commandId))
      .unique();
    return row?.status;
  });
}

// ---- Registration / heartbeat ----

test("heartbeat with a wrong secret registers nothing", async () => {
  const t = newT();
  await t.mutation(api.local.heartbeat, { machineId: MACHINE, secret: "no" });
  expect(await readMachine(t)).toBeNull();
});

test("first heartbeat self-registers; later ones refresh liveness + metadata", async () => {
  const t = newT();
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  await t.mutation(api.local.heartbeat, {
    machineId: MACHINE,
    secret: SECRET,
    displayName: "Axel's Mac",
    ownerSlackUser: "U1",
  });
  const first = await readMachine(t);
  expect(first).toMatchObject({
    machineId: MACHINE,
    displayName: "Axel's Mac",
    ownerSlackUser: "U1",
    lastSeenAt: t0,
  });

  setSystemTime(new Date(t0 + 60_000));
  await t.mutation(api.local.heartbeat, {
    machineId: MACHINE,
    secret: SECRET,
    displayName: "Axel's MacBook",
  });
  const machines = await t.run((ctx) =>
    ctx.db.query("localMachines").collect(),
  );
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    displayName: "Axel's MacBook",
    ownerSlackUser: "U1",
    lastSeenAt: t0 + 60_000,
  });
});

// ---- localCommands queue ----

test("pendingFor lists only pending commands, oldest first", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    const rows = [
      { commandId: "lcmd-late", status: "pending", createdAt: 2_000 },
      { commandId: "lcmd-early", status: "pending", createdAt: 1_000 },
      { commandId: "lcmd-claimed", status: "running", createdAt: 500 },
    ] as const;
    for (const row of rows) {
      await ctx.db.insert("localCommands", {
        machineId: MACHINE,
        kind: "start",
        payload: "{}",
        ...row,
      });
    }
  });

  const pending = await t.query(api.local.pendingFor, {
    machineId: MACHINE,
    secret: SECRET,
  });
  expect(pending.map((c) => c.commandId)).toEqual(["lcmd-early", "lcmd-late"]);

  expect(
    await t.query(api.local.pendingFor, { machineId: MACHINE, secret: "no" }),
  ).toEqual([]);
});

test("claim wins once (pending -> running), then loses forever; ack finalizes", async () => {
  const t = newT();
  const commandId = await t.mutation(internal.local.enqueue, {
    machineId: MACHINE,
    kind: "start",
    payload: "{}",
  });

  expect(await t.mutation(api.local.claim, { commandId, secret: SECRET })).toBe(
    true,
  );
  expect(await commandStatus(t, commandId)).toBe("running");
  // A daemon restarting with an empty seen-set re-claims: it must lose.
  expect(await t.mutation(api.local.claim, { commandId, secret: SECRET })).toBe(
    false,
  );

  await t.mutation(api.local.ack, { commandId, secret: SECRET });
  expect(await commandStatus(t, commandId)).toBe("acked");
  expect(await t.mutation(api.local.claim, { commandId, secret: SECRET })).toBe(
    false,
  );
});

test("ack tolerates a pending -> acked shortcut", async () => {
  const t = newT();
  const commandId = await t.mutation(internal.local.enqueue, {
    machineId: MACHINE,
    kind: "user_message",
    payload: "{}",
  });
  await t.mutation(api.local.ack, { commandId, secret: SECRET });
  expect(await commandStatus(t, commandId)).toBe("acked");
});

test("claim and ack no-op on a wrong secret", async () => {
  const t = newT();
  const commandId = await t.mutation(internal.local.enqueue, {
    machineId: MACHINE,
    kind: "start",
    payload: "{}",
  });
  expect(await t.mutation(api.local.claim, { commandId, secret: "no" })).toBe(
    false,
  );
  await t.mutation(api.local.ack, { commandId, secret: "no" });
  expect(await commandStatus(t, commandId)).toBe("pending");
});

// ---- peerRequest state machine ----

test("peerRequest rejects unknown tasks, foreign devboxes, and terminal tasks", async () => {
  const t = newT();
  expect(
    await t.mutation(internal.local.peerRequest, {
      taskId: "task-ghost",
      devboxId: DEVBOX,
      requestId: "req-1",
      body: "b",
    }),
  ).toEqual({ state: "unknown_task" });

  await seedTask(t, { devboxId: DEVBOX });
  expect(
    await t.mutation(internal.local.peerRequest, {
      taskId: TASK,
      devboxId: "dev-imposter",
      requestId: "req-1",
      body: "b",
    }),
  ).toEqual({ state: "not_your_task" });

  await seedTask(t, {
    taskId: "task-done",
    status: "completed",
    devboxId: DEVBOX,
  });
  expect(
    await t.mutation(internal.local.peerRequest, {
      taskId: "task-done",
      devboxId: DEVBOX,
      requestId: "req-1",
      body: "b",
    }),
  ).toEqual({ state: "task_terminal" });

  // None of the rejections recorded a request row.
  expect(await peerRows(t)).toEqual([]);
});

test("first request on an ungranted task starts the permission flow once", async () => {
  const t = newT();
  await seedTask(t, { devboxId: DEVBOX, slackUser: "U1" });
  await seedMachine(t);

  const first = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-1",
    body: "open the signed-in banking app",
  });
  expect(first).toEqual({ state: "permission_requested" });
  expect((await readTask(t))?.localAccess?.status).toBe("requested");
  const rows = await peerRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "request", requestId: "req-1" });
  expect(await taskEventTypes(t)).toEqual(["peer_request"]);
  expect(await scheduledCount(t, "localAccessRequest")).toBe(1);

  // A second request while the ask is pending reports, records its request,
  // but never re-asks the user.
  const second = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-2",
    body: "also check the calendar",
  });
  expect(second).toEqual({ state: "permission_pending" });
  expect((await peerRows(t)).filter((r) => r.kind === "request")).toHaveLength(
    2,
  );
  expect(await scheduledCount(t, "localAccessRequest")).toBe(1);

  // The scheduled ask no-ops without SLACK_BOT_TOKEN; run it so any error
  // surfaces here rather than in the background.
  await drainScheduled(t);
});

test("no registered (or fresh) machine -> no_machine, and no permission flow", async () => {
  const t = newT();
  await seedTask(t, { devboxId: DEVBOX });

  expect(
    await t.mutation(internal.local.peerRequest, {
      taskId: TASK,
      devboxId: DEVBOX,
      requestId: "req-1",
      body: "b",
    }),
  ).toEqual({ state: "no_machine" });

  // A machine whose heartbeat went stale is as good as absent.
  await seedMachine(t, {
    lastSeenAt: Date.now() - HEARTBEAT_FRESHNESS_MS - 1_000,
  });
  expect(
    await t.mutation(internal.local.peerRequest, {
      taskId: TASK,
      devboxId: DEVBOX,
      requestId: "req-2",
      body: "b",
    }),
  ).toEqual({ state: "no_machine" });

  expect((await readTask(t))?.localAccess).toBeUndefined();
  expect(await scheduledCount(t, "localAccessRequest")).toBe(0);
});

test("granted + free machine -> spawned with the request folded into the start prompt", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    slackUser: "U1",
    localAccess: { status: "granted" },
  });
  await seedMachine(t);

  const result = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-1",
    body: "read ~/notes.txt",
  });
  expect(result).toEqual({ state: "spawned", machineId: MACHINE });

  expect((await readTask(t))?.localMachineId).toBe(MACHINE);
  expect((await readMachine(t))?.taskId).toBe(TASK);

  const commands = await commandsFor(t);
  expect(commands.map((c) => c.kind)).toEqual(["start"]);
  const payload = JSON.parse(commands[0]?.payload ?? "{}") as {
    taskId?: string;
    prompt?: string;
  };
  expect(payload.taskId).toBe(TASK);
  expect(payload.prompt).toContain('<peer_request id="req-1">');
  expect(payload.prompt).toContain("read ~/notes.txt");
});

test("granted + live agent -> delivered as a user_message; retries never duplicate", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    localMachineId: MACHINE,
    localAccess: { status: "granted" },
  });
  await seedMachine(t, { taskId: TASK });

  const result = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-2",
    body: "click the export button",
  });
  expect(result).toEqual({ state: "delivered", machineId: MACHINE });

  const commands = await commandsFor(t);
  expect(commands.map((c) => c.kind)).toEqual(["user_message"]);
  const payload = JSON.parse(commands[0]?.payload ?? "{}") as {
    taskId?: string;
    text?: string;
  };
  expect(payload.taskId).toBe(TASK);
  expect(payload.text).toContain('<peer_request id="req-2">');
  expect(payload.text).toContain("click the export button");

  // The cloud gateway retries the POST: same state, no second request row,
  // no second delivery.
  const retry = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-2",
    body: "click the export button",
  });
  expect(retry).toEqual({ state: "delivered", machineId: MACHINE });
  expect((await peerRows(t)).filter((r) => r.kind === "request")).toHaveLength(
    1,
  );
  expect((await commandsFor(t)).map((c) => c.kind)).toEqual(["user_message"]);
});

test("denied task -> denied + an immediate synthetic reply, once", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    localAccess: { status: "denied" },
  });
  await seedMachine(t);

  const result = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-1",
    body: "b",
  });
  expect(result).toEqual({ state: "denied" });
  const replies = (await peerRows(t)).filter((r) => r.kind === "reply");
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ requestId: "req-1" });
  expect(replies[0]?.body).toContain("denied");

  const retry = await t.mutation(internal.local.peerRequest, {
    taskId: TASK,
    devboxId: DEVBOX,
    requestId: "req-1",
    body: "b",
  });
  expect(retry).toEqual({ state: "denied" });
  expect((await peerRows(t)).filter((r) => r.kind === "reply")).toHaveLength(1);
});

// ---- peerReply ----

test("peerReply rejects crosstalk and unknown requests", async () => {
  const t = newT();
  await seedTask(t, { devboxId: DEVBOX, localMachineId: MACHINE });
  await seedRequest(t, "req-1");

  // Only the task's assigned machine may answer for it.
  const wrongMachine = await t.mutation(internal.local.peerReply, {
    machineId: "mac-imposter",
    taskId: TASK,
    requestId: "req-1",
    body: "hijacked",
  });
  expect(wrongMachine.ok).toBe(false);

  const unknownRequest = await t.mutation(internal.local.peerReply, {
    machineId: MACHINE,
    taskId: TASK,
    requestId: "req-ghost",
    body: "answer",
  });
  expect(unknownRequest.ok).toBe(false);

  expect((await peerRows(t)).filter((r) => r.kind === "reply")).toEqual([]);
});

test("peerReply answers once; peerReplyFor surfaces it to the cloud agent", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    localMachineId: MACHINE,
    localAccess: { status: "granted" },
  });
  await seedMachine(t, { taskId: TASK });
  await seedRequest(t, "req-1");

  // Nothing answered yet: the poll sees the live agent but no reply.
  const before = await t.query(internal.local.peerReplyFor, {
    taskId: TASK,
    requestId: "req-1",
  });
  expect(before).toEqual({
    reply: null,
    localAccess: "granted",
    agentActive: true,
  });

  const first = await t.mutation(internal.local.peerReply, {
    machineId: MACHINE,
    taskId: TASK,
    requestId: "req-1",
    body: "the file says 42",
  });
  expect(first).toEqual({ ok: true });
  expect(await taskEventTypes(t)).toEqual(["peer_reply"]);

  const after = await t.query(internal.local.peerReplyFor, {
    taskId: TASK,
    requestId: "req-1",
  });
  expect(after.reply).toBe("the file says 42");

  // A duplicate answer reports success without a duplicate row.
  const second = await t.mutation(internal.local.peerReply, {
    machineId: MACHINE,
    taskId: TASK,
    requestId: "req-1",
    body: "the file says 43",
  });
  expect(second).toEqual({ ok: true, reason: "already answered" });
  expect((await peerRows(t)).filter((r) => r.kind === "reply")).toHaveLength(1);
});

// ---- resolveAccess ----

test("denying resolves every unanswered request with a synthetic reply", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    localAccess: { status: "requested" },
  });
  await seedRequest(t, "req-1");
  await seedRequest(t, "req-2");

  const result = await t.mutation(internal.local.resolveAccess, {
    taskId: TASK,
    decision: "denied",
    requester: "U1",
  });
  expect(result).toMatchObject({ ok: true, decision: "denied" });

  expect((await readTask(t))?.localAccess?.status).toBe("denied");
  const replies = (await peerRows(t)).filter((r) => r.kind === "reply");
  expect(replies.map((r) => r.requestId).sort()).toEqual(["req-1", "req-2"]);
  for (const reply of replies) {
    expect(reply.body).toContain("denied");
  }
});

test("granting with queued requests spawns the helper with them in its start prompt", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    slackUser: "U1",
    localAccess: { status: "requested" },
  });
  await seedMachine(t, { ownerSlackUser: "U1" });
  await seedRequest(t, "req-1", "read ~/notes.txt");
  await seedRequest(t, "req-2", "screenshot the dashboard");

  const result = await t.mutation(internal.local.resolveAccess, {
    taskId: TASK,
    decision: "granted",
    requester: "U1",
  });
  expect(result).toMatchObject({
    ok: true,
    decision: "granted",
    machineId: MACHINE,
  });

  expect((await readTask(t))?.localAccess?.status).toBe("granted");
  expect((await readTask(t))?.localMachineId).toBe(MACHINE);
  expect((await readMachine(t))?.taskId).toBe(TASK);

  const commands = await commandsFor(t);
  expect(commands.map((c) => c.kind)).toEqual(["start"]);
  const payload = JSON.parse(commands[0]?.payload ?? "{}") as {
    prompt?: string;
  };
  expect(payload.prompt).toContain('<peer_request id="req-1">');
  expect(payload.prompt).toContain('<peer_request id="req-2">');
});

test("only the machine's owner may grant access to it", async () => {
  const t = newT();
  await seedTask(t, { devboxId: DEVBOX, localMachineId: MACHINE });
  await seedMachine(t, { ownerSlackUser: "U-owner" });

  const result = await t.mutation(internal.local.resolveAccess, {
    taskId: TASK,
    decision: "granted",
    requester: "U-else",
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toContain("U-owner");
  }
  expect((await readTask(t))?.localAccess).toBeUndefined();
});

test("granting with no online machine fails", async () => {
  const t = newT();
  await seedTask(t, { devboxId: DEVBOX });
  await seedMachine(t, {
    lastSeenAt: Date.now() - HEARTBEAT_FRESHNESS_MS - 1_000,
  });

  const result = await t.mutation(internal.local.resolveAccess, {
    taskId: TASK,
    decision: "granted",
    requester: "U1",
  });
  expect(result.ok).toBe(false);
  expect((await readTask(t))?.localAccess).toBeUndefined();
});

test("re-resolving the same decision is an idempotent no-op", async () => {
  const t = newT();
  await seedTask(t, {
    devboxId: DEVBOX,
    localAccess: { status: "granted" },
  });

  const result = await t.mutation(internal.local.resolveAccess, {
    taskId: TASK,
    decision: "granted",
    requester: "U1",
  });
  expect(result).toMatchObject({ ok: true, decision: "granted" });
  if (result.ok) {
    expect(result.note).toContain("already");
  }
  // No machine got assigned and nothing was enqueued by the no-op.
  expect((await readTask(t))?.localMachineId).toBeUndefined();
  expect(await commandsFor(t)).toEqual([]);
});

// ---- recordEvent: local-primary vs helper ----

test("local-primary lifecycle: started applies, completed frees the machine + interrupts", async () => {
  const t = newT();
  await seedTask(t, {
    status: "queued",
    placement: "local",
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });

  const startTs = Date.now();
  const started = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "started",
    summary: "kicking off",
    ts: startTs,
  });
  expect(started).toEqual({ taskFound: true, applied: true });
  expect(await readTask(t)).toMatchObject({
    status: "running",
    startedAt: startTs,
  });

  const completed = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "completed",
    summary: "all done",
    ts: startTs + 1,
  });
  expect(completed).toEqual({ taskFound: true, applied: true });
  expect(await readTask(t)).toMatchObject({
    status: "completed",
    lastSummary: "all done",
    finishedAt: startTs + 1,
  });
  // The machine frees and the (otherwise idling) session is interrupted.
  expect((await readMachine(t))?.taskId).toBeUndefined();
  const commands = await commandsFor(t);
  expect(commands.map((c) => c.kind)).toEqual(["interrupt"]);
  expect(JSON.parse(commands[0]?.payload ?? "{}")).toEqual({ taskId: TASK });
});

test("a helper's progress/completed never move the cloud agent's task", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    devboxId: DEVBOX,
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });

  const progress = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "progress",
    summary: "helper working",
    ts: Date.now(),
  });
  expect(progress).toEqual({ taskFound: true, applied: false });

  // The helper ends a turn after each answered request — that must not
  // complete the task the CLOUD agent owns.
  const completed = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "completed",
    summary: "helper turn done",
    ts: Date.now(),
  });
  expect(completed).toEqual({ taskFound: true, applied: false });
  expect((await readTask(t))?.status).toBe("running");
  // A completed helper turn keeps the machine (the next request re-uses it).
  expect((await readMachine(t))?.taskId).toBe(TASK);
  expect(await taskEventTypes(t)).toEqual(["progress", "completed"]);
});

test("a helper's needs_input DOES reach the task", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    devboxId: DEVBOX,
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });

  const result = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "needs_input",
    summary: "may I click the pay button?",
    ts: Date.now(),
  });
  expect(result).toEqual({ taskFound: true, applied: true });
  expect((await readTask(t))?.status).toBe("needs_input");
});

test("a helper's failure synthesizes replies + frees the machine, task untouched", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    devboxId: DEVBOX,
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });
  await seedRequest(t, "req-1");

  const result = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "failed",
    summary: "session crashed",
    ts: Date.now(),
  });
  expect(result).toEqual({ taskFound: true, applied: false });
  // The cloud agent's task keeps running...
  expect((await readTask(t))?.status).toBe("running");
  // ...but its blocked await_local_result unblocks via a synthetic reply.
  const replies = (await peerRows(t)).filter((r) => r.kind === "reply");
  expect(replies).toHaveLength(1);
  expect(replies[0]?.requestId).toBe("req-1");
  expect((await readMachine(t))?.taskId).toBeUndefined();
});

test("events from a machine that is not the task's assignment never move it", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    placement: "local",
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });

  const result = await t.mutation(internal.local.recordEvent, {
    machineId: "mac-stale",
    taskId: TASK,
    type: "completed",
    summary: "stale session claiming victory",
    ts: Date.now(),
  });
  expect(result).toEqual({ taskFound: true, applied: false });
  expect((await readTask(t))?.status).toBe("running");
  expect((await readMachine(t))?.taskId).toBe(TASK);
});

test("info events record on the timeline and refresh liveness, never status", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    placement: "local",
    localMachineId: MACHINE,
  });
  const staleSeenAt = Date.now() - 60_000;
  await seedMachine(t, { taskId: TASK, lastSeenAt: staleSeenAt });

  const result = await t.mutation(internal.local.recordEvent, {
    machineId: MACHINE,
    taskId: TASK,
    type: "tool_call",
    summary: "left_click",
    tool: "computer",
    ts: Date.now(),
  });
  expect(result).toEqual({ taskFound: true, applied: false });
  expect(await taskEventTypes(t)).toEqual(["tool_call"]);
  expect((await readTask(t))?.status).toBe("running");
  // Any event proves the daemon is alive.
  const machine = await readMachine(t);
  expect(machine?.lastSeenAt).toBeGreaterThan(staleSeenAt);
});

// ---- reconcileOrphans ----

test("a still-pending start command is not an orphan; bad secrets reconcile nothing", async () => {
  const t = newT();
  await seedTask(t, {
    status: "queued",
    placement: "local",
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });
  await t.mutation(internal.local.enqueue, {
    machineId: MACHINE,
    kind: "start",
    payload: JSON.stringify({ taskId: TASK, prompt: "go" }),
  });

  expect(
    await t.mutation(api.local.reconcileOrphans, {
      machineId: MACHINE,
      secret: "no",
    }),
  ).toEqual({ reconciled: 0 });

  // The booting daemon is about to consume that start — nothing to reconcile.
  expect(
    await t.mutation(api.local.reconcileOrphans, {
      machineId: MACHINE,
      secret: SECRET,
    }),
  ).toEqual({ reconciled: 0 });
  expect((await readTask(t))?.status).toBe("queued");
  expect((await readMachine(t))?.taskId).toBe(TASK);
});

test("a dead local-primary session terminally fails the task", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    placement: "local",
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });
  // The start was consumed before the daemon died.
  const commandId = await t.mutation(internal.local.enqueue, {
    machineId: MACHINE,
    kind: "start",
    payload: JSON.stringify({ taskId: TASK, prompt: "go" }),
  });
  await t.mutation(api.local.claim, { commandId, secret: SECRET });
  await t.mutation(api.local.ack, { commandId, secret: SECRET });
  await seedRequest(t, "req-1");

  const result = await t.mutation(api.local.reconcileOrphans, {
    machineId: MACHINE,
    secret: SECRET,
  });
  expect(result).toEqual({ reconciled: 1 });

  const task = await readTask(t);
  expect(task?.status).toBe("failed");
  expect(task?.finishedAt).toBeDefined();
  expect((await readMachine(t))?.taskId).toBeUndefined();
  expect(await taskEventTypes(t)).toContain("failed");
  const replies = (await peerRows(t)).filter((r) => r.kind === "reply");
  expect(replies.map((r) => r.requestId)).toEqual(["req-1"]);
  // The Slack notification is scheduled (no-op without a token).
  expect(await scheduledCount(t, "devboxEvent")).toBe(1);
  await drainScheduled(t);
});

test("a helper orphan frees the machine + unblocks the cloud agent, task untouched", async () => {
  const t = newT();
  await seedTask(t, {
    status: "running",
    devboxId: DEVBOX,
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });
  await seedRequest(t, "req-1");

  const result = await t.mutation(api.local.reconcileOrphans, {
    machineId: MACHINE,
    secret: SECRET,
  });
  expect(result).toEqual({ reconciled: 1 });

  expect((await readTask(t))?.status).toBe("running");
  expect((await readMachine(t))?.taskId).toBeUndefined();
  const replies = (await peerRows(t)).filter((r) => r.kind === "reply");
  expect(replies.map((r) => r.requestId)).toEqual(["req-1"]);
  expect(await scheduledCount(t, "devboxEvent")).toBe(0);
});

test("a machine still pointing at a terminal task just frees", async () => {
  const t = newT();
  await seedTask(t, {
    status: "completed",
    placement: "local",
    localMachineId: MACHINE,
  });
  await seedMachine(t, { taskId: TASK });

  const result = await t.mutation(api.local.reconcileOrphans, {
    machineId: MACHINE,
    secret: SECRET,
  });
  expect(result).toEqual({ reconciled: 1 });
  expect((await readTask(t))?.status).toBe("completed");
  expect((await readMachine(t))?.taskId).toBeUndefined();
});
