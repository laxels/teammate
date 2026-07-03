import { describe, expect, test } from "bun:test";
import {
  clampTtlMs,
  DEFAULT_FLEET_LOCK_TTL_MS,
  decideAcquire,
  type FleetLockRow,
  MAX_FLEET_LOCK_TTL_MS,
} from "./fleetLock";

const row = (over: Partial<FleetLockRow> = {}): FleetLockRow => ({
  name: "fleet",
  holder: "laptop:1",
  acquiredAt: 1_000,
  renewedAt: 1_000,
  expiresAt: 10_000,
  ...over,
});

describe("decideAcquire", () => {
  test("inserts when no row exists", () => {
    expect(
      decideAcquire({ existing: null, holder: "gh:1", nowMs: 5_000 }),
    ).toEqual({
      action: "insert",
    });
  });

  test("renews when the same holder re-acquires (idempotent)", () => {
    expect(
      decideAcquire({
        existing: row({ holder: "gh:1" }),
        holder: "gh:1",
        nowMs: 5_000,
      }),
    ).toEqual({ action: "renew" });
  });

  test("renews own lock even after its own lease expired (never rejects self)", () => {
    expect(
      decideAcquire({
        existing: row({ holder: "gh:1", expiresAt: 4_000 }),
        holder: "gh:1",
        nowMs: 5_000,
      }),
    ).toEqual({ action: "renew" });
  });

  test("rejects when a different holder's lease is still live", () => {
    expect(
      decideAcquire({
        existing: row({ holder: "laptop:1", expiresAt: 10_000 }),
        holder: "gh:1",
        nowMs: 9_999,
      }),
    ).toEqual({ action: "reject", heldBy: "laptop:1", expiresAt: 10_000 });
  });

  test("steals when a different holder's lease has expired (boundary inclusive: nowMs === expiresAt)", () => {
    expect(
      decideAcquire({
        existing: row({ holder: "laptop:1", expiresAt: 10_000 }),
        holder: "gh:1",
        nowMs: 10_000,
      }),
    ).toEqual({ action: "steal", stolenFrom: "laptop:1" });
  });
});

describe("clampTtlMs", () => {
  test("passes a normal ttl through unchanged", () => {
    expect(clampTtlMs(60_000)).toBe(60_000);
  });

  test("falls back to the default for undefined / non-positive", () => {
    expect(clampTtlMs(undefined)).toBe(DEFAULT_FLEET_LOCK_TTL_MS);
    expect(clampTtlMs(0)).toBe(DEFAULT_FLEET_LOCK_TTL_MS);
    expect(clampTtlMs(-5)).toBe(DEFAULT_FLEET_LOCK_TTL_MS);
  });

  test("falls back to the default for non-finite (the permanent-wedge inputs)", () => {
    // Infinity survives JSON.parse + Convex v.number(); NaN likewise. Either
    // would make expiresAt non-finite so the lease could never be reclaimed.
    expect(clampTtlMs(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_FLEET_LOCK_TTL_MS,
    );
    expect(clampTtlMs(Number.NaN)).toBe(DEFAULT_FLEET_LOCK_TTL_MS);
  });

  test("caps an absurdly large ttl at the ceiling", () => {
    expect(clampTtlMs(10 * MAX_FLEET_LOCK_TTL_MS)).toBe(MAX_FLEET_LOCK_TTL_MS);
  });
});
