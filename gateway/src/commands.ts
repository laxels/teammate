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
            `[gateway] giving up claiming ${commandId} after ${attempt} retries:`,
            error,
          );
          seen.delete(commandId);
          return "give-up";
        }
        console.error(
          `[gateway] claim ${commandId} failed (attempt ${attempt + 1}), retrying:`,
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
    { devboxId: options.devboxId, ...auth },
    (commands) => {
      for (const command of selectNewCommands(
        commands as PendingCommand[],
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
