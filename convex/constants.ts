// Runtime-neutral values shared across Convex modules. Lives in its own file
// (no function registrations) so "use node" actions can import these without
// bundling a default-runtime functions module.

import { v } from "convex/values";

export const devboxEventTypeValidator = v.union(
  v.literal("started"),
  v.literal("progress"),
  v.literal("needs_input"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("stopped"),
);

/** A devbox/host heartbeat older than this is treated as gone. */
export const HEARTBEAT_FRESHNESS_MS = 2 * 60_000;
