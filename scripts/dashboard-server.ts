// Static server for the fleet dashboard, run by the com.ultraclaude.dashboard
// LaunchAgent on a fleet host (fronted by Tailscale Serve — tailnet-only).
// Self-contained on purpose: the host has only this file + the prebuilt dist.
//
//   DASHBOARD_DIR  directory containing index.html + assets + config.json
//   DASHBOARD_PORT listen port (default 8788)

import { join, normalize } from "node:path";

const dir =
  process.env.DASHBOARD_DIR ?? `${process.env.HOME}/ultraclaude-dashboard/dist`;
const port = Number(process.env.DASHBOARD_PORT ?? 8788);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (
    (dot >= 0 ? MIME[path.slice(dot)] : undefined) ?? "application/octet-stream"
  );
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    // Resolve inside the dist dir only.
    const relative = normalize(decoded).replace(/^(\.\.(\/|$))+/, "");
    const candidate = join(dir, relative);
    if (candidate.startsWith(dir) && relative !== "/" && relative !== "") {
      const file = Bun.file(candidate);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "content-type": contentType(candidate) },
        });
      }
      // A missing path WITH an extension is a real 404 (e.g. a stale hashed
      // asset after a redeploy) — serving index.html as JS breaks the page.
      if (/\.[a-z0-9]+$/i.test(relative)) {
        return new Response("not found", { status: 404 });
      }
    }
    // Extensionless misses are SPA routes.
    const index = Bun.file(join(dir, "index.html"));
    return new Response(index, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[dashboard] serving ${dir} on http://127.0.0.1:${port}`);
