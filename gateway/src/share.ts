// The share_file core moved to shared/agentShare.ts (#138) so the localagent
// daemon reuses it; this shim binds the gateway's /devbox/artifact endpoint +
// x-devbox-secret header and preserves the original module surface.

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  createShareMcpServer as createAgentShareMcpServer,
  type ShareEndpoint,
  type ShareFileResult,
  shareFile as shareAgentFile,
} from "../../shared/agentShare";
import type { GatewayConfig } from "./config";
import type { FetchLike } from "./events";

export type { ShareFileResult } from "../../shared/agentShare";

export type ShareFileArgs = {
  config: GatewayConfig;
  taskId: string;
  path: string;
  title?: string | undefined;
  comment?: string | undefined;
  fetchFn?: FetchLike;
};

function endpointFor(config: GatewayConfig): ShareEndpoint {
  return {
    convexSiteUrl: config.convexSiteUrl,
    endpointPath: "/devbox/artifact",
    authHeader: { "x-devbox-secret": config.devboxSharedSecret },
  };
}

export async function shareFile(args: ShareFileArgs): Promise<ShareFileResult> {
  return await shareAgentFile({
    endpoint: endpointFor(args.config),
    taskId: args.taskId,
    path: args.path,
    title: args.title,
    comment: args.comment,
    ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
  });
}

export function createShareMcpServer(args: {
  config: GatewayConfig;
  taskId: string;
  fetchFn?: FetchLike;
}): McpSdkServerConfigWithInstance {
  return createAgentShareMcpServer({
    endpoint: endpointFor(args.config),
    taskId: args.taskId,
    ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
  });
}
