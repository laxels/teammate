import { loadConfig } from "./config";
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

console.log(
  `[gateway] devbox ${config.devboxId} listening on http://${server.hostname}:${server.port}`,
);
