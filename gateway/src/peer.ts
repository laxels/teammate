// The cloud agent's side of the local-machine peer channel (#138): an
// in-process MCP server with two tools. request_local_work files a request
// against the user's real Mac (POST /devbox/peer/request — Convex delivers it
// to the local agent, spawning one and/or asking the user for permission as
// needed; the orchestrator LLM stays out of the loop). await_local_result
// blocks THIS tool call polling for the reply, capped at 240s per call so the
// session's #69 wait-in-turn discipline holds: the agent loops on it with its
// own wall-clock deadline.

import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { PeerRequestPayload } from "../../shared/protocol";
import type { GatewayConfig } from "./config";
import type { FetchLike } from "./events";

/** Per-call cap on the await tool: matches the session prompt's "cap every
 * individual wait at 4 minutes" discipline (#69) — under the 10-min stall
 * watchdog and the ~5-min prompt-cache TTL. */
export const AWAIT_CAP_SECONDS = 240;
const POLL_INTERVAL_MS = 5_000;

export type PeerRequestResult = {
  requestId: string;
  state: string;
  machineId?: string;
};

export type PeerReplyResult = {
  reply: string | null;
  localAccess: string | null;
  agentActive: boolean;
};

export type PeerDeps = {
  config: GatewayConfig;
  taskId: string;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  newRequestId?: () => string;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function postPeerRequest(
  deps: PeerDeps,
  body: string,
): Promise<PeerRequestResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const requestId =
    deps.newRequestId?.() ?? `req-${crypto.randomUUID().slice(0, 8)}`;
  const payload: PeerRequestPayload = {
    taskId: deps.taskId,
    devboxId: deps.config.devboxId,
    requestId,
    body,
  };
  const response = await fetchFn(
    new URL("/devbox/peer/request", deps.config.convexSiteUrl).toString(),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-devbox-secret": deps.config.devboxSharedSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`peer request failed (HTTP ${response.status})`);
  }
  return (await response.json()) as PeerRequestResult;
}

export async function fetchPeerReply(
  deps: PeerDeps,
  requestId: string,
): Promise<PeerReplyResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = new URL("/devbox/peer/reply", deps.config.convexSiteUrl);
  url.searchParams.set("taskId", deps.taskId);
  url.searchParams.set("requestId", requestId);
  const response = await fetchFn(url.toString(), {
    headers: { "x-devbox-secret": deps.config.devboxSharedSecret },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`peer reply poll failed (HTTP ${response.status})`);
  }
  return (await response.json()) as PeerReplyResult;
}

/** Poll until a reply lands or the (capped) timeout lapses. */
export async function awaitPeerReply(
  deps: PeerDeps,
  requestId: string,
  timeoutSeconds: number,
): Promise<PeerReplyResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const capped = Math.min(Math.max(timeoutSeconds, 1), AWAIT_CAP_SECONDS);
  const deadline = now() + capped * 1000;
  for (;;) {
    const result = await fetchPeerReply(deps, requestId);
    if (result.reply !== null) {
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return result;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

const STATE_NOTES: Record<string, string> = {
  delivered: "Delivered to the live local agent.",
  spawned: "A local agent is starting on the user's machine with this request.",
  permission_requested:
    "The user was just asked in the Slack thread for permission to use their machine (per-task grant). Poll await_local_result; if permission is denied you'll get that as the reply. If nothing arrives within your deadline (~10-15 min is reasonable for a human answer), continue cloud-only best-effort and say so in your result.",
  permission_pending:
    "Permission is still pending with the user (already asked). Poll await_local_result and apply your deadline discipline.",
  denied:
    "The user DENIED local-machine access for this task. Do not re-request. Continue cloud-only best-effort and note the limitation in your result.",
  machine_busy:
    "The user's machine is busy with another task (one local session at a time, no queueing). Re-file the request later, or continue cloud-only.",
  no_machine:
    "No local machine is available (none registered, offline, or not this user's). Continue cloud-only best-effort and note the limitation in your result.",
  unknown_task: "This task is unknown to the orchestrator — likely a bug.",
  not_your_task:
    "This devbox is no longer the task's assigned agent; local requests are refused.",
  task_terminal: "The task is already terminal; no local work can be filed.",
};

const SERVER_INSTRUCTIONS = `Request work on the USER'S OWN Mac — their real machine, with their local files, locally installed apps, and signed-in accounts/sessions that don't exist on this devbox. Use it when the task genuinely needs something only their machine has; prefer doing everything you can here first.

Flow: request_local_work files one request (a complete, self-contained ask with everything the local agent needs — it shares no context with you). The first request may trigger a permission ask to the user (per-task grant); the tool result says exactly what happened. Then loop on await_local_result until the reply arrives or your own wall-clock deadline passes — each await call blocks at most 240 seconds (your standard wait discipline). Requests are answered with plain text; there is no back-and-forth within one request, so batch related needs into one ask or file follow-up requests.

If access is denied, no machine is available, or your deadline lapses: continue cloud-only, best effort, and say so in your final result. Never stall the whole task indefinitely on local access.`;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

export function createPeerMcpServer(
  deps: PeerDeps,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "local-machine",
    version: "0.1.0",
    instructions: SERVER_INSTRUCTIONS,
    alwaysLoad: true,
    tools: [
      tool(
        "request_local_work",
        "File a request for the user's local machine (their real Mac: local files, local apps, signed-in sessions). Returns a requestId to poll with await_local_result. The ask must be complete and self-contained — the local agent shares no context with you.",
        {
          description: z
            .string()
            .describe(
              "The complete, self-contained ask: what to do on the user's machine, every detail the local agent needs, and what to send back.",
            ),
        },
        async (input): Promise<ToolResult> => {
          try {
            const result = await postPeerRequest(deps, input.description);
            const note = STATE_NOTES[result.state] ?? `state: ${result.state}`;
            const isError =
              result.state === "unknown_task" ||
              result.state === "not_your_task" ||
              result.state === "task_terminal";
            return textResult(
              `requestId: ${result.requestId}\nstate: ${result.state}\n${note}`,
              isError,
            );
          } catch (error) {
            return textResult(
              `Error filing local-work request: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
          }
        },
      ),
      tool(
        "await_local_result",
        "Block (up to 240s per call) polling for a local-work reply. Loop on it with your own wall-clock deadline; a null reply just means not-yet.",
        {
          request_id: z
            .string()
            .describe("The requestId returned by request_local_work"),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(AWAIT_CAP_SECONDS)
            .default(AWAIT_CAP_SECONDS)
            .describe("How long this call may block (capped at 240)"),
        },
        async (input): Promise<ToolResult> => {
          try {
            const result = await awaitPeerReply(
              deps,
              input.request_id,
              input.timeout_seconds,
            );
            if (result.reply !== null) {
              return textResult(`Local reply:\n${result.reply}`);
            }
            const accessNote =
              result.localAccess === null
                ? "permission not yet requested"
                : `local access: ${result.localAccess}`;
            const agentNote = result.agentActive
              ? "local agent is active"
              : "no local agent is live";
            return textResult(
              `No reply yet (${accessNote}; ${agentNote}). Loop again if your deadline allows; otherwise continue cloud-only best-effort and say so.`,
            );
          } catch (error) {
            return textResult(
              `Error awaiting local result: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
          }
        },
      ),
    ],
  });
}
