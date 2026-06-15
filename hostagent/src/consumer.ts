import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { HostCommandKind } from "../../shared/protocol";

// Referenced by name so the host agent doesn't compile against
// convex/_generated (a separate TS project). The shapes are pinned by
// convex/hosts.ts. Note: shared/protocol imports above must stay type-only —
// the deployed host (~/hostagent) has no shared/ checkout next to it.
const pendingForRef = makeFunctionReference<"query">("hosts:pendingFor");
const claimRef = makeFunctionReference<"mutation">("hosts:claim");
const ackRef = makeFunctionReference<"mutation">("hosts:ack");
const heartbeatRef = makeFunctionReference<"mutation">("hosts:heartbeat");
/** Deletes a devbox row after the host agent tart-deletes its VM. */
export const removeDevboxRef =
  makeFunctionReference<"mutation">("hosts:removeDevbox");
/** Frees the leaked devbox row and fails the task after a failed provision_vm. */
export const provisionVmFailedRef = makeFunctionReference<"mutation">(
  "hosts:provisionVmFailed",
);

export type PendingHostCommand = {
  commandId: string;
  kind: HostCommandKind;
  /** JSON-encoded HostVmPayload. */
  payload: string;
  createdAt: number;
};

export type HostCommandExecutor = (
  command: PendingHostCommand,
) => Promise<void>;

/**
 * Returns the not-yet-seen commands in creation order and marks them seen.
 * The subscription re-delivers the full pending set on every update (commands
 * stay pending until acked), so dedupe is what prevents double execution.
 * (Same pattern as gateway/src/commands.ts, against hostCommands.)
 */
export function selectNewCommands(
  commands: PendingHostCommand[],
  seen: Set<string>,
): PendingHostCommand[] {
  const fresh = commands
    .filter((c) => !seen.has(c.commandId))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const c of fresh) {
    seen.add(c.commandId);
  }
  return fresh;
}

export type HostConsumerOptions = {
  /**
   * Created by the caller so it can be shared with the hosts:removeDevbox
   * mutation (one outbound WebSocket per process). The returned stop function
   * takes ownership and closes it.
   */
  client: ConvexClient;
  hostId: string;
  secret: string;
  execute: HostCommandExecutor;
  /** Advertised in every heartbeat (fleet-provisioner role). */
  canProvisionHosts?: boolean;
  heartbeatIntervalMs?: number;
  /** Backoff between claim retries; injectable so tests don't wait. */
  claimRetryDelaysMs?: number[];
};

export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Backoff for retrying a failed claim mutation. The claim runs before any side
 * effect and is idempotent, so retrying is always safe — and necessary: the
 * pendingFor subscription only re-fires when its result changes, so a claim
 * that rejects while the row stays pending would otherwise leave the command
 * idle until an unrelated queue change or a restart. Bounded so a deterministic
 * failure can't wedge the queue forever.
 */
export const CLAIM_RETRY_DELAYS_MS = [250, 1000, 5000, 15000];

/**
 * Subscribes to this host's pending commands over the Convex client (outbound
 * WebSocket — nothing dials into the host) and executes them serially. Each
 * command is claimed (pending -> running) before its side effect and acked
 * (-> acked) after; the claim is what makes execution idempotent across a
 * crash/restart (the in-memory `seen` set is process-local — see hosts.claim,
 * which prevents a replayed provision_vm from double-allocating a VM).
 * Commands are acked even when execution fails: a failed provision_vm reports
 * itself to Convex (freeing the slot and failing the task; see vm.ts), so
 * there is nothing to retry, and redelivering a broken command forever would
 * wedge the queue. Returns a stop function.
 */
export function startHostConsumer(options: HostConsumerOptions): () => void {
  const { client } = options;
  const seen = new Set<string>();
  const auth = { secret: options.secret };
  const claimRetryDelaysMs =
    options.claimRetryDelaysMs ?? CLAIM_RETRY_DELAYS_MS;
  let chain: Promise<void> = Promise.resolve();

  // Claim a command, retrying transient mutation failures in-band (the claim is
  // pre-side-effect and idempotent). Returns the claim outcome, or "give-up"
  // when every attempt failed — at which point the command is dropped from
  // `seen` so a reconnect's redelivery (the subscription re-fires on
  // re-subscribe) gets another shot. Never executes on an unresolved claim.
  const claimWithRetry = async (
    commandId: string,
  ): Promise<boolean | "give-up"> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.mutation(claimRef, {
          commandId,
          ...auth,
        })) as boolean;
      } catch (error) {
        if (attempt >= claimRetryDelaysMs.length) {
          console.error(
            `[hostagent] giving up claiming ${commandId} after ${attempt} retries:`,
            error,
          );
          seen.delete(commandId);
          return "give-up";
        }
        console.error(
          `[hostagent] claim ${commandId} failed (attempt ${attempt + 1}), retrying:`,
          error,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, claimRetryDelaysMs[attempt]),
        );
      }
    }
  };

  const unsubscribe = client.onUpdate(
    pendingForRef,
    { hostId: options.hostId, ...auth },
    (commands) => {
      for (const command of selectNewCommands(
        commands as PendingHostCommand[],
        seen,
      )) {
        chain = chain.then(async () => {
          // Claim before executing. A false return means a prior incarnation
          // already claimed (and ran, or is running) this command after a
          // crash/restart — never replay it.
          const won = await claimWithRetry(command.commandId);
          if (won === "give-up" || !won) {
            return;
          }
          try {
            await options.execute(command);
          } catch (error) {
            console.error(
              `[hostagent] command ${command.commandId} (${command.kind}) failed:`,
              error,
            );
          }
          await client
            .mutation(ackRef, { commandId: command.commandId, ...auth })
            .catch((error) => {
              console.error(
                `[hostagent] failed to ack ${command.commandId}:`,
                error,
              );
            });
        });
      }
    },
  );

  // hosts:heartbeat self-registers the host row, so the first successful
  // heartbeat means "this host is live in Convex". adopt-host.sh tails the
  // log for that line; later heartbeats stay quiet to avoid log spam.
  let firstHeartbeatLogged = false;
  const sendHeartbeat = () => {
    client
      .mutation(heartbeatRef, {
        hostId: options.hostId,
        canProvisionHosts: options.canProvisionHosts === true,
        ...auth,
      })
      .then(
        () => {
          if (!firstHeartbeatLogged) {
            firstHeartbeatLogged = true;
            console.log(
              `[hostagent] first heartbeat acknowledged for ${options.hostId}`,
            );
          }
        },
        (error) => {
          console.error("[hostagent] heartbeat failed:", error);
        },
      );
  };
  sendHeartbeat();
  const heartbeatTimer = setInterval(
    sendHeartbeat,
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
  );

  return () => {
    clearInterval(heartbeatTimer);
    unsubscribe();
    void client.close();
  };
}
