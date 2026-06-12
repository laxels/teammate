// Pure host-pool helpers shared by the Convex functions (convex/hosts.ts,
// convex/devboxes.ts) and covered by `bun test`. No Convex runtime
// dependencies here.

import { isTerminalTaskStatus, type TaskStatus } from "../shared/protocol";

// ---- Host selection for ephemeral devbox allocation ----

export type HostRow = {
  hostId: string;
  maxVms: number;
  status: "active" | "draining" | "provisioning";
  lastSeenAt: number;
  canProvisionHosts?: boolean;
  provisionRequestedAt?: number;
};

/**
 * Picks the host for a new ephemeral devbox VM. Eligible hosts are "active",
 * heartbeated within `freshnessMs`, and below their VM cap. Devbox rows hold
 * VM slots regardless of status (a provisioning or retiring VM still occupies
 * a slot until its row is removed), so the count includes every row pointing
 * at the host. Among eligible hosts the least loaded wins, spreading VMs
 * across the pool; ties go to input order. Returns null when no host has
 * capacity.
 */
export function pickHost(args: {
  hosts: HostRow[];
  vmCountByHost: ReadonlyMap<string, number>;
  nowMs: number;
  freshnessMs: number;
}): string | null {
  const cutoff = args.nowMs - args.freshnessMs;
  let best: { hostId: string; count: number } | null = null;
  for (const host of args.hosts) {
    if (host.status !== "active" || host.lastSeenAt < cutoff) {
      continue;
    }
    const count = args.vmCountByHost.get(host.hostId) ?? 0;
    if (count >= host.maxVms) {
      continue;
    }
    if (best === null || count < best.count) {
      best = { hostId: host.hostId, count };
    }
  }
  return best?.hostId ?? null;
}

// ---- Fleet scaling ----

/** A bootstrap that hasn't heartbeated within this window is presumed dead
 * (Scaleway delivery + macOS boot + brew/tart + ghcr pull, padded). */
export const HOST_PROVISION_STALE_MS = 90 * 60_000;

/**
 * The next sequential fleet host name. Existing names that don't match the
 * ultraclaude-host-<n> convention (e.g. manually adopted hosts) count for
 * uniqueness but not for numbering.
 */
export function nextHostName(existingHostIds: readonly string[]): string {
  let max = 0;
  for (const hostId of existingHostIds) {
    const match = /^ultraclaude-host-(\d+)$/.exec(hostId);
    if (match?.[1] !== undefined) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `ultraclaude-host-${max + 1}`;
}

/**
 * The in-flight bootstrap, if any. Scale-ups are serialized: one new host at
 * a time, so a burst of queued tasks rides the same bootstrap and the next
 * deficit triggers the next one. Stale provisioning rows (older than
 * `staleMs`) are ignored — a dead bootstrap must not wedge scaling forever.
 */
export function inflightProvision(
  hosts: readonly HostRow[],
  nowMs: number,
  staleMs: number = HOST_PROVISION_STALE_MS,
): HostRow | null {
  for (const host of hosts) {
    if (
      host.status === "provisioning" &&
      (host.provisionRequestedAt ?? 0) > nowMs - staleMs
    ) {
      return host;
    }
  }
  return null;
}

/**
 * Picks the live host that should run a new-host bootstrap: active, fresh,
 * and holding fleet credentials. Load doesn't matter (the bootstrap is mostly
 * network-bound); first match wins for determinism.
 */
export function pickProvisioner(args: {
  hosts: readonly HostRow[];
  nowMs: number;
  freshnessMs: number;
}): string | null {
  const cutoff = args.nowMs - args.freshnessMs;
  for (const host of args.hosts) {
    if (
      host.status === "active" &&
      host.lastSeenAt >= cutoff &&
      host.canProvisionHosts === true
    ) {
      return host.hostId;
    }
  }
  return null;
}

// ---- Deterministic gateway URL for ephemeral devboxes ----

/**
 * The gateway URL is known before the VM exists: the host agent brings the VM
 * onto the tailnet under its devboxId as hostname, so the orchestrator can
 * pre-create the devbox row and enqueue the task's start command — the
 * freshly booted gateway picks it up on first subscription.
 */
export function ephemeralGatewayUrl(
  devboxId: string,
  tailnetSuffix: string,
): string {
  return `http://${devboxId}.${tailnetSuffix}:8787`;
}

// ---- Ephemeral retire decision ----

/**
 * Whether a recorded devbox event should push the devbox into "retiring":
 * only an APPLIED terminal task status on an EPHEMERAL devbox qualifies.
 * Permanent devboxes return to the warm pool instead, and unapplied events
 * (late duplicates that didn't change task state) must not trigger a second
 * retire. Ephemeral devboxes never go back to warm: no task ever runs on a
 * previous task's VM.
 */
export function shouldRetireEphemeralDevbox(args: {
  ephemeral: boolean | undefined;
  statusApplied: boolean;
  incomingStatus: TaskStatus;
}): boolean {
  return (
    args.ephemeral === true &&
    args.statusApplied &&
    isTerminalTaskStatus(args.incomingStatus)
  );
}
