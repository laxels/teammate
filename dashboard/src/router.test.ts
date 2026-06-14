import { describe, expect, test } from "bun:test";
import { parsePath, taskPath } from "./router";

describe("parsePath", () => {
  test("the board path has no taskId", () => {
    expect(parsePath("/")).toEqual({ taskId: null });
    expect(parsePath("")).toEqual({ taskId: null });
    expect(parsePath("/anything/else")).toEqual({ taskId: null });
  });

  test("a task path yields the id, trailing slash tolerated", () => {
    expect(parsePath("/task/task-abc123")).toEqual({ taskId: "task-abc123" });
    expect(parsePath("/task/task-abc123/")).toEqual({ taskId: "task-abc123" });
  });

  test("the id is URL-decoded", () => {
    expect(parsePath("/task/task%2Fweird")).toEqual({ taskId: "task/weird" });
  });

  test("an empty or malformed id is not a task route", () => {
    expect(parsePath("/task/")).toEqual({ taskId: null });
    expect(parsePath("/task/%")).toEqual({ taskId: null });
  });
});

describe("taskPath", () => {
  test("round-trips through parsePath", () => {
    for (const id of ["task-1", "task/with/slashes", "weird id"]) {
      expect(parsePath(taskPath(id))).toEqual({ taskId: id });
    }
  });
});
