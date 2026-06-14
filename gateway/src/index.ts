import { homedir } from "node:os";
import { join } from "node:path";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { BrowserSession } from "./browser/executor";
import { startCommandConsumer } from "./commands";
import { loadConfig } from "./config";
import { createEventSender } from "./events";
import { waitForProvisionReady } from "./ready";
import { type RunningTask, reconcileOrphanedTasks } from "./reconcile";
import { createScreenRecorder } from "./recorder";
import { createGatewayServer } from "./server";

const config = loadConfig();

if (
  process.env.CLAUDE_CODE_OAUTH_TOKEN === undefined ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN === ""
) {
  console.warn(
    "[gateway] CLAUDE_CODE_OAUTH_TOKEN is not set; Agent SDK sessions will fail to authenticate",
  );
}

const browserSession = new BrowserSession();
const recorder = createScreenRecorder({ config });
const server = createGatewayServer({ config, browserSession, recorder });

// Close Chrome cleanly on shutdown so the profile unlocks for the next boot;
// cap the wait so a wedged browser can't hang gateway restarts. (After a hard
// kill, BrowserSession's launch recovery evicts the orphan instead.) Abort any
// in-flight screen capture too, so a graceful restart mid-task doesn't orphan a
// screencapture process still writing to disk.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    recorder.abort();
    void Promise.race([
      browserSession.close(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).finally(() => process.exit(0));
  });
}

// Orchestrator commands arrive via the Convex queue (outbound subscription)
// and are executed against this gateway's own HTTP surface, reusing the
// /task 202/409 semantics. A 409 means the orchestrator's view was stale —
// surface it as a failed lifecycle event so the task doesn't sit in "queued".
const emitEvent = createEventSender(config);
const localUrl = `http://127.0.0.1:${server.port}`;
// POST /task and /interrupt require the shared secret even from localhost.
const authHeader = { "x-devbox-secret": config.devboxSharedSecret };
const startConsumer = () =>
  startCommandConsumer({
    convexUrl: config.convexUrl,
    devboxId: config.devboxId,
    secret: config.devboxSharedSecret,
    execute: async (command) => {
      if (command.kind === "start") {
        const post = () =>
          fetch(`${localUrl}/task`, {
            method: "POST",
            headers: { "content-type": "application/json", ...authHeader },
            body: command.payload,
          });
        let response = await post();
        if (response.status === 409) {
          // A finished-but-steerable session still occupies the slot. The
          // orchestrator only assigns devboxes Convex considers warm, so a new
          // task wins: end the old session, wait for the slot to actually free
          // (teardown is asynchronous), then retry.
          await fetch(`${localUrl}/interrupt`, {
            method: "POST",
            headers: authHeader,
            body: "{}",
          });
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const health = (await fetch(`${localUrl}/health`).then((r) =>
              r.json(),
            )) as { running: boolean };
            if (!health.running) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          response = await post();
        }
        if (response.status !== 202) {
          const request = JSON.parse(command.payload) as { taskId?: string };
          if (typeof request.taskId === "string") {
            await emitEvent(
              request.taskId,
              "failed",
              `devbox rejected the task (HTTP ${response.status}) even after interrupting the previous session`,
            );
          }
        }
        return;
      }
      if (command.kind === "user_message") {
        // Slack-relayed steering. A 409 means the session ended (or the devbox
        // moved on) before delivery — the task's terminal status update already
        // tells that story in its thread, so just log.
        const response = await fetch(`${localUrl}/message`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader },
          body: command.payload,
        });
        if (!response.ok) {
          console.warn(
            `[gateway] user_message ${command.commandId} not delivered (HTTP ${response.status})`,
          );
        }
        return;
      }
      if (command.kind === "interrupt") {
        // The payload may carry { taskId } so /interrupt can refuse to stop a
        // session that has moved on to another task.
        const response = await fetch(`${localUrl}/interrupt`, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader },
          body: command.payload,
        });
        if (!response.ok) {
          console.warn(
            `[gateway] interrupt ${command.commandId} not applied (HTTP ${response.status})`,
          );
        }
        return;
      }
      // A kind this binary doesn't know (orchestrator deployed ahead of the
      // gateway payload). Never guess — executing it as something else could
      // kill the session. Log and let the consumer ack it away.
      console.warn(
        `[gateway] ignoring unknown command kind ${String(command.kind)} (${command.commandId})`,
      );
    },
  });

// /health serves immediately (provisioning polls it before the ready marker
// exists), but commands are only consumed on a fully provisioned VM — and
// only after failing any task a previous gateway process took to its grave.
const runningForDevboxRef = makeFunctionReference<"query">(
  "tasks:runningForDevbox",
);
void (async () => {
  await waitForProvisionReady(join(homedir(), "ultraclaude.ready"));
  const bootClient = new ConvexClient(config.convexUrl);
  await reconcileOrphanedTasks({
    queryRunning: async () =>
      (await bootClient.query(runningForDevboxRef, {
        devboxId: config.devboxId,
        secret: config.devboxSharedSecret,
      })) as RunningTask[],
    emitEvent,
  });
  await bootClient.close();
  startConsumer();
})();

console.log(
  `[gateway] devbox ${config.devboxId} listening on http://${server.hostname}:${server.port}`,
);
