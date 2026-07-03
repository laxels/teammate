import { describe, expect, test } from "bun:test";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { FetchLike } from "../../shared/agentEvents";
import type { PeerReplyPayload } from "../../shared/protocol";
import type { LocalAgentConfig } from "./config";
import { createLocalMcpServers, sendPeerReply } from "./mcp";

const config: LocalAgentConfig = {
  machineId: "local-axels-mbp",
  convexUrl: "https://x.convex.cloud",
  convexSiteUrl: "https://x.convex.site",
  localMachineSecret: "local-secret",
  cuaDriverBin: "/Users/axel/.local/bin/cua-driver",
  cwd: "/Users/axel",
};

/** Fetch stub that records every call and answers via `responder` (mirrors
 * gateway/src/test-helpers.ts recordingFetch, typed as the shared FetchLike). */
function recordingFetch(responder: () => Response): {
  fetchFn: FetchLike;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return responder();
  };
  return { fetchFn, calls };
}

/** The result shape MCP tool handlers resolve with, as the tests consume it. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type RegisteredTool = {
  handler: (args: never, extra: Record<string, unknown>) => Promise<unknown>;
};

/** findTool/call against a live SDK MCP server (mirrors
 * gateway/src/test-helpers.ts findTool/call, which take a bare tool array;
 * here the tools are registered on createSdkMcpServer's McpServer instance). */
function findTool(
  server: McpServerConfig | undefined,
  name: string,
): RegisteredTool {
  if (server === undefined || server.type !== "sdk") {
    throw new Error(`no sdk server carrying tool ${name}`);
  }
  const registered = (
    server.instance as unknown as {
      _registeredTools: Record<string, RegisteredTool>;
    }
  )._registeredTools;
  const tool = registered[name];
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  return tool;
}

async function call(
  server: McpServerConfig | undefined,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  return (await findTool(server, name).handler(
    args as never,
    {},
  )) as ToolResult;
}

const payload: PeerReplyPayload = {
  machineId: "local-axels-mbp",
  taskId: "task-1",
  requestId: "req-1",
  body: "the answer",
};

describe("sendPeerReply", () => {
  test("POSTs the payload to /local/peer/reply with the local secret", async () => {
    const rec = recordingFetch(() => Response.json({ ok: true }));
    const outcome = await sendPeerReply(config, payload, rec.fetchFn);
    expect(outcome).toEqual({ ok: true });
    expect(rec.calls[0]?.url).toBe("https://x.convex.site/local/peer/reply");
    expect(rec.calls[0]?.init?.method).toBe("POST");
    const headers = (rec.calls[0]?.init?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(headers["x-local-secret"]).toBe("local-secret");
    expect(JSON.parse(String(rec.calls[0]?.init?.body))).toEqual(payload);
  });

  test("maps an HTTP error status to a failed outcome", async () => {
    const rec = recordingFetch(() => new Response("denied", { status: 401 }));
    expect(await sendPeerReply(config, payload, rec.fetchFn)).toEqual({
      ok: false,
      reason: "HTTP 401",
    });
  });

  test("maps a server-side rejection to a failed outcome with its reason", async () => {
    const rec = recordingFetch(() =>
      Response.json({ ok: false, reason: "unknown requestId" }),
    );
    expect(await sendPeerReply(config, payload, rec.fetchFn)).toEqual({
      ok: false,
      reason: "unknown requestId",
    });
  });

  test("maps a network error to a failed outcome instead of throwing", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("socket hang up");
    };
    expect(await sendPeerReply(config, payload, fetchFn)).toEqual({
      ok: false,
      reason: "socket hang up",
    });
  });
});

describe("createLocalMcpServers", () => {
  test("runs cua-driver as an external stdio server on the pinned binary", () => {
    const servers = createLocalMcpServers(config, "task-1");
    // No --claude-code-computer-use-compat flag (a no-op upstream that
    // confuses the tool indexer) and no "cua-computer-use" compat name.
    expect(servers["cua-driver"]).toEqual({
      type: "stdio",
      command: "/Users/axel/.local/bin/cua-driver",
      args: ["mcp"],
    });
    expect("cua-computer-use" in servers).toBe(false);
  });

  test("registers the local-peer and share-file in-process servers", () => {
    const servers = createLocalMcpServers(config, "task-1");
    expect(findTool(servers["local-peer"], "reply_to_cloud")).toBeDefined();
    expect(findTool(servers["share-file"], "share_file")).toBeDefined();
  });

  test("reply_to_cloud posts this task's reply and reports delivery", async () => {
    const rec = recordingFetch(() => Response.json({ ok: true }));
    const servers = createLocalMcpServers(config, "task-9", rec.fetchFn);
    const result = await call(servers["local-peer"], "reply_to_cloud", {
      requestId: "req-7",
      result: "the app is on port 8787",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "Reply delivered for request req-7",
    );
    // The tool attributes the reply to the task it was built for.
    expect(JSON.parse(String(rec.calls[0]?.init?.body))).toEqual({
      machineId: "local-axels-mbp",
      taskId: "task-9",
      requestId: "req-7",
      body: "the app is on port 8787",
    });
  });

  test("reply_to_cloud reports an already-answered request as settled, not an error", async () => {
    const rec = recordingFetch(() =>
      Response.json({ ok: true, reason: "already answered" }),
    );
    const servers = createLocalMcpServers(config, "task-9", rec.fetchFn);
    const result = await call(servers["local-peer"], "reply_to_cloud", {
      requestId: "req-7",
      result: "second answer",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      "already answered — the earlier reply stands",
    );
  });

  test("reply_to_cloud surfaces a rejection as a tool error with its reason", async () => {
    const rec = recordingFetch(() =>
      Response.json({ ok: false, reason: "no matching pending request" }),
    );
    const servers = createLocalMcpServers(config, "task-9", rec.fetchFn);
    const result = await call(servers["local-peer"], "reply_to_cloud", {
      requestId: "req-gone",
      result: "too late",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no matching pending request");
  });
});
