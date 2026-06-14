import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { HostCommandKind } from "../../shared/protocol";

// Referenced by name so the host agent doesn't compile against
// convex/_generated (a separate TS project). The shapes are pinned by
// convex/hosts.ts. Note: shared/protocol imports above must stay type-only —
// the deployed host (~/hostagent) has no shared/ checkout next to it.
const pendingForRef = makeFunctionReference<"query">("hosts:pendingFor");
const ackRef = makeFunctionReference<"mutation">("hosts:ack");
const heartbeatRef = makeFunctionReference<"mutation">("hosts:heartbeat");
/** Deletes a devbox row after the host agent tart-deletes its VM. */
export const removeDevboxRef =
  makeFunctionReference<"mutation">("hosts:removeDevbox");
/** Frees the leaked devbox row and fails the task after a failed provision_vm. */
export const provisionVmFailedRef = makeFunctionReference<"mutation">(
  "hosts:provisionVmFailed",
);
/** Posts fleet lifecycle events (host bootstrap progress/failures). */
export const recordHostEventRef = makeFunctionReference<"mutation">(
  "hosts:recordHostEvent",
);
/** Boot-time reconciliation: fails bootstraps this provisioner left dangling
 * when its process restarted mid-bootstrap (frees the fleet scale-up lock). */
export const failOrphanedProvisionsRef = makeFunctionReference<"mutation">(
  "hosts:failOrphanedProvisions",
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
};

export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Subscribes to this host's pending commands over the Convex client (outbound
 * WebSocket — nothing dials into the host) and executes them serially.
 * Commands are acked even when execution fails: a failed provision_vm reports
 * itself to Convex (freeing the slot and failing the task; see vm.ts), so
 * there is nothing to retry, and redelivering a broken command forever would
 * wedge the queue. Returns a stop function.
 */
export function startHostConsumer(options: HostConsumerOptions): () => void {
  const { client } = options;
  const seen = new Set<string>();
  const auth = { secret: options.secret };
  let chain: Promise<void> = Promise.resolve();

  const unsubscribe = client.onUpdate(
    pendingForRef,
    { hostId: options.hostId, ...auth },
    (commands) => {
      for (const command of selectNewCommands(
        commands as PendingHostCommand[],
        seen,
      )) {
        chain = chain.then(async () => {
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
