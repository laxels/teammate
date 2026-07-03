import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const REQUIRED_ENV = {
  LOCAL_MACHINE_ID: "local-axels-mbp",
  CONVEX_URL: "https://x.convex.cloud",
  CONVEX_SITE_URL: "https://x.convex.site",
  LOCAL_MACHINE_SECRET: "local-secret",
};

// The launchd KeepAlive loop retries forever, so a misconfigured env must
// surface EVERY missing var in the single error that lands in the log —
// one-at-a-time discovery would mean one relaunch per missing var.
test("collects all missing required vars into one error", () => {
  expect(() => loadConfig({})).toThrow(
    "missing required environment variable(s): LOCAL_MACHINE_ID, CONVEX_URL, CONVEX_SITE_URL, LOCAL_MACHINE_SECRET",
  );
});

// ~/.localagent.env lines like `LOCAL_MACHINE_SECRET=` must not sneak an
// empty secret into the daemon.
test("an empty value counts as missing", () => {
  expect(() =>
    loadConfig({ ...REQUIRED_ENV, LOCAL_MACHINE_SECRET: "" }),
  ).toThrow("missing required environment variable(s): LOCAL_MACHINE_SECRET");
});

test("maps the env with the cua-driver and cwd defaults", () => {
  const cfg = loadConfig(REQUIRED_ENV);
  expect(cfg.machineId).toBe("local-axels-mbp");
  expect(cfg.convexUrl).toBe("https://x.convex.cloud");
  expect(cfg.convexSiteUrl).toBe("https://x.convex.site");
  expect(cfg.localMachineSecret).toBe("local-secret");
  // The pinned binary installed by scripts/setup-localagent.sh.
  expect(cfg.cuaDriverBin).toBe(join(homedir(), ".local", "bin", "cua-driver"));
  // Task sessions start in $HOME (the localagent drives apps, not a repo).
  expect(cfg.cwd).toBe(homedir());
  expect(cfg.displayName).toBeUndefined();
  expect(cfg.ownerSlackUser).toBeUndefined();
});

test("optional vars override the defaults and pass through", () => {
  const cfg = loadConfig({
    ...REQUIRED_ENV,
    CUA_DRIVER_BIN: "/opt/cua/cua-driver",
    LOCAL_AGENT_CWD: "/Users/axel/agent-work",
    LOCAL_DISPLAY_NAME: "Axel's MBP",
    LOCAL_OWNER_SLACK_USER: "U0AXEL",
  });
  expect(cfg.cuaDriverBin).toBe("/opt/cua/cua-driver");
  expect(cfg.cwd).toBe("/Users/axel/agent-work");
  expect(cfg.displayName).toBe("Axel's MBP");
  expect(cfg.ownerSlackUser).toBe("U0AXEL");
});
