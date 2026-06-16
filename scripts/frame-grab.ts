// Pure + dependency-injected core of the fleet-host frame-grab endpoint (#70),
// kept out of dashboard-server.ts so it can be unit-tested without a real
// ffmpeg or network. dashboard-server.ts wires this to Bun.serve + Bun.spawn.
//
// Flow for one grab: resolve the task's recording to a signed Convex storage
// URL (secret-gated, so the browser never supplies a URL) -> ffmpeg-seek a
// single PNG frame at the timestamp -> upload the PNG to Convex storage ->
// return the new storageId for the comment to reference. No repo imports: the
// host runs only this file + dashboard-server.ts + the prebuilt dist.
//
// ffmpeg input-seeks the storage URL directly (not a local download): Convex
// storage honors HTTP range, so ffmpeg reads only the moov + the bytes near the
// target keyframe (~MBs), never the whole recording (which can be hundreds of
// MB). The real #102 bug was never extraction — it was a silent EMPTY upload
// (see the runFfmpeg / upload notes below).

/** Config the host needs, written by deploy-dashboard.sh to a mode-0600 file
 * OUTSIDE the browser-served dist dir (the devbox secret must never be
 * fetchable by the page). */
export type FrameGrabConfig = {
  convexSiteUrl: string;
  /** Operator secret the browser presents (same one the dashboard queries with). */
  dashboardSecret: string;
  /** Gateway/host secret authenticating the host's calls to Convex. */
  devboxSharedSecret: string;
};

export type FrameGrabRequest = { taskId: string; videoTimeSec: number };

/** How long ffmpeg may run on one frame before it's killed (a wedged or absurd
 * input must not pile processes up on the host). */
export const FFMPEG_TIMEOUT_MS = 20_000;

/** Validates the parsed JSON body of a frame-grab request. Returns null on any
 * shape problem (the caller answers 400). videoTimeSec must be a finite,
 * non-negative number — a NaN/negative seek would make ffmpeg misbehave. */
export function parseFrameGrabRequest(body: unknown): FrameGrabRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.taskId !== "string" || b.taskId === "") return null;
  if (
    typeof b.videoTimeSec !== "number" ||
    !Number.isFinite(b.videoTimeSec) ||
    b.videoTimeSec < 0
  ) {
    return null;
  }
  return { taskId: b.taskId, videoTimeSec: b.videoTimeSec };
}

/** Constant-time string compare (length leak is acceptable, value isn't). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** ffmpeg args to extract ONE PNG frame at `videoTimeSec` from `url` to stdout.
 * `-ss` before `-i` is an input seek: ffmpeg issues an HTTP range request when
 * the server supports it (Convex storage does), so it reads only near the
 * target instead of downloading the whole .mov. */
export function ffmpegFrameArgs(url: string, videoTimeSec: number): string[] {
  return [
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    String(videoTimeSec),
    "-i",
    url,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "png",
    "pipe:1",
  ];
}

export type FrameGrabDeps = {
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs ffmpeg with the given args, resolving the PNG bytes from stdout.
   * MUST resolve a real Uint8Array (see dashboard-server.runFfmpeg / #102):
   * Bun's Response(subprocessStdout).bytes() hands back a bare ArrayBuffer for
   * multi-chunk output, which has no `.buffer` — the source of the empty-upload
   * bug. Throws on a non-zero exit, a timeout, or a missing binary. */
  runFfmpeg: (args: string[], timeoutMs: number) => Promise<Uint8Array>;
};

export type FrameGrabResult =
  | { ok: true; storageId: string }
  | { ok: false; status: number; reason: string };

async function readJson(
  res: Response,
): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The full grab pipeline. Every Convex hop carries the devbox secret; failures
 * map to an HTTP status the route returns verbatim. A null recording URL (task
 * gone, recording not "available", or blob pruned) is a clean 404 — the comment
 * is still created, just without a frame.
 */
export async function grabFrame(
  config: FrameGrabConfig,
  req: FrameGrabRequest,
  deps: FrameGrabDeps,
): Promise<FrameGrabResult> {
  const base = config.convexSiteUrl.replace(/\/$/, "");
  const auth = { "x-devbox-secret": config.devboxSharedSecret };

  // 1. Resolve the recording to a signed storage URL.
  let recordingUrl: string;
  try {
    const res = await deps.fetchFn(
      `${base}/devbox/recording-url?taskId=${encodeURIComponent(req.taskId)}`,
      { headers: auth },
    );
    if (!res.ok) {
      return { ok: false, status: 502, reason: `recording-url ${res.status}` };
    }
    const body = await readJson(res);
    const url = body?.url;
    if (typeof url !== "string" || url === "") {
      return { ok: false, status: 404, reason: "recording not available" };
    }
    recordingUrl = url;
  } catch {
    return { ok: false, status: 502, reason: "recording-url unreachable" };
  }

  // 2. Extract the frame (input-seeks the URL via HTTP range; no full download).
  let png: Uint8Array;
  try {
    png = await deps.runFfmpeg(
      ffmpegFrameArgs(recordingUrl, req.videoTimeSec),
      FFMPEG_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, status: 500, reason: "frame extraction failed" };
  }
  if (png.byteLength === 0) {
    return { ok: false, status: 500, reason: "empty frame" };
  }

  // 3. Get a one-shot upload URL.
  let uploadUrl: string;
  try {
    const res = await deps.fetchFn(`${base}/devbox/recording/upload-url`, {
      method: "POST",
      headers: auth,
    });
    if (!res.ok) {
      return { ok: false, status: 502, reason: `upload-url ${res.status}` };
    }
    const body = await readJson(res);
    if (typeof body?.url !== "string" || body.url === "") {
      return { ok: false, status: 502, reason: "no upload url" };
    }
    uploadUrl = body.url;
  } catch {
    return { ok: false, status: 502, reason: "upload-url unreachable" };
  }

  // 4. Upload the PNG; read back its storageId. Send the Uint8Array directly:
  // it's valid BodyInit and carries exactly its bytes. (The old `png.slice()
  // .buffer` was the #102 bug — `.buffer` is undefined when png is an
  // ArrayBuffer, so the body became `undefined` → a 0-byte blob.)
  try {
    const res = await deps.fetchFn(uploadUrl, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    if (!res.ok) {
      return { ok: false, status: 502, reason: `upload ${res.status}` };
    }
    const body = await readJson(res);
    const storageId = body?.storageId;
    if (typeof storageId !== "string" || storageId === "") {
      return { ok: false, status: 502, reason: "no storageId" };
    }
    return { ok: true, storageId };
  } catch {
    return { ok: false, status: 502, reason: "upload unreachable" };
  }
}
