import type { GatewayHealth } from "../shared/protocol";
import {
  monitoringUrl,
  STALE_AFTER_MS,
  shouldNudge,
} from "../src/orchestration";
import { postSlackMessage } from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

async function fetchGatewayHealth(
  gatewayUrl: string,
): Promise<GatewayHealth | null> {
  try {
    const response = await fetch(new URL("/health", gatewayUrl), {
      method: "GET",
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as GatewayHealth;
  } catch {
    return null;
  }
}

/**
 * Cron target: for running tasks with no devbox event in the last 30 minutes,
 * check the gateway's health and post a one-line check-in to the task thread.
 * markNudged guarantees at most one check-in per task per 30 minutes.
 */
export const checkStaleTasks = internalAction({
  args: {},
  handler: async (ctx) => {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (botToken === undefined) {
      console.error("SLACK_BOT_TOKEN is not set; skipping staleness check");
      return;
    }
    const now = Date.now();
    const running = await ctx.runQuery(
      internal.tasks.runningWithLatestEvent,
      {},
    );

    for (const task of running) {
      const nudgeArgs: Parameters<typeof shouldNudge>[0] = {
        nowMs: now,
        latestActivityMs: task.latestActivityMs,
      };
      if (task.lastNudgedAt !== undefined) {
        nudgeArgs.lastNudgedAtMs = task.lastNudgedAt;
      }
      if (!shouldNudge(nudgeArgs)) {
        continue;
      }

      const devbox =
        task.devboxId === undefined
          ? null
          : await ctx.runQuery(internal.devboxes.getByDevboxId, {
              devboxId: task.devboxId,
            });
      const health =
        devbox === null ? null : await fetchGatewayHealth(devbox.gatewayUrl);
      const monitorUrl =
        devbox === null ? null : monitoringUrl(devbox.gatewayUrl);

      const sinceMin = Math.round((now - task.latestActivityMs) / 60_000);
      const statusPart =
        health === null
          ? "the devbox gateway is not responding"
          : health.running && health.taskId === task.taskId
            ? "the devbox says it is still working"
            : "the devbox no longer reports this task as running";
      const monitorPart = monitorUrl === null ? "" : ` Monitor: ${monitorUrl}`;
      const text = `:hourglass_flowing_sand: No updates from *${task.title}* for ${sinceMin} min — ${statusPart}.${monitorPart}`;

      try {
        await postSlackMessage({
          botToken,
          channel: task.slackChannel,
          text,
          threadTs: task.slackThreadTs,
        });
        await ctx.runMutation(internal.tasks.markNudged, {
          taskId: task.taskId,
          nudgedAt: now,
        });
      } catch (error) {
        console.error(`check-in for ${task.taskId} failed:`, error);
      }
    }
  },
});

// Re-export so the 30-minute contract is visible from the cron module too.
export { STALE_AFTER_MS };
