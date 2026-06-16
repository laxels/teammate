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
    const args = ffmpegFrameArgs("https://blob/x.mov", 12.5);
    // -ss must precede -i (input seek -> HTTP range, no full download).
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("12.5");
    expect(args).toContain("https://blob/x.mov");
    expect(args.slice(-1)).toEqual(["pipe:1"]);
    expect(args).toContain("png");
  });
});

/** Normalize whatever was passed as a fetch `body` into bytes — including the
 * `undefined` the #102 bug produced (→ 0 bytes), so a test can prove the upload
 * actually carried the frame. */
async function bodyBytes(body: RequestInit["body"]): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body ?? null).arrayBuffer());
}

/** A scripted fetch over the three Convex hops; captures the upload body. */
function makeFetch(
  handlers: Partial<{
    recordingUrl: () => Response;
    uploadUrl: () => Response;
    upload: () => Response;
  }>,
  log?: { urls: string[]; uploadBody?: RequestInit["body"] },
): FrameGrabDeps["fetchFn"] {
  return async (url, init) => {
    log?.urls.push(url);
    if (url.includes("/devbox/recording-url")) {
      return (
        handlers.recordingUrl ??
        (() => Response.json({ url: "https://blob/rec.mov" }))
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
      if (log) log.uploadBody = init?.body;
      return (
        handlers.upload ?? (() => Response.json({ storageId: "stor-1" }))
      )();
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe("grabFrame pipeline", () => {
  const req = { taskId: "task-1", videoTimeSec: 3 };

  test("resolve -> ffmpeg -> upload -> storageId, and the upload carries the frame", async () => {
    const log = {
      urls: [] as string[],
      uploadBody: null as RequestInit["body"],
    };
    const fetchFn = makeFetch({}, log);
    const frame = new Uint8Array([1, 2, 3, 4]);
    const runFfmpeg = async () => frame;
    const result = await grabFrame(CONFIG, req, { fetchFn, runFfmpeg });
    expect(result).toEqual({ ok: true, storageId: "stor-1" });
    // The recording-url hop is keyed by taskId, secret-gated.
    expect(log.urls[0]).toContain("/devbox/recording-url?taskId=task-1");
    // The PNG bytes actually reached the upload (not an empty body).
    expect(await bodyBytes(log.uploadBody)).toEqual(frame);
  });

  test("uploads the real frame even when runFfmpeg yields an ArrayBuffer (#102)", async () => {
    // Bun's Response(subprocessStdout).bytes() returns a bare ArrayBuffer for
    // multi-chunk ffmpeg output — the exact runtime value that broke the old
    // `png.slice().buffer` body (-> undefined -> 0-byte blob). The pipeline must
    // still upload the bytes.
    const log = {
      urls: [] as string[],
      uploadBody: null as RequestInit["body"],
    };
    const fetchFn = makeFetch({}, log);
    const arrayBufferFrame = new Uint8Array([9, 8, 7, 6, 5]).buffer;
    const runFfmpeg = async () => arrayBufferFrame as unknown as Uint8Array;
    const result = await grabFrame(CONFIG, req, { fetchFn, runFfmpeg });
    expect(result).toEqual({ ok: true, storageId: "stor-1" });
    const uploaded = await bodyBytes(log.uploadBody);
    expect(uploaded.byteLength).toBe(5);
    expect(uploaded).toEqual(new Uint8Array([9, 8, 7, 6, 5]));
  });

  test("404 when the recording isn't available (null url)", async () => {
    const fetchFn = makeFetch({
      recordingUrl: () => Response.json({ url: null }),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  test("500 when ffmpeg throws", async () => {
    const fetchFn = makeFetch({});
    const runFfmpeg = async () => {
      throw new Error("ffmpeg boom");
    };
    const result = await grabFrame(CONFIG, req, { fetchFn, runFfmpeg });
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  test("500 on an empty frame — never uploads", async () => {
    const log = {
      urls: [] as string[],
      uploadBody: null as RequestInit["body"],
    };
    const fetchFn = makeFetch({}, log);
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([]),
    });
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      reason: "empty frame",
    });
    // Guard fired before the upload hop — no empty blob is ever created.
    expect(log.urls.some((u) => u.includes("upload-url"))).toBe(false);
  });

  test("502 when the PNG upload fails", async () => {
    const fetchFn = makeFetch({
      upload: () => new Response("nope", { status: 500 }),
    });
    const result = await grabFrame(CONFIG, req, {
      fetchFn,
      runFfmpeg: async () => new Uint8Array([1]),
    });
    expect(result).toMatchObject({ ok: false, status: 502 });
  });
});
