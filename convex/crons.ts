import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Proactive check-ins: flag running tasks whose latest devbox event is older
// than 30 minutes (see staleness.checkStaleTasks).
crons.interval(
  "check stale tasks",
  { minutes: 15 },
  internal.staleness.checkStaleTasks,
  {},
);

// Dead-letter recovery: re-schedule Slack events whose processing action
// died before claiming them (see slack.retryUnprocessed).
crons.interval(
  "retry stranded slack events",
  { minutes: 5 },
  internal.slack.retryUnprocessed,
  {},
);

export default crons;
