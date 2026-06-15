import { homedir } from "node:os";

export type HostAgentConfig = {
  hostId: string;
  /** The deployment's .convex.cloud URL (Convex client / hostCommands queue). */
  convexUrl: string;
  /** The deployment's .convex.site URL (passed into each VM's gateway env). */
  convexSiteUrl: string;
  devboxSharedSecret: string;
  /**
   * Joins each freshly cloned VM to the tailnet under its devbox id. Must be
   * a REUSABLE+EPHEMERAL authkey: hostagents only enroll ephemeral VMs, and
   * ephemeral nodes auto-purge from the tailnet when they go offline
   * (non-ephemeral keys leak offline node entries on every crashed VM).
   */
  tailscaleAuthkey: string;
  /** e.g. "tail4d21c4.ts.net" — used for the deterministic gateway hostname. */
  tailnetSuffix: string;
  /** Local tart image name VMs are cloned from. */
  goldenImage: string;
  /** Directory rsynced into each VM (gateway/src, shared, web/dist). */
  payloadDir: string;
  /** Absolute path to the tart binary. */
  tartBin: string;
  /**
   * Fleet-provisioner role of record (FLEET_PROVISIONER=1): reported in the
   * heartbeat so the Convex decision machinery (pickProvisioner, kept for the
   * #88 monitor) can identify a credential-holding host. The host agent no
   * longer runs bootstraps itself — GitHub Actions is the doer (#87) — so this
   * is now just advertised metadata, not an executor capability.
   */
  canProvisionHosts: boolean;
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
  const payloadDir = env.PAYLOAD_DIR || `${home}/ultraclaude-payload`;
  return {
    hostId,
    convexUrl,
    convexSiteUrl,
    devboxSharedSecret,
    tailscaleAuthkey,
    tailnetSuffix,
    // Authoritative value is GOLDEN_IMAGE in ~/hostagent.env, written from the
    // pin (scripts/golden-constants.sh) by adopt-host.sh on provision and by
    // refresh-golden.sh on a golden roll (#89) — that env LEADS the rollout.
    // This literal is only the fallback when the env predates that line (an
    // existing host not yet refreshed). It must therefore LAG the pin: a value
    // guaranteed present on every host, since deploy-payload ships this code
    // independently of which goldens a host has pulled. Bumping it to the new
    // golden before that golden is on every host would make a host with no
    // GOLDEN_IMAGE clone a missing image. Advance it only after a roll completes.
    goldenImage: env.GOLDEN_IMAGE || "golden-v4",
    payloadDir,
    tartBin: env.TART_BIN || `${home}/tart.app/Contents/MacOS/tart`,
    canProvisionHosts: env.FLEET_PROVISIONER === "1",
  };
}
