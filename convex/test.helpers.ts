// Shared convex-test utilities. The multi-dot basename keeps the Convex CLI
// from bundling this file as a deploy entry point (the same rule that already
// excludes *.test.ts) and keeps bun test from collecting it as a suite.

import type { TestConvex } from "convex-test";
import type schema from "./schema";

/**
 * Runs the 0ms scheduled follow-ups (placeQueuedEphemeralTasks,
 * notify.devboxEvent/taskNote, self-rescheduling prune batches) so they
 * execute inside the test and any error surfaces, instead of erroring in the
 * background after the suite goes green. Each continuation is a real 0ms
 * timer inside convex-test, so yield a macrotask per chain link before
 * finishing the in-progress functions.
 */
export async function drainScheduled(
  t: TestConvex<typeof schema>,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }
}
