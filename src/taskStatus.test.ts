import { expect, test } from "bun:test";
import {
  isTerminalTaskStatus,
  shouldApplyTaskStatus,
} from "../shared/protocol";

test("terminal statuses are terminal", () => {
  expect(isTerminalTaskStatus("completed")).toBe(true);
  expect(isTerminalTaskStatus("failed")).toBe(true);
  expect(isTerminalTaskStatus("stopped")).toBe(true);
  expect(isTerminalTaskStatus("running")).toBe(false);
  expect(isTerminalTaskStatus("queued")).toBe(false);
  expect(isTerminalTaskStatus("needs_input")).toBe(false);
});

test("a late progress event cannot regress a completed task", () => {
  expect(shouldApplyTaskStatus("completed", "running")).toBe(false);
  expect(shouldApplyTaskStatus("stopped", "needs_input")).toBe(false);
});

test("normal forward transitions apply", () => {
  expect(shouldApplyTaskStatus("queued", "running")).toBe(true);
  expect(shouldApplyTaskStatus("running", "completed")).toBe(true);
  expect(shouldApplyTaskStatus("running", "needs_input")).toBe(true);
});

test("terminal-to-terminal transitions apply (a retry/correction wins)", () => {
  expect(shouldApplyTaskStatus("completed", "stopped")).toBe(true);
  expect(shouldApplyTaskStatus("failed", "completed")).toBe(true);
});
