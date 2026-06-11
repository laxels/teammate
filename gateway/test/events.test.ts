import { describe, expect, test } from "bun:test";
import type { DevboxEvent } from "../../shared/protocol";
import { createEventSender, type FetchLike } from "../src/events";

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
});
