import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

// Proves the review concern (PR #90): `fleet-lock.sh guard` must, on a lost
// lease, terminate the WHOLE descendant tree of the wrapped command — not just
// the wrapper shell. A provision blocked in a long ssh/brew/Scaleway call would
// otherwise keep mutating the fleet unlocked. We stand up a fake lock endpoint,
// guard a command that backgrounds a long `sleep` (the "blocked descendant"),
// and assert that sleep is dead once guard returns.

const SCRIPT = join(import.meta.dir, "fleet-lock.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fleet-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runGuard(renewResponse: Record<string, unknown>) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/fleet/lock/renew") {
        return Response.json(renewResponse);
      }
      // acquire/release aren't used by `guard`, but answer anything else benignly.
      return Response.json({ ok: true });
    },
  });
  const gcFile = join(dir, "grandchild.pid");
  try {
    const proc = spawn({
      // guard <cmd>: background a long sleep (the blocked descendant), record
      // its pid, then wait — exactly the "stuck in a long call" shape.
      cmd: [
        "bash",
        SCRIPT,
        "guard",
        "bash",
        "-c",
        `sleep 120 & echo $! > "${gcFile}"; wait`,
      ],
      env: {
        ...process.env,
        CONVEX_SITE_URL: `http://localhost:${server.port}`,
        DEVBOX_SHARED_SECRET: "test-secret",
        FLEET_LOCK_HOLDER: "test-runner",
        // 15s TTL → RENEW_SECS floors at 5; the first renew fires immediately.
        FLEET_LOCK_TTL_MS: "15000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    let grandchild: number | undefined;
    try {
      grandchild = Number(readFileSync(gcFile, "utf8").trim());
    } catch {
      grandchild = undefined;
    }
    return { exitCode, grandchild };
  } finally {
    server.stop(true);
  }
}

test("guard kills the wrapped command's whole tree when the lease is lost", async () => {
  const { exitCode, grandchild } = await runGuard({
    renewed: false,
    heldBy: "thief",
  });
  // The guard aborted (non-zero — the wrapped command was killed mid-flight).
  expect(exitCode).not.toBe(0);
  // The blocked descendant `sleep` is dead — not orphaned and still running.
  expect(grandchild).toBeGreaterThan(0);
  if (grandchild !== undefined) {
    expect(alive(grandchild)).toBe(false);
  }
}, 30_000);

test("guard lets a command finish cleanly while the lease holds", async () => {
  // A fast command that exits 0; the renewer keeps reporting the lease held.
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/fleet/lock/renew") {
        return Response.json({ renewed: true, expiresAt: Date.now() + 15_000 });
      }
      return Response.json({ ok: true });
    },
  });
  try {
    const proc = spawn({
      cmd: ["bash", SCRIPT, "guard", "bash", "-c", "exit 0"],
      env: {
        ...process.env,
        CONVEX_SITE_URL: `http://localhost:${server.port}`,
        DEVBOX_SHARED_SECRET: "test-secret",
        FLEET_LOCK_HOLDER: "test-runner",
        FLEET_LOCK_TTL_MS: "15000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
  } finally {
    server.stop(true);
  }
}, 30_000);
