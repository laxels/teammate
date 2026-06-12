import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "worktree-setup.sh");

// A minimal installable project: one file: dependency so `bun install
// --frozen-lockfile` does real work without touching the network.
async function writeFixtureProject(dir: string): Promise<void> {
  await mkdir(join(dir, "dep"), { recursive: true });
  await writeFile(
    join(dir, "dep", "package.json"),
    JSON.stringify({ name: "wt-fixture-dep", version: "1.0.0" }),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "wt-fixture",
      private: true,
      dependencies: { "wt-fixture-dep": "file:./dep" },
    }),
  );
}

async function run(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([SCRIPT], {
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

describe("worktree-setup.sh", () => {
  let source: string;
  let worktree: string;

  beforeEach(async () => {
    source = await mkdtemp(join(tmpdir(), "wt-source-"));
    worktree = await mkdtemp(join(tmpdir(), "wt-tree-"));
    await writeFixtureProject(source);
    // Generate the lockfile the frozen install will be checked against.
    const lock = Bun.spawn(["bun", "install"], {
      cwd: source,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await lock.exited).toBe(0);
    // The worktree starts as a bare checkout: tracked files only.
    await writeFixtureProject(worktree);
    await Bun.write(
      join(worktree, "bun.lock"),
      Bun.file(join(source, "bun.lock")),
    );
    await writeFile(join(source, ".env"), "SECRET=1\n");
    await writeFile(join(source, ".env.local"), "CONVEX_DEPLOYMENT=dev:x\n");
  });

  afterEach(async () => {
    await rm(source, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  test("copies env files and installs dependencies", async () => {
    const result = await run(
      { SOURCE_DIR: source, WORKTREE_PATH: worktree },
      worktree,
    );
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(worktree, ".env")).text()).toBe("SECRET=1\n");
    expect(await Bun.file(join(worktree, ".env.local")).text()).toBe(
      "CONVEX_DEPLOYMENT=dev:x\n",
    );
    const dep = Bun.file(
      join(worktree, "node_modules", "wt-fixture-dep", "package.json"),
    );
    expect(await dep.exists()).toBe(true);
  });

  test("warns but continues when a source env file is missing", async () => {
    await rm(join(source, ".env.local"));
    const result = await run(
      { SOURCE_DIR: source, WORKTREE_PATH: worktree },
      worktree,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(".env.local");
    expect(await Bun.file(join(worktree, ".env")).exists()).toBe(true);
    expect(await Bun.file(join(worktree, ".env.local")).exists()).toBe(false);
  });

  test("defaults the worktree to the working directory", async () => {
    const result = await run(
      { SOURCE_DIR: source, WORKTREE_PATH: undefined },
      worktree,
    );
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(join(worktree, ".env")).exists()).toBe(true);
  });

  test("fails without SOURCE_DIR", async () => {
    const result = await run(
      { SOURCE_DIR: undefined, WORKTREE_PATH: worktree },
      worktree,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("SOURCE_DIR");
  });

  test("keeps stdout clean when the hook redirect flag is set", async () => {
    const result = await run(
      {
        SOURCE_DIR: source,
        WORKTREE_PATH: worktree,
        WORKTREE_SETUP_REDIRECT_SETUP_OUTPUT_TO_STDERR: "true",
      },
      worktree,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});
