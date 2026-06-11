import { monitoringUrl, shouldNudge } from "../src/orchestration";
import { postSlackMessage } from "../src/slackApi";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { HEARTBEAT_FRESHNESS_MS } from "./devboxes";

/**
 * Cron target: for active (queued or running) tasks with no devbox event in
 * the last 30 minutes, post a one-line check-in to the task thread. The
 * status line is derived purely from Convex state (devbox heartbeat freshness
 * and task assignment) — Convex cloud cannot reach tailnet gateway addresses,
 * so dialing the gateway from here would always fail. markNudged guarantees
 * at most one check-in per task per 30 minutes.
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
    const active = await ctx.runQuery(internal.tasks.activeWithLatestEvent, {});

    for (const task of active) {
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
      const monitorUrl =
        devbox === null ? null : monitoringUrl(devbox.gatewayUrl);

      let statusPart: string;
      if (devbox === null) {
        statusPart = "no devbox is assigned to this task";
      } else {
        const heartbeatMin = Math.round((now - devbox.lastSeenAt) / 60_000);
        const heartbeatPart =
          now - devbox.lastSeenAt <= HEARTBEAT_FRESHNESS_MS
            ? `last devbox heartbeat ${heartbeatMin}m ago`
            : `no devbox heartbeat for ${heartbeatMin}m — the devbox may be down`;
        statusPart =
          devbox.taskId === task.taskId
            ? heartbeatPart
            : `${heartbeatPart}, and the devbox is no longer assigned to this task`;
      }

      const sinceMin = Math.round((now - task.latestActivityMs) / 60_000);
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
