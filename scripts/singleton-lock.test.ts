import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "singleton-lock.sh");

async function sh(
  cmd: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

async function initRepo(dir: string): Promise<void> {
  for (const args of [
    ["git", "init", "--quiet", "--initial-branch=main"],
    [
      "git",
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "init",
    ],
  ]) {
    const result = await sh(args, dir);
    expect(result.exitCode).toBe(0);
  }
}

function lockDir(repo: string, name: string): string {
  return join(repo, ".git", "singleton-locks", name);
}

async function until(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("singleton-lock.sh", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "lock-repo-"));
    await initRepo(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("runs the command and releases the lock", async () => {
    const result = await sh([SCRIPT, "convex", "sh", "-c", "echo ran"], repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ran\n");
    expect(
      await Bun.file(join(lockDir(repo, "convex"), "owner")).exists(),
    ).toBe(false);
  });

  test("propagates the command's exit code and still releases", async () => {
    const result = await sh([SCRIPT, "convex", "sh", "-c", "exit 7"], repo);
    expect(result.exitCode).toBe(7);
    const retry = await sh([SCRIPT, "convex", "true"], repo);
    expect(retry.exitCode).toBe(0);
  });

  test("refuses while another holder is alive", async () => {
    const holder = Bun.spawn([SCRIPT, "convex", "sleep", "30"], { cwd: repo });
    try {
      await until(() =>
        Bun.file(join(lockDir(repo, "convex"), "owner")).exists(),
      );
      const blocked = await sh([SCRIPT, "convex", "true"], repo);
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr).toContain("held");
      expect(blocked.stderr).toContain(String(holder.pid));
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  test("steals a lock whose owner is dead", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await mkdir(lockDir(repo, "convex"), { recursive: true });
    await writeFile(
      join(lockDir(repo, "convex"), "owner"),
      `pid=${dead.pid}\n`,
    );
    const result = await sh([SCRIPT, "convex", "sh", "-c", "echo ran"], repo);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });

  test("treats a lock with no owner record as held, never steals it", async () => {
    await mkdir(lockDir(repo, "convex"), { recursive: true });
    const result = await sh([SCRIPT, "convex", "true"], repo);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no owner record");
    const dir = await sh(["test", "-d", lockDir(repo, "convex")], repo);
    expect(dir.exitCode).toBe(0);
  });

  test("exactly one of many contenders steals a stale lock", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await mkdir(lockDir(repo, "convex"), { recursive: true });
    await writeFile(
      join(lockDir(repo, "convex"), "owner"),
      `pid=${dead.pid}\n`,
    );
    const ranFile = join(repo, "ran.txt");
    const contenders = Array.from({ length: 5 }, () =>
      sh(
        [SCRIPT, "convex", "sh", "-c", `echo ran >> ${ranFile}; sleep 0.5`],
        repo,
      ),
    );
    const results = await Promise.all(contenders);
    const winners = results.filter((r) => r.exitCode === 0);
    expect(winners.length).toBe(1);
    expect((await Bun.file(ranFile).text()).trim().split("\n")).toHaveLength(1);
  });

  test("locks are shared across worktrees of the same repo", async () => {
    const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
    expect(
      (await sh(["git", "worktree", "add", "-q", wt, "-b", "wt"], repo))
        .exitCode,
    ).toBe(0);
    const holder = Bun.spawn([SCRIPT, "convex", "sleep", "30"], { cwd: repo });
    try {
      await until(() =>
        Bun.file(join(lockDir(repo, "convex"), "owner")).exists(),
      );
      const blocked = await sh([SCRIPT, "convex", "true"], wt, {
        ULTRACLAUDE_SINGLETON_FROM_WORKTREE: "1",
      });
      expect(blocked.exitCode).not.toBe(0);
      expect(blocked.stderr).toContain("held");
    } finally {
      holder.kill();
      await holder.exited;
      await rm(wt, { recursive: true, force: true });
    }
  });

  test("refuses to run from a linked worktree by default", async () => {
    const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
    expect(
      (await sh(["git", "worktree", "add", "-q", wt, "-b", "wt"], repo))
        .exitCode,
    ).toBe(0);
    try {
      const refused = await sh([SCRIPT, "convex", "true"], wt);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("primary checkout");

      const overridden = await sh([SCRIPT, "convex", "true"], wt, {
        ULTRACLAUDE_SINGLETON_FROM_WORKTREE: "1",
      });
      expect(overridden.exitCode).toBe(0);
    } finally {
      await rm(wt, { recursive: true, force: true });
    }
  });

  test("passes through outside a git checkout (host payload context)", async () => {
    const plain = await mkdtemp(join(tmpdir(), "lock-plain-"));
    try {
      const result = await sh(
        [SCRIPT, "fleet", "sh", "-c", "echo ran"],
        plain,
        {
          GIT_CEILING_DIRECTORIES: plain,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ran\n");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  test("re-entrant for the same lock name (wrapped script calls a sibling)", async () => {
    const holder = Bun.spawn([SCRIPT, "fleet", "sleep", "30"], { cwd: repo });
    try {
      await until(() =>
        Bun.file(join(lockDir(repo, "fleet"), "owner")).exists(),
      );
      const nested = await sh([SCRIPT, "fleet", "sh", "-c", "echo ran"], repo, {
        SINGLETON_LOCK: "fleet",
      });
      expect(nested.exitCode).toBe(0);
      expect(nested.stdout).toBe("ran\n");
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  test("rejects invalid lock names", async () => {
    const result = await sh([SCRIPT, "../escape", "true"], repo);
    expect(result.exitCode).not.toBe(0);
  });
});
