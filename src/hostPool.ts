// Pure host-pool helpers shared by the Convex functions (convex/hosts.ts,
// convex/devboxes.ts) and covered by `bun test`. No Convex runtime
// dependencies here.

import { isTerminalTaskStatus, type TaskStatus } from "../shared/protocol";

// ---- Host selection for ephemeral devbox allocation ----

export type HostRow = {
  hostId: string;
  maxVms: number;
  status: "active" | "draining";
  lastSeenAt: number;
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
