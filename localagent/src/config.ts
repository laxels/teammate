import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Environment configuration for the localagent daemon (#138). Mirrors
 * hostagent/src/config.ts: collect every missing required var, then throw one
 * error — the launchd KeepAlive loop retries and the error lands in the log.
 */
export type LocalAgentConfig = {
  /** Stable machine identity, e.g. "local-axels-mbp" (self-registers the
   * localMachines row on first heartbeat). */
  machineId: string;
  /** Convex .convex.cloud URL (Convex client / localCommands queue). */
  convexUrl: string;
  /** Convex .convex.site URL (/local/* HTTP endpoints). */
  convexSiteUrl: string;
  /** The local trust tier's secret — NEVER the fleet devbox secret. */
  localMachineSecret: string;
  /** The pinned cua-driver binary (see scripts/setup-localagent.sh). */
  cuaDriverBin: string;
  /** Working directory for task sessions (defaults to $HOME). */
  cwd: string;
  /** Human-readable label for Slack asks / the dashboard. */
  displayName?: string | undefined;
  /** Slack user id of the machine's owner: permission asks tag them and only
   * their yes may grant access to this machine. */
  ownerSlackUser?: string | undefined;
};

export function loadConfig(env = process.env): LocalAgentConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  };
  const machineId = required("LOCAL_MACHINE_ID");
  const convexUrl = required("CONVEX_URL");
  const convexSiteUrl = required("CONVEX_SITE_URL");
  const localMachineSecret = required("LOCAL_MACHINE_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `localagent: missing required environment variable(s): ${missing.join(", ")}`,
    );
  }
  return {
    machineId,
    convexUrl,
    convexSiteUrl,
    localMachineSecret,
    cuaDriverBin:
      env.CUA_DRIVER_BIN ?? join(homedir(), ".local", "bin", "cua-driver"),
    cwd: env.LOCAL_AGENT_CWD ?? homedir(),
    displayName: env.LOCAL_DISPLAY_NAME,
    ownerSlackUser: env.LOCAL_OWNER_SLACK_USER,
  };
}
