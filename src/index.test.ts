import { expect, test } from "bun:test";
import { greet } from "./index";

test("greet", () => {
  expect(greet("Ada")).toBe("Hello, Ada!");
});
