import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { MAX_FLEET_LOCK_TTL_MS } from "../src/fleetLock";
import schema from "./schema";

// http.ts registers the router for t.fetch; fleetLock.ts + hosts.ts hold the
// mutations/queries the /fleet/* endpoints call.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
  "./fleetLock.ts": () => import("./fleetLock"),
  "./hosts.ts": () => import("./hosts"),
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

function post(
  t: ReturnType<typeof newT>,
  path: string,
  body: unknown,
  secret = SECRET,
) {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-devbox-secret": secret },
    body: JSON.stringify(body),
  });
}

test("/fleet/lock/acquire rejects a missing/wrong secret (401)", async () => {
  const t = newT();
  const noHeader = await t.fetch("/fleet/lock/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ holder: "gh:1" }),
  });
  expect(noHeader.status).toBe(401);
  const wrong = await post(
    t,
    "/fleet/lock/acquire",
    { holder: "gh:1" },
    "nope",
  );
  expect(wrong.status).toBe(401);
});

test("/fleet/lock/acquire rejects a body with no holder (400)", async () => {
  const t = newT();
  expect((await post(t, "/fleet/lock/acquire", { holder: "" })).status).toBe(
    400,
  );
  expect((await post(t, "/fleet/lock/acquire", { ttlMs: 1000 })).status).toBe(
    400,
  );
  expect((await post(t, "/fleet/lock/acquire", [1, 2, 3])).status).toBe(400);
});

test("/fleet/lock/acquire grants, then a second holder is rejected with heldBy", async () => {
  const t = newT();
  const first = await post(t, "/fleet/lock/acquire", { holder: "gh:1" });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ acquired: true });

  const second = await post(t, "/fleet/lock/acquire", { holder: "laptop:1" });
  expect(await second.json()).toMatchObject({
    acquired: false,
    heldBy: "gh:1",
  });
});

test("/fleet/lock/acquire clamps an absurd ttl so the lease stays reclaimable", async () => {
  const t = newT();
  const before = Date.now();
  const res = await post(t, "/fleet/lock/acquire", {
    holder: "buggy",
    ttlMs: 1000 * 60 * 60_000,
  });
  const body = (await res.json()) as { acquired: boolean; expiresAt: number };
  expect(body.acquired).toBe(true);
  expect(body.expiresAt).toBeLessThanOrEqual(
    before + MAX_FLEET_LOCK_TTL_MS + 5_000,
  );
});

test("/fleet/lock/release frees only the holder's own lock", async () => {
  const t = newT();
  await post(t, "/fleet/lock/acquire", { holder: "gh:1" });
  expect(
    await (await post(t, "/fleet/lock/release", { holder: "x" })).json(),
  ).toEqual({
    released: false,
  });
  expect(
    await (await post(t, "/fleet/lock/release", { holder: "gh:1" })).json(),
  ).toEqual({ released: true });
});

test("/fleet/status requires the secret and returns the snapshot", async () => {
  const t = newT();
  const unauth = await t.fetch("/fleet/status", { method: "GET" });
  expect(unauth.status).toBe(401);

  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
    });
  });
  const ok = await t.fetch("/fleet/status", {
    method: "GET",
    headers: { "x-devbox-secret": SECRET },
  });
  expect(ok.status).toBe(200);
  const snap = (await ok.json()) as { hosts: { hostId: string }[] };
  expect(snap.hosts.map((h) => h.hostId)).toEqual(["host-1"]);
});

test("/fleet/event requires the secret and records into hostEvents", async () => {
  const t = newT();
  expect(
    (
      await post(
        t,
        "/fleet/event",
        { hostId: "h", type: "t", summary: "s" },
        "nope",
      )
    ).status,
  ).toBe(401);
  expect((await post(t, "/fleet/event", { hostId: "h" })).status).toBe(400);

  const ok = await post(t, "/fleet/event", {
    hostId: "ultraclaude-host-2",
    type: "provision_started",
    summary: "go",
  });
  expect(ok.status).toBe(200);
  const events = await t.run(async (ctx) =>
    ctx.db
      .query("hostEvents")
      .withIndex("by_host_id", (q) => q.eq("hostId", "ultraclaude-host-2"))
      .collect(),
  );
  expect(events.map((e) => e.type)).toEqual(["provision_started"]);
});

// #89: the golden-refresh drives draining/rejoin over the secret-gated
// /fleet/host/status endpoint.
test("/fleet/host/status drains a host and validates its body", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "active",
      lastSeenAt: Date.now(),
    });
  });

  expect(
    (
      await post(
        t,
        "/fleet/host/status",
        { hostId: "host-1", status: "draining" },
        "nope",
      )
    ).status,
  ).toBe(401);
  // Missing hostId, and an out-of-range status, are both rejected.
  expect(
    (await post(t, "/fleet/host/status", { status: "draining" })).status,
  ).toBe(400);
  expect(
    (
      await post(t, "/fleet/host/status", {
        hostId: "host-1",
        status: "provisioning",
      })
    ).status,
  ).toBe(400);

  const ok = await post(t, "/fleet/host/status", {
    hostId: "host-1",
    status: "draining",
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ found: true });
  const host = await t.run(async (ctx) =>
    ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", "host-1"))
      .unique(),
  );
  expect(host?.status).toBe("draining");
});

test("/fleet/host/evict force-evicts a host's ephemerals", async () => {
  const t = newT();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("hosts", {
      hostId: "host-1",
      maxVms: 2,
      status: "draining",
      lastSeenAt: now,
    });
    await ctx.db.insert("devboxes", {
      devboxId: "eph-1",
      gatewayUrl: "http://eph-1.ts:8787",
      status: "busy",
      taskId: "task-1",
      hostId: "host-1",
      ephemeral: true,
      lastSeenAt: now,
    });
  });

  expect(
    (await post(t, "/fleet/host/evict", { hostId: "host-1" }, "nope")).status,
  ).toBe(401);
  expect((await post(t, "/fleet/host/evict", {})).status).toBe(400);

  const ok = await post(t, "/fleet/host/evict", { hostId: "host-1" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ evicted: 1, devboxIds: ["eph-1"] });
  const commands = await t.run(async (ctx) =>
    ctx.db.query("hostCommands").collect(),
  );
  expect(commands.map((c) => c.kind)).toEqual(["destroy_vm"]);
});
