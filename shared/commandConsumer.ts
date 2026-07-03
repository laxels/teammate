import type { ConvexClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

// This module must stay free of RUNTIME imports (type-only is fine): fleet
// hosts run it from a bare ~/shared rsynced next to ~/hostagent
// (scripts/deploy-payload.sh) with no node_modules on its resolution path.
// Callers construct their own convex function refs (makeFunctionReference)
// and pass them in via `refs`.

/** The fields the consumer needs; callers narrow `kind` to their own union. */
export type ConsumerCommand = {
  commandId: string;
  kind: string;
  createdAt: number;
};

/**
 * Returns the not-yet-seen commands in creation order and marks them seen.
 * The subscription re-delivers the full pending set on every update (commands
 * stay pending until acked), so dedupe is what prevents double execution.
 */
export function selectNewCommands<C extends ConsumerCommand>(
  commands: C[],
  seen: Set<string>,
): C[] {
  const fresh = commands
    .filter((c) => !seen.has(c.commandId))
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const c of fresh) {
    seen.add(c.commandId);
  }
  return fresh;
}

export type CommandConsumerOptions<C extends ConsumerCommand> = {
  /**
   * Created by the caller (one outbound WebSocket per process). The returned
   * stop function takes ownership and closes it.
   */
  client: ConvexClient;
  /** Built by the caller with makeFunctionReference (see the header comment). */
  refs: {
    pendingFor: FunctionReference<"query">;
    claim: FunctionReference<"mutation">;
    ack: FunctionReference<"mutation">;
    heartbeat: FunctionReference<"mutation">;
  };
  /** Spread into every call as `{ secret }`. */
  secret: string;
  /** Args for the pendingFor subscription, sans secret (e.g. `{ devboxId }`). */
  subscriptionArgs: Record<string, unknown>;
  /** Args for each heartbeat mutation, sans secret. */
  buildHeartbeatArgs: () => Record<string, unknown>;
  /** Fires after every successful heartbeat (hostagent logs the first one). */
  onHeartbeatSuccess?: () => void;
  /** Bare tag for log lines, e.g. "gateway" -> "[gateway] ...". */
  logPrefix: string;
  execute: (command: C) => Promise<void>;
  /** Injectable so tests don't wait. */
  heartbeatIntervalMs?: number;
  /** Backoff between claim retries; injectable so tests don't wait. */
  claimRetryDelaysMs?: number[];
};

const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Backoff for retrying a failed claim mutation. The claim runs before any side
 * effect and is idempotent, so retrying is always safe — and necessary: the
 * pendingFor subscription only re-fires when its result changes, so a claim
 * that rejects while the row stays pending would otherwise leave the command
 * idle until an unrelated queue change or a restart. Bounded so a deterministic
 * failure can't wedge the queue forever.
 */
const CLAIM_RETRY_DELAYS_MS = [250, 1000, 5000, 15000];

/**
 * Subscribes to the caller's pending commands over the Convex client
 * (outbound WebSocket — nothing dials in) and executes them serially. Each
 * command is claimed (pending -> running) before its side effect and acked
 * (-> acked) after; the claim is what makes execution idempotent across a
 * crash/restart (the in-memory `seen` set is process-local). Commands are
 * acked even when execution fails: retrying a broken command forever would
 * wedge the queue. Returns a stop function.
 */
export function startCommandConsumer<C extends ConsumerCommand>(
  options: CommandConsumerOptions<C>,
): () => void {
  const { client, refs, logPrefix } = options;
  const seen = new Set<string>();
  const auth = { secret: options.secret };
  const claimRetryDelaysMs =
    options.claimRetryDelaysMs ?? CLAIM_RETRY_DELAYS_MS;
  let chain: Promise<void> = Promise.resolve();

  // Claim a command, retrying transient mutation failures in-band (the claim is
  // pre-side-effect and idempotent). Returns the claim outcome; false is also
  // returned when every attempt failed — at which point the command is dropped
  // from `seen` so a reconnect's redelivery (the subscription re-fires on
  // re-subscribe) gets another shot. Never executes on an unresolved claim.
  const claimWithRetry = async (commandId: string): Promise<boolean> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await client.mutation(refs.claim, {
          commandId,
          ...auth,
        })) as boolean;
      } catch (error) {
        if (attempt >= claimRetryDelaysMs.length) {
          console.error(
            `[${logPrefix}] giving up claiming ${commandId} after ${attempt} retries:`,
            error,
          );
          seen.delete(commandId);
          return false;
        }
        console.error(
          `[${logPrefix}] claim ${commandId} failed (attempt ${attempt + 1}), retrying:`,
          error,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, claimRetryDelaysMs[attempt]),
        );
      }
    }
  };

  const unsubscribe = client.onUpdate(
    refs.pendingFor,
    { ...options.subscriptionArgs, ...auth },
    (commands) => {
      for (const command of selectNewCommands(commands as C[], seen)) {
        chain = chain.then(async () => {
          // Claim before executing. A false return means a prior incarnation
          // already claimed (and ran, or is running) this command after a
          // crash/restart — never replay it — or the claim gave up after
          // bounded retries (redelivery on reconnect gets another shot).
          if (!(await claimWithRetry(command.commandId))) {
            return;
          }
          try {
            await options.execute(command);
          } catch (error) {
            console.error(
              `[${logPrefix}] command ${command.commandId} (${command.kind}) failed:`,
              error,
            );
          }
          await client
            .mutation(refs.ack, { commandId: command.commandId, ...auth })
            .catch((error) => {
              console.error(
                `[${logPrefix}] failed to ack ${command.commandId}:`,
                error,
              );
            });
        });
      }
    },
  );

  const sendHeartbeat = () => {
    client
      .mutation(refs.heartbeat, { ...options.buildHeartbeatArgs(), ...auth })
      .then(
        () => {
          options.onHeartbeatSuccess?.();
        },
        (error) => {
          console.error(`[${logPrefix}] heartbeat failed:`, error);
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
