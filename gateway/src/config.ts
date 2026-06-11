export type GatewayConfig = {
  devboxId: string;
  port: number;
  convexSiteUrl: string;
  devboxSharedSecret: string;
};

export const DEFAULT_PORT = 8787;

/**
 * Read gateway configuration from the environment, failing fast with a clear
 * message when a required variable is missing. PORT is optional (default 8787).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const missing: string[] = [];
  const require = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  };

  const devboxId = require("DEVBOX_ID");
  const convexSiteUrl = require("CONVEX_SITE_URL");
  const devboxSharedSecret = require("DEVBOX_SHARED_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `gateway: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  const rawPort = env.PORT;
  const port =
    rawPort === undefined || rawPort === ""
      ? DEFAULT_PORT
      : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`gateway: invalid PORT value: ${JSON.stringify(rawPort)}`);
  }

  return { devboxId, port, convexSiteUrl, devboxSharedSecret };
}
