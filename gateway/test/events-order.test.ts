import { expect, test } from "bun:test";
import { createEventSender, type FetchLike } from "../src/events";

test("event deliveries are serialized in emission order", async () => {
  const arrivals: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fetchFn: FetchLike = async (_url, init) => {
    calls++;
    const isFirst = calls === 1;
    if (isFirst) {
      // First delivery hangs; without serialization the second would
      // overtake it and arrive first.
      await gate;
    }
    const body = JSON.parse(String(init?.body)) as { type: string };
    arrivals.push(body.type);
    return new Response(null, { status: 200 });
  };

  const send = createEventSender(
    {
      convexSiteUrl: "https://convex.example",
      devboxId: "devbox-test",
      devboxSharedSecret: "shhh",
    },
    fetchFn,
  );

  const first = send("task-1", "progress", "almost done");
  const second = send("task-1", "completed", "done");
  // Let the queued microtask start the first fetch.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toBe(1); // second POST not started while first is in flight
  release();
  await Promise.all([first, second]);
  expect(arrivals).toEqual(["progress", "completed"]);
});
