import { describe, expect, test } from "bun:test";
import { createRingBuffer } from "../src/history";

describe("createRingBuffer", () => {
  test("returns pushed items oldest-first while under capacity", () => {
    const buffer = createRingBuffer<number>(5);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.snapshot()).toEqual([1, 2, 3]);
  });

  test("retains only the most recent items past capacity, in order", () => {
    const buffer = createRingBuffer<number>(3);
    for (let i = 1; i <= 10; i++) buffer.push(i);
    expect(buffer.snapshot()).toEqual([8, 9, 10]);
  });

  test("snapshot is a copy, not a live view", () => {
    const buffer = createRingBuffer<number>(2);
    buffer.push(1);
    const snap = buffer.snapshot();
    buffer.push(2);
    expect(snap).toEqual([1]);
  });

  test("rejects a non-positive capacity", () => {
    expect(() => createRingBuffer(0)).toThrow();
  });
});
