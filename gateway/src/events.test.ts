import { describe, expect, test } from "bun:test";
import type { DevboxEvent } from "../../shared/protocol";
import { createEventSender, type FetchLike } from "./events";

const config = {
  convexSiteUrl: "https://example.convex.site",
  devboxId: "devbox-1",
  devboxSharedSecret: "s3cret",
};

describe("createEventSender", () => {
  test("POSTs a DevboxEvent with the shared-secret header", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchStub: FetchLike = async (url, init) => {
      requests.push({ url, init: init ?? {} });
      return new Response("ok");
    };

    const send = createEventSender(config, fetchStub, () => 1234);
    await send("task-1", "progress", "halfway there");

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("unreachable");
    expect(request.url).toBe("https://example.convex.site/devbox/events");
    expect(request.init.method).toBe("POST");
    const headers = request.init.headers as Record<string, string>;
    expect(headers["x-devbox-secret"]).toBe("s3cret");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(request.init.body)) as DevboxEvent;
    expect(body).toEqual({
      devboxId: "devbox-1",
      taskId: "task-1",
      type: "progress",
      summary: "halfway there",
      ts: 1234,
    });
  });

  test("a rejected fetch never throws", async () => {
    const send = createEventSender(config, async () => {
      throw new Error("connection refused");
    });
    await expect(send("task-1", "started", "hi")).resolves.toBeUndefined();
  });

  test("a non-2xx response never throws", async () => {
    const send = createEventSender(
      config,
      async () => new Response("nope", { status: 500 }),
    );
    await expect(send("task-1", "failed", "boom")).resolves.toBeUndefined();
  });

  test("a blackholed POST times out instead of wedging the queue", async () => {
    const urls: string[] = [];
    const fetchStub: FetchLike = (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) {
        // Never settles on its own; only the abort signal can end it. A POST
        // into a dead network behaves exactly like this.
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        });
      }
      return Promise.resolve(new Response("ok"));
    };

    const send = createEventSender(config, fetchStub, Date.now, 20);
    await send("task-1", "started", "into the void");
    await send("task-1", "completed", "must still be delivered");

    expect(urls).toHaveLength(2);
  });

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

    const send = createEventSender(config, fetchFn);

    const first = send("task-1", "progress", "almost done");
    const second = send("task-1", "completed", "done");
    // Let the queued microtask start the first fetch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1); // second POST not started while first is in flight
    release();
    await Promise.all([first, second]);
    expect(arrivals).toEqual(["progress", "completed"]);
  });
});
