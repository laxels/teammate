import { describe, expect, test } from "bun:test";
import { reconcileOrphanedTasks } from "../src/reconcile";

type Emitted = { taskId: string; type: string; summary: string };

function emitCollector(events: Emitted[]) {
  return async (taskId: string, type: string, summary: string) => {
    events.push({ taskId, type, summary });
  };
}

describe("reconcileOrphanedTasks", () => {
  test("fails every running task assigned to this devbox", async () => {
    const events: Emitted[] = [];
    await reconcileOrphanedTasks({
      queryOrphans: async () => [
        { taskId: "task-a", title: "Probe A" },
        { taskId: "task-b", title: "Probe B" },
      ],
      emitEvent: emitCollector(events),
    });

    expect(events.map((e) => e.taskId)).toEqual(["task-a", "task-b"]);
    for (const event of events) {
      expect(event.type).toBe("failed");
      expect(event.summary).toContain("restarted");
    }
  });

  test("emits nothing when no running tasks are assigned", async () => {
    const events: Emitted[] = [];
    await reconcileOrphanedTasks({
      queryOrphans: async () => [],
      emitEvent: emitCollector(events),
    });
    expect(events).toEqual([]);
  });

  test("a failing query is swallowed (boot must not crash)", async () => {
    const events: Emitted[] = [];
    await reconcileOrphanedTasks({
      queryOrphans: async () => {
        throw new Error("convex unreachable");
      },
      emitEvent: emitCollector(events),
    });
    expect(events).toEqual([]);
  });
});
