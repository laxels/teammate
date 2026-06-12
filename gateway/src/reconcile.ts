export type RunningTask = { taskId: string; title?: string };

export type ReconcileOptions = {
  /** Fetches the tasks Convex still considers running on this devbox. */
  queryRunning: () => Promise<RunningTask[]>;
  emitEvent: (taskId: string, type: "failed", summary: string) => Promise<void>;
};

/**
 * A freshly booted gateway owns no sessions, so any task Convex still
 * considers running on this devbox was lost with the previous process
 * (crash, watchdog hard-exit, deploy kickstart). Fail those tasks loudly:
 * their start commands are already acked and will never be redelivered, so
 * without this they hang silently forever — nothing else in the system
 * notices a dead session whose gateway came back.
 */
export async function reconcileOrphanedTasks(
  options: ReconcileOptions,
): Promise<void> {
  let orphans: RunningTask[];
  try {
    orphans = await options.queryRunning();
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
