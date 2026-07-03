import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { startCommandConsumer } from "../../shared/commandConsumer";
import type { HostCommandKind } from "../../shared/protocol";

// Referenced by name so the host agent doesn't compile against
// convex/_generated (a separate TS project). The shapes are pinned by
// convex/hosts.ts. Runtime imports from shared/ are fine here:
// deploy-payload.sh ships shared/ to the host as a ~/shared sibling of
// ~/hostagent, and shared/commandConsumer.ts has no runtime dependencies.
const refs = {
  pendingFor: makeFunctionReference<"query">("hosts:pendingFor"),
  claim: makeFunctionReference<"mutation">("hosts:claim"),
  ack: makeFunctionReference<"mutation">("hosts:ack"),
  heartbeat: makeFunctionReference<"mutation">("hosts:heartbeat"),
};
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
  /** Local golden image new ephemerals clone — reported in every heartbeat so
   * a golden-refresh (#89) can confirm the host converged on the new tag. */
  goldenImage?: string;
  /** Injectable so tests don't wait. */
  heartbeatIntervalMs?: number;
};

/**
 * Consumes this host's pending commands via the shared consumer
 * (shared/commandConsumer.ts: claim -> execute -> ack, serially, plus
 * heartbeats). hosts.claim is what prevents a replayed provision_vm from
 * double-allocating a VM across a crash/restart. Commands are acked even
 * when execution fails: a failed provision_vm reports itself to Convex
 * (freeing the slot and failing the task; see vm.ts), so there is nothing
 * to retry. Returns a stop function.
 */
export function startHostConsumer(options: HostConsumerOptions): () => void {
  // hosts:heartbeat self-registers the host row, so the first successful
  // heartbeat means "this host is live in Convex". adopt-host.sh tails the
  // log for that line; later heartbeats stay quiet to avoid log spam.
  let firstHeartbeatLogged = false;
  return startCommandConsumer<PendingHostCommand>({
    client: options.client,
    refs,
    secret: options.secret,
    subscriptionArgs: { hostId: options.hostId },
    buildHeartbeatArgs: () => ({
      hostId: options.hostId,
      canProvisionHosts: options.canProvisionHosts === true,
      ...(options.goldenImage !== undefined
        ? { goldenImage: options.goldenImage }
        : {}),
    }),
    onHeartbeatSuccess: () => {
      if (firstHeartbeatLogged) {
        return;
      }
      firstHeartbeatLogged = true;
      console.log(
        `[hostagent] first heartbeat acknowledged for ${options.hostId}`,
      );
    },
    logPrefix: "hostagent",
    execute: options.execute,
    ...(options.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
      : {}),
  });
}
