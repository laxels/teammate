// Static server for the fleet dashboard, run by the com.ultraclaude.dashboard
// LaunchAgent on a fleet host (fronted by Tailscale Serve — tailnet-only).
// Ships with frame-grab.ts; the host has only these two files + the prebuilt dist.
//
//   DASHBOARD_DIR       directory containing index.html + assets + config.json
//   DASHBOARD_PORT      listen port (default 8788)
//   FRAME_GRAB_CONFIG   path to the (mode-0600) JSON with the Convex site URL +
//                       secrets used by POST /api/frame (#70). Default:
//                       $HOME/ultraclaude-dashboard/server-config.json. Lives
//                       OUTSIDE DASHBOARD_DIR so the browser can't fetch it.

import { join, normalize } from "node:path";
import {
  type FrameGrabConfig,
  grabFrame,
  parseFrameGrabRequest,
  timingSafeEqual,
} from "./frame-grab";

const dir =
  process.env.DASHBOARD_DIR ?? `${process.env.HOME}/ultraclaude-dashboard/dist`;
const port = Number(process.env.DASHBOARD_PORT ?? 8788);
const configPath =
  process.env.FRAME_GRAB_CONFIG ??
  `${process.env.HOME}/ultraclaude-dashboard/server-config.json`;

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

// ---- Frame-grab endpoint (#70) ----

/** Cached on first successful load; re-read until the deploy has written it
 * (the LaunchAgent restart after a deploy makes this a non-issue in practice). */
let cachedConfig: FrameGrabConfig | null = null;
async function frameGrabConfig(): Promise<FrameGrabConfig | null> {
  if (cachedConfig) return cachedConfig;
  try {
    const file = Bun.file(configPath);
    if (!(await file.exists())) return null;
    const obj = (await file.json()) as Record<string, unknown>;
    if (
      typeof obj.convexSiteUrl === "string" &&
      typeof obj.dashboardSecret === "string" &&
      typeof obj.devboxSharedSecret === "string"
    ) {
      cachedConfig = {
        convexSiteUrl: obj.convexSiteUrl,
        dashboardSecret: obj.dashboardSecret,
        devboxSharedSecret: obj.devboxSharedSecret,
      };
    }
  } catch {
    // Unreadable/malformed: treat as unconfigured (the route answers 503).
  }
  return cachedConfig;
}

/** Spawn ffmpeg, resolve its stdout PNG bytes; reject on non-zero exit, a
 * timeout (SIGKILL), or a missing binary. */
async function runFfmpeg(
  args: string[],
  timeoutMs: number,
): Promise<Uint8Array> {
  const proc = Bun.spawn(["ffmpeg", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [bytes, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      throw new Error(`ffmpeg exited ${exitCode}: ${err.slice(0, 300)}`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

// One ffmpeg per request; bound concurrency so a burst (e.g. a comment-heavy
// timeline) can't fork-bomb the host. Excess requests get 429 and retry.
const MAX_CONCURRENT_FRAMES = 3;
let inFlight = 0;

async function handleFrameGrab(request: Request): Promise<Response> {
  const config = await frameGrabConfig();
  if (config === null) {
    return Response.json(
      { error: "frame-grab not configured" },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const secret = (body as { secret?: unknown }).secret;
  if (
    typeof secret !== "string" ||
    !timingSafeEqual(secret, config.dashboardSecret)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const req = parseFrameGrabRequest(body);
  if (req === null) {
    return Response.json(
      { error: "expected { taskId, videoTimeSec }" },
      { status: 400 },
    );
  }
  if (inFlight >= MAX_CONCURRENT_FRAMES) {
    return Response.json({ error: "busy, retry shortly" }, { status: 429 });
  }
  inFlight++;
  try {
    const result = await grabFrame(config, req, { fetchFn: fetch, runFfmpeg });
    return result.ok
      ? Response.json({ storageId: result.storageId })
      : Response.json({ error: result.reason }, { status: result.status });
  } finally {
    inFlight--;
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);

    // Frame-grab API (#70) — same origin as the page, so no CORS.
    if (request.method === "POST" && url.pathname === "/api/frame") {
      return handleFrameGrab(request);
    }

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
