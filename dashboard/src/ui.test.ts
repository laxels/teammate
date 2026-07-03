import { describe, expect, test } from "bun:test";
import { orphanNoteEntries } from "./ui";

// Repro for the orphan-note double render: a note whose task is rendered on a
// history row (e.g. a retry note on a terminal task under the "all" filter)
// must NOT also render as a live-board orphan.
describe("orphanNoteEntries", () => {
  test("excludes notes for tasks shown on the live board or in history", () => {
    const notes = {
      "task-active": "✓ sent",
      "task-history": "✓ retried → task-new",
      "task-hidden": "✓ archived",
    };
    const orphans = orphanNoteEntries(notes, [
      "task-active", // live board row
      "task-history", // history row (the pre-fix bug: these double-rendered)
    ]);
    expect(orphans).toEqual([["task-hidden", "✓ archived"]]);
  });

  test("keeps the safety net for tasks hidden by the current filter", () => {
    const orphans = orphanNoteEntries({ "task-gone": "✓ stopped" }, []);
    expect(orphans).toEqual([["task-gone", "✓ stopped"]]);
  });
});
