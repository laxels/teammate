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

import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  type FrameGrabConfig,
  grabFrame,
  parseFrameGrabRequest,
  type RecordingDownload,
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
 * timeout (SIGKILL), or a missing binary. stdout AND stderr are drained
 * concurrently: ffmpeg can be chatty (the mov demuxer emits a warning per odd
 * read), and an undrained stderr pipe fills its ~64 KB OS buffer and deadlocks
 * the process until the timeout SIGKILLs it. */
export async function runFfmpeg(
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
    const [bytes, err, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited ${exitCode}: ${err.slice(0, 300)}`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Hard cap on a single recording download. A signed storage URL that stalls
 * mid-stream must not pin an /api/frame slot open forever (only
 * MAX_CONCURRENT_FRAMES exist; pinning them all wedges the endpoint at 429).
 * Generous vs. a real screen recording — this only bounds the pathological. */
export const RECORDING_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Disk/abuse sanity ceiling for a downloaded recording (1 GiB). A genuine
 * task recording is far smaller; this just stops a wrong/hostile URL from
 * filling the host disk. */
export const MAX_RECORDING_BYTES = 1_073_741_824;

/** Stream the recording at `url` to a unique temp .mov ffmpeg can seek locally
 * (#102), bounded by `timeoutMs` (whole-download abort) and `maxBytes`. Streams
 * straight to disk rather than buffering the body in JS memory. Any non-ok
 * outcome cleans up its own partial file; success hands the path to the caller,
 * which removes it after extraction. */
export async function downloadRecording(
  url: string,
  opts: { timeoutMs: number; maxBytes: number } = {
    timeoutMs: RECORDING_DOWNLOAD_TIMEOUT_MS,
    maxBytes: MAX_RECORDING_BYTES,
  },
): Promise<RecordingDownload> {
  const path = join(tmpdir(), `ultraclaude-frame-${crypto.randomUUID()}.mov`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const writer = Bun.file(path).writer();
  let total = 0;
  let ok = false;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok || res.body === null) {
      return { ok: false, reason: "fetch-failed" };
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      writer.write(value);
    }
    if (total === 0) {
      return { ok: false, reason: "empty" };
    }
    ok = true;
    return { ok: true, path, bytes: total };
  } catch {
    // Timeout abort, network error, or a stream read error.
    return { ok: false, reason: "fetch-failed" };
  } finally {
    clearTimeout(timer);
    // Flush+close the sink (completes the file on success) before any cleanup.
    // FileSink.end() may return a number or a Promise; await tolerates both.
    try {
      await writer.end();
    } catch {
      // Already closed / errored — nothing more to flush.
    }
    if (!ok) await removeFile(path);
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
    const result = await grabFrame(config, req, {
      fetchFn: fetch,
      runFfmpeg,
      downloadRecording,
      removeFile,
    });
    return result.ok
      ? Response.json({ storageId: result.storageId })
      : Response.json({ error: result.reason }, { status: result.status });
  } finally {
    inFlight--;
  }
}

// Started only when run as the entrypoint (the launchd plist does:
// `bun run dashboard-server.ts`), so a test can import the helpers above
// without binding a port.
if (import.meta.main) {
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
}
