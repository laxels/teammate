import { expect, test } from "bun:test";
import {
  createVmExecutors,
  type Run,
  type RunResult,
  type VmConfig,
} from "./vm";

const config: VmConfig = {
  goldenImage: "golden-v2",
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
const SSH_E =
  "sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -o PubkeyAuthentication=no -o IdentitiesOnly=yes -o NumberOfPasswordPrompts=1";
const KICKSTART =
  "launchctl kickstart -k gui/501/com.ultraclaude.gateway " +
  "|| { launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.ultraclaude.gateway.plist 2>/dev/null; " +
  "launchctl kickstart -k gui/501/com.ultraclaude.gateway; }";
const TAILSCALE_RESET =
  "set -e; " +
  "sudo launchctl bootout system/homebrew.mxcl.tailscale 2>/dev/null || true; " +
  "sudo rm -rf /Library/Tailscale; " +
  "sudo launchctl bootstrap system /Library/LaunchDaemons/homebrew.mxcl.tailscale.plist; " +
  "for i in $(seq 1 30); do /opt/homebrew/bin/tailscale version --daemon >/dev/null 2>&1 && exit 0; sleep 1; done; " +
  'echo "tailscaled did not come back after state wipe" >&2; exit 1';

type Call = { command: string[]; stdin: string | undefined };
type Handler = (command: string[]) => Partial<RunResult> | undefined;

function harness(handler: Handler = () => undefined) {
  const calls: Call[] = [];
  const removed: string[] = [];
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
    sleep: async () => {},
  });
  return { calls, removed, executors };
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
  const { calls, removed, executors } = harness(happyHandler);
  await executors.provision("dev-1");

  expect(calls.map(summarize)).toEqual([
    `${TART} clone golden-v2 dev-1`,
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
    `ssh admin@${IP}: ${KICKSTART}`,
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

  // Provisioning never touches the devbox row.
  expect(removed).toEqual([]);
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

test("provision failure mid-way cleans up the partial VM and rethrows", async () => {
  const { calls, removed, executors } = harness((command) => {
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
  expect(removed).toEqual([]);
});

test("provision gives up after the IP poll budget, with cleanup", async () => {
  const { calls, executors } = harness((command) =>
    command[1] === "ip" ? { code: 1 } : undefined,
  );

  await expect(executors.provision("dev-1")).rejects.toThrow("never got an IP");
  expect(calls.filter((c) => c.command[1] === "ip")).toHaveLength(36);
  expect(calls.slice(-2).map((c) => c.command)).toEqual([
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
        stdout: "Source Name      Size State\nlocal  golden-v2 40   stopped\n",
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
