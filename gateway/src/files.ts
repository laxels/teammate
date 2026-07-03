// The download core moved to shared/agentFiles.ts (#138) so the localagent
// daemon reuses it; this shim binds the gateway's /devbox/file endpoint +
// x-devbox-secret header and preserves the original module surface.

import {
  type DownloadedFile,
  downloadInboundFiles as downloadAgentFiles,
} from "../../shared/agentFiles";
import type { DeliverableFile } from "../../shared/protocol";
import type { FetchLike } from "./events";

export {
  buildInboundFilePromptSuffix,
  type DownloadedFile,
  removeBatchInbox,
  removeTaskInbox,
  taskInboxDir,
} from "../../shared/agentFiles";

export type DownloadDeps = {
  /** Orchestrator HTTP origin (CONVEX_SITE_URL) hosting /devbox/file. */
  convexSiteUrl: string;
  /** Shared secret sent as x-devbox-secret (the file is auth-gated, not a
   * public capability URL). */
  secret: string;
  /** A unique-per-download segment (e.g. a monotonic counter). Each /task or
   * /message download gets its own subdir under the task dir, so a later steer
   * carrying the same filename can't overwrite a path an earlier turn was
   * already told to use. */
  subdir: string;
  fetchFn?: FetchLike;
};

export async function downloadInboundFiles(
  files: DeliverableFile[],
  taskId: string,
  baseDir: string,
  deps: DownloadDeps,
): Promise<DownloadedFile[]> {
  return await downloadAgentFiles(files, taskId, baseDir, {
    convexSiteUrl: deps.convexSiteUrl,
    endpointPath: "/devbox/file",
    authHeader: { "x-devbox-secret": deps.secret },
    subdir: deps.subdir,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });
}
