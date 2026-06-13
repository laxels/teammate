// VM lifecycle executors for host commands (provision_vm / destroy_vm).
// Every side effect goes through an injected `Run` so tests can record and
// stub the exact tart/ssh command sequences. The provisioning steps mirror
// scripts/provision-devbox.sh, executed from ON the host (no ssh jump).

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { stdin?: string };
export type Run = (
  command: string[],
  options?: RunOptions,
) => Promise<RunResult>;

/** Default runner: Bun.spawn, capturing stdout/stderr, optional stdin. */
export const spawnRun: Run = async (command, options) => {
  const proc = Bun.spawn(command, {
    stdin: options?.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export type VmConfig = {
  goldenImage: string;
  payloadDir: string;
  tartBin: string;
  tailnetSuffix: string;
  tailscaleAuthkey: string;
  convexUrl: string;
  convexSiteUrl: string;
  devboxSharedSecret: string;
};

export type VmExecutors = {
  provision: (devboxId: string) => Promise<void>;
  destroy: (devboxId: string) => Promise<void>;
};

export type VmExecutorOptions = {
  config: VmConfig;
  /** Drops the devbox row in Convex after a successful tart delete. */
  removeDevbox: (devboxId: string) => Promise<void>;
  /**
   * Reports a failed provision to Convex: drops the leaked devbox row (freeing
   * the host VM slot) and fails the associated task. Without this a failed
   * provision permanently occupies one of the host's Apple-EULA-capped slots.
   */
  reportProvisionFailure: (devboxId: string, summary: string) => Promise<void>;
  run?: Run;
  /** Injectable for tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
};

const GATEWAY_PORT = 8787;
const VM_USER = "admin";
// Golden-image default; VMs are reachable only from the host (NAT) and the
// tailnet, and sshd inside the image allows password auth on purpose.
const VM_PASSWORD = "admin";
const TAILSCALE = "/opt/homebrew/bin/tailscale";

// Every clone boots with the golden image's tailscaled state (brew tailscaled
// keeps it in /Library/Tailscale, including the machine key), so without a
// wipe ALL clones share ONE tailnet machine identity: each `tailscale up`
// re-keys and renames that single node — knocking the previous holder off the
// tailnet — and each destroy-time `tailscale logout` revokes the shared key
// fleet-wide. Wiping the state dir while the daemon is down forces a fresh
// identity before the clone joins. The daemon is the root LaunchDaemon
// homebrew.mxcl.tailscale (brew services); `tailscale version --daemon`
// exits 0 once the restarted daemon is reachable, even while logged out.
//
// launchd tears services down ASYNCHRONOUSLY: a bootstrap right after
// bootout intermittently fails with "Bootstrap failed: 5: Input/output
// error" (observed on a freshly booted clone, 2026-06-12). Wait for the
// label to disappear before removing state, and retry the bootstrap.
const TAILSCALE_RESET =
  "set -e; " +
  "sudo launchctl bootout system/homebrew.mxcl.tailscale 2>/dev/null || true; " +
  "for i in $(seq 1 15); do sudo launchctl print system/homebrew.mxcl.tailscale >/dev/null 2>&1 || break; sleep 1; done; " +
  "sudo rm -rf /Library/Tailscale; " +
  "for i in $(seq 1 10); do sudo launchctl bootstrap system /Library/LaunchDaemons/homebrew.mxcl.tailscale.plist 2>/dev/null && break; sleep 2; done; " +
  `for i in $(seq 1 30); do ${TAILSCALE} version --daemon >/dev/null 2>&1 && exit 0; sleep 1; done; ` +
  'echo "tailscaled did not come back after state wipe" >&2; exit 1';

const POLL_INTERVAL_MS = 5_000;
const IP_ATTEMPTS = 36; // 3 min
const SSH_ATTEMPTS = 60; // 5 min
const HEALTH_ATTEMPTS = 36; // 3 min

// Devbox ids are interpolated into remote shell commands; the same pattern
// scripts/provision-devbox.sh enforces keeps them shell-inert.
const DEVBOX_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Ephemeral NAT clones share host keys and reuse 192.168.64.x IPs, so
// host-key pinning is meaningless; skip known_hosts entirely. Auth is
// password-only and single-shot: host-side identities (e.g. the fleet SSH
// key on provisioner hosts) must never be offered first — rejected pubkey
// attempts count against the VM sshd's MaxAuthTries and intermittently
// produce "Too many authentication failures" before the password is tried.
const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "PubkeyAuthentication=no",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "NumberOfPasswordPrompts=1",
];

const SSH_BASE = ["sshpass", "-p", VM_PASSWORD, "ssh", ...SSH_OPTS];

function sshCommand(ip: string, remoteCommand: string): string[] {
  return [...SSH_BASE, `${VM_USER}@${ip}`, remoteCommand];
}

// Exact pattern from scripts/provision-devbox.sh: kickstart the baked
// LaunchAgent, bootstrapping it first if this boot never loaded it.
const GATEWAY_KICKSTART =
  "launchctl kickstart -k gui/501/com.ultraclaude.gateway " +
  "|| { launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.ultraclaude.gateway.plist 2>/dev/null; " +
  "launchctl kickstart -k gui/501/com.ultraclaude.gateway; }";

export function createVmExecutors(options: VmExecutorOptions): VmExecutors {
  const { config, removeDevbox, reportProvisionFailure } = options;
  const run = options.run ?? spawnRun;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const tart = config.tartBin;

  // Freshly cloned VMs intermittently deny password auth for a short window
  // after boot (new MAC -> OpenDirectory/auth settle): provisions fail at a
  // RANDOM ssh step with exit 255 while neighboring steps succeed. Every
  // provisioning step is idempotent, so ssh-layer failures (255) get retried.
  const SSH_FAILURE_EXIT = 255;
  const SSH_RETRY_ATTEMPTS = 4;
  const SSH_RETRY_DELAY_MS = 5_000;

  const must = async (
    step: string,
    command: string[],
    runOptions?: RunOptions,
  ): Promise<RunResult> => {
    let result = await run(command, runOptions);
    for (
      let attempt = 1;
      result.code === SSH_FAILURE_EXIT && attempt < SSH_RETRY_ATTEMPTS;
      attempt++
    ) {
      console.log(
        `[hostagent] ${step}: ssh failure (exit 255), retry ${attempt}/${SSH_RETRY_ATTEMPTS - 1}`,
      );
      await sleep(SSH_RETRY_DELAY_MS);
      result = await run(command, runOptions);
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new Error(`${step} failed (exit ${result.code}): ${detail}`);
    }
    return result;
  };

  const vmExists = async (devboxId: string): Promise<boolean> => {
    const list = await run([tart, "list"]);
    return (
      list.code === 0 &&
      new RegExp(`^local\\s+${devboxId}\\s`, "m").test(list.stdout)
    );
  };

  const provisionSteps = async (devboxId: string): Promise<void> => {
    await must("tart clone", [tart, "clone", config.goldenImage, devboxId]);

    // Boot headless, detached: `tart run` blocks for the VM's lifetime, so it
    // is backgrounded under nohup (same pattern as provision-devbox.sh). The
    // tart path and VM name are passed as positional args to dodge quoting.
    await must("tart run (detached)", [
      "/bin/sh",
      "-c",
      'nohup "$0" run "$1" --no-graphics </dev/null >>"/tmp/tart-$1.log" 2>&1 & sleep 1',
      tart,
      devboxId,
    ]);

    let ip = "";
    for (let i = 0; i < IP_ATTEMPTS; i++) {
      const result = await run([tart, "ip", devboxId]);
      const candidate = result.stdout.trim();
      if (result.code === 0 && candidate !== "") {
        ip = candidate;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (ip === "") {
      throw new Error(`${devboxId} never got an IP`);
    }
    console.log(`[hostagent] ${devboxId} IP: ${ip}`);

    let sshUp = false;
    for (let i = 0; i < SSH_ATTEMPTS; i++) {
      if ((await run(sshCommand(ip, "true"))).code === 0) {
        sshUp = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!sshUp) {
      throw new Error(`SSH to ${devboxId} (${ip}) never came up`);
    }

    // Current code on top of the baked image: the golden image provides the
    // slow-to-build environment (logins, node_modules); the payload dir holds
    // the repo's latest gateway/src, shared, web/dist (scripts/deploy-payload.sh).
    await must("rsync payload", [
      "rsync",
      "-az",
      "-e",
      SSH_BASE.join(" "),
      `${config.payloadDir}/`,
      `${VM_USER}@${ip}:ultraclaude/`,
    ]);

    // The baked node_modules lags the payload's code: a dependency added
    // after the golden image was baked crashes the gateway at import
    // (observed 2026-06-12: playwright-core). Install against the payload's
    // lockfile every provision; the baked bun cache makes the no-change
    // case sub-second, so only genuinely new packages hit the network.
    await must(
      "bun install",
      sshCommand(
        ip,
        "cd ~/ultraclaude && ~/.bun/bin/bun install --frozen-lockfile",
      ),
    );

    // Gateway config only; Claude Code auth comes from the golden image.
    const envFile = [
      `DEVBOX_ID=${devboxId}`,
      `PORT=${GATEWAY_PORT}`,
      `CONVEX_SITE_URL=${config.convexSiteUrl}`,
      `CONVEX_URL=${config.convexUrl}`,
      `DEVBOX_SHARED_SECRET=${config.devboxSharedSecret}`,
      "",
    ].join("\n");
    await must(
      "write ultraclaude.env",
      sshCommand(
        ip,
        "umask 077; cat > ~/ultraclaude.env && chmod 600 ~/ultraclaude.env",
      ),
      { stdin: envFile },
    );

    // Interactive `claude` on a devbox must never stall on permission
    // prompts (humans debug via the remote desktop); gateway sessions
    // already bypass via SDK options. Merged into the baked settings.json
    // rather than replacing it (model/effort/env pins live there too).
    await must(
      "set bypassPermissions default",
      sshCommand(
        ip,
        `python3 -c 'import json; p="/Users/admin/.claude/settings.json"; d=json.load(open(p)); d.setdefault("permissions",{})["defaultMode"]="bypassPermissions"; json.dump(d,open(p,"w"),indent=2)'`,
      ),
    );

    await must("tailscale state wipe", sshCommand(ip, TAILSCALE_RESET));

    // Authkey is piped via stdin so it never appears in a command line.
    // --accept-dns=false: the VM's egress is plain NAT through the host, so
    // letting MagicDNS rewrite its resolvers risks api.anthropic.com lookups
    // for zero benefit (ts.net names resolve via public DNS anyway).
    await must(
      "tailscale up",
      sshCommand(
        ip,
        `sudo ${TAILSCALE} up --authkey="$(cat)" --hostname=${devboxId} --accept-dns=false`,
      ),
      { stdin: config.tailscaleAuthkey },
    );
    // HTTPS front for the monitoring page (noVNC needs a secure context).
    await must(
      "tailscale serve",
      sshCommand(ip, `sudo ${TAILSCALE} serve --bg ${GATEWAY_PORT}`),
    );

    await must("gateway kickstart", sshCommand(ip, GATEWAY_KICKSTART));

    // The host cannot reach VM tailnet addresses reliably (and the orchestrator
    // health-checks nothing), so verify the gateway from INSIDE the VM.
    let healthy = false;
    for (let i = 0; i < HEALTH_ATTEMPTS; i++) {
      const health = await run(
        sshCommand(ip, `curl -s http://127.0.0.1:${GATEWAY_PORT}/health`),
      );
      if (health.stdout.includes(`"devboxId":"${devboxId}"`)) {
        healthy = true;
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (!healthy) {
      throw new Error(`gateway health check failed for ${devboxId}`);
    }

    // Only now may the gateway consume commands (it polls for this marker):
    // a gateway that boots mid-provision must never accept a task, because
    // the kickstart above would kill it — and the task with it.
    await must(
      "write provision-ready marker",
      sshCommand(ip, "touch ~/ultraclaude.ready"),
    );

    // Best-effort TLS cert pre-warm: the first HTTPS request triggers
    // issuance (~30s), so the monitoring link works instantly when posted.
    await run(
      sshCommand(
        ip,
        `curl -fsS --max-time 60 https://${devboxId}.${config.tailnetSuffix}/health`,
      ),
    );
  };

  const requireValidId = (devboxId: string): void => {
    if (!DEVBOX_ID_PATTERN.test(devboxId)) {
      throw new Error(`invalid devbox id: ${JSON.stringify(devboxId)}`);
    }
  };

  return {
    provision: async (devboxId) => {
      requireValidId(devboxId);
      console.log(
        `[hostagent] provisioning ${devboxId} from ${config.goldenImage}`,
      );
      try {
        await provisionSteps(devboxId);
        console.log(`[hostagent] ${devboxId} provisioned and healthy`);
      } catch (error) {
        // Best-effort teardown of the partial VM, then report the failure to
        // Convex so the pre-created devbox row is dropped (freeing the host
        // slot) and the task is failed — otherwise the row counts against the
        // host's VM capacity forever. Rethrow afterwards so the failure is
        // visible in the log; the consumer acks either way.
        console.error(
          `[hostagent] provisioning ${devboxId} failed; cleaning up partial VM:`,
          error,
        );
        await run([tart, "stop", devboxId]);
        await run([tart, "delete", devboxId]);
        const summary = `Provisioning failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        // Best-effort: a Convex hiccup here must not mask the original error.
        await reportProvisionFailure(devboxId, summary).catch((reportError) => {
          console.error(
            `[hostagent] failed to report provision failure for ${devboxId}:`,
            reportError,
          );
        });
        throw error;
      }
    },

    destroy: async (devboxId) => {
      requireValidId(devboxId);
      console.log(`[hostagent] destroying ${devboxId}`);
      // Best-effort: release the tailnet identity while the VM is still up.
      // Safe since the provision-time state wipe makes identities per-clone:
      // logout revokes only THIS node's key, not a shared one.
      const ipResult = await run([tart, "ip", devboxId]);
      const ip = ipResult.code === 0 ? ipResult.stdout.trim() : "";
      if (ip !== "") {
        await run(sshCommand(ip, `sudo ${TAILSCALE} logout`));
      }
      await run([tart, "stop", devboxId]); // may already be stopped
      const deleted = await run([tart, "delete", devboxId]);
      if (deleted.code !== 0 && (await vmExists(devboxId))) {
        // The VM survived the delete: keep the devbox row so the leak stays
        // visible (the consumer acks the command either way).
        const detail = deleted.stderr.trim() || deleted.stdout.trim();
        throw new Error(
          `tart delete ${devboxId} failed (exit ${deleted.code}): ${detail}`,
        );
      }
      await removeDevbox(devboxId);
      console.log(`[hostagent] ${devboxId} destroyed and removed from Convex`);
    },
  };
}
