import { describe, expect, test } from "bun:test";
import { createThrottler } from "./throttle";

describe("createThrottler", () => {
  test("allows the first acquire immediately", () => {
    const t = 0;
    const throttler = createThrottler(30_000, () => t);
    expect(throttler.tryAcquire()).toBe(true);
  });

  test("suppresses acquires inside the window and allows after it", () => {
    let t = 0;
    const throttler = createThrottler(30_000, () => t);
    expect(throttler.tryAcquire()).toBe(true);

    t = 29_999;
    expect(throttler.tryAcquire()).toBe(false);

    t = 30_000;
    expect(throttler.tryAcquire()).toBe(true);

    // The window restarts from the last successful acquire.
    t = 59_999;
    expect(throttler.tryAcquire()).toBe(false);
    t = 60_000;
    expect(throttler.tryAcquire()).toBe(true);
  });

  test("failed acquires do not push the window forward", () => {
    let t = 0;
    const throttler = createThrottler(30_000, () => t);
    expect(throttler.tryAcquire()).toBe(true);
    for (t = 1_000; t < 30_000; t += 1_000) {
      expect(throttler.tryAcquire()).toBe(false);
    }
    t = 30_000;
    expect(throttler.tryAcquire()).toBe(true);
  });
});
