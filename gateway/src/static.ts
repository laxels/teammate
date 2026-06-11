import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

async function fileResponse(path: string): Promise<Response | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  return new Response(Bun.file(path));
}

/**
 * Serve a file from `distDir` for GET `pathname`, falling back to
 * index.html (SPA routing). Returns null when nothing can be served
 * (missing dist directory or path traversal attempt).
 */
export async function serveStatic(
  distDir: string,
  pathname: string,
): Promise<Response | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const root = resolve(distDir);
  const target = resolve(root, `.${sep}${decoded.replace(/^\/+/, "")}`);
  if (target !== root && !target.startsWith(root + sep)) {
    return null; // path traversal
  }

  if (target !== root) {
    const exact = await fileResponse(target);
    if (exact !== null) return exact;
  }
  return fileResponse(resolve(root, "index.html"));
}
