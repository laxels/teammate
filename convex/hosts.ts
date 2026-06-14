import { v } from "convex/values";
import {
  type HostProvisionPayload,
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
  v.literal("provision_host"),
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
 * Mirrors the provision_host failure path, where recordHostEvent deletes the
 * pre-created "provisioning" host row. Idempotent: a missing devbox row (an
 * already-cleaned-up retry) is a no-op.
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

/** Host agents post fleet lifecycle events (bootstrap progress, failures). */
export const recordHostEvent = mutation({
  args: {
    hostId: v.string(),
    type: v.string(),
    summary: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, args) => {
    if (!secretOk(args.secret)) {
      return;
    }
    await recordHostEventRow(ctx, args);
    // A failed bootstrap frees the serialization slot for a retry on the next
    // allocation attempt; mark the pre-created row so it stops counting as
    // in-flight.
    if (args.type === "provision_failed") {
      const host = await ctx.db
        .query("hosts")
        .withIndex("by_host_id", (q) => q.eq("hostId", args.hostId))
        .unique();
      if (host !== null && host.status === "provisioning") {
        await ctx.db.delete(host._id);
      }
    }
  },
});

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

/**
 * Boot-time reconciliation called by a provisioner host agent on startup. A new
 * host bootstrap runs as a DETACHED child of the host-agent process, tracked
 * only by an in-memory flag (hostagent/src/hostProvision.ts). When the agent
 * restarts mid-bootstrap — a crash, or a deploy-payload `kickstart -k` that
 * kills the whole launchd job tree — the bootstrap dies WITHOUT emitting
 * `provision_failed`, so its pre-created "provisioning" host row would keep
 * holding the fleet-wide scale-up lock until HOST_PROVISION_STALE_MS (90 min),
 * blocking every queued task that whole time.
 *
 * The just-restarted provisioner owns no live bootstrap, so any "provisioning"
 * row naming it as `provisionedBy` is orphaned. Fail each (delete the row +
 * record the event), freeing the lock in seconds instead of after 90 min, and
 * re-drain the queue so a fresh bootstrap starts at once rather than waiting for
 * an external event. Mirrors the gateway's boot-time orphan reconciliation
 * (tasks.runningForDevbox).
 *
 * Safe even in the rare case the detached bootstrap survived the restart as an
 * orphaned process: the new host still self-registers an "active" row on its own
 * first heartbeat, so it comes online regardless; at worst a redundant second
 * bootstrap runs, which provision-host.sh makes idempotent (it reuses an
 * existing Scaleway server by name). Idempotent: a second call (nothing
 * orphaned) returns an empty list and schedules nothing.
 */
export const failOrphanedProvisions = mutation({
  args: { provisionerHostId: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<{ failed: string[] }> => {
    if (!secretOk(args.secret)) {
      return { failed: [] };
    }
    const hosts = await ctx.db.query("hosts").collect();
    const orphaned = hosts.filter(
      (host) =>
        host.status === "provisioning" &&
        host.provisionedBy === args.provisionerHostId,
    );
    for (const host of orphaned) {
      await ctx.db.delete(host._id);
      await recordHostEventRow(ctx, {
        hostId: host.hostId,
        type: "provision_failed",
        summary:
          `Provisioner ${args.provisionerHostId} restarted mid-bootstrap; ` +
          "freeing the scale-up lock (the detached bootstrap did not survive the restart).",
      });
    }
    if (orphaned.length > 0) {
      // This mutation is the just-restarted provisioner's first contact with
      // Convex, so it also serves as a liveness signal: refresh its host row
      // before re-draining the queue. Otherwise, if the agent was down longer
      // than HEARTBEAT_FRESHNESS_MS (a crash-loop, a slow deploy, a reboot),
      // the scheduled requestHostProvisionRow's pickProvisioner would see a
      // stale provisioner and return no_provisioner — freeing the lock but
      // never requesting the replacement bootstrap. (The agent's own first
      // heartbeat refreshes lastSeenAt too, but races this scheduled drain and,
      // being a plain active heartbeat, schedules no drain of its own.) The
      // caller owns "provisioning" rows, so it was a credentialed provisioner;
      // its row already exists.
      const self = hosts.find((host) => host.hostId === args.provisionerHostId);
      if (self !== undefined) {
        await ctx.db.patch(self._id, { lastSeenAt: Date.now() });
      }
      await ctx.scheduler.runAfter(
        0,
        internal.hosts.placeQueuedEphemeralTasks,
        {},
      );
    }
    return { failed: orphaned.map((host) => host.hostId) };
  },
});

async function enqueueHostCommand(
  ctx: MutationCtx,
  args: {
    hostId: string;
    kind: "provision_vm" | "destroy_vm" | "provision_host";
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
      scaling:
        | {
            kind: "provisioning_started";
            hostName: string;
            provisionedBy: string;
          }
        | {
            kind: "already_provisioning";
            hostName: string;
            requestedAt: number;
          }
        | { kind: "no_provisioner" };
      queuedTasks: number;
    };

/**
 * Places a task on an ephemeral devbox, or — when every slot is taken —
 * leaves it queued and (idempotently) kicks off a new-host bootstrap. The
 * scale-up is serialized: one new Mac at a time; queued bursts ride the same
 * bootstrap. Plain-function form so other mutations (dashboard retry) can
 * place inside their own transaction.
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
  const scaling = await requestHostProvisionRow(ctx);
  const queued = await queuedEphemeralTasks(ctx);
  return { placed: false, scaling, queuedTasks: queued.length };
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
 * Drains queued ephemeral tasks into freed/new slots, oldest first. Scheduled
 * from heartbeat (new host online) and removeDevbox (slot freed). If tasks
 * remain unplaced and no bootstrap is in flight, requests the next host so a
 * deep queue keeps scaling without waiting for the next start_task call.
 */
export const placeQueuedEphemeralTasks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const waiting = await queuedEphemeralTasks(ctx);
    let unplaced = 0;
    for (const task of waiting) {
      const slot = await allocateEphemeralSlot(ctx, task.taskId);
      if (slot === null) {
        unplaced = waiting.length - waiting.indexOf(task);
        break;
      }
      await dispatchTaskToSlot(ctx, task, slot);
    }
    if (unplaced > 0) {
      await requestHostProvisionRow(ctx);
    }
  },
});

/**
 * Idempotently requests a new fleet host: pre-creates its "provisioning" row
 * (visible in get_fleet) and enqueues provision_host to a credential-holding
 * live host. No-ops with the in-flight bootstrap when one is already running.
 */
async function requestHostProvisionRow(
  ctx: MutationCtx,
): Promise<
  | { kind: "provisioning_started"; hostName: string; provisionedBy: string }
  | { kind: "already_provisioning"; hostName: string; requestedAt: number }
  | { kind: "no_provisioner" }
> {
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
  const payload: HostProvisionPayload = { hostName };
  await enqueueHostCommand(ctx, {
    hostId: provisioner,
    kind: "provision_host",
    payload: JSON.stringify(payload),
  });
  await recordHostEventRow(ctx, {
    hostId: hostName,
    type: "provision_requested",
    summary: `New Mac host requested; bootstrap delegated to ${provisioner}.`,
  });
  return { kind: "provisioning_started", hostName, provisionedBy: provisioner };
}

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
