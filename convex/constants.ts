// Runtime-neutral values shared across Convex modules. Lives in its own file
// (no function registrations) so "use node" actions can import these without
// bundling a default-runtime functions module.

import { v } from "convex/values";
import { DEVBOX_EVENT_TYPES } from "../shared/protocol";

// Derived from the shared wire contract so a new event type can't be added to
// the union without this validator accepting it.
export const devboxEventTypeValidator = v.union(
  ...DEVBOX_EVENT_TYPES.map((t) => v.literal(t)),
);

/** A devbox/host heartbeat older than this is treated as gone. */
export const HEARTBEAT_FRESHNESS_MS = 2 * 60_000;
