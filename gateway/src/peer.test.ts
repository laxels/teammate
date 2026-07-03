import { describe, expect, test } from "bun:test";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { GatewayConfig } from "./config";
import {
  awaitPeerReply,
  createPeerMcpServer,
  type PeerDeps,
  postPeerRequest,
} from "./peer";
import { call, recordingFetch } from "./test-helpers";

const config: GatewayConfig = {
  devboxId: "devbox-1",
  port: 8787,
  convexSiteUrl: "https://example.convex.site",
  convexUrl: "https://example.convex.cloud",
  devboxSharedSecret: "s3cret",
};

function makeDeps(
  fetchFn: typeof fetch,
  extra: Partial<PeerDeps> = {},
): PeerDeps {
  return {
    config,
    taskId: "task-1a2b3c4d",
    fetchFn,
    newRequestId: () => "req-fixed001",
    ...extra,
  };
}

/** Fake clock: sleep() advances now() instantly, so poll loops run without
 * real waiting and the poll cadence is observable. */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
} {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Answers reply polls with each entry in turn, repeating the last one. */
function replySequence(replies: (string | null)[]): (url: string) => Response {
  let i = 0;
  return () => {
    const reply = replies[Math.min(i, replies.length - 1)] ?? null;
    i += 1;
    return jsonResponse({ reply, localAccess: "granted", agentActive: true });
  };
}

/** The SDK server config wraps its tools in a live McpServer; reach into its
 * registry to drive handlers directly (findTool/call operate on that shape). */
function serverTools(server: McpSdkServerConfigWithInstance): {
  name: string;
  handler: (args: never, extra: Record<string, unknown>) => Promise<unknown>;
}[] {
  const registered = (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: never,
            extra: Record<string, unknown>,
          ) => Promise<unknown>;
        }
      >;
    }
  )._registeredTools;
  return Object.entries(registered).map(([name, t]) => ({
    name,
    handler: t.handler,
  }));
}

describe("postPeerRequest", () => {
  test("POSTs the request payload with the shared secret and surfaces the state", async () => {
    const rec = recordingFetch(() =>
      jsonResponse({
        requestId: "req-fixed001",
        state: "spawned",
        machineId: "mac-abc123",
      }),
    );
    const result = await postPeerRequest(
      makeDeps(rec.fetchFn),
      "zip ~/taxes and share the path",
    );

    expect(result).toEqual({
      requestId: "req-fixed001",
      state: "spawned",
      machineId: "mac-abc123",
    });
    expect(rec.calls[0]?.url).toBe(
      "https://example.convex.site/devbox/peer/request",
    );
    const init = rec.calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-devbox-secret"]).toBe("s3cret");
    // The wire payload carries the crosstalk guard (devboxId) and the
    // caller-generated idempotency key (requestId).
    expect(JSON.parse(String(init?.body))).toEqual({
      taskId: "task-1a2b3c4d",
      devboxId: "devbox-1",
      requestId: "req-fixed001",
      body: "zip ~/taxes and share the path",
    });
  });

  test("throws on a non-2xx response", async () => {
    const rec = recordingFetch(() => new Response("no", { status: 503 }));
    await expect(postPeerRequest(makeDeps(rec.fetchFn), "x")).rejects.toThrow(
      "503",
    );
  });
});

describe("awaitPeerReply", () => {
  test("returns immediately when the first poll already has the reply", async () => {
    const rec = recordingFetch(replySequence(["all done"]));
    const clock = fakeClock();
    const result = await awaitPeerReply(
      makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      "req-fixed001",
      240,
    );
    expect(result.reply).toBe("all done");
    expect(rec.calls.length).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("polls every 5s until a reply appears on a later poll", async () => {
    const rec = recordingFetch(replySequence([null, null, "took a while"]));
    const clock = fakeClock();
    const result = await awaitPeerReply(
      makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      "req-fixed001",
      240,
    );
    expect(result.reply).toBe("took a while");
    expect(rec.calls.length).toBe(3);
    expect(clock.sleeps).toEqual([5_000, 5_000]);
  });

  test("returns reply:null once the deadline lapses, never sleeping past it", async () => {
    const rec = recordingFetch(replySequence([null]));
    const clock = fakeClock();
    const result = await awaitPeerReply(
      makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      "req-fixed001",
      12, // deadline mid-interval: the last sleep is clipped to 2s
    );
    expect(result.reply).toBeNull();
    // Polls at t=0s, 5s, 10s, 12s — then the deadline has lapsed.
    expect(rec.calls.length).toBe(4);
    expect(clock.sleeps).toEqual([5_000, 5_000, 2_000]);
  });

  test("caps a timeout above 240s at 240s (the per-call wait discipline)", async () => {
    const rec = recordingFetch(replySequence([null]));
    const clock = fakeClock();
    const result = await awaitPeerReply(
      makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      "req-fixed001",
      999_999,
    );
    expect(result.reply).toBeNull();
    // 240s at a 5s cadence: polls at t=0..240s inclusive = 49, not ~200k.
    expect(rec.calls.length).toBe(49);
  });
});

describe("createPeerMcpServer tools", () => {
  test("exposes exactly the request/await pair", () => {
    const rec = recordingFetch(() => jsonResponse({}));
    const names = serverTools(createPeerMcpServer(makeDeps(rec.fetchFn))).map(
      (t) => t.name,
    );
    expect(names.sort()).toEqual(["await_local_result", "request_local_work"]);
  });

  test("request_local_work returns the requestId and state note", async () => {
    const rec = recordingFetch(() =>
      jsonResponse({
        requestId: "req-fixed001",
        state: "permission_requested",
      }),
    );
    const tools = serverTools(createPeerMcpServer(makeDeps(rec.fetchFn)));
    const result = await call(tools, "request_local_work", {
      description: "read ~/notes/todo.md and send its contents back",
    });

    expect(result.isError).toBeUndefined();
    const text = String(result.content[0]?.text);
    expect(text).toContain("requestId: req-fixed001");
    expect(text).toContain("state: permission_requested");
    // The state note tells the agent what actually happened next.
    expect(text).toContain("permission");
  });

  test("request_local_work flags misrouted/terminal states as errors", async () => {
    for (const state of [
      "unknown_task",
      "not_your_task",
      "task_terminal",
    ] as const) {
      const rec = recordingFetch(() =>
        jsonResponse({ requestId: "req-fixed001", state }),
      );
      const tools = serverTools(createPeerMcpServer(makeDeps(rec.fetchFn)));
      const result = await call(tools, "request_local_work", {
        description: "anything",
      });
      expect(result.isError).toBe(true);
      expect(String(result.content[0]?.text)).toContain(`state: ${state}`);
    }
  });

  test("request_local_work surfaces a failed POST as an error result", async () => {
    const rec = recordingFetch(() => new Response("no", { status: 500 }));
    const tools = serverTools(createPeerMcpServer(makeDeps(rec.fetchFn)));
    const result = await call(tools, "request_local_work", {
      description: "anything",
    });
    expect(result.isError).toBe(true);
    expect(String(result.content[0]?.text)).toContain("500");
  });

  test("await_local_result formats a landed reply", async () => {
    const rec = recordingFetch(
      replySequence(["The folder is zipped at ~/out.zip"]),
    );
    const clock = fakeClock();
    const tools = serverTools(
      createPeerMcpServer(
        makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      ),
    );
    const result = await call(tools, "await_local_result", {
      request_id: "req-fixed001",
      timeout_seconds: 240,
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content[0]?.text)).toBe(
      "Local reply:\nThe folder is zipped at ~/out.zip",
    );
  });

  test("await_local_result explains a not-yet reply with the access/agent context", async () => {
    const rec = recordingFetch(() =>
      jsonResponse({
        reply: null,
        localAccess: "requested",
        agentActive: false,
      }),
    );
    const clock = fakeClock();
    const tools = serverTools(
      createPeerMcpServer(
        makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      ),
    );
    const result = await call(tools, "await_local_result", {
      request_id: "req-fixed001",
      timeout_seconds: 1,
    });
    expect(result.isError).toBeUndefined();
    const text = String(result.content[0]?.text);
    expect(text).toContain("No reply yet");
    expect(text).toContain("local access: requested");
    expect(text).toContain("no local agent is live");
  });

  test("await_local_result distinguishes never-requested permission", async () => {
    const rec = recordingFetch(() =>
      jsonResponse({ reply: null, localAccess: null, agentActive: true }),
    );
    const clock = fakeClock();
    const tools = serverTools(
      createPeerMcpServer(
        makeDeps(rec.fetchFn, { sleep: clock.sleep, now: clock.now }),
      ),
    );
    const result = await call(tools, "await_local_result", {
      request_id: "req-fixed001",
      timeout_seconds: 1,
    });
    const text = String(result.content[0]?.text);
    expect(text).toContain("permission not yet requested");
    expect(text).toContain("local agent is active");
  });
});
