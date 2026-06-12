// provision_host executor: bootstraps a brand-new Scaleway Mac by running
// scripts/provision-host.sh (shipped in the payload dir, which also carries
// the fleet .env the script reads its secrets from). The bootstrap takes tens
// of minutes, so unlike the VM executors it runs DETACHED: start() returns
// immediately (the command gets acked) and progress streams to Convex as
// hostEvents via `recordEvent`.

export type ProvisionEvent = {
  hostId: string;
  type: string;
  summary: string;
};

export type StreamingRun = (
  command: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    onLine: (line: string) => void;
  },
) => Promise<{ code: number }>;

/** Default runner: Bun.spawn with merged, line-buffered stdout+stderr. */
export const spawnStreamingRun: StreamingRun = async (command, options) => {
  const [bin, ...args] = command;
  if (bin === undefined) throw new Error("empty command");
  const proc = Bun.spawn([bin, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) options.onLine(line);
      }
    }
    const rest = buffer.trim();
    if (rest.length > 0) options.onLine(rest);
  };
  const [, , code] = await Promise.all([
    pump(proc.stdout),
    pump(proc.stderr),
    proc.exited,
  ]);
  return { code };
};

export type HostProvisionerOptions = {
  /** scripts/provision-host.sh as shipped in the payload dir. */
  scriptPath: string;
  /** Working directory for the script (the payload dir = its REPO_ROOT). */
  workdir: string;
  /** Fleet secrets file, kept OUTSIDE the payload (which is rsynced into
   * VMs). Exported to the script as ULTRACLAUDE_ENV. */
  fleetEnvFile: string;
  recordEvent: (event: ProvisionEvent) => Promise<void>;
  run?: StreamingRun;
};

const HOST_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FAILURE_TAIL_LINES = 8;

export type HostProvisioner = {
  /**
   * Kicks off a bootstrap and returns immediately; false when one is already
   * running (scale-ups are serialized fleet-wide, so a second request while
   * busy indicates a duplicate command — safe to drop).
   */
  start(hostName: string): boolean;
  inFlight(): string | null;
};

export function createHostProvisioner(
  options: HostProvisionerOptions,
): HostProvisioner {
  const run = options.run ?? spawnStreamingRun;
  let current: string | null = null;

  const emit = (hostId: string, type: string, summary: string) => {
    options.recordEvent({ hostId, type, summary }).catch((error) => {
      console.error("[hostagent] failed to record host event:", error);
    });
  };

  const execute = async (hostName: string): Promise<void> => {
    const tail: string[] = [];
    emit(
      hostName,
      "provision_started",
      `Bootstrap started: ${options.scriptPath} ${hostName}`,
    );
    try {
      const { code } = await run(["bash", options.scriptPath, hostName], {
        cwd: options.workdir,
        env: { ULTRACLAUDE_ENV: options.fleetEnvFile },
        onLine: (line) => {
          tail.push(line);
          if (tail.length > FAILURE_TAIL_LINES) tail.shift();
          // The script logs step transitions as "==> step"; forward those as
          // progress events and keep the rest local (the full log stays in
          // the hostagent log for debugging).
          if (line.startsWith("==> ")) {
            emit(hostName, "provision_progress", line.slice(4));
          }
          console.log(`[hostagent] provision ${hostName}: ${line}`);
        },
      });
      if (code === 0) {
        // The new host's own first heartbeat flips its row to active; this
        // event just brackets the bootstrap for debugging.
        emit(
          hostName,
          "provision_bootstrap_done",
          "Bootstrap script finished; waiting for the new host agent's first heartbeat.",
        );
      } else {
        emit(
          hostName,
          "provision_failed",
          `Bootstrap exited ${code}: ${tail.join(" | ")}`,
        );
      }
    } catch (error) {
      emit(
        hostName,
        "provision_failed",
        `Bootstrap crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      current = null;
    }
  };

  return {
    start(hostName: string): boolean {
      if (current !== null) {
        console.error(
          `[hostagent] provision_host ${hostName} dropped: ${current} is already bootstrapping`,
        );
        return false;
      }
      if (!HOST_NAME_PATTERN.test(hostName)) {
        emit(hostName, "provision_failed", `Invalid host name "${hostName}"`);
        return false;
      }
      current = hostName;
      void execute(hostName);
      return true;
    },
    inFlight: () => current,
  };
}
