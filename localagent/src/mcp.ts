// The local session's MCP servers (#138):
//
// - "cua-driver": the pinned background computer-use driver, run as an
//   EXTERNAL stdio MCP server (`cua-driver mcp`). Background operation is its
//   native design (AX-tree perception, per-window screenshots, per-pid event
//   delivery); when spawned from a launchd context it auto-delegates to the
//   TCC-attributed CuaDriver daemon over its Unix socket. Deliberately NOT
//   registered under the "cua-computer-use" compat name and without the
//   --claude-code-computer-use-compat flag: the flag is a no-op since the
//   compat screenshot tool was removed upstream (#1692) and it confuses
//   Claude Code's tool indexer.
// - "local-peer": reply_to_cloud — answers a split task's peer requests via
//   POST /local/peer/reply.
// - "share-file": the shared deliverable-upload tool against /local/artifact.

import {
  createSdkMcpServer,
  type McpServerConfig,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FetchLike } from "../../shared/agentEvents";
import { createShareMcpServer } from "../../shared/agentShare";
import {
  PEER_BODY_MAX_CHARS,
  type PeerReplyPayload,
} from "../../shared/protocol";
import type { LocalAgentConfig } from "./config";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/** POSTs a PeerReplyPayload to /local/peer/reply; pure-ish so it is
 * unit-testable without the SDK. */
export async function sendPeerReply(
  config: LocalAgentConfig,
  payload: PeerReplyPayload,
  fetchFn: FetchLike = fetch,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const response = await fetchFn(
      new URL("/local/peer/reply", config.convexSiteUrl).toString(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-secret": config.localMachineSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as { ok?: boolean; reason?: string };
    return body.ok === true
      ? {
          ok: true,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }
      : { ok: false, reason: body.reason ?? "rejected" };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const PEER_SERVER_INSTRUCTIONS = `Answer the cloud agent's peer requests. Every <peer_request id="..."> message you receive MUST be answered with exactly one reply_to_cloud call quoting its requestId, BEFORE you end your turn — the cloud agent is blocked waiting on it. Put the complete answer in \`result\` (it is delivered as tool output to the cloud agent; there is no follow-up round-trip).`;

function createPeerReplyTool(
  config: LocalAgentConfig,
  taskId: string,
  fetchFn: FetchLike,
) {
  return tool(
    "reply_to_cloud",
    "Answer a peer request from the task's cloud agent. Call exactly once per <peer_request>, quoting its requestId, before ending your turn.",
    {
      requestId: z
        .string()
        .describe('The id from the <peer_request id="..."> block'),
      result: z
        .string()
        .max(PEER_BODY_MAX_CHARS)
        .describe("The complete answer, delivered verbatim to the cloud agent"),
    },
    async (input): Promise<ToolResult> => {
      const outcome = await sendPeerReply(
        config,
        {
          machineId: config.machineId,
          taskId,
          requestId: input.requestId,
          body: input.result,
        },
        fetchFn,
      );
      return outcome.ok
        ? textResult(
            outcome.reason === "already answered"
              ? `Request ${input.requestId} was already answered — the earlier reply stands.`
              : `Reply delivered for request ${input.requestId}.`,
          )
        : textResult(
            `Error: reply for ${input.requestId} was not accepted (${outcome.reason ?? "unknown"}).`,
            true,
          );
    },
  );
}

/** Built fresh per task (like the gateway's factory) so in-process servers
 * carry no session state and tools attribute their work to the task. */
export function createLocalMcpServers(
  config: LocalAgentConfig,
  taskId: string,
  fetchFn: FetchLike = fetch,
): Record<string, McpServerConfig> {
  return {
    "cua-driver": {
      type: "stdio",
      command: config.cuaDriverBin,
      args: ["mcp"],
    },
    "local-peer": createSdkMcpServer({
      name: "local-peer",
      version: "0.1.0",
      instructions: PEER_SERVER_INSTRUCTIONS,
      alwaysLoad: true,
      tools: [createPeerReplyTool(config, taskId, fetchFn)],
    }),
    "share-file": createShareMcpServer({
      endpoint: {
        convexSiteUrl: config.convexSiteUrl,
        endpointPath: "/local/artifact",
        authHeader: { "x-local-secret": config.localMachineSecret },
      },
      taskId,
      fetchFn,
    }),
  };
}
