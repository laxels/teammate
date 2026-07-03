// The share_file tool shared by the devbox gateway and the localagent
// daemon (#138): each uploads deliverables through its own secret-gated
// artifact endpoint (/devbox/artifact; /local/artifact) into the task's
// Slack thread.

import { basename } from "node:path";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FetchLike } from "./agentEvents";
import { MAX_OUTBOUND_FILE_BYTES } from "./protocol";

/** Where and how to upload: each host's artifact endpoint + auth header. */
export type ShareEndpoint = {
  convexSiteUrl: string;
  /** e.g. "/devbox/artifact" or "/local/artifact". */
  endpointPath: string;
  /** e.g. { "x-devbox-secret": secret }. */
  authHeader: Record<string, string>;
};

export type ShareFileArgs = {
  endpoint: ShareEndpoint;
  taskId: string;
  path: string;
  title?: string | undefined;
  comment?: string | undefined;
  fetchFn?: FetchLike;
};

export type ShareFileResult =
  | { ok: true; filename: string }
  | { ok: false; error: string };

/**
 * Uploads a local file to the orchestrator's /devbox/artifact endpoint, which
 * posts it into the task's Slack thread. Pure-ish core (no SDK types) so it is
 * unit-testable; the MCP tool below is a thin formatting wrapper. Best-effort:
 * returns the reason on failure rather than throwing.
 */
export async function shareFile(args: ShareFileArgs): Promise<ShareFileResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const filename = basename(args.path);
  try {
    const file = Bun.file(args.path);
    if (!(await file.exists())) {
      return { ok: false, error: `${args.path} does not exist` };
    }
    if (file.size > MAX_OUTBOUND_FILE_BYTES) {
      return {
        ok: false,
        error: `file is ${file.size} bytes, over the ${MAX_OUTBOUND_FILE_BYTES}-byte limit`,
      };
    }
    const form = new FormData();
    form.set("taskId", args.taskId);
    form.set("filename", filename);
    if (args.title !== undefined) form.set("title", args.title);
    if (args.comment !== undefined) form.set("comment", args.comment);
    form.set("file", file, filename);

    const endpoint = new URL(
      args.endpoint.endpointPath,
      args.endpoint.convexSiteUrl,
    ).toString();
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: args.endpoint.authHeader,
      body: form,
    });
    if (!response.ok) {
      return { ok: false, error: `upload failed (HTTP ${response.status})` };
    }
    return { ok: true, filename };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const SERVER_INSTRUCTIONS = `Share a file from this machine into the task's Slack thread, so the person who requested the task receives it.

Use this to deliver results best seen AS a file: a screenshot you captured, a log or report you produced, an exported artifact. First PRODUCE the file (e.g. take a screenshot with the computer-use tools, or write output to a path), then call share_file with its absolute path. Add a short comment so the user knows what it is. This is for deliverables — routine progress is already reported automatically.`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function createShareFileTool(args: {
  endpoint: ShareEndpoint;
  taskId: string;
  fetchFn?: FetchLike;
}) {
  return tool(
    "share_file",
    "Upload a local file into the task's Slack thread so the requester receives it (screenshots, logs, exported results). Give an absolute path to a file you have already created.",
    {
      path: z.string().describe("Absolute path to the file on this machine"),
      title: z
        .string()
        .optional()
        .describe("Optional display title for the file"),
      comment: z
        .string()
        .optional()
        .describe("Optional message posted alongside the file"),
    },
    async (input): Promise<ToolResult> => {
      const result = await shareFile({
        endpoint: args.endpoint,
        taskId: args.taskId,
        path: input.path,
        title: input.title,
        comment: input.comment,
        ...(args.fetchFn ? { fetchFn: args.fetchFn } : {}),
      });
      // A 2xx only means the orchestrator accepted + queued the upload; the
      // actual post into Slack happens asynchronously and is best-effort, so
      // report it as queued rather than confirmed-delivered.
      return result.ok
        ? {
            content: [
              {
                type: "text",
                text: `Queued ${result.filename} for posting to the Slack thread (delivery is best-effort).`,
              },
            ],
          }
        : {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            isError: true,
          };
    },
  );
}

export function createShareMcpServer(args: {
  endpoint: ShareEndpoint;
  taskId: string;
  fetchFn?: FetchLike;
}): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "share-file",
    version: "0.1.0",
    instructions: SERVER_INSTRUCTIONS,
    // Small, always-relevant capability — keep it in the prompt, not behind
    // tool search.
    alwaysLoad: true,
    tools: [createShareFileTool(args)],
  });
}
