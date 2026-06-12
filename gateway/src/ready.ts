import { existsSync } from "node:fs";

/**
 * Blocks until the provision-ready marker exists. Provisioning writes it as
 * the final step (after the gateway health check), so a gateway that boots
 * mid-provision — the LaunchAgent KeepAlive-respawns the moment
 * ~/ultraclaude.env appears — can serve /health but never consumes commands
 * until the VM is fully provisioned. Without this gate, the early gateway
 * could accept a task only to be killed seconds later by provisioning's
 * `launchctl kickstart -k`, silently orphaning the task (observed 2026-06-11:
 * 4 of 6 ephemeral tasks lost this way).
 */
export async function waitForProvisionReady(
  markerPath: string,
  { pollMs = 500 }: { pollMs?: number } = {},
): Promise<void> {
  let waitedMs = 0;
  while (!existsSync(markerPath)) {
    if (waitedMs > 0 && waitedMs % 30_000 < pollMs) {
      console.log(
        `[gateway] waiting for provision-ready marker ${markerPath} (${Math.round(waitedMs / 1000)}s)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    waitedMs += pollMs;
  }
}
