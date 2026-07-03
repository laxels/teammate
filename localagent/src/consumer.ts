import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { startCommandConsumer } from "../../shared/commandConsumer";

// Convex function refs by name: the daemon never compiles against
// convex/_generated (same pattern as gateway/src/commands.ts and
// hostagent/src/consumer.ts — this is the third consumer instance).
const refs = {
  pendingFor: makeFunctionReference<"query">("local:pendingFor"),
  claim: makeFunctionReference<"mutation">("local:claim"),
  ack: makeFunctionReference<"mutation">("local:ack"),
  heartbeat: makeFunctionReference<"mutation">("local:heartbeat"),
};

export const reconcileOrphansRef = makeFunctionReference<"mutation">(
  "local:reconcileOrphans",
);

export type PendingLocalCommand = {
  commandId: string;
  kind: "start" | "user_message" | "interrupt";
  /** JSON: StartTaskRequest / UserMessagePayload / InterruptPayload. */
  payload: string;
  createdAt: number;
};

export type LocalConsumerOptions = {
  client: ConvexClient;
  machineId: string;
  secret: string;
  displayName?: string | undefined;
  ownerSlackUser?: string | undefined;
  execute: (command: PendingLocalCommand) => Promise<void>;
  heartbeatIntervalMs?: number;
};

/** Outbound-only subscription to this machine's localCommands queue plus the
 * self-registering 60s heartbeat. Claim/ack/retry semantics live in
 * shared/commandConsumer (tested there); this wires identity + refs. */
export function startLocalConsumer(options: LocalConsumerOptions): () => void {
  let heartbeatLogged = false;
  return startCommandConsumer<PendingLocalCommand>({
    client: options.client,
    refs,
    secret: options.secret,
    subscriptionArgs: { machineId: options.machineId },
    buildHeartbeatArgs: () => ({
      machineId: options.machineId,
      ...(options.displayName === undefined
        ? {}
        : { displayName: options.displayName }),
      ...(options.ownerSlackUser === undefined
        ? {}
        : { ownerSlackUser: options.ownerSlackUser }),
    }),
    onHeartbeatSuccess: () => {
      if (!heartbeatLogged) {
        heartbeatLogged = true;
        // scripts/setup-localagent.sh greps for this exact substring as its
        // installation success gate (like adopt-host.sh does for hostagent).
        console.log(
          `[localagent] first heartbeat acknowledged for ${options.machineId}`,
        );
      }
    },
    logPrefix: "localagent",
    execute: options.execute,
    ...(options.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
  });
}
