import { expect, test } from "bun:test";
import {
  createVmExecutors,
  GATEWAY_KICKSTART,
  type Run,
  type RunResult,
  SSH_BASE,
  TAILSCALE_RESET,
  type VmConfig,
} from "./vm";

const config: VmConfig = {
  goldenImage: "golden-v4",
  payloadDir: "/Users/m1/ultraclaude-payload",
  tartBin: "/Users/m1/tart.app/Contents/MacOS/tart",
  tailnetSuffix: "ts.example.com",
  tailscaleAuthkey: "tskey-test",
  convexUrl: "https://x.convex.cloud",
  convexSiteUrl: "https://x.convex.site",
  devboxSharedSecret: "s3cret",
};

const TART = config.tartBin;
const IP = "192.168.64.9";
// vm.ts passes the full joined SSH_BASE (sshpass prefix included) as rsync's
// -e argument.
const SSH_E = SSH_BASE.join(" ");

type Call = { command: string[]; stdin: string | undefined };
type Handler = (command: string[]) => Partial<RunResult> | undefined;

function harness(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const reported: { devboxId: string; summary: string }[] = [];
  const run: Run = async (command, options) => {
    calls.push({ command, stdin: options?.stdin });
    return { code: 0, stdout: "", stderr: "", ...handler(command) };
  };
  const executors = createVmExecutors({
    config,
    run,
    removeDevbox: async (devboxId) => {
      removed.push(devboxId);
    },
    reportProvisionFailure: async (devboxId, summary) => {
      reported.push({ devboxId, summary });
    },
    sleep: async () => {},
  });
  return { calls, removed, reported, executors };
}

function remoteOf(command: string[]): string {
  return command.at(-1) ?? "";
}

/** Compact one-line label per recorded command, for sequence assertions. */
function summarize(call: Call): string {
  const cmd = call.command;
  if (cmd[0] === "sshpass") {
    return `ssh admin@${(cmd.at(-2) ?? "").replace("admin@", "")}: ${remoteOf(cmd)}`;
  }
  if (cmd[0] === "/bin/sh") {
    // Detached nohup wrapper: the positional args are tart bin + VM name.
    return `detached: ${cmd.slice(3).join(" ")}`;
  }
  return cmd.join(" ");
}

function happyHandler(command: string[]): Partial<RunResult> | undefined {
  if (command[0] === TART && command[1] === "ip") {
    return { stdout: `${IP}\n` };
  }
  if (
    command[0] === "sshpass" &&
    remoteOf(command).includes("curl -s http://127.0.0.1:8787/health")
  ) {
    return {
      stdout: '{"devboxId":"dev-1","running":false,"taskId":null}',
    };
  }
  return undefined;
}

test("provision runs the exact step sequence in order", async () => {
  const { calls, removed, reported, executors } = harness(happyHandler);
  await executors.provision("dev-1");

  expect(calls.map(summarize)).toEqual([
    `${TART} clone golden-v4 dev-1`,
    `detached: ${TART} dev-1`,
    `${TART} ip dev-1`,
    `ssh admin@${IP}: true`,
    `rsync -az -e ${SSH_E} /Users/m1/ultraclaude-payload/ admin@${IP}:ultraclaude/`,
    `ssh admin@${IP}: cd ~/ultraclaude && ~/.bun/bin/bun install --frozen-lockfile`,
    `ssh admin@${IP}: umask 077; cat > ~/ultraclaude.env && chmod 600 ~/ultraclaude.env`,
    `ssh admin@${IP}: python3 -c 'import json; p="/Users/admin/.claude/settings.json"; d=json.load(open(p)); d.setdefault("permissions",{})["defaultMode"]="bypassPermissions"; json.dump(d,open(p,"w"),indent=2)'`,
    `ssh admin@${IP}: ${TAILSCALE_RESET}`,
    `ssh admin@${IP}: sudo /opt/homebrew/bin/tailscale up --authkey="$(cat)" --hostname=dev-1 --accept-dns=false`,
    `ssh admin@${IP}: sudo /opt/homebrew/bin/tailscale serve --bg 8787`,
    `ssh admin@${IP}: ${GATEWAY_KICKSTART}`,
    `ssh admin@${IP}: curl -s http://127.0.0.1:8787/health`,
    `ssh admin@${IP}: touch ~/ultraclaude.ready`,
    `ssh admin@${IP}: curl -fsS --max-time 60 https://dev-1.ts.example.com/health`,
  ]);

  // The gateway env file is written via stdin (chmod 600 on the VM side).
  const envWrite = calls.find((c) =>
    remoteOf(c.command).includes("cat > ~/ultraclaude.env"),
  );
  expect(envWrite?.stdin).toBe(
    "DEVBOX_ID=dev-1\nPORT=8787\nCONVEX_SITE_URL=https://x.convex.site\n" +
      "CONVEX_URL=https://x.convex.cloud\nDEVBOX_SHARED_SECRET=s3cret\n",
  );

  // The tailnet authkey goes via stdin, never on a command line.
  const tailscaleUp = calls.find((c) =>
    remoteOf(c.command).includes("tailscale up"),
  );
  expect(tailscaleUp?.stdin).toBe("tskey-test");
  for (const call of calls) {
    expect(call.command.join(" ")).not.toContain("tskey-test");
  }

  // A successful provision never touches the devbox row, nor reports a failure.
  expect(removed).toEqual([]);
  expect(reported).toEqual([]);
});

test("provision polls until the IP and SSH come up", async () => {
  let ipAttempts = 0;
  let sshAttempts = 0;
  const { calls, executors } = harness((command) => {
    if (command[0] === TART && command[1] === "ip") {
      ipAttempts += 1;
      return ipAttempts < 3 ? { code: 1 } : { stdout: `${IP}\n` };
    }
    if (command[0] === "sshpass" && remoteOf(command) === "true") {
      sshAttempts += 1;
      return sshAttempts < 2 ? { code: 255 } : { code: 0 };
    }
    return happyHandler(command);
  });
  await executors.provision("dev-1");

  expect(calls.filter((c) => c.command[1] === "ip")).toHaveLength(3);
  expect(
    calls.filter(
      (c) => c.command[0] === "sshpass" && remoteOf(c.command) === "true",
    ),
  ).toHaveLength(2);
});

test("provision failure mid-way tears down the VM, reports the leak, and rethrows", async () => {
  const { calls, removed, reported, executors } = harness((command) => {
    if (command[0] === "rsync") {
      return { code: 23, stderr: "rsync: connection unexpectedly closed" };
    }
    return happyHandler(command);
  });

  await expect(executors.provision("dev-1")).rejects.toThrow(
    "rsync payload failed (exit 23)",
  );
  expect(calls.slice(-2).map((c) => c.command)).toEqual([
    [TART, "stop", "dev-1"],
    [TART, "delete", "dev-1"],
  ]);
  // The slot is freed via the failure report, never via removeDevbox (which is
  // reserved for the destroy path). The summary carries the failing step.
  expect(removed).toEqual([]);
  expect(reported).toEqual([
    {
      devboxId: "dev-1",
      summary:
        "Provisioning failed: rsync payload failed (exit 23): " +
        "rsync: connection unexpectedly closed",
    },
  ]);
});

test("provision gives up after the IP poll budget, with cleanup and a failure report", async () => {
  const { calls, reported, executors } = harness((command) =>
    command[1] === "ip" ? { code: 1 } : undefined,
  );

  await expect(executors.provision("dev-1")).rejects.toThrow("never got an IP");
  expect(calls.filter((c) => c.command[1] === "ip")).toHaveLength(36);
  expect(calls.slice(-2).map((c) => c.command)).toEqual([
    [TART, "stop", "dev-1"],
    [TART, "delete", "dev-1"],
  ]);
  expect(reported).toEqual([
    {
      devboxId: "dev-1",
      summary: "Provisioning failed: dev-1 never got an IP",
    },
  ]);
});

test("a noisy failure summary is collapsed to one line and capped", async () => {
  // A failing step can spew a multi-KB multi-line stderr tail; the report must
  // stay small enough that the provisionVmFailed mutation can't reject on size.
  const noisyStderr = `${"connection reset by peer\n".repeat(200)}`;
  const { reported, executors } = harness((command) =>
    command[0] === "rsync"
      ? { code: 23, stderr: noisyStderr }
      : happyHandler(command),
  );

  await expect(executors.provision("dev-1")).rejects.toThrow("rsync payload");

  const summary = reported[0]?.summary ?? "";
  expect(summary.length).toBe(500);
  expect(summary).not.toContain("\n");
  expect(summary.startsWith("Provisioning failed: rsync payload failed")).toBe(
    true,
  );
});

test("a failure-report error never masks the original provision error", async () => {
  const calls: string[][] = [];
  const run: Run = async (command) => {
    calls.push(command);
    const override =
      command[0] === "rsync"
        ? { code: 23, stderr: "rsync: connection unexpectedly closed" }
        : happyHandler(command);
    return { code: 0, stdout: "", stderr: "", ...override };
  };
  const executors = createVmExecutors({
    config,
    run,
    removeDevbox: async () => {},
    reportProvisionFailure: async () => {
      throw new Error("convex unreachable");
    },
    sleep: async () => {},
  });

  // The provision rejects with the ORIGINAL error, not the reporting error.
  await expect(executors.provision("dev-1")).rejects.toThrow(
    "rsync payload failed (exit 23)",
  );
  // Teardown still ran despite the reporting failure.
  expect(calls.slice(-2)).toEqual([
    [TART, "stop", "dev-1"],
    [TART, "delete", "dev-1"],
  ]);
});

test("provision rejects shell-unsafe devbox ids before touching tart", async () => {
  const { calls, executors } = harness();
  await expect(executors.provision("Bad;Id")).rejects.toThrow(
    "invalid devbox id",
  );
  expect(calls).toEqual([]);
});

test("destroy logs out of the tailnet, deletes the VM, then removes the row", async () => {
  const { calls, removed, executors } = harness((command) =>
    command[1] === "ip" ? { stdout: `${IP}\n` } : undefined,
  );
  await executors.destroy("dev-1");

  expect(calls.map(summarize)).toEqual([
    `${TART} ip dev-1`,
    `ssh admin@${IP}: sudo /opt/homebrew/bin/tailscale logout`,
    `${TART} stop dev-1`,
    `${TART} delete dev-1`,
  ]);
  expect(removed).toEqual(["dev-1"]);
});

test("destroy still removes the row when the VM is already gone", async () => {
  // tart ip / stop / delete all fail (the VM does not exist), and tart list
  // confirms it is absent: the devbox row must still be cleaned up.
  const { calls, removed, executors } = harness((command) => {
    if (command[1] === "list") {
      return {
        stdout: "Source Name      Size State\nlocal  golden-v4 40   stopped\n",
      };
    }
    return { code: 1, stderr: `VM "dev-1" not found` };
  });
  await executors.destroy("dev-1");

  expect(calls.map((c) => c.command)).toEqual([
    [TART, "ip", "dev-1"], // fails -> no ssh logout attempt
    [TART, "stop", "dev-1"],
    [TART, "delete", "dev-1"],
    [TART, "list"],
  ]);
  expect(removed).toEqual(["dev-1"]);
});

test("destroy keeps the devbox row when the VM survives tart delete", async () => {
  const { removed, executors } = harness((command) => {
    if (command[1] === "ip") {
      return { code: 1 };
    }
    if (command[1] === "delete") {
      return { code: 1, stderr: "delete failed" };
    }
    if (command[1] === "list") {
      return { stdout: "Source Name  Size State\nlocal  dev-1 40   running\n" };
    }
    return undefined;
  });

  await expect(executors.destroy("dev-1")).rejects.toThrow(
    "tart delete dev-1 failed",
  );
  expect(removed).toEqual([]);
});

test("transient ssh failures (exit 255) are retried, not fatal", async () => {
  let bypassAttempts = 0;
  const { calls, executors } = harness((command) => {
    if (
      command[0] === "sshpass" &&
      remoteOf(command).includes("settings.json")
    ) {
      bypassAttempts++;
      if (bypassAttempts === 1) {
        return {
          code: 255,
          stderr:
            "admin@192.168.64.3: Permission denied (publickey,password,keyboard-interactive).",
        };
      }
      return {};
    }
    return happyHandler(command);
  });
  await executors.provision("dev-1");

  expect(bypassAttempts).toBe(2);
  // The rest of the sequence still completed.
  expect(calls.some((c) => remoteOf(c.command).includes("tailscale up"))).toBe(
    true,
  );
});
