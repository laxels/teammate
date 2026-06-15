import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { MAX_FLEET_LOCK_TTL_MS } from "../src/fleetLock";
import { internal } from "./_generated/api";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./fleetLock.ts": () => import("./fleetLock"),
};

function newT() {
  return convexTest(schema, modules);
}

const NAME = "fleet";

test("acquire on a free lock succeeds and creates the row", async () => {
  const t = newT();
  const res = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 60_000,
  });
  expect(res.acquired).toBe(true);
  const row = await t.query(internal.fleetLock.get, { name: NAME });
  expect(row?.holder).toBe("gh:1");
});

test("a second holder is rejected while the lease is live", async () => {
  const t = newT();
  await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 60_000,
  });
  const res = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "laptop:1",
    ttlMs: 60_000,
  });
  expect(res).toMatchObject({ acquired: false, heldBy: "gh:1" });
  // The original holder is untouched.
  const row = await t.query(internal.fleetLock.get, { name: NAME });
  expect(row?.holder).toBe("gh:1");
});

test("the same holder re-acquiring renews (idempotent) and extends the lease", async () => {
  const t = newT();
  const first = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 1_000,
  });
  const before = await t.query(internal.fleetLock.get, { name: NAME });
  const again = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 600_000,
  });
  expect(again.acquired).toBe(true);
  expect(again.acquired && again.expiresAt).toBeGreaterThan(
    first.acquired ? first.expiresAt : 0,
  );
  // A self-renew extends the lease but PRESERVES acquiredAt (the ownership
  // epoch the #88 monitor reads to measure how long this holder has owned it).
  const after = await t.query(internal.fleetLock.get, { name: NAME });
  expect(after?.acquiredAt).toBe(before?.acquiredAt);
  expect(after && before && after.renewedAt >= before.renewedAt).toBe(true);
});

test("a contender steals an expired lease (dead-holder reclamation)", async () => {
  const t = newT();
  // Seed a lease whose deadline is already in the past — a holder that died
  // without releasing.
  const seededAcquiredAt = Date.now() - 70_000;
  await t.run(async (ctx) => {
    const past = Date.now() - 10_000;
    await ctx.db.insert("fleetLocks", {
      name: NAME,
      holder: "dead-runner",
      acquiredAt: seededAcquiredAt,
      renewedAt: seededAcquiredAt,
      expiresAt: past,
    });
  });
  const res = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:2",
    ttlMs: 60_000,
  });
  expect(res).toMatchObject({ acquired: true, stolenFrom: "dead-runner" });
  const row = await t.query(internal.fleetLock.get, { name: NAME });
  expect(row?.holder).toBe("gh:2");
  // A steal starts a fresh ownership epoch — acquiredAt is reset to ~now, not
  // inherited from the dead holder.
  expect(row && row.acquiredAt > seededAcquiredAt).toBe(true);
});

test("an absurd ttl is clamped so the lease stays reclaimable (no permanent wedge)", async () => {
  const t = newT();
  const before = Date.now();
  // A huge ttl (here ~1000h) — or Infinity/NaN over HTTP — would otherwise push
  // expiresAt so far out the global lock could never be stolen back.
  const res = await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "buggy-caller",
    ttlMs: 1000 * 60 * 60_000,
  });
  expect(res.acquired).toBe(true);
  const row = await t.query(internal.fleetLock.get, { name: NAME });
  // Capped to the ceiling (MAX_FLEET_LOCK_TTL_MS), so it remains reclaimable.
  expect(row && row.expiresAt <= before + MAX_FLEET_LOCK_TTL_MS + 5_000).toBe(
    true,
  );
});

test("renew only succeeds for the current holder", async () => {
  const t = newT();
  await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 1_000,
  });
  const ok = await t.mutation(internal.fleetLock.renew, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 600_000,
  });
  expect(ok.renewed).toBe(true);

  const wrongHolder = await t.mutation(internal.fleetLock.renew, {
    name: NAME,
    holder: "laptop:1",
  });
  expect(wrongHolder).toMatchObject({ renewed: false, heldBy: "gh:1" });

  // Renewing a free lock reports no holder.
  await t.mutation(internal.fleetLock.release, { name: NAME, holder: "gh:1" });
  const free = await t.mutation(internal.fleetLock.renew, {
    name: NAME,
    holder: "gh:1",
  });
  expect(free).toMatchObject({ renewed: false, heldBy: null });
});

test("release frees only the holder's own lock", async () => {
  const t = newT();
  await t.mutation(internal.fleetLock.acquire, {
    name: NAME,
    holder: "gh:1",
    ttlMs: 60_000,
  });
  // A non-holder cannot release it.
  const notMine = await t.mutation(internal.fleetLock.release, {
    name: NAME,
    holder: "laptop:1",
  });
  expect(notMine.released).toBe(false);
  expect(await t.query(internal.fleetLock.get, { name: NAME })).not.toBeNull();

  // The holder can.
  const mine = await t.mutation(internal.fleetLock.release, {
    name: NAME,
    holder: "gh:1",
  });
  expect(mine.released).toBe(true);
  expect(await t.query(internal.fleetLock.get, { name: NAME })).toBeNull();

  // Releasing an already-free lock is a no-op, not an error.
  const again = await t.mutation(internal.fleetLock.release, {
    name: NAME,
    holder: "gh:1",
  });
  expect(again.released).toBe(false);
});

test("locks are independent across names", async () => {
  const t = newT();
  await t.mutation(internal.fleetLock.acquire, {
    name: "fleet",
    holder: "gh:1",
    ttlMs: 60_000,
  });
  // A different lock name (e.g. a future #89 golden-refresh lock) is unaffected.
  const other = await t.mutation(internal.fleetLock.acquire, {
    name: "golden-refresh",
    holder: "gh:1",
    ttlMs: 60_000,
  });
  expect(other.acquired).toBe(true);
});
