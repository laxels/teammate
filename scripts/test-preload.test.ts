import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

// Proves the footgun guard (issue #80): a real SLACK_BOT_TOKEN present in the
// environment must NOT reach a test, because scripts/test-preload.ts (wired via
// bunfig.toml's [test] preload) strips it. Several code paths post to Slack off
// the ambient token, so a leak here means a test could fire a real Slack call
// from a dev's machine.
//
// We can't assert on this process's own env — the preload already ran for the
// outer suite, so the token is gone regardless of whether the wiring works. So
// we inject a canary token and spawn a fresh `bun test`, then read back whether
// the probe saw it: under the repo's bunfig (preload active) it must be gone;
// from a bunfig-less cwd (control) it must be visible, proving the preload —
// not some unrelated effect — is what removed it.

const REPO_ROOT = join(import.meta.dir, "..");
const CANARY = "xoxb-canary-must-not-leak";

// A one-line test that reports whether the token is visible. `--no-env-file`
// keeps the repo's real `.env` out of it, so the only token in play is the
// canary we inject — isolating the preload as the sole cause of its removal.
const PROBE = `import { test } from "bun:test";
test("probe", () => {
  console.log("PROBE_VISIBLE=" + (process.env.SLACK_BOT_TOKEN !== undefined));
});
`;

let dir: string;
let probe: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "preload-probe-"));
  probe = join(dir, "probe.test.ts");
  writeFileSync(probe, PROBE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function probeVisibility(cwd: string): Promise<boolean> {
  const proc = spawn({
    cmd: ["bun", "test", "--no-env-file", probe],
    cwd,
    env: { ...process.env, SLACK_BOT_TOKEN: CANARY },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const match = `${out}${err}`.match(/PROBE_VISIBLE=(true|false)/);
  if (match === null) {
    throw new Error(`probe produced no marker:\n${out}\n${err}`);
  }
  return match[1] === "true";
}

test("the test preload strips an ambient SLACK_BOT_TOKEN", async () => {
  // Repo root → bunfig.toml's preload runs → the injected canary is stripped.
  expect(await probeVisibility(REPO_ROOT)).toBe(false);
});

test("control: without the preload the token would be visible", async () => {
  // A bunfig-less temp dir → no preload → the injected canary survives. This is
  // the negative control that makes the assertion above meaningful.
  expect(await probeVisibility(dir)).toBe(true);
});
