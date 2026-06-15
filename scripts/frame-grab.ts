// Pure + dependency-injected core of the fleet-host frame-grab endpoint (#70),
// kept out of dashboard-server.ts so it can be unit-tested without a real
// ffmpeg or network. dashboard-server.ts wires this to Bun.serve + Bun.spawn.
//
// Flow for one grab: resolve the task's recording to a signed Convex storage
// URL (secret-gated, so the browser never supplies a URL) -> download the .mov
// to a local temp file -> ffmpeg-seek a single PNG frame at the timestamp ->
// upload the PNG to Convex storage -> return the new storageId for the comment
// to reference. No repo imports: the host runs only this file +
// dashboard-server.ts + the prebuilt dist.
//
// Why download instead of ffmpeg-seeking the URL directly (#102): a
// `screencapture -v` .mov is non-faststart — its `moov` atom is written at the
// END of the file. To extract any frame, ffmpeg must read that trailing moov
// first, which over HTTP means a byte-range request to the tail. If the storage
// URL doesn't honor ranges flawlessly (a redirect, a CDN that answers 200 with
// the whole body, etc.), ffmpeg can't read the moov and produces a failed or
// empty frame. Seeking a LOCAL file sidesteps range entirely and is reliable
// regardless of moov position. (Verified: input-seeking a range-less HTTP
// server yields a 0-byte frame; the local-file path always yields the frame.)

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

/** ffmpeg args to extract ONE PNG frame at `videoTimeSec` from a LOCAL file
 * `inputPath` to stdout. `-ss` before `-i` is an input seek: against a local
 * file ffmpeg uses the moov index to jump straight to the nearest keyframe
 * (fast, and reliable regardless of where the moov atom sits — unlike seeking
 * the .mov over HTTP, see the file header re #102). */
export function ffmpegFrameArgs(
  inputPath: string,
  videoTimeSec: number,
): string[] {
  return [
    "-nostdin",
    "-loglevel",
    "error",
    "-ss",
    String(videoTimeSec),
    "-i",
    inputPath,
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
   * Throws on a non-zero exit, a timeout, or a missing binary. */
  runFfmpeg: (args: string[], timeoutMs: number) => Promise<Uint8Array>;
  /** Persists the downloaded recording to a local temp path ffmpeg can seek,
   * returning that path. grabFrame always removes it once extraction is done. */
  writeTempFile: (bytes: Uint8Array) => Promise<string>;
  /** Best-effort delete of a temp path; must not throw. */
  removeFile: (path: string) => Promise<void>;
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

  // 2. Download the recording to a local temp file. Seeking the .mov over HTTP
  // is unreliable for the non-faststart files screencapture produces (#102, see
  // the file header) — a local file always works.
  let recordingBytes: Uint8Array;
  try {
    const res = await deps.fetchFn(recordingUrl);
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        reason: `recording fetch ${res.status}`,
      };
    }
    recordingBytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, status: 502, reason: "recording fetch failed" };
  }
  if (recordingBytes.byteLength === 0) {
    return { ok: false, status: 404, reason: "recording not available" };
  }

  // 3. Extract one frame from the local file, always cleaning the temp file up.
  let png: Uint8Array;
  const tempPath = await deps.writeTempFile(recordingBytes);
  try {
    png = await deps.runFfmpeg(
      ffmpegFrameArgs(tempPath, req.videoTimeSec),
      FFMPEG_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, status: 500, reason: "frame extraction failed" };
  } finally {
    await deps.removeFile(tempPath);
  }
  if (png.byteLength === 0) {
    return { ok: false, status: 500, reason: "empty frame" };
  }

  // 4. Get a one-shot upload URL.
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

  // 5. Upload the PNG; read back its storageId.
  try {
    const res = await deps.fetchFn(uploadUrl, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png.slice().buffer as ArrayBuffer,
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
