import { v } from "convex/values";
import {
  type HostVmPayload,
  isTerminalTaskStatus,
  type StartTaskRequest,
} from "../shared/protocol";
import {
  ephemeralGatewayUrl,
  inflightProvision,
  nextHostName,
  pickHost,
  pickProvisioner,
} from "../src/hostPool";
import { timingSafeEqual } from "../src/slack";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { deleteCommandsForDevbox, enqueueCommandRow } from "./commands";
import { HEARTBEAT_FRESHNESS_MS } from "./constants";
import { resolveDeliverableFiles, type StoredFile } from "./files";

export const hostCommandKindValidator = v.union(
  v.literal("provision_vm"),
  v.literal("destroy_vm"),
);

/** Apple's EULA allows 2 concurrent macOS VMs per host. */
const DEFAULT_MAX_VMS = 2;

/** Upper bound on event summaries stored in Convex / posted to Slack, so a
 * noisy failure tail can't blow the document/payload size limits. */
const MAX_EVENT_SUMMARY = 500;

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
  args: {
    hostId: v.string(),
    secret: v.string(),
    canProvisionHosts: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const capability = { canProvisionHosts: args.canProvisionHosts === true };
    const host = await ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", args.hostId))
      .unique();
    if (host !== null) {
      // A freshly bootstrapped host's first heartbeat flips its pre-created
      // "provisioning" row to active — and may unblock queued ephemeral tasks.
      const comingOnline = host.status === "provisioning";
      await ctx.db.patch(host._id, {
        lastSeenAt: Date.now(),
        ...capability,
        ...(comingOnline ? { status: "active" as const } : {}),
      });
      if (comingOnline) {
        await recordHostEventRow(ctx, {
          hostId: args.hostId,
          type: "online",
          summary: "Host agent heartbeating — bootstrap complete, slots open.",
        });
        await ctx.scheduler.runAfter(
          0,
          internal.hosts.placeQueuedEphemeralTasks,
          {},
        );
      }
      return;
    }
    await ctx.db.insert("hosts", {
      hostId: args.hostId,
      maxVms: DEFAULT_MAX_VMS,
      status: "active",
      lastSeenAt: Date.now(),
      ...capability,
    });
    await ctx.scheduler.runAfter(
      0,
      internal.hosts.placeQueuedEphemeralTasks,
      {},
    );
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

/**
 * Atomically claims a pending host command (pending -> running) before the
 * host agent runs its side effect. Returns true only to the caller that won
 * the transition; a command already running or acked returns false. This is
 * the persisted idempotency guard mirroring commands.claim: the in-memory
 * `seen` set is lost on restart, so without this a crash between a side effect
 * and its ack would replay the command (re-running a `provision_vm` that
 * double-allocates a VM). Mutations are serialized, so two overlapping
 * incarnations cannot both win the claim.
 */
export const claim = mutation({
  args: { commandId: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    if (!secretOk(args.secret)) {
      return false;
    }
    const row = await ctx.db
      .query("hostCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
      .unique();
    if (row === null || row.status !== "pending") {
      return false;
    }
    await ctx.db.patch(row._id, { status: "running", claimedAt: Date.now() });
    return true;
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
    // Normal path is running -> acked (the host agent claimed first); tolerate
    // a direct pending -> acked too so an ack is never silently dropped.
    if (row !== null && row.status !== "acked") {
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
      // The freed VM slot may unblock a queued ephemeral task.
      await ctx.scheduler.runAfter(
        0,
        internal.hosts.placeQueuedEphemeralTasks,
        {},
      );
    }
  },
});

/**
 * Called by the host agent when provision_vm fails after the partial VM is
 * torn down: deletes the leaked devbox row (freeing the host VM slot — every
 * row counts against capacity regardless of status) and fails the associated
 * task so it surfaces in Slack and the dashboard instead of stalling forever.
 * Mirrors the host-provision failure path, where a `provision_failed` fleet
 * event deletes the pre-created "provisioning" host row (applyFleetEvent).
 * Idempotent: a missing devbox row (an already-cleaned-up retry) is a no-op.
 */
export const provisionVmFailed = mutation({
  args: { devboxId: v.string(), summary: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    const devbox = await ctx.db
      .query("devboxes")
      .withIndex("by_devbox_id", (q) => q.eq("devboxId", args.devboxId))
      .unique();
    if (devbox === null) {
      return;
    }
    const taskId = devbox.taskId;
    await ctx.db.delete(devbox._id);
    // Drop the task's pre-enqueued gateway commands (the `start` command was
    // inserted before the VM existed) so a future gateway reusing the devboxId
    // can't pick up this dead task's command.
    await deleteCommandsForDevbox(ctx, args.devboxId);
    // The freed VM slot may unblock a queued ephemeral task.
    await ctx.scheduler.runAfter(
      0,
      internal.hosts.placeQueuedEphemeralTasks,
      {},
    );
    if (taskId === undefined) {
      return;
    }
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
      .unique();
    // Never regress a task that already reached a terminal status (e.g. a user
    // stopped it before the provision failed).
    if (task === null || isTerminalTaskStatus(task.status)) {
      return;
    }
    const now = Date.now();
    // Cap the summary before it lands in a Convex document / Slack payload: a
    // failing provision step can spew a multi-KB stderr tail, and an oversized
    // taskEvents insert would roll back this whole mutation — leaving the slot
    // leaked. Same 500-char bound recordHostEventRow uses.
    const summary = args.summary.slice(0, MAX_EVENT_SUMMARY);
    await ctx.db.patch(task._id, {
      status: "failed",
      updatedAt: now,
      finishedAt: now,
    });
    await ctx.db.insert("taskEvents", {
      taskId,
      devboxId: args.devboxId,
      type: "failed",
      summary,
      ts: now,
    });
    // Surface the failure the same way a gateway-posted terminal event would:
    // create/refresh the status card to "failed", post a threaded ping, react.
    await ctx.scheduler.runAfter(0, internal.notify.devboxEvent, {
      devboxId: args.devboxId,
      taskId,
      type: "failed",
      summary,
    });
  },
});

/**
 * Fleet lifecycle events (host bootstrap progress, failures) into hostEvents,
 * which get_fleet surfaces. The only writer is the secret-gated /fleet/event
 * HTTP endpoint (the GitHub Actions provisioner / a laptop run): it checks the
 * `x-devbox-secret` header, then calls this — so no Convex client and no
 * per-arg secret are needed. (Host agents no longer post events; the provision
 * executor that did was retired in #87.)
 */
export const recordFleetEvent = internalMutation({
  args: { hostId: v.string(), type: v.string(), summary: v.string() },
  handler: async (ctx, args) => {
    await applyFleetEvent(ctx, args);
  },
});

async function applyFleetEvent(
  ctx: MutationCtx,
  args: { hostId: string; type: string; summary: string },
): Promise<void> {
  await recordHostEventRow(ctx, args);
  // A failed bootstrap drops the pre-created "provisioning" row (if any —
  // #88's monitor pre-creates one) so it stops counting as the in-flight
  // provision, freeing the serialization slot for a retry.
  if (args.type === "provision_failed") {
    const host = await ctx.db
      .query("hosts")
      .withIndex("by_host_id", (q) => q.eq("hostId", args.hostId))
      .unique();
    if (host !== null && host.status === "provisioning") {
      await ctx.db.delete(host._id);
    }
  }
}

async function recordHostEventRow(
  ctx: MutationCtx,
  args: { hostId: string; type: string; summary: string },
): Promise<void> {
  await ctx.db.insert("hostEvents", {
    hostId: args.hostId,
    type: args.type,
    summary: args.summary.slice(0, MAX_EVENT_SUMMARY),
    ts: Date.now(),
  });
}

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
 * Atomically allocates an ephemeral devbox slot for a task on a host with
 * spare VM capacity (mutations are serialized, so concurrent allocations
 * cannot oversubscribe a host). Pre-creates the devbox row in "provisioning"
 * with a deterministic gateway URL — the VM joins the tailnet under its
 * devboxId, so the task's start command can be enqueued before the VM exists.
 * Returns null when no active, recently-seen host has a free slot.
 */
async function allocateEphemeralSlot(
  ctx: MutationCtx,
  taskId: string,
): Promise<{ devboxId: string; hostId: string; gatewayUrl: string } | null> {
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
    hosts,
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
    taskId,
    hostId,
    ephemeral: true,
    lastSeenAt: Date.now(),
  });
  return { devboxId, hostId, gatewayUrl };
}

export const allocateEphemeral = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args) => {
    return await allocateEphemeralSlot(ctx, args.taskId);
  },
});

/**
 * Assigns an allocated slot to a task: patches the task row, enqueues the
 * gateway start command (picked up by the new VM's gateway on first
 * subscription), and enqueues provision_vm to the slot's host agent.
 */
async function dispatchTaskToSlot(
  ctx: MutationCtx,
  task: {
    _id: Id<"tasks">;
    taskId: string;
    prompt: string;
    files?: StoredFile[];
  },
  slot: { devboxId: string; hostId: string },
): Promise<void> {
  await ctx.db.patch(task._id, {
    devboxId: slot.devboxId,
    updatedAt: Date.now(),
  });
  // Shared Slack attachments staged in storage: the freshly booted gateway
  // fetches each by storageId from the secret-gated /devbox/file endpoint (the
  // bot token never reaches the devbox).
  const files = resolveDeliverableFiles(task.files);
  const request: StartTaskRequest = {
    taskId: task.taskId,
    prompt: task.prompt,
    ...(files.length > 0 ? { files } : {}),
  };
  await enqueueCommandRow(ctx, {
    devboxId: slot.devboxId,
    kind: "start",
    payload: JSON.stringify(request),
  });
  const payload: HostVmPayload = { devboxId: slot.devboxId };
  await enqueueHostCommand(ctx, {
    hostId: slot.hostId,
    kind: "provision_vm",
    payload: JSON.stringify(payload),
  });
}

export type PlacementResult =
  | { placed: true; devboxId: string; hostId: string }
  | {
      placed: false;
      // On-demand autoscale on task spillover is gated off (issue #87): an
      // unplaceable task simply stays queued and drains when a slot frees
      // (placeQueuedEphemeralTasks). Proactive capacity growth moves to the
      // background monitor in #88, which fires the GitHub Actions provisioner.
      scaling: { kind: "autoscale_disabled" };
      queuedTasks: number;
    };

/**
 * Places a task on an ephemeral devbox, or — when every slot is taken — leaves
 * it queued. On-demand autoscale on spillover is gated off (#87): the task
 * drains when a slot frees (placeQueuedEphemeralTasks), and the #88 monitor
 * grows the fleet proactively in the background. Plain-function form so other
 * mutations (dashboard retry) can place inside their own transaction.
 */
export async function placeEphemeralTaskRow(
  ctx: MutationCtx,
  taskId: string,
): Promise<PlacementResult> {
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
  if (task === null) {
    throw new Error(`placeEphemeralTask: no task ${taskId}`);
  }
  const slot = await allocateEphemeralSlot(ctx, taskId);
  if (slot !== null) {
    await dispatchTaskToSlot(ctx, task, slot);
    return { placed: true, devboxId: slot.devboxId, hostId: slot.hostId };
  }
  const queued = await queuedEphemeralTasks(ctx);
  return {
    placed: false,
    scaling: { kind: "autoscale_disabled" },
    queuedTasks: queued.length,
  };
}

export const placeEphemeralTask = internalMutation({
  args: { taskId: v.string() },
  handler: async (ctx, args): Promise<PlacementResult> => {
    return await placeEphemeralTaskRow(ctx, args.taskId);
  },
});

async function queuedEphemeralTasks(ctx: MutationCtx) {
  const queued = await ctx.db
    .query("tasks")
    .withIndex("by_status", (q) => q.eq("status", "queued"))
    .collect();
  return queued
    .filter((t) => t.placement === "ephemeral" && t.devboxId === undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Drains queued ephemeral tasks into freed slots, oldest first. Scheduled from
 * heartbeat (a new host came online) and removeDevbox (a slot freed). Tasks
 * that still don't fit stay queued — on-demand autoscale is gated off (#87);
 * the #88 monitor grows the fleet proactively in the background.
 */
export const placeQueuedEphemeralTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const waiting = await queuedEphemeralTasks(ctx);
    for (const task of waiting) {
      const slot = await allocateEphemeralSlot(ctx, task.taskId);
      if (slot === null) {
        break;
      }
      await dispatchTaskToSlot(ctx, task, slot);
    }
  },
});

export type ProvisionDecision =
  | { kind: "provisioning_started"; hostName: string; provisionedBy: string }
  | { kind: "already_provisioning"; hostName: string; requestedAt: number }
  | { kind: "no_provisioner" };

/**
 * Decides whether a new fleet host should be provisioned and, if so, reserves
 * the slot: pre-creates its serialized "provisioning" row (visible in
 * get_fleet) and records the request, returning the chosen host name. One
 * provision in flight at a time (inflightProvision) — never double-provisions.
 *
 * This is the kept Convex decision/serialization machinery (#87 step 2). The
 * on-demand task-spillover trigger that used to call it is gated off; the #88
 * capacity monitor calls requestHostProvision proactively and then fires the
 * GitHub Actions provisioner (repository_dispatch) — GH Actions is the doer
 * now, so this no longer enqueues any host-agent command. Exposed for that
 * monitor and for manual ops (`convex run`).
 */
async function requestHostProvisionRow(
  ctx: MutationCtx,
): Promise<ProvisionDecision> {
  const hosts = await ctx.db.query("hosts").collect();
  const now = Date.now();
  const inflight = inflightProvision(hosts, now);
  if (inflight !== null) {
    return {
      kind: "already_provisioning",
      hostName: inflight.hostId,
      requestedAt: inflight.provisionRequestedAt ?? now,
    };
  }
  const provisioner = pickProvisioner({
    hosts,
    nowMs: now,
    freshnessMs: HEARTBEAT_FRESHNESS_MS,
  });
  if (provisioner === null) {
    return { kind: "no_provisioner" };
  }
  const hostName = nextHostName(hosts.map((h) => h.hostId));
  await ctx.db.insert("hosts", {
    hostId: hostName,
    maxVms: DEFAULT_MAX_VMS,
    status: "provisioning",
    lastSeenAt: now,
    provisionRequestedAt: now,
    provisionedBy: provisioner,
  });
  await recordHostEventRow(ctx, {
    hostId: hostName,
    type: "provision_requested",
    summary: `New Mac host ${hostName} requested (provisioner of record: ${provisioner}).`,
  });
  return { kind: "provisioning_started", hostName, provisionedBy: provisioner };
}

export const requestHostProvision = internalMutation({
  args: {},
  handler: async (ctx): Promise<ProvisionDecision> => {
    return await requestHostProvisionRow(ctx);
  },
});

const RECENT_HOST_EVENTS = 15;

/** Fleet snapshot for the orchestrator's get_fleet tool. */
/** Plain-function form shared with the dashboard's fleet query. */
export async function fleetSnapshotData(ctx: QueryCtx) {
  const hosts = await ctx.db.query("hosts").collect();
  const devboxes = await ctx.db.query("devboxes").collect();
  const queuedTasks = await ctx.db
    .query("tasks")
    .withIndex("by_status", (q) => q.eq("status", "queued"))
    .collect();
  const events = await ctx.db
    .query("hostEvents")
    .order("desc")
    .take(RECENT_HOST_EVENTS);
  const now = Date.now();
  return {
    hosts: hosts.map((host) => ({
      hostId: host.hostId,
      status: host.status,
      canProvisionHosts: host.canProvisionHosts === true,
      vmsInUse: devboxes.filter((d) => d.hostId === host.hostId).length,
      maxVms: host.maxVms,
      secondsSinceSeen: Math.round((now - host.lastSeenAt) / 1000),
      // Raw timestamp for reactive clients (the dashboard): a server-baked
      // age freezes inside a Convex query result until other data changes.
      lastSeenAt: host.lastSeenAt,
      ...(host.status === "provisioning"
        ? {
            provisioningForSeconds: Math.round(
              (now - (host.provisionRequestedAt ?? now)) / 1000,
            ),
            provisionedBy: host.provisionedBy,
          }
        : {}),
    })),
    devboxes: devboxes.map((d) => ({
      devboxId: d.devboxId,
      status: d.status,
      ephemeral: d.ephemeral === true,
      taskId: d.taskId,
      hostId: d.hostId,
    })),
    queuedEphemeralTasks: queuedTasks
      .filter((t) => t.placement === "ephemeral" && t.devboxId === undefined)
      .map((t) => ({ taskId: t.taskId, title: t.title })),
    recentHostEvents: events.reverse().map((e) => ({
      hostId: e.hostId,
      type: e.type,
      summary: e.summary,
      ts: e.ts,
    })),
  };
}

export const fleetSnapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await fleetSnapshotData(ctx);
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
