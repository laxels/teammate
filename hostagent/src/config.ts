import { homedir } from "node:os";

export type HostAgentConfig = {
  hostId: string;
  /** The deployment's .convex.cloud URL (Convex client / hostCommands queue). */
  convexUrl: string;
  /** The deployment's .convex.site URL (passed into each VM's gateway env). */
  convexSiteUrl: string;
  devboxSharedSecret: string;
  /** Joins each freshly cloned VM to the tailnet under its devbox id. */
  tailscaleAuthkey: string;
  /** e.g. "tail4d21c4.ts.net" — used for the deterministic gateway hostname. */
  tailnetSuffix: string;
  /** Local tart image name VMs are cloned from. */
  goldenImage: string;
  /** Directory rsynced into each VM (gateway/src, shared, web/dist). */
  payloadDir: string;
  /** Absolute path to the tart binary. */
  tartBin: string;
};

/**
 * Read host agent configuration from the environment, failing fast with a
 * clear message when a required variable is missing (the launchd KeepAlive
 * loop retries, so a missing ~/hostagent.env shows up in the log, not as a
 * silently dead agent).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): HostAgentConfig {
  const missing: string[] = [];
  const require = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  };

  const hostId = require("HOST_ID");
  const convexUrl = require("CONVEX_URL");
  const convexSiteUrl = require("CONVEX_SITE_URL");
  const devboxSharedSecret = require("DEVBOX_SHARED_SECRET");
  const tailscaleAuthkey = require("TAILSCALE_AUTHKEY");
  const tailnetSuffix = require("TAILNET_SUFFIX");
  if (missing.length > 0) {
    throw new Error(
      `hostagent: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }

  const home = env.HOME ?? homedir();
  return {
    hostId,
    convexUrl,
    convexSiteUrl,
    devboxSharedSecret,
    tailscaleAuthkey,
    tailnetSuffix,
    goldenImage: env.GOLDEN_IMAGE || "golden-v2",
    payloadDir: env.PAYLOAD_DIR || `${home}/ultraclaude-payload`,
    tartBin: env.TART_BIN || `${home}/tart.app/Contents/MacOS/tart`,
  };
}
