import { startCommandConsumer } from "./commands";
import { loadConfig } from "./config";
import { createEventSender } from "./events";
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

const server = createGatewayServer({ config });

// Orchestrator commands arrive via the Convex queue (outbound subscription)
// and are executed against this gateway's own HTTP surface, reusing the
// /task 202/409 semantics. A 409 means the orchestrator's view was stale —
// surface it as a failed lifecycle event so the task doesn't sit in "queued".
const emitEvent = createEventSender(config);
const localUrl = `http://127.0.0.1:${server.port}`;
startCommandConsumer({
  convexUrl: config.convexUrl,
  devboxId: config.devboxId,
  secret: config.devboxSharedSecret,
  execute: async (command) => {
    if (command.kind === "start") {
      const response = await fetch(`${localUrl}/task`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: command.payload,
      });
      if (response.status === 409) {
        const request = JSON.parse(command.payload) as { taskId?: string };
        if (typeof request.taskId === "string") {
          await emitEvent(
            request.taskId,
            "failed",
            "devbox rejected the task: a session is already active (interrupt it first)",
          );
        }
      }
      return;
    }
    await fetch(`${localUrl}/interrupt`, { method: "POST", body: "{}" });
  },
});

console.log(
  `[gateway] devbox ${config.devboxId} listening on http://${server.hostname}:${server.port}`,
);
