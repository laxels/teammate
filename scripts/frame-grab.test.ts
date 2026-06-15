import { describe, expect, test } from "bun:test";
import {
  type FrameGrabConfig,
  type FrameGrabDeps,
  ffmpegFrameArgs,
  grabFrame,
  parseFrameGrabRequest,
  timingSafeEqual,
} from "./frame-grab";

const CONFIG: FrameGrabConfig = {
  convexSiteUrl: "https://example.convex.site",
  dashboardSecret: "dash",
  devboxSharedSecret: "devbox",
};

describe("parseFrameGrabRequest", () => {
  test("accepts a well-formed body and ignores extra fields", () => {
    expect(
      parseFrameGrabRequest({ taskId: "t-1", videoTimeSec: 4.5, secret: "x" }),
    ).toEqual({ taskId: "t-1", videoTimeSec: 4.5 });
    expect(parseFrameGrabRequest({ taskId: "t", videoTimeSec: 0 })).toEqual({
      taskId: "t",
      videoTimeSec: 0,
    });
  });

  test("rejects missing/empty taskId and bad timestamps", () => {
    expect(parseFrameGrabRequest({ videoTimeSec: 1 })).toBeNull();
    expect(parseFrameGrabRequest({ taskId: "", videoTimeSec: 1 })).toBeNull();
    expect(parseFrameGrabRequest({ taskId: "t", videoTimeSec: -1 })).toBeNull();
    expect(
      parseFrameGrabRequest({ taskId: "t", videoTimeSec: Number.NaN }),
    ).toBeNull();
    expect(parseFrameGrabRequest({ taskId: "t" })).toBeNull();
    expect(parseFrameGrabRequest("nope")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  test("matches equal strings, rejects differing ones", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});

describe("ffmpegFrameArgs", () => {
  test("input-seeks to the timestamp and writes one PNG to stdout", () => {
    const args = ffmpegFrameArgs("/tmp/rec.mov", 12.5);
    // -ss must precede -i (input seek via the local moov index).
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("12.5");
    // Seeks the LOCAL temp file, not the URL (#102).
    expect(args).toContain("/tmp/rec.mov");
    expect(args.slice(-1)).toEqual(["pipe:1"]);
    expect(args).toContain("png");
  });
});

/** A scripted fetch over the Convex hops the pipeline makes: resolve the
 * recording URL, download the .mov, get an upload URL, upload the PNG. */
function makeFetch(
  handlers: Partial<{
    recordingUrl: () => Response;
    recordingBlob: () => Response;
    uploadUrl: () => Response;
    upload: () => Response;
  }>,
  log?: { urls: string[] },
): FrameGrabDeps["fetchFn"] {
  return async (url, init) => {
    log?.urls.push(url);
    if (url.includes("/devbox/recording-url")) {
      return (
        handlers.recordingUrl ??
        (() => Response.json({ url: "https://blob/rec.mov" }))
      )();
    }
    if (url === "https://blob/rec.mov") {
      // The recording download is a plain GET of the signed URL.
      return (
        handlers.recordingBlob ??
        (() => new Response(new Uint8Array([9, 9, 9])))
      )();
    }
    if (url.includes("/devbox/recording/upload-url")) {
      return (
        handlers.uploadUrl ??
        (() => Response.json({ url: "https://upload/target" }))
      )();
    }
    if (url === "https://upload/target") {
      expect(init?.method).toBe("POST");
      return (
        handlers.upload ?? (() => Response.json({ storageId: "stor-1" }))
      )();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

/** Records temp-file lifecycle so tests can assert it's always cleaned up. */
function makeTempDeps() {
  const log = { written: [] as Uint8Array[], removed: [] as string[] };
  let n = 0;
  return {
    log,
    writeTempFile: async (bytes: Uint8Array) => {
      log.written.push(bytes);
      return `/tmp/frame-${n++}.mov`;
    },
    removeFile: async (path: string) => {
      log.removed.push(path);
    },
  };
}

describe("grabFrame pipeline", () => {
  const req = { taskId: "task-1", videoTimeSec: 3 };

  test("resolve -> download -> ffmpeg -> upload -> storageId (happy path)", async () => {
    const log = { urls: [] as string[] };
    const fetchFn = makeFetch({}, log);
    const temp = makeTempDeps();
    const ffmpegInput: string[] = [];
    const runFfmpeg = async (args: string[]) => {
      ffmpegInput.push(args[args.indexOf("-i") + 1] ?? "");
      return new Uint8Array([1, 2, 3, 4]);
    };
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg,
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toEqual({ ok: true, storageId: "stor-1" });
    // The recording-url hop is keyed by taskId, secret-gated.
    expect(log.urls[0]).toContain("/devbox/recording-url?taskId=task-1");
    // The downloaded bytes were staged to a temp file, and ffmpeg seeked THAT
    // file (not the URL), then the temp file was removed.
    expect(temp.log.written).toEqual([new Uint8Array([9, 9, 9])]);
    expect(ffmpegInput).toEqual(["/tmp/frame-0.mov"]);
    expect(temp.log.removed).toEqual(["/tmp/frame-0.mov"]);
  });

  test("404 when the recording isn't available (null url)", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({
      recordingUrl: () => Response.json({ url: null }),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    // Never got far enough to stage a temp file.
    expect(temp.log.written).toEqual([]);
  });

  test("502 when the recording download fails", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({
      recordingBlob: () => new Response("gone", { status: 404 }),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(temp.log.written).toEqual([]);
  });

  test("404 when the downloaded recording is empty", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({
      recordingBlob: () => new Response(new Uint8Array([])),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(temp.log.written).toEqual([]);
  });

  test("500 when ffmpeg throws — and the temp file is still removed", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({});
    const runFfmpeg = async () => {
      throw new Error("ffmpeg boom");
    };
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg,
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({ ok: false, status: 500 });
    // The grab failed, but we must not leak the downloaded .mov.
    expect(temp.log.removed).toEqual(["/tmp/frame-0.mov"]);
  });

  test("500 on an empty frame — and the temp file is still removed", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({});
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([]),
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      reason: "empty frame",
    });
    expect(temp.log.removed).toEqual(["/tmp/frame-0.mov"]);
  });

  test("502 when the PNG upload fails", async () => {
    const temp = makeTempDeps();
    const fetchFn = makeFetch({
      upload: () => new Response("nope", { status: 500 }),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
      writeTempFile: temp.writeTempFile,
      removeFile: temp.removeFile,
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
    // ffmpeg ran, so the temp file must have been cleaned up.
    expect(temp.log.removed).toEqual(["/tmp/frame-0.mov"]);
  });
});
