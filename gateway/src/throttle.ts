export type Throttler = {
  /**
   * Returns true (and starts a new window) if at least `intervalMs` has
   * elapsed since the last successful acquire; false otherwise.
   */
  tryAcquire(): boolean;
};

export function createThrottler(
  intervalMs: number,
  now: () => number = Date.now,
): Throttler {
  let last = Number.NEGATIVE_INFINITY;
  return {
    tryAcquire(): boolean {
      const t = now();
      if (t - last >= intervalMs) {
        last = t;
        return true;
      }
      return false;
    },
  };
}
