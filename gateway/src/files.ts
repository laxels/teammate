import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliverableFile } from "../../shared/protocol";
import type { FetchLike } from "./events";

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

export type DownloadDeps = {
  /** Orchestrator HTTP origin (CONVEX_SITE_URL) hosting /devbox/file. */
  convexSiteUrl: string;
  /** Shared secret sent as x-devbox-secret (the file is auth-gated, not a
   * public capability URL). */
  secret: string;
  fetchFn?: FetchLike;
};

/**
 * Downloads each staged file into <baseDir>/<taskId>/ via the orchestrator's
 * authenticated GET /devbox/file?storageId=... endpoint — the bytes are gated
 * by the shared secret, never a public storage URL, and the bot token never
 * reaches the devbox. Best-effort per file: one failure (including a 404 for a
 * blob pruned while the task sat queued) doesn't sink the others, and the
 * session is told which paths exist (and which failed) via
 * buildInboundFilePromptSuffix. Names are index-prefixed so two attachments
 * with the same name don't collide.
 */
export async function downloadInboundFiles(
  files: DeliverableFile[],
  taskId: string,
  baseDir: string,
  deps: DownloadDeps,
): Promise<DownloadedFile[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const dir = join(baseDir, sanitizeName(taskId));
  await mkdir(dir, { recursive: true });
  return await Promise.all(
    files.map(async (file, index) => {
      const name = sanitizeName(file.name);
      const path = join(dir, `${index + 1}-${name}`);
      try {
        const url = new URL("/devbox/file", deps.convexSiteUrl);
        url.searchParams.set("storageId", file.storageId);
        const response = await fetchFn(url.toString(), {
          headers: { "x-devbox-secret": deps.secret },
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
