export type OrphanTask = { taskId: string; title?: string };

export type ReconcileOptions = {
  /**
   * Fetches the tasks this devbox should treat as orphaned on boot: tasks
   * Convex still considers running here, plus queued tasks whose `start`
   * command was already delivered (claimed/acked) to a now-dead process.
   */
  queryOrphans: () => Promise<OrphanTask[]>;
  emitEvent: (taskId: string, type: "failed", summary: string) => Promise<void>;
};

/**
 * A freshly booted gateway owns no sessions, so any task Convex still treats
 * as live on this devbox was lost with the previous process (crash, watchdog
 * hard-exit, deploy kickstart). Fail those tasks loudly: their start commands
 * were already claimed/acked and will never be redelivered, so without this
 * they hang silently forever — nothing else in the system notices a dead
 * session whose gateway came back.
 */
export async function reconcileOrphanedTasks(
  options: ReconcileOptions,
): Promise<void> {
  let orphans: OrphanTask[];
  try {
    orphans = await options.queryOrphans();
  } catch (error) {
    // Boot must survive a flaky control-plane query; the staleness cron is
    // the backstop for anything missed here.
    console.error("[gateway] orphan reconciliation query failed:", error);
    return;
  }
  for (const task of orphans) {
    console.error(
      `[gateway] reconciling orphaned task ${task.taskId}: gateway restarted while it was running`,
    );
    await options.emitEvent(
      task.taskId,
      "failed",
      "Gateway process restarted while this task was running; the session was lost. " +
        "Marking the task failed so it does not hang silently.",
    );
  }
}
