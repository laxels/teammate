import { describe, expect, test } from "bun:test";
import {
  createHostProvisioner,
  type ProvisionEvent,
  type StreamingRun,
} from "./hostProvision";

function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error("timed out waiting for condition"));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

type Harness = {
  events: ProvisionEvent[];
  runs: { command: string[]; cwd: string; env?: Record<string, string> }[];
  finish: (code: number) => void;
  provisioner: ReturnType<typeof createHostProvisioner>;
  emitLine: (line: string) => void;
};

function createHarness(): Harness {
  const events: ProvisionEvent[] = [];
  const runs: Harness["runs"] = [];
  let resolveRun: ((result: { code: number }) => void) | null = null;
  let onLine: ((line: string) => void) | null = null;

  const run: StreamingRun = (command, options) => {
    runs.push({
      command,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
    });
    onLine = options.onLine;
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  };

  const provisioner = createHostProvisioner({
    scriptPath: "/payload/scripts/provision-host.sh",
    workdir: "/payload",
    fleetEnvFile: "/Users/m1/fleet.env",
    recordEvent: async (event) => {
      events.push(event);
    },
    run,
  });

  return {
    events,
    runs,
    provisioner,
    finish: (code) => resolveRun?.({ code }),
    emitLine: (line) => onLine?.(line),
  };
}

describe("host provisioner", () => {
  test("runs the bootstrap script detached with the fleet env file", async () => {
    const h = createHarness();
    expect(h.provisioner.start("ultraclaude-host-2")).toBe(true);
    expect(h.provisioner.inFlight()).toBe("ultraclaude-host-2");

    await until(() => h.runs.length === 1);
    expect(h.runs[0]?.command).toEqual([
      "bash",
      "/payload/scripts/provision-host.sh",
      "ultraclaude-host-2",
    ]);
    expect(h.runs[0]?.cwd).toBe("/payload");
    expect(h.runs[0]?.env).toEqual({ ULTRACLAUDE_ENV: "/Users/m1/fleet.env" });

    h.finish(0);
    await until(() => h.provisioner.inFlight() === null);
    expect(h.events.map((e) => e.type)).toEqual([
      "provision_started",
      "provision_bootstrap_done",
    ]);
  });

  test("forwards step-marker lines as progress events", async () => {
    const h = createHarness();
    h.provisioner.start("ultraclaude-host-2");
    await until(() => h.runs.length === 1);

    h.emitLine(
      "==> Creating M2-L server 'ultraclaude-host-2' in fr-par-1 (reused if it exists)",
    );
    h.emitLine("server status: starting"); // not a step marker: stays local
    h.emitLine(
      "==> Pulling the golden image (if missing; ~60 GB on first pull)",
    );
    h.finish(0);
    await until(() => h.provisioner.inFlight() === null);

    const progress = h.events.filter((e) => e.type === "provision_progress");
    expect(progress.map((e) => e.summary)).toEqual([
      "Creating M2-L server 'ultraclaude-host-2' in fr-par-1 (reused if it exists)",
      "Pulling the golden image (if missing; ~60 GB on first pull)",
    ]);
    expect(progress.every((e) => e.hostId === "ultraclaude-host-2")).toBe(true);
  });

  test("a non-zero exit reports provision_failed with the output tail", async () => {
    const h = createHarness();
    h.provisioner.start("ultraclaude-host-2");
    await until(() => h.runs.length === 1);

    h.emitLine("ERROR: server ultraclaude-host-2 is 'starting' after 30 min");
    h.finish(1);
    await until(() => h.provisioner.inFlight() === null);

    const failed = h.events.find((e) => e.type === "provision_failed");
    expect(failed?.summary).toContain("Bootstrap exited 1");
    expect(failed?.summary).toContain("after 30 min");
  });

  test("serializes: a second start while one is in flight is dropped", async () => {
    const h = createHarness();
    expect(h.provisioner.start("ultraclaude-host-2")).toBe(true);
    expect(h.provisioner.start("ultraclaude-host-3")).toBe(false);
    await until(() => h.runs.length === 1);
    expect(h.runs).toHaveLength(1);

    h.finish(0);
    await until(() => h.provisioner.inFlight() === null);
    expect(h.provisioner.start("ultraclaude-host-3")).toBe(true);
  });

  test("rejects shell-unsafe host names without running anything", () => {
    const h = createHarness();
    expect(h.provisioner.start("bad name; rm -rf /")).toBe(false);
    expect(h.runs).toHaveLength(0);
    expect(h.events[0]?.type).toBe("provision_failed");
  });
});
