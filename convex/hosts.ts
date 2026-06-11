import { v } from "convex/values";
import type { HostVmPayload } from "../shared/protocol";
import { ephemeralGatewayUrl, pickHost } from "../src/hostPool";
import { timingSafeEqual } from "../src/slack";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import { HEARTBEAT_FRESHNESS_MS } from "./devboxes";

export const hostCommandKindValidator = v.union(
  v.literal("provision_vm"),
  v.literal("destroy_vm"),
);

/** Apple's EULA allows 2 concurrent macOS VMs per host. */
const DEFAULT_MAX_VMS = 2;

/**
 * Host agents authenticate with the same shared secret gateways use, passed
 * as a function argument (host agents are Convex clients, so there are no
 * request headers). On mismatch the functions no-op rather than throw: a
 * misconfigured host agent sees an empty queue instead of generating error
 * spam. A console.warn still records the mismatch for diagnosability.
 */
function secretOk(secret: string): boolean {
  const expected = process.env.DEVBOX_SHARED_SECRET;
  const ok =
    expected !== undefined &&
    expected !== "" &&
    timingSafeEqual(secret, expected);
  if (!ok) {
    console.warn(
      "hosts: devbox shared secret mismatch (or DEVBOX_SHARED_SECRET unset); ignoring request",
    );
  }
  return ok;
}

/**
 * Liveness signal + self-registration: the first heartbeat from a new host
 * creates its row (maxVms 2, active), so provisioning a host needs no manual
 * Convex step. allocateEphemeral only places VMs on recently-seen hosts.
 */
export const heartbeat = mutation({
  args: { hostId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const host = await ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", args.hostId))
      .unique();
    if (host !== null) {
      await ctx.db.patch(host._id, { lastSeenAt: Date.now() });
      return;
    }
    await ctx.db.insert("hosts", {
      hostId: args.hostId,
      maxVms: DEFAULT_MAX_VMS,
      status: "active",
      lastSeenAt: Date.now(),
    });
  },
});

/** Reactive query a host agent subscribes to for its own pending commands. */
export const pendingFor = query({
  args: { hostId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return [];
    }
    const rows = await ctx.db
      .query("hostCommands")
      .withIndex("by_host_status", (q) =>
        q.eq("hostId", args.hostId).eq("status", "pending"),
      )
      .collect();
    return rows
      .map((row) => ({
        commandId: row.commandId,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.createdAt,
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
  },
});

export const ack = mutation({
  args: { commandId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const row = await ctx.db
      .query("hostCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
      .unique();
    if (row !== null && row.status === "pending") {
      await ctx.db.patch(row._id, { status: "acked" });
    }
  },
});

/**
 * Called by the host agent after `tart delete` succeeds: removes the devbox
 * row, freeing the VM slot it held on the host (allocateEphemeral counts
 * rows, not statuses).
 */
export const removeDevbox = mutation({
  args: { devboxId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox !== null) {
      await ctx.db.delete(devbox._id);
    }
  },
});

async function enqueueHostCommand(
  ctx: MutationCtx,
  args: {
    hostId: string;
    kind: "provision_vm" | "destroy_vm";
    payload: string;
  },
): Promise<string> {
  const commandId = `hostcmd-${crypto.randomUUID().slice(0, 8)}`;
  await ctx.db.insert("hostCommands", {
    commandId,
    hostId: args.hostId,
    kind: args.kind,
    payload: args.payload,
    status: "pending",
    createdAt: Date.now(),
  });
  return commandId;
}

export const enqueue = internalMutation({
  args: {
    hostId: v.string(),
    kind: hostCommandKindValidator,
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    return await enqueueHostCommand(ctx, args);
  },
});

/**
 * Atomically allocates an ephemeral devbox for a task on a host with spare VM
 * capacity (mutations are serialized, so concurrent allocations cannot
 * oversubscribe a host). Pre-creates the devbox row in "provisioning" with a
 * deterministic gateway URL — the VM joins the tailnet under its devboxId, so
 * the task's start command can be enqueued before the VM exists. Returns null
 * when no active, recently-seen host has a free slot.
 */
export const allocateEphemeral = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    const hosts = await ctx.db.query("hosts").collect();
    // Every devbox row pointing at a host occupies a VM slot, whatever its
    // status: the slot is only freed when the host agent deletes the VM and
    // calls removeDevbox.
    const devboxes = await ctx.db.query("devboxes").collect();
    const vmCountByHost = new Map<string, number>();
    for (const devbox of devboxes) {
      if (devbox.hostId !== undefined) {
        vmCountByHost.set(
          devbox.hostId,
          (vmCountByHost.get(devbox.hostId) ?? 0) + 1,
        );
      }
    }
    const hostId = pickHost({
      hosts: hosts.map((h) => ({
        hostId: h.hostId,
        maxVms: h.maxVms,
        status: h.status,
        lastSeenAt: h.lastSeenAt,
      })),
      vmCountByHost,
      nowMs: Date.now(),
      freshnessMs: HEARTBEAT_FRESHNESS_MS,
    });
    if (hostId === null) {
      return null;
    }

    const tailnetSuffix = process.env.TAILNET_SUFFIX;
    if (tailnetSuffix === undefined || tailnetSuffix === "") {
      // Only fails once a host is actually available, so deployments without
      // hosts keep getting the plain "no capacity" path instead of an error.
      throw new Error(
        "TAILNET_SUFFIX is not set — cannot derive the ephemeral devbox gateway URL",
      );
    }
    const devboxId = `devbox-eph-${crypto.randomUUID().slice(0, 8)}`;
    const gatewayUrl = ephemeralGatewayUrl(devboxId, tailnetSuffix);
    await ctx.db.insert("devboxes", {
      devboxId,
      gatewayUrl,
      status: "provisioning",
      taskId: args.taskId,
      hostId,
      ephemeral: true,
      lastSeenAt: Date.now(),
    });
    return { devboxId, hostId, gatewayUrl };
  },
});

/**
 * Scheduled by devboxes.recordEvent when an ephemeral devbox's task reaches a
 * terminal status, after EPHEMERAL_RETIRE_GRACE_MS (the monitoring page stays
 * reachable in the meantime). Enqueues destroy_vm unless the devbox row is
 * already gone or left "retiring" (e.g. an admin repair).
 */
export const retireDevbox = internalMutation({
  args: { devboxId: v.string() },
  handler: async (ctx, args) => {
    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox === null || devbox.status !== "retiring") {
      return;
    }
    if (devbox.hostId === undefined) {
      console.warn(
        `hosts: devbox ${args.devboxId} is retiring but has no hostId; cannot enqueue destroy_vm`,
      );
      return;
    }
    const payload: HostVmPayload = { devboxId: args.devboxId };
    await enqueueHostCommand(ctx, {
      hostId: devbox.hostId,
      kind: "destroy_vm",
      payload: JSON.stringify(payload),
    });
  },
});
