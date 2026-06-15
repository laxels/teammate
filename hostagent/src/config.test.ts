import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "./config";

const REQUIRED_ENV = {
  HOST_ID: "host-1",
  CONVEX_URL: "https://x.convex.cloud",
  CONVEX_SITE_URL: "https://x.convex.site",
  DEVBOX_SHARED_SECRET: "secret",
  TAILSCALE_AUTHKEY: "key",
  TAILNET_SUFFIX: "ts.example.com",
};

// #89: GOLDEN_IMAGE in ~/hostagent.env (written from the golden pin by
// adopt-host.sh / refresh-golden.sh) is authoritative and LEADS the rollout; the
// code default is only a fallback for an env that predates that line. So a host
// pointed at the new golden must use it regardless of the (lagging) default.
test("GOLDEN_IMAGE from the env is authoritative over the fallback default", () => {
  const cfg = loadConfig({ ...REQUIRED_ENV, GOLDEN_IMAGE: "golden-v9" });
  expect(cfg.goldenImage).toBe("golden-v9");

  // Absent in the env -> the code fallback. (It intentionally LAGS the pin —
  // see config.ts — so it can't be cross-checked against golden-constants.sh.)
  const fallback = loadConfig(REQUIRED_ENV);
  expect(fallback.goldenImage).toMatch(/^golden-v\d+$/);
});

// The golden pin (scripts/golden-constants.sh) is the single source of truth the
// fleet scripts source; this guards its internal consistency (the local image
// name and ghcr ref both derive from the one version), so a bump can't leave
// them out of step.
test("golden-constants.sh derives the local image and ghcr ref from the version", () => {
  const scriptPath = join(import.meta.dir, "../../scripts/golden-constants.sh");
  const proc = Bun.spawnSync([
    "bash",
    "-c",
    `source ${JSON.stringify(scriptPath)} && ` +
      `printf '%s\\n%s\\n%s' "$GOLDEN_VERSION" "$GOLDEN_LOCAL" "$GOLDEN_REMOTE"`,
  ]);
  expect(proc.success).toBe(true);

  const lines = proc.stdout.toString().trim().split("\n");
  const version = lines[0];
  expect(version).toMatch(/^v\d+$/);
  expect(lines[1]).toBe(`golden-${version}`);
  expect(lines[2]).toBe(`ghcr.io/laxels/ultraclaude-golden:${version}`);
});
