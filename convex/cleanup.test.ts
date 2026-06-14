import { afterEach, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import {
  SLACK_EVENT_RETRY_MAX_AGE_MS,
  shouldRetrySlackEvent,
} from "../src/orchestration";
import { internal } from "./_generated/api";
import {
  EVENT_RETENTION_MS,
  INBOUND_FILE_RETENTION_MS,
  PRUNE_BATCH_SIZE,
  QUEUE_RETENTION_MS,
} from "./cleanup";
import schema from "./schema";

// Bun has no import.meta.glob; hand-build the module map convex-test needs.
// The _generated entries anchor the functions root, and cleanup.ts must be
// listed so the scheduler can resolve the prune mutation's continuation.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./cleanup.ts": () => import("./cleanup"),
};

type Tester = ReturnType<typeof newT>;

function newT() {
  return convexTest(schema, modules);
}

afterEach(() => {
  setSystemTime();
});

/** Runs `fn` with the clock turned back `ageMs`, so inserted rows get a
 * backdated _creationTime (verified: convex-test stamps via Date.now()). */
async function agedBy<T>(ageMs: number, fn: () => Promise<T>): Promise<T> {
  setSystemTime(new Date(Date.now() - ageMs));
  try {
    return await fn();
  } finally {
    setSystemTime();
  }
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function insertSlackEvent(t: Tester, eventId: string, processed: boolean) {
  return t.run(async (ctx) => {
    await ctx.db.insert("slackEvents", {
      eventId,
      type: "message",
      payload: "{}",
      receivedAt: Date.now(),
      processed,
    });
  });
}

function insertCommand(
  t: Tester,
  commandId: string,
  status: "pending" | "acked",
) {
  return t.run(async (ctx) => {
    await ctx.db.insert("commands", {
      commandId,
      devboxId: "devbox-1",
      kind: "start",
      payload: "{}",
      status,
      createdAt: Date.now(),
    });
  });
}

function insertHostCommand(
  t: Tester,
  commandId: string,
  status: "pending" | "acked",
) {
  return t.run(async (ctx) => {
    await ctx.db.insert("hostCommands", {
      commandId,
      hostId: "host-1",
      kind: "provision_vm",
      payload: "{}",
      status,
      createdAt: Date.now(),
    });
  });
}

function insertTaskEvent(t: Tester, summary: string) {
  return t.run(async (ctx) => {
    await ctx.db.insert("taskEvents", {
      taskId: "task-1",
      type: "progress",
      summary,
      ts: Date.now(),
    });
  });
}

function insertHostEvent(t: Tester, summary: string) {
  return t.run(async (ctx) => {
    await ctx.db.insert("hostEvents", {
      hostId: "host-1",
      type: "provision_progress",
      summary,
      ts: Date.now(),
    });
  });
}

test("prunes rows past each table's window, keeps rows inside it", async () => {
  const t = newT();

  // Oldest first: convex-test forces _creationTime to be monotonically
  // increasing, so out-of-order backdated inserts would get bumped forward.
  await agedBy(EVENT_RETENTION_MS + HOUR_MS, async () => {
    await insertTaskEvent(t, "task-old");
    await insertHostEvent(t, "host-old");
  });
  await agedBy(EVENT_RETENTION_MS - HOUR_MS, async () => {
    await insertTaskEvent(t, "task-new");
    await insertHostEvent(t, "host-new");
  });
  await agedBy(QUEUE_RETENTION_MS + HOUR_MS, async () => {
    await insertSlackEvent(t, "evt-old", true);
    // Old *pending* rows go too: their devbox/host is long gone, and
    // delivering a week-old command would be wrong, not just useless.
    await insertCommand(t, "cmd-old-pending", "pending");
    await insertCommand(t, "cmd-old-acked", "acked");
    await insertHostCommand(t, "hcmd-old", "pending");
  });
  await agedBy(QUEUE_RETENTION_MS - HOUR_MS, async () => {
    await insertSlackEvent(t, "evt-new", true);
    await insertCommand(t, "cmd-new", "pending");
    await insertHostCommand(t, "hcmd-new", "acked");
  });

  const result = await t.mutation(internal.cleanup.pruneExpired, {});
  expect(result.rescheduled).toBe(false);
  expect(result.deleted).toEqual({
    slackEvents: 1,
    commands: 2,
    hostCommands: 1,
    taskEvents: 1,
    hostEvents: 1,
  });

  const remaining = await t.run(async (ctx) => ({
    slackEvents: (await ctx.db.query("slackEvents").collect()).map(
      (r) => r.eventId,
    ),
    commands: (await ctx.db.query("commands").collect()).map(
      (r) => r.commandId,
    ),
    hostCommands: (await ctx.db.query("hostCommands").collect()).map(
      (r) => r.commandId,
    ),
    taskEvents: (await ctx.db.query("taskEvents").collect()).map(
      (r) => r.summary,
    ),
    hostEvents: (await ctx.db.query("hostEvents").collect()).map(
      (r) => r.summary,
    ),
  }));
  expect(remaining).toEqual({
    slackEvents: ["evt-new"],
    commands: ["cmd-new"],
    hostCommands: ["hcmd-new"],
    taskEvents: ["task-new"],
    hostEvents: ["host-new"],
  });
});

test("prunes inbound file blobs + rows past the window, keeps fresh ones", async () => {
  const t = newT();

  const staleId = await agedBy(INBOUND_FILE_RETENTION_MS + HOUR_MS, () =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["old bytes"]));
      await ctx.db.insert("inboundFiles", {
        storageId,
        eventId: "evt-old",
        createdAt: Date.now(),
      });
      return storageId;
    }),
  );
  const freshId = await agedBy(INBOUND_FILE_RETENTION_MS - HOUR_MS, () =>
    t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["new bytes"]));
      await ctx.db.insert("inboundFiles", {
        storageId,
        eventId: "evt-new",
        createdAt: Date.now(),
      });
      return storageId;
    }),
  );

  const result = await t.mutation(internal.cleanup.pruneExpired, {});
  expect(result.deleted.inboundFiles).toBe(1);

  const remaining = await t.run(async (ctx) => ({
    rows: (await ctx.db.query("inboundFiles").collect()).map((r) => r.eventId),
    staleBlobExists: (await ctx.storage.get(staleId)) !== null,
    freshBlobExists: (await ctx.storage.get(freshId)) !== null,
  }));
  expect(remaining.rows).toEqual(["evt-new"]);
  // The stale blob is gone; the fresh one survives.
  expect(remaining.staleBlobExists).toBe(false);
  expect(remaining.freshBlobExists).toBe(true);
});

test("never prunes a slack event the dead-letter replay could still pick up", async () => {
  // Static invariant behind the race the retention window must avoid:
  // anything old enough to prune is permanently outside the 2min-24h
  // replay window of slack.retryUnprocessed, with ample margin.
  expect(QUEUE_RETENTION_MS).toBeGreaterThan(SLACK_EVENT_RETRY_MAX_AGE_MS * 2);
  const now = Date.now();
  expect(
    shouldRetrySlackEvent({
      nowMs: now,
      receivedAtMs: now - QUEUE_RETENTION_MS,
      processed: false,
    }),
  ).toBe(false);

  const t = newT();
  // Stranded event past retention: replay gave up on it days of margin ago.
  await agedBy(QUEUE_RETENTION_MS + MINUTE_MS, () =>
    insertSlackEvent(t, "evt-dead", false),
  );
  // Stranded (unprocessed) event still inside the replay window: must survive.
  await agedBy(23 * HOUR_MS, () => insertSlackEvent(t, "evt-stranded", false));

  await t.mutation(internal.cleanup.pruneExpired, {});

  const remaining = await t.run(async (ctx) =>
    (await ctx.db.query("slackEvents").collect()).map((r) => r.eventId),
  );
  expect(remaining).toEqual(["evt-stranded"]);
});

test("drains a backlog in batches via self-rescheduling", async () => {
  const t = newT();
  const backlog = PRUNE_BATCH_SIZE + 3;
  await agedBy(EVENT_RETENTION_MS + HOUR_MS, () =>
    t.run(async (ctx) => {
      for (let i = 0; i < backlog; i++) {
        await ctx.db.insert("hostEvents", {
          hostId: "host-1",
          type: "provision_progress",
          summary: `backlog-${i}`,
          ts: Date.now(),
        });
      }
    }),
  );
  await insertHostEvent(t, "fresh");

  const result = await t.mutation(internal.cleanup.pruneExpired, {});
  expect(result.deleted.hostEvents).toBe(PRUNE_BATCH_SIZE);
  expect(result.rescheduled).toBe(true);

  // The continuation is a real 0ms timer inside convex-test: yield
  // macrotasks so each link of the chain fires, then await its completion.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.finishInProgressScheduledFunctions();
  }

  const remaining = await t.run(async (ctx) =>
    (await ctx.db.query("hostEvents").collect()).map((r) => r.summary),
  );
  expect(remaining).toEqual(["fresh"]);
});
