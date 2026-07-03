import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { startCommandConsumer as startConsumer } from "../../shared/commandConsumer";

// Referenced by name so the gateway doesn't compile against convex/_generated
// (a separate TS project). The shapes are pinned by convex/commands.ts.
const refs = {
  pendingFor: makeFunctionReference<"query">("commands:pendingFor"),
  claim: makeFunctionReference<"mutation">("commands:claim"),
  ack: makeFunctionReference<"mutation">("commands:ack"),
  heartbeat: makeFunctionReference<"mutation">("commands:heartbeat"),
};

export type PendingCommand = {
  commandId: string;
  kind: "start" | "user_message" | "interrupt";
  payload: string;
  createdAt: number;
};

export type CommandExecutor = (command: PendingCommand) => Promise<void>;

export type CommandConsumerOptions = {
  /**
   * Created by the caller (one outbound WebSocket per process). The returned
   * stop function takes ownership and closes it.
   */
  client: ConvexClient;
  devboxId: string;
  secret: string;
  execute: CommandExecutor;
};

/**
 * Consumes this devbox's pending commands via the shared consumer
 * (shared/commandConsumer.ts: claim -> execute -> ack, serially, plus
 * heartbeats). Commands are acked even when execution fails: lifecycle
 * events report the failure, and retrying a broken command forever would
 * wedge the queue. Returns a stop function.
 */
export function startCommandConsumer(
  options: CommandConsumerOptions,
): () => void {
  return startConsumer<PendingCommand>({
    client: options.client,
    refs,
    secret: options.secret,
    subscriptionArgs: { devboxId: options.devboxId },
    buildHeartbeatArgs: () => ({ devboxId: options.devboxId }),
    logPrefix: "gateway",
    execute: options.execute,
  });
}
