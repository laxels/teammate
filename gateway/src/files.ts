import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeliverableFile } from "../../shared/protocol";
import type { FetchLike } from "./events";

export type DownloadedFile = {
  /** Original Slack filename. */
  name: string;
  /** Where it was written on this machine (absolute). */
  path: string;
  ok: boolean;
  error?: string;
};

const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Strip path separators and leading dots so a hostile name can't escape the
 * task directory. */
function safeName(name: string): string {
  const base = name.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
  return base === "" ? "file" : base;
}

/**
 * Downloads each staged file (a public Convex storage URL — the bot token
 * never reaches the devbox) into <baseDir>/<taskId>/ and reports where each
 * landed. Best-effort per file: one failure doesn't sink the others, and the
 * session is told which paths exist via buildInboundFilePromptSuffix. Names
 * are index-prefixed so two attachments with the same name don't collide.
 */
export async function downloadInboundFiles(
  files: DeliverableFile[],
  taskId: string,
  baseDir: string,
  fetchFn: FetchLike = fetch,
): Promise<DownloadedFile[]> {
  const dir = join(baseDir, safeName(taskId));
  await mkdir(dir, { recursive: true });
  return await Promise.all(
    files.map(async (file, index) => {
      const path = join(dir, `${index + 1}-${safeName(file.name)}`);
      try {
        const response = await fetchFn(file.url, {
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) {
          return {
            name: file.name,
            path,
            ok: false,
            error: `HTTP ${response.status}`,
          };
        }
        await writeFile(path, new Uint8Array(await response.arrayBuffer()));
        return { name: file.name, path, ok: true };
      } catch (error) {
        return {
          name: file.name,
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
 * naming any that failed). Returns "" when there were no files, so a fileless
 * task's prompt is untouched.
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
