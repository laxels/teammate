// Local machine mode (#138): the Convex side of the localagent daemon.
//
// A localagent daemon on the user's own Mac mirrors the gateway pattern
// against its own control plane: `local:heartbeat` self-registers a
// localMachines row, `local:pendingFor/claim/ack` drive the localCommands
// queue (same claim lifecycle as `commands`/`hostCommands`), and
// /local/events records LocalAgentEvents. The agent<->agent peer channel
// (peerMessages) also lives here: cloud agents file requests, local agents
// answer, and the orchestrator LLM stays out of the loop after the one
// permission ask.
//
// This module must not import tasks.ts / devboxes.ts / hosts.ts (they import
// it for the local-release hooks); it keeps its own task lookup.

import { type Infer, v } from "convex/values";
import { secretMatches } from "../shared/auth";
import {
  type InterruptPayload,
  isTerminalTaskStatus,
  LOCAL_ACCESS_DENIED_REPLY,
  PEER_BODY_MAX_CHARS,
  type StartTaskRequest,
  shouldApplyTaskStatus,
  statusForEvent,
  type UserMessagePayload,
} from "../shared/protocol";
import {
  buildLocalHelperPrompt,
  excerptLine,
  formatPeerRequestMessage,
  pickLocalMachine,
} from "../src/orchestration";
import { internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server";
import { devboxEventTypeValidator, HEARTBEAT_FRESHNESS_MS } from "./constants";
import { resolveDeliverableFiles } from "./files";
import { commandKindValidator } from "./schema";

/**
 * Local daemons authenticate with LOCAL_MACHINE_SECRET — their own trust
 * tier, deliberately not the fleet-wide devbox secret: a leaked fleet
 * credential must never grant the ability to drive a user's real machine
 * (and vice versa). secretMatches lives in shared/auth.ts (not commands.ts)
 * so importing it here can't close an import cycle (devboxes -> local ->
 * commands -> devboxes).
 */
export function localSecretOk(secret: string, context = "local"): boolean {
  return secretMatches(
    process.env.LOCAL_MACHINE_SECRET,
    secret,
    `${context}: local machine secret mismatch (or LOCAL_MACHINE_SECRET unset); ignoring request`,
  );
}

/** Own copy of the task lookup (tasks.ts imports this module). */
async function taskByTaskId(ctx: QueryCtx, taskId: string) {
  return await ctx.db
    .query("tasks")
    .withIndex("by_task_id", (q) => q.eq("taskId", taskId))
    .unique();
}

export async function machineByMachineId(ctx: QueryCtx, machineId: string) {
  return await ctx.db
    .query("localMachines")
    .withIndex("by_machine_id", (q) => q.eq("machineId", machineId))
    .unique();
}

type MachineRow = NonNullable<Awaited<ReturnType<typeof machineByMachineId>>>;

function machineOnline(machine: MachineRow, now: number): boolean {
  return now - machine.lastSeenAt <= HEARTBEAT_FRESHNESS_MS;
}

// ---- Registration / heartbeat ----

/** True when a start command for `taskId` is still on its way to the machine
 * (pending, or claimed-but-unacked while the daemon downloads files / boots
 * the session). While one is in flight, a heartbeat that doesn't yet report
 * the task must not be read as "the session is gone". */
async function startInFlight(
  ctx: QueryCtx,
  machineId: string,
  taskId: string,
): Promise<boolean> {
  for (const status of ["pending", "running"] as const) {
    const rows = await ctx.db
      .query("localCommands")
      .withIndex("by_machine_status", (q) =>
        q.eq("machineId", machineId).eq("status", status),
      )
      .collect();
    for (const row of rows) {
      if (row.kind !== "start") {
        continue;
      }
      try {
        if (
          (JSON.parse(row.payload) as { taskId?: unknown }).taskId === taskId
        ) {
          return true;
        }
      } catch {
        // Malformed payload can't be correlated; ignore.
      }
    }
  }
  return false;
}

/**
 * Self-registering liveness signal, mirroring hosts.heartbeat: the first
 * heartbeat creates the machine row; later ones refresh lastSeenAt and the
 * reported metadata.
 *
 * The heartbeat also RECONCILES the machine's busy marker: the daemon reports
 * the task its live session serves (`taskId`), and a machine still marked
 * busy for a task the daemon is NOT running — with no start command in
 * flight — is freed. This is the release path for sessions that end without
 * a terminal event (an interrupt landing on an idle helper emits nothing) and
 * the self-heal for any marker leak; releaseLocalAgentForTask deliberately
 * does NOT free the machine (the session is still winding down when it runs).
 */
export const heartbeat = mutation({
  args: {
    machineId: v.string(),
    secret: v.string(),
    displayName: v.optional(v.string()),
    ownerSlackUser: v.optional(v.string()),
    /** The task the daemon's live session currently serves, if any. */
    taskId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!localSecretOk(args.secret)) {
      return;
    }
    const reported = {
      ...(args.displayName === undefined
        ? {}
        : { displayName: args.displayName }),
      ...(args.ownerSlackUser === undefined
        ? {}
        : { ownerSlackUser: args.ownerSlackUser }),
    };
    const machine = await machineByMachineId(ctx, args.machineId);
    if (machine === null) {
      await ctx.db.insert("localMachines", {
        machineId: args.machineId,
        lastSeenAt: Date.now(),
        ...reported,
      });
      return;
    }
    const freeStaleAssignment =
      machine.taskId !== undefined &&
      machine.taskId !== args.taskId &&
      !(await startInFlight(ctx, args.machineId, machine.taskId));
    await ctx.db.patch(machine._id, {
      lastSeenAt: Date.now(),
      ...reported,
      ...(freeStaleAssignment ? { taskId: undefined } : {}),
    });
  },
});

/** The public projection of a machine row (dashboard fleet cell, orchestrator
 * <local_machines> section, hosts.fleetSnapshotData). */
export function publicMachine(m: MachineRow, now: number) {
  return {
    machineId: m.machineId,
    displayName: m.displayName,
    ownerSlackUser: m.ownerSlackUser,
    taskId: m.taskId,
    lastSeenAt: m.lastSeenAt,
    online: machineOnline(m, now),
  };
}

export const listMachines = internalQuery({
  args: {},
  handler: async (ctx) => {
    const machines = await ctx.db.query("localMachines").collect();
    const now = Date.now();
    return machines.map((m) => publicMachine(m, now));
  },
});

// ---- Command queue (mirrors commands.ts against localCommands) ----

/** Reactive query a local daemon subscribes to for its pending commands. */
export const pendingFor = query({
  args: { machineId: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    if (!localSecretOk(args.secret)) {
      return [];
    }
    const rows = await ctx.db
      .query("localCommands")
      .withIndex("by_machine_status", (q) =>
        q.eq("machineId", args.machineId).eq("status", "pending"),
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

/** Same claim lifecycle as commands.claim: the persisted idempotency guard —
 * a crash after the claim leaves the command "running", never redelivered. */
export const claim = mutation({
  args: { commandId: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    if (!localSecretOk(args.secret)) {
      return false;
    }
    const row = await ctx.db
      .query("localCommands")
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
    if (!localSecretOk(args.secret)) {
      return;
    }
    const row = await ctx.db
      .query("localCommands")
      .withIndex("by_command_id", (q) => q.eq("commandId", args.commandId))
      .unique();
    if (row !== null && row.status !== "acked") {
      await ctx.db.patch(row._id, { status: "acked" });
    }
  },
});

/** Plain-function form so peer/placement mutations can enqueue local commands
 * inside their own transaction. */
export async function enqueueLocalCommandRow(
  ctx: MutationCtx,
  args: {
    machineId: string;
    kind: Infer<typeof commandKindValidator>;
    payload: string;
  },
): Promise<string> {
  const commandId = `lcmd-${crypto.randomUUID().slice(0, 8)}`;
  await ctx.db.insert("localCommands", {
    commandId,
    machineId: args.machineId,
    kind: args.kind,
    payload: args.payload,
    status: "pending",
    createdAt: Date.now(),
  });
  return commandId;
}

export const getMachine = internalQuery({
  args: { machineId: v.string() },
  handler: async (ctx, args) => {
    return await machineByMachineId(ctx, args.machineId);
  },
});

export const enqueue = internalMutation({
  args: {
    machineId: v.string(),
    kind: commandKindValidator,
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    return await enqueueLocalCommandRow(ctx, args);
  },
});

// ---- Local agent events (mirrors devboxes.recordEvent) ----

/**
 * Records a LocalAgentEvent posted by a daemon. Status events drive task
 * status ONLY when the local agent is the task's primary agent (placement
 * "local", no devbox); a split task's helper agent contributes timeline rows
 * and needs_input notifications, but its started/progress/completed must
 * never move the task the CLOUD agent owns. A helper's failed/stopped also
 * synthesizes replies for unanswered peer requests so the blocked cloud
 * agent unblocks instead of waiting out its deadline.
 */
export const recordEvent = internalMutation({
  args: {
    machineId: v.string(),
    taskId: v.string(),
    type: devboxEventTypeValidator,
    summary: v.string(),
    ts: v.number(),
    detail: v.optional(v.string()),
    tool: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("taskEvents", {
      taskId: args.taskId,
      machineId: args.machineId,
      type: args.type,
      summary: args.summary,
      ts: args.ts,
      ...(args.detail === undefined ? {} : { detail: args.detail }),
      ...(args.tool === undefined ? {} : { tool: args.tool }),
      ...(args.imageStorageId === undefined
        ? {}
        : { imageStorageId: args.imageStorageId }),
    });

    // Any event proves daemon liveness. Info events arrive ~every agent step,
    // so only write when meaningfully staler than the 60s heartbeat cadence —
    // each patch fans out to every subscription on the row.
    const machine = await machineByMachineId(ctx, args.machineId);
    if (machine !== null && Date.now() - machine.lastSeenAt > 30_000) {
      await ctx.db.patch(machine._id, { lastSeenAt: Date.now() });
    }

    const incomingStatus = statusForEvent(args.type);
    if (incomingStatus === undefined) {
      return { taskFound: true, applied: false };
    }

    const task = await taskByTaskId(ctx, args.taskId);
    // Events from a machine that is not the task's assigned machine (stale
    // session racing a release) must never move the task.
    const isCurrentAssignment =
      task !== null && task.localMachineId === args.machineId;
    // The local agent owns the task's status only when it is the primary
    // agent. A split task's cloud agent is primary; the helper's lifecycle is
    // its own (each answered request ends a turn -> "completed").
    const isPrimary = isCurrentAssignment && task.devboxId === undefined;
    // needs_input flows to the user regardless of primary-ness: a helper
    // asking a sensitive-action re-ask question must reach the thread.
    const applies =
      task !== null &&
      shouldApplyTaskStatus(task.status, incomingStatus) &&
      (isPrimary || args.type === "needs_input") &&
      isCurrentAssignment;
    if (task !== null && applies) {
      const now = Date.now();
      await ctx.db.patch(task._id, {
        status: incomingStatus,
        lastSummary: args.summary,
        updatedAt: now,
        ...(incomingStatus === "running" && task.startedAt === undefined
          ? { startedAt: args.ts }
          : {}),
        ...(isTerminalTaskStatus(incomingStatus)
          ? { finishedAt: args.ts }
          : {}),
      });
    }

    if (task !== null && isCurrentAssignment) {
      if (isPrimary && applies && isTerminalTaskStatus(incomingStatus)) {
        // Primary local task finished: the daemon itself reported the
        // terminal status, so the session is done — free the machine now and
        // stop the (finished-but-steerable) session.
        await releaseLocalAgentForTask(
          ctx,
          task,
          `The task ended (${incomingStatus}) before this request was answered.`,
          { freeMachine: true },
        );
      } else if (
        !isPrimary &&
        (args.type === "failed" || args.type === "stopped")
      ) {
        // Helper agent died mid-task: unblock the cloud agent. "completed"
        // is NOT synthesized — a helper completes a turn after every
        // answered request, and a request delivered mid-turn would be
        // answered on the next one. The machine frees now: the daemon just
        // told us the session ended.
        await synthesizePeerReplies(
          ctx,
          args.taskId,
          `The local agent ended (${args.type}) before answering this request: ${excerptLine(args.summary)}`,
        );
        if (machine !== null && machine.taskId === args.taskId) {
          await ctx.db.patch(machine._id, { taskId: undefined });
        }
      }
    }

    // Helper "needs_input" applies task status but arrives while the cloud
    // agent keeps working; notify like any applied status event.
    return { taskFound: task !== null, applied: applies };
  },
});

// ---- Peer channel ----

async function peerRequestsForTask(ctx: QueryCtx, taskId: string) {
  const rows = await ctx.db
    .query("peerMessages")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  return {
    requests: rows.filter((r) => r.kind === "request"),
    replies: rows.filter((r) => r.kind === "reply"),
  };
}

async function unansweredRequests(ctx: QueryCtx, taskId: string) {
  const { requests, replies } = await peerRequestsForTask(ctx, taskId);
  const answered = new Set(replies.map((r) => r.requestId));
  return requests.filter((r) => !answered.has(r.requestId));
}

async function insertPeerRow(
  ctx: MutationCtx,
  args: {
    taskId: string;
    requestId: string;
    kind: "request" | "reply";
    body: string;
  },
): Promise<void> {
  await ctx.db.insert("peerMessages", {
    messageId: `peer-${crypto.randomUUID().slice(0, 8)}`,
    taskId: args.taskId,
    requestId: args.requestId,
    kind: args.kind,
    body: args.body.slice(0, PEER_BODY_MAX_CHARS),
    createdAt: Date.now(),
  });
}

/** Timeline row for peer traffic (type "peer_request"/"peer_reply"): the
 * dashboard renders these; they never drive status and never reach Slack. */
async function insertPeerEvent(
  ctx: MutationCtx,
  args: {
    taskId: string;
    type: "peer_request" | "peer_reply";
    body: string;
    devboxId?: string;
    machineId?: string;
  },
): Promise<void> {
  await ctx.db.insert("taskEvents", {
    taskId: args.taskId,
    type: args.type,
    summary: excerptLine(args.body),
    detail: args.body.slice(0, PEER_BODY_MAX_CHARS),
    ts: Date.now(),
    ...(args.devboxId === undefined ? {} : { devboxId: args.devboxId }),
    ...(args.machineId === undefined ? {} : { machineId: args.machineId }),
  });
}

/** Inserts synthetic replies for every unanswered request of a task, so a
 * cloud agent blocked on await_local_result always unblocks when local help
 * is off the table (denial, helper death, task teardown). */
export async function synthesizePeerReplies(
  ctx: MutationCtx,
  taskId: string,
  text: string,
): Promise<number> {
  const pending = await unansweredRequests(ctx, taskId);
  for (const request of pending) {
    await insertPeerRow(ctx, {
      taskId,
      requestId: request.requestId,
      kind: "reply",
      body: text,
    });
    await insertPeerEvent(ctx, {
      taskId,
      type: "peer_reply",
      body: `(synthetic) ${text}`,
    });
  }
  return pending.length;
}

/** Spawns the task's local agent on `machine`: assigns both rows and enqueues
 * the start command. Caller has already validated the machine is free. */
async function spawnLocalAgent(
  ctx: MutationCtx,
  task: NonNullable<Awaited<ReturnType<typeof taskByTaskId>>>,
  machine: MachineRow,
  prompt: string,
): Promise<void> {
  await ctx.db.patch(task._id, {
    localMachineId: machine.machineId,
    updatedAt: Date.now(),
  });
  await ctx.db.patch(machine._id, { taskId: task.taskId });
  const start: StartTaskRequest = {
    taskId: task.taskId,
    prompt,
    ...(task.effort === undefined ? {} : { effort: task.effort }),
    ...(task.files === undefined || task.files.length === 0
      ? {}
      : { files: resolveDeliverableFiles(task.files) }),
  };
  await enqueueLocalCommandRow(ctx, {
    machineId: machine.machineId,
    kind: "start",
    payload: JSON.stringify(start),
  });
}

export type PeerRequestState =
  | "delivered"
  | "spawned"
  | "permission_requested"
  | "permission_pending"
  | "denied"
  | "machine_busy"
  | "machine_offline"
  | "no_machine"
  | "unknown_task"
  | "not_your_task"
  | "task_terminal";

/**
 * The machine a spawn (or permission ask) should target, honoring the
 * ownership rule: a FREE eligible machine wins; when every eligible machine
 * is busy the pick reports that (a busy owned machine must not shadow a free
 * unowned one — hence the two-pass filter); no eligible machine at all is the
 * caller's "no_machine".
 */
async function pickSpawnMachine(
  ctx: QueryCtx,
  preferOwner: string | undefined,
): Promise<
  | { kind: "free"; machine: MachineRow }
  | { kind: "busy"; machine: MachineRow }
  | { kind: "none" }
> {
  const machines = await ctx.db.query("localMachines").collect();
  const now = Date.now();
  const opts = { preferOwner, now, freshnessMs: HEARTBEAT_FRESHNESS_MS };
  const free = pickLocalMachine(
    machines.filter((m) => m.taskId === undefined),
    opts,
  );
  if (free !== null) {
    return { kind: "free", machine: free };
  }
  const any = pickLocalMachine(machines, opts);
  return any === null ? { kind: "none" } : { kind: "busy", machine: any };
}

/** The task's existing peer row for a requestId, if any. requestIds are
 * task-scoped: the by_request index can legitimately hold same-requestId rows
 * from different tasks, so lookups filter — never `.unique()`. */
async function peerRowFor(
  ctx: QueryCtx,
  taskId: string,
  requestId: string,
  kind: "request" | "reply",
) {
  const rows = await ctx.db
    .query("peerMessages")
    .withIndex("by_request", (q) =>
      q.eq("requestId", requestId).eq("kind", kind),
    )
    .collect();
  return rows.find((r) => r.taskId === taskId) ?? null;
}

/**
 * A cloud agent requests local work (POST /devbox/peer/request). Records the
 * request, then either delivers it to the live local agent, spawns one (grant
 * present, machine free), or kicks off the permission flow. Idempotent on
 * (taskId, requestId): a retried POST reports state without duplicating the
 * request.
 */
export const peerRequest = internalMutation({
  args: {
    taskId: v.string(),
    devboxId: v.string(),
    requestId: v.string(),
    body: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ state: PeerRequestState; machineId?: string }> => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return { state: "unknown_task" };
    }
    // Crosstalk guard: only the task's current devbox may file requests.
    if (task.devboxId !== args.devboxId) {
      return { state: "not_your_task" };
    }
    if (isTerminalTaskStatus(task.status)) {
      return { state: "task_terminal" };
    }

    const body = args.body.slice(0, PEER_BODY_MAX_CHARS);
    const existing = await peerRowFor(
      ctx,
      args.taskId,
      args.requestId,
      "request",
    );
    const isNew = existing === null;
    if (isNew) {
      await insertPeerRow(ctx, {
        taskId: args.taskId,
        requestId: args.requestId,
        kind: "request",
        body,
      });
      await insertPeerEvent(ctx, {
        taskId: args.taskId,
        type: "peer_request",
        body,
        devboxId: args.devboxId,
      });
    }

    const access = task.localAccess;
    if (access?.status === "denied") {
      if (isNew) {
        await insertPeerRow(ctx, {
          taskId: args.taskId,
          requestId: args.requestId,
          kind: "reply",
          body: LOCAL_ACCESS_DENIED_REPLY,
        });
      }
      return { state: "denied" };
    }

    if (access?.status === "granted") {
      // Live agent: deliver directly (the orchestrator LLM is out of the
      // loop). Delivery is enqueued even when the daemon's heartbeat is stale
      // (it consumes on reconnect), but the state is honest about it so the
      // cloud agent can apply its deadline instead of trusting "delivered".
      if (task.localMachineId !== undefined) {
        const machine = await machineByMachineId(ctx, task.localMachineId);
        if (machine !== null && machine.taskId === task.taskId) {
          if (isNew) {
            const payload: UserMessagePayload = {
              taskId: task.taskId,
              text: formatPeerRequestMessage(args.requestId, body),
            };
            await enqueueLocalCommandRow(ctx, {
              machineId: machine.machineId,
              kind: "user_message",
              payload: JSON.stringify(payload),
            });
          }
          return {
            state: machineOnline(machine, Date.now())
              ? "delivered"
              : "machine_offline",
            machineId: machine.machineId,
          };
        }
      }
      // No live agent: spawn one on a free machine.
      const pick = await pickSpawnMachine(ctx, task.slackUser);
      if (pick.kind === "none") {
        return { state: "no_machine" };
      }
      if (pick.kind === "busy") {
        return { state: "machine_busy", machineId: pick.machine.machineId };
      }
      const pending = await unansweredRequests(ctx, args.taskId);
      await spawnLocalAgent(
        ctx,
        task,
        pick.machine,
        buildLocalHelperPrompt({
          taskId: task.taskId,
          title: task.title,
          requests: pending.map((r) => ({
            requestId: r.requestId,
            body: r.body,
          })),
        }),
      );
      return { state: "spawned", machineId: pick.machine.machineId };
    }

    // No grant yet. Only start the permission flow when a machine exists to
    // grant access TO (busy is fine — permission is per-task, not per-slot);
    // otherwise report the gap immediately.
    const pick = await pickSpawnMachine(ctx, task.slackUser);
    if (pick.kind === "none") {
      return { state: "no_machine" };
    }
    if (access?.status === "requested") {
      return { state: "permission_pending" };
    }
    await ctx.db.patch(task._id, {
      localAccess: { status: "requested", requestedAt: Date.now() },
      updatedAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.notify.localAccessRequest, {
      taskId: args.taskId,
      reason: excerptLine(body),
    });
    return { state: "permission_requested" };
  },
});

/** Poll target for the cloud agent's await_local_result tool. A found reply
 * short-circuits the status lookups (the poll loop's hot exit); agentActive
 * additionally requires a FRESH heartbeat, so a dead daemon reads as
 * inactive and the cloud agent applies its deadline instead of waiting on a
 * machine that will never answer. */
export const peerReplyFor = internalQuery({
  args: { taskId: v.string(), requestId: v.string() },
  handler: async (ctx, args) => {
    const reply = await peerRowFor(ctx, args.taskId, args.requestId, "reply");
    if (reply !== null) {
      return { reply: reply.body, localAccess: null, agentActive: false };
    }
    const task = await taskByTaskId(ctx, args.taskId);
    const machine =
      task?.localMachineId === undefined
        ? null
        : await machineByMachineId(ctx, task.localMachineId);
    return {
      reply: null,
      localAccess: task?.localAccess?.status ?? null,
      agentActive:
        task !== null &&
        machine !== null &&
        machine.taskId === task.taskId &&
        machineOnline(machine, Date.now()),
    };
  },
});

/** A local agent answers a request (POST /local/peer/reply). */
export const peerReply = internalMutation({
  args: {
    machineId: v.string(),
    taskId: v.string(),
    requestId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    // Crosstalk guard: only the task's assigned machine may answer for it.
    if (task.localMachineId !== args.machineId) {
      return {
        ok: false,
        reason: `machine ${args.machineId} is not assigned to task ${args.taskId}`,
      };
    }
    const request = await peerRowFor(
      ctx,
      args.taskId,
      args.requestId,
      "request",
    );
    if (request === null) {
      return { ok: false, reason: `unknown requestId ${args.requestId}` };
    }
    const answered = await peerRowFor(
      ctx,
      args.taskId,
      args.requestId,
      "reply",
    );
    if (answered !== null) {
      return { ok: true, reason: "already answered" };
    }
    await insertPeerRow(ctx, {
      taskId: args.taskId,
      requestId: args.requestId,
      kind: "reply",
      body: args.body,
    });
    await insertPeerEvent(ctx, {
      taskId: args.taskId,
      type: "peer_reply",
      body: args.body,
      machineId: args.machineId,
    });
    return { ok: true };
  },
});

// ---- Permission resolution (orchestrator resolve_local_access tool) ----

export type ResolveAccessOutcome =
  | {
      ok: true;
      decision: "granted" | "denied";
      machineId?: string;
      note: string;
    }
  | { ok: false; reason: string };

export const resolveAccess = internalMutation({
  args: {
    taskId: v.string(),
    decision: v.union(v.literal("granted"), v.literal("denied")),
    /** Slack user id whose message the orchestrator is acting on. */
    requester: v.string(),
  },
  handler: async (ctx, args): Promise<ResolveAccessOutcome> => {
    const task = await taskByTaskId(ctx, args.taskId);
    if (task === null) {
      return { ok: false, reason: `no task with id ${args.taskId}` };
    }
    if (isTerminalTaskStatus(task.status)) {
      return {
        ok: false,
        reason: `task ${args.taskId} is already ${task.status}`,
      };
    }
    if (task.localAccess?.status === args.decision) {
      return {
        ok: true,
        decision: args.decision,
        note: `local access was already ${args.decision} for this task`,
      };
    }

    if (args.decision === "denied") {
      await ctx.db.patch(task._id, {
        localAccess: {
          status: "denied",
          ...(task.localAccess?.requestedAt === undefined
            ? {}
            : { requestedAt: task.localAccess.requestedAt }),
          resolvedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      const answered = await synthesizePeerReplies(
        ctx,
        args.taskId,
        LOCAL_ACCESS_DENIED_REPLY,
      );
      // A denial can REVOKE an earlier grant: a live helper session must be
      // stopped, not left driving the user's machine to finish its request.
      // (The machine's busy marker frees via the daemon's own signals.)
      await releaseLocalAgentForTask(ctx, task, LOCAL_ACCESS_DENIED_REPLY);
      return {
        ok: true,
        decision: "denied",
        note:
          answered > 0
            ? `denial recorded; ${answered} pending local-work request(s) were answered with the denial so the cloud agent unblocks`
            : "denial recorded",
      };
    }

    // Granting: the grant must come from someone entitled to give it. When
    // the task already has a machine, its owner (if any) must be the
    // requester; otherwise pick a machine the requester may offer (their own
    // or an unowned one).
    let machine: MachineRow | null = null;
    if (task.localMachineId !== undefined) {
      machine = await machineByMachineId(ctx, task.localMachineId);
    }
    if (machine === null) {
      const pick = await pickSpawnMachine(ctx, args.requester);
      machine = pick.kind === "none" ? null : pick.machine;
    }
    if (machine === null) {
      return {
        ok: false,
        reason:
          "no online local machine is registered that this user may grant (machines are per-owner; is the localagent daemon running?)",
      };
    }
    if (
      machine.ownerSlackUser !== undefined &&
      machine.ownerSlackUser !== args.requester
    ) {
      return {
        ok: false,
        reason: `machine ${machine.machineId} belongs to <@${machine.ownerSlackUser}> — only its owner may grant access to it`,
      };
    }

    await ctx.db.patch(task._id, {
      localAccess: {
        status: "granted",
        ...(task.localAccess?.requestedAt === undefined
          ? {}
          : { requestedAt: task.localAccess.requestedAt }),
        resolvedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    // Drain any requests that queued while permission was pending: spawn the
    // agent with them folded into its start prompt.
    const pending = await unansweredRequests(ctx, args.taskId);
    const agentLive =
      task.localMachineId !== undefined && machine.taskId === task.taskId;
    if (pending.length > 0 && !agentLive) {
      if (machine.taskId !== undefined && machine.taskId !== task.taskId) {
        return {
          ok: true,
          decision: "granted",
          machineId: machine.machineId,
          note: `grant recorded, but ${machine.machineId} is busy with ${machine.taskId} — the ${pending.length} pending request(s) stay queued; the cloud agent can re-request once the machine frees`,
        };
      }
      await spawnLocalAgent(
        ctx,
        task,
        machine,
        buildLocalHelperPrompt({
          taskId: task.taskId,
          title: task.title,
          requests: pending.map((r) => ({
            requestId: r.requestId,
            body: r.body,
          })),
        }),
      );
      return {
        ok: true,
        decision: "granted",
        machineId: machine.machineId,
        note: `grant recorded; a local agent is starting on ${machine.machineId} with ${pending.length} pending request(s)`,
      };
    }
    return {
      ok: true,
      decision: "granted",
      machineId: machine.machineId,
      note: "grant recorded for this task (whole machine, this task only)",
    };
  },
});

// ---- Local-primary task placement (orchestrator start_task target=local) ----

/** Plain-function form so dashboard.retryTask can place inside its own
 * transaction; the internalMutation wraps it for the orchestrator. */
export async function placeLocalTaskRow(
  ctx: MutationCtx,
  taskId: string,
  machineId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const task = await taskByTaskId(ctx, taskId);
  if (task === null) {
    return { ok: false, reason: `no task with id ${taskId}` };
  }
  const machine = await machineByMachineId(ctx, machineId);
  if (machine === null || !machineOnline(machine, Date.now())) {
    return {
      ok: false,
      reason: `machine ${machineId} is not online (daemon heartbeat stale)`,
    };
  }
  if (machine.taskId !== undefined) {
    return {
      ok: false,
      reason: `machine ${machineId} is busy with ${machine.taskId} — local machines run one task at a time`,
    };
  }
  await spawnLocalAgent(ctx, task, machine, task.prompt);
  return { ok: true };
}

export const placeLocalTask = internalMutation({
  args: { taskId: v.string(), machineId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    return await placeLocalTaskRow(ctx, args.taskId, args.machineId);
  },
});

/**
 * Boot-time orphan reconcile for local daemons, mirroring the gateway's
 * tasks.orphansForDevbox pass: a freshly started daemon owns no sessions, so
 * a machine still marked busy points at a task whose session died with the
 * previous process. A local-primary orphan is terminally failed (event +
 * Slack notify); a split task's helper orphan just releases the machine and
 * synthesizes replies (the cloud agent keeps working). A task whose start
 * command is still PENDING is NOT an orphan — this booting daemon is about to
 * consume it.
 */
export const reconcileOrphans = mutation({
  args: { machineId: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<{ reconciled: number }> => {
    if (!localSecretOk(args.secret)) {
      return { reconciled: 0 };
    }
    const machine = await machineByMachineId(ctx, args.machineId);
    if (machine === null || machine.taskId === undefined) {
      return { reconciled: 0 };
    }
    const taskId = machine.taskId;
    const task = await taskByTaskId(ctx, taskId);
    if (task === null || isTerminalTaskStatus(task.status)) {
      await ctx.db.patch(machine._id, { taskId: undefined });
      return { reconciled: task === null ? 0 : 1 };
    }
    // An undelivered start command means the assignment is ahead of this
    // daemon, not behind it.
    const commands = await ctx.db
      .query("localCommands")
      .withIndex("by_machine_status", (q) =>
        q.eq("machineId", args.machineId).eq("status", "pending"),
      )
      .collect();
    const startStillPending = commands.some((c) => {
      if (c.kind !== "start") {
        return false;
      }
      try {
        return (
          (JSON.parse(c.payload) as { taskId?: unknown }).taskId === taskId
        );
      } catch {
        return false;
      }
    });
    if (startStillPending) {
      return { reconciled: 0 };
    }

    await ctx.db.patch(machine._id, { taskId: undefined });
    await synthesizePeerReplies(
      ctx,
      taskId,
      "The local agent's daemon restarted before this request was answered.",
    );
    const isPrimary = task.devboxId === undefined;
    if (isPrimary) {
      const now = Date.now();
      const summary =
        "The local agent's daemon restarted mid-task; the session was lost.";
      await ctx.db.patch(task._id, {
        status: "failed",
        lastSummary: summary,
        updatedAt: now,
        finishedAt: now,
      });
      await ctx.db.insert("taskEvents", {
        taskId,
        machineId: args.machineId,
        type: "failed",
        summary,
        ts: now,
      });
      await ctx.scheduler.runAfter(0, internal.notify.devboxEvent, {
        machineId: args.machineId,
        taskId,
        type: "failed",
        summary,
      });
    }
    return { reconciled: 1 };
  },
});

/** The task-row slice releaseLocalAgentForTask needs; every caller already
 * holds the freshly-loaded row, so it is passed in rather than re-queried. */
export type TaskForRelease = {
  taskId: string;
  localMachineId?: string | undefined;
};

/**
 * Releases a task's local agent: stops the session (an interrupt — the daemon
 * holds it open between turns otherwise) and synthesizes replies for anything
 * still unanswered. Called from every task-terminal path — cloud events
 * (devboxes.recordEvent), stops (tasks.stopTaskCore), provision failures
 * (hosts.terminallyFailTask), grant revocation (resolveAccess) — and from the
 * local-primary terminal branch of recordEvent. Idempotent.
 *
 * The machine's busy marker is freed ONLY when `freeMachine` is set: the
 * session is typically still winding down when this runs, and an eagerly
 * freed machine lets a new task be placed onto a daemon whose old session is
 * live (busy-reject race) and erases the marker reconcileOrphans needs when
 * the daemon is dead (stranded-task bug). The marker instead clears on the
 * daemon's own signals — the terminal event (recordEvent) or the heartbeat
 * reconcile — except where the caller KNOWS the session is gone (local
 * terminal event applied; offline-machine stop).
 */
export async function releaseLocalAgentForTask(
  ctx: MutationCtx,
  task: TaskForRelease,
  syntheticReplyText: string,
  opts: { freeMachine?: boolean } = {},
): Promise<void> {
  if (task.localMachineId === undefined) {
    return;
  }
  const machine = await machineByMachineId(ctx, task.localMachineId);
  if (machine !== null && machine.taskId === task.taskId) {
    if (opts.freeMachine === true) {
      await ctx.db.patch(machine._id, { taskId: undefined });
    }
    const payload: InterruptPayload = { taskId: task.taskId };
    await enqueueLocalCommandRow(ctx, {
      machineId: machine.machineId,
      kind: "interrupt",
      payload: JSON.stringify(payload),
    });
  }
  await synthesizePeerReplies(ctx, task.taskId, syntheticReplyText);
}
