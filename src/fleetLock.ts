// Pure fleet-lock helpers shared by the Convex functions (convex/fleetLock.ts)
// and covered by `bun test`. No Convex runtime dependencies here.
//
// The fleet lock is the authoritative, cross-origin mutual-exclusion for
// fleet-provisioning operations. Unlike scripts/singleton-lock.sh (a local
// .git filesystem lock that only sees initiators in *this* checkout), this
// lock lives in Convex, so every fleet-mutating op grabs it regardless of
// origin — a laptop run, a GitHub Actions runner, or the future Convex
// capacity monitor (#88). It is a LEASE: a holder must renew before the lease
// expires, so a runner that dies mid-op can't wedge the lock forever — the
// next contender reclaims the expired lease (the distributed analogue of
// singleton-lock's dead-owner steal).

/** Default lease length. Long enough that the renew cadence (≈ttl/3) tolerates
 * a missed renewal or a slow CI step, short enough that a dead holder is
 * reclaimed in minutes rather than the 90-min provision backstop. */
export const DEFAULT_FLEET_LOCK_TTL_MS = 15 * 60_000;

/** Hard ceiling on a lease. A non-finite or absurdly large ttl (e.g. a buggy
 * caller sending `Infinity` — which survives JSON.parse and Convex's v.number()
 * — would make `expiresAt = now + ttl` non-finite, so `now >= expiresAt` is
 * false forever and the lock could NEVER be reclaimed: a permanent fleet-wide
 * wedge recoverable only by hand-deleting the row. Capping at the worst-case
 * provision budget keeps the lease reclaimable while still covering a slow
 * first golden pull. */
export const MAX_FLEET_LOCK_TTL_MS = 2 * 60 * 60_000;

/**
 * Coerce a requested ttl to a safe, finite, positive, bounded value. Applied at
 * the authoritative Convex boundary (both the HTTP door and direct #88-monitor
 * callers), so the lease can always expire and be reclaimed.
 */
export function clampTtlMs(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return DEFAULT_FLEET_LOCK_TTL_MS;
  }
  return Math.min(ttlMs, MAX_FLEET_LOCK_TTL_MS);
}

export type FleetLockRow = {
  name: string;
  holder: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
};

export type AcquireDecision =
  /** No row exists — insert a fresh lease. */
  | { action: "insert" }
  /** This holder already owns it — extend the lease (idempotent re-acquire). */
  | { action: "renew" }
  /** The current lease expired (holder presumed dead) — reclaim it. */
  | { action: "steal"; stolenFrom: string }
  /** Held by a live, different holder — caller must back off. */
  | { action: "reject"; heldBy: string; expiresAt: number };

/**
 * Decides what an acquire attempt should do, given the current row (or null)
 * and the wall clock. The expiry check uses `>=` so a lease is reclaimable the
 * instant it expires. Convex serializes mutations, so the caller applies this
 * decision with no TOCTOU window. Re-acquire by the same holder always renews
 * (never rejects), making a retried acquire safe.
 */
export function decideAcquire(args: {
  existing: FleetLockRow | null;
  holder: string;
  nowMs: number;
}): AcquireDecision {
  const { existing, holder, nowMs } = args;
  if (existing === null) {
    return { action: "insert" };
  }
  if (existing.holder === holder) {
    return { action: "renew" };
  }
  if (nowMs >= existing.expiresAt) {
    return { action: "steal", stolenFrom: existing.holder };
  }
  return {
    action: "reject",
    heldBy: existing.holder,
    expiresAt: existing.expiresAt,
  };
}
