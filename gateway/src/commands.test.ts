import { expect, test } from "bun:test";
import { type PendingCommand, selectNewCommands } from "./commands";

function cmd(id: string, createdAt: number): PendingCommand {
  return { commandId: id, kind: "start", payload: "{}", createdAt };
}

test("returns unseen commands in creation order and marks them seen", () => {
  const seen = new Set<string>();
  const out = selectNewCommands([cmd("b", 2), cmd("a", 1)], seen);
  expect(out.map((c) => c.commandId)).toEqual(["a", "b"]);
  expect(seen.has("a")).toBe(true);
  expect(seen.has("b")).toBe(true);
});

test("re-delivered pending sets do not double-execute", () => {
  const seen = new Set<string>();
  selectNewCommands([cmd("a", 1)], seen);
  // Subscription fires again with the same still-pending command plus a new one.
  const out = selectNewCommands([cmd("a", 1), cmd("c", 3)], seen);
  expect(out.map((c) => c.commandId)).toEqual(["c"]);
});

test("empty update yields nothing", () => {
  const seen = new Set<string>(["a"]);
  expect(selectNewCommands([], seen)).toEqual([]);
});
