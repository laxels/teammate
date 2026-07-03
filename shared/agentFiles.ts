// Inbound-file staging shared by the devbox gateway and the localagent
// daemon (#138): each downloads staged Slack attachments from its own
// secret-gated endpoint (/devbox/file with x-devbox-secret; /local/file with
// x-local-secret) into a per-task inbox.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "./agentEvents";
import type { DeliverableFile } from "./protocol";

export type DownloadedFile = {
  /** Sanitized display name (safe to put in the prompt). */
  name: string;
  /** Where it was written on this machine (absolute). */
  path: string;
  ok: boolean;
  error?: string;
};

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Makes a Slack filename safe for BOTH the on-disk path and the model prompt.
 * Slack names are attacker-controlled: a newline-bearing name would otherwise
 * inject an instruction-looking line into the devbox prompt, and control chars
 * / path separators could escape the task dir. Replace every control char with
 * a space, drop path separators + leading dots, and collapse whitespace runs.
 */
function sanitizeName(name: string): string {
  let stripped = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? " " : ch;
  }
  const cleaned = stripped
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return cleaned === "" ? "file" : cleaned;
}

/** The per-task inbox directory. Each task's files live under their own dir so
 * cleanup of one task never touches another's (no shared-base race). */
export function taskInboxDir(baseDir: string, taskId: string): string {
  return join(baseDir, sanitizeName(taskId));
}

/** Best-effort removal of a whole task's inbox dir (all batches), on task
 * teardown. Targets only that task's dir, so it can't race another task. */
export async function removeTaskInbox(
  baseDir: string,
  taskId: string,
): Promise<void> {
  await rm(taskInboxDir(baseDir, taskId), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

/** Best-effort removal of a SINGLE download batch's dir. Used when a download
 * is rejected (a duplicate-start race): cleaning only this batch can't delete
 * the accepted same-taskId task's own batch under the shared task dir. */
export async function removeBatchInbox(
  baseDir: string,
  taskId: string,
  subdir: string,
): Promise<void> {
  await rm(join(taskInboxDir(baseDir, taskId), sanitizeName(subdir)), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

export type DownloadDeps = {
  /** Orchestrator HTTP origin (CONVEX_SITE_URL) hosting the file endpoint. */
  convexSiteUrl: string;
  /** File endpoint path, e.g. "/devbox/file" or "/local/file". */
  endpointPath: string;
  /** Auth header (the file is auth-gated, not a public capability URL),
   * e.g. { "x-devbox-secret": secret }. */
  authHeader: Record<string, string>;
  /** A unique-per-download segment (e.g. a monotonic counter). Each /task or
   * /message download gets its own subdir under the task dir, so a later steer
   * carrying the same filename can't overwrite a path an earlier turn was
   * already told to use. */
  subdir: string;
  fetchFn?: FetchLike;
};

/**
 * Downloads each staged file into <baseDir>/<taskId>/<subdir>/ via the
 * orchestrator's authenticated GET <endpointPath>?storageId=... endpoint — the
 * bytes are gated by the shared secret, never a public storage URL, and the
 * bot token never reaches the devbox. Best-effort per file: one failure
 * (including a 404 for a blob pruned while the task sat queued) doesn't sink
 * the others, and the session is told which paths exist (and which failed) via
 * buildInboundFilePromptSuffix. Names are index-prefixed within a batch, and
 * each batch has its own subdir, so paths are stable for the whole task even
 * across repeated steers with the same filename.
 */
export async function downloadInboundFiles(
  files: DeliverableFile[],
  taskId: string,
  baseDir: string,
  deps: DownloadDeps,
): Promise<DownloadedFile[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const dir = join(taskInboxDir(baseDir, taskId), sanitizeName(deps.subdir));
  await mkdir(dir, { recursive: true });
  return await Promise.all(
    files.map(async (file, index) => {
      const name = sanitizeName(file.name);
      const path = join(dir, `${index + 1}-${name}`);
      try {
        const url = new URL(deps.endpointPath, deps.convexSiteUrl);
        url.searchParams.set("storageId", file.storageId);
        const response = await fetchFn(url.toString(), {
          headers: deps.authHeader,
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
          return { name, path, ok: false, error: `HTTP ${response.status}` };
        }
        await writeFile(path, new Uint8Array(await response.arrayBuffer()));
        return { name, path, ok: true };
      } catch (error) {
        return {
          name,
          path,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/**
 * Builds a prompt block pointing the session at the downloaded files (and
 * naming any that failed). Names are already sanitized by downloadInboundFiles.
 * Returns "" when there were no files, so a fileless task's prompt is untouched.
 */
export function buildInboundFilePromptSuffix(
  downloaded: DownloadedFile[],
): string {
  if (downloaded.length === 0) {
    return "";
  }
  const ok = downloaded.filter((file) => file.ok);
  const failed = downloaded.filter((file) => !file.ok);
  const lines: string[] = ["", "---"];
  if (ok.length > 0) {
    lines.push(
      "The user shared these files; they are saved on this machine for you to open and read:",
    );
    for (const file of ok) {
      lines.push(`- ${file.name}: ${file.path}`);
    }
  }
  if (failed.length > 0) {
    lines.push(
      `Note: ${failed.length} shared file(s) could not be downloaded (${failed
        .map((file) => file.name)
        .join(", ")}); tell the user if they were needed.`,
    );
  }
  return lines.join("\n");
}
