export type RingBuffer<T> = {
  push(item: T): void;
  /** Oldest-first copy of the retained items. */
  snapshot(): T[];
};

/** Fixed-capacity buffer retaining the most recent `capacity` items. */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `ring buffer capacity must be a positive integer, got ${capacity}`,
    );
  }
  const items: T[] = [];
  let start = 0;
  return {
    push(item: T): void {
      if (items.length < capacity) {
        items.push(item);
      } else {
        items[start] = item;
        start = (start + 1) % capacity;
      }
    },
    snapshot(): T[] {
      return [...items.slice(start), ...items.slice(0, start)];
    },
  };
}
