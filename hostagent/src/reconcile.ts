// Boot-time reconciliation for a provisioner host agent. A new-host bootstrap
// runs as a DETACHED child of the host-agent process, tracked only by an
// in-memory flag (hostProvision.ts). When the agent restarts mid-bootstrap (a
// crash, or a deploy-payload `kickstart -k` that kills the whole launchd job
// tree) the bootstrap dies without emitting `provision_failed`, and its
// pre-created "provisioning" Convex row would hold the fleet-wide scale-up lock
// until HOST_PROVISION_STALE_MS (90 min) — blocking every queued task. On
// startup the just-restarted agent owns no live bootstrap, so it explicitly
// fails any "provisioning" row it created, freeing the lock in seconds. Mirrors
// the gateway's boot-time orphan reconciliation (tasks.orphansForDevbox).

export type ReconcileOptions = {
  /** Wraps the hosts:failOrphanedProvisions mutation (injected for testing). */
  failOrphanedProvisions: (args: {
    provisionerHostId: string;
    secret: string;
  }) => Promise<{ failed: string[] }>;
  hostId: string;
  secret: string;
  /** Only fleet provisioners ever own "provisioning" rows; others skip. */
  canProvisionHosts: boolean;
  log?: (message: string) => void;
  logError?: (message: string, error: unknown) => void;
};

/**
 * Fails any bootstrap this provisioner left dangling across a process restart.
 * Returns the freed host names (empty when this host is not a provisioner, when
 * there was nothing to free, or when the call failed). Errors are swallowed: the
 * 90-min stale window stays as the backstop, and a brief Convex hiccup at
 * startup must not stop the agent from coming up.
 *
 * Run this BEFORE the command consumer starts so a `provision_host` arriving
 * right after startup can't be mistaken for an orphan of the dead process.
 */
export async function reconcileOrphanedProvisions(
  options: ReconcileOptions,
): Promise<string[]> {
  if (!options.canProvisionHosts) {
    return [];
  }
  try {
    const { failed } = await options.failOrphanedProvisions({
      provisionerHostId: options.hostId,
      secret: options.secret,
    });
    if (failed.length > 0) {
      options.log?.(
        `freed ${failed.length} orphaned bootstrap(s) from a prior restart: ${failed.join(", ")}`,
      );
    }
    return failed;
  } catch (error) {
    options.logError?.("failed to reconcile orphaned bootstraps", error);
    return [];
  }
}
