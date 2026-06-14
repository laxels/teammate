import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// Referenced by name so the gateway doesn't compile against convex/_generated
// (a separate TS project). The shapes are pinned by convex/commands.ts.
const pendingForRef = makeFunctionReference<"query">("commands:pendingFor");
const claimRef = makeFunctionReference<"mutation">("commands:claim");
const ackRef = makeFunctionReference<"mutation">("commands:ack");
const heartbeatRef = makeFunctionReference<"mutation">("commands:heartbeat");

export type PendingCommand = {
  commandId: string;
  kind: "start" | "user_message" | "interrupt";
  payload: string;
  createdAt: number;
};

export type CommandExecutor = (command: PendingCommand) => Promise<void>;

/**
 * Returns the not-yet-seen commands in creation order and marks them seen.
 * The subscription re-delivers the full pending set on every update (commands
 * stay pending until acked), so dedupe is what prevents double execution.
 */
export function selectNewCommands(
  commands: PendingCommand[],
  seen: Set<string>,
): PendingCommand[] {
  const fresh = commands
    .filter((c) => !seen.has(c.commandId))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const c of fresh) {
    seen.add(c.commandId);
  }
  return fresh;
}

export type CommandConsumerOptions = {
  /**
   * Created by the caller (one outbound WebSocket per process). The returned
   * stop function takes ownership and closes it.
   */
  client: ConvexClient;
  devboxId: string;
  secret: string;
  execute: CommandExecutor;
  heartbeatIntervalMs?: number;
};

export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Subscribes to this devbox's pending commands over the Convex client
 * (outbound WebSocket — nothing dials into the devbox) and executes them
 * serially. Each command is claimed (pending -> running) before its side
 * effect and acked (-> acked) after; the claim is what makes execution
 * idempotent across a crash/restart (the in-memory `seen` set is process-local
 * — see commands.claim). Commands are acked even when execution fails:
 * lifecycle events report the failure, and retrying a broken command forever
 * would wedge the queue. Returns a stop function.
 */
export function startCommandConsumer(
  options: CommandConsumerOptions,
): () => void {
  const { client } = options;
  const seen = new Set<string>();
  const auth = { secret: options.secret };
  let chain: Promise<void> = Promise.resolve();

  const unsubscribe = client.onUpdate(
    pendingForRef,
    { devboxId: options.devboxId, ...auth },
    (commands) => {
      for (const command of selectNewCommands(
        commands as PendingCommand[],
        seen,
      )) {
        chain = chain.then(async () => {
          // Claim before executing. A false return means a prior incarnation
          // already claimed (and ran, or is running) this command after a
          // crash/restart — never replay it. A claim that throws is left
          // pending for redelivery, so drop it from `seen` to allow a retry.
          let won: boolean;
          try {
            won = (await client.mutation(claimRef, {
              commandId: command.commandId,
              ...auth,
            })) as boolean;
          } catch (error) {
            console.error(
              `[gateway] failed to claim ${command.commandId}:`,
              error,
            );
            seen.delete(command.commandId);
            return;
          }
          if (!won) {
            return;
          }
          try {
            await options.execute(command);
          } catch (error) {
            console.error(
              `[gateway] command ${command.commandId} (${command.kind}) failed:`,
              error,
            );
          }
          await client
            .mutation(ackRef, { commandId: command.commandId, ...auth })
            .catch((error) => {
              console.error(
                `[gateway] failed to ack ${command.commandId}:`,
                error,
              );
            });
        });
      }
    },
  );

  const sendHeartbeat = () => {
    client
      .mutation(heartbeatRef, { devboxId: options.devboxId, ...auth })
      .catch((error) => {
        console.error("[gateway] heartbeat failed:", error);
      });
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
