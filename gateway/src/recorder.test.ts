import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "./events";
import { createScreenRecorder, type RecorderProcess } from "./recorder";
import { until } from "./test-helpers";

const config = {
  convexSiteUrl: "https://site.convex.cloud",
  devboxId: "devbox-1",
  devboxSharedSecret: "s3cr3t",
};

const UPLOAD_URL = "https://storage.example/upload?token=abc";

type FetchCall = { url: string; init: RequestInit | undefined };

function bodyOf(call: FetchCall): Record<string, unknown> {
  const body = call.init?.body;
  return typeof body === "string"
    ? (JSON.parse(body) as Record<string, unknown>)
    : {};
}

function statusPosts(calls: FetchCall[]): string[] {
  return calls
    .filter((c) => c.url.endsWith("/devbox/recording"))
    .map((c) => bodyOf(c).status as string);
}

function makeFetch(
  opts: { uploadUrlOk?: boolean; uploadOk?: boolean; storageId?: string } = {},
): { fetchFn: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/devbox/recording/upload-url")) {
      return opts.uploadUrlOk === false
        ? new Response("err", { status: 500 })
        : Response.json({ url: UPLOAD_URL });
    }
    if (url.startsWith("https://storage.example/upload")) {
      return opts.uploadOk === false
        ? new Response("err", { status: 500 })
        : Response.json({ storageId: opts.storageId ?? "stored-123" });
    }
    if (url.endsWith("/devbox/recording")) {
      return new Response(null, { status: 200 });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchFn, calls };
}

/** A stub child process whose SIGINT resolves `exited` (like screencapture
 * finalizing on signal). */
function makeProc(opts: { exitsOnKill?: boolean } = {}): {
  proc: RecorderProcess;
  signals: string[];
} {
  const exitsOnKill = opts.exitsOnKill ?? true;
  const signals: string[] = [];
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolve = r;
  });
  return {
    proc: {
      kill: (signal) => {
        signals.push(signal);
        // A wedged screencapture (exitsOnKill: false) ignores SIGINT, so
        // `exited` never settles and finish()'s finalize race times out.
        if (exitsOnKill) resolve(0);
      },
      exited,
    },
    signals,
  };
}

function uniqueDir(): string {
  return join(tmpdir(), `recorder-test-${crypto.randomUUID().slice(0, 8)}`);
}

/** One recorder wired to the standard stubs; tests override only what they
 * exercise and get every recorded interaction back. */
function makeRecorder(
  opts: {
    fetch?: Parameters<typeof makeFetch>[0];
    exitsOnKill?: boolean;
    bytes?: Uint8Array;
    finalizeTimeoutMs?: number;
  } = {},
): {
  recorder: ReturnType<typeof createScreenRecorder>;
  calls: FetchCall[];
  signals: string[];
  removed: string[];
  spawnPaths: string[];
} {
  const { fetchFn, calls } = makeFetch(opts.fetch);
  const { proc, signals } = makeProc(opts);
  const removed: string[] = [];
  const spawnPaths: string[] = [];
  const recorder = createScreenRecorder({
    config,
    fetchFn,
    spawn: (path) => {
      spawnPaths.push(path);
      return proc;
    },
    recordingsDir: uniqueDir(),
    readFile: async () => opts.bytes ?? new Uint8Array([1]),
    removeFile: async (path) => {
      removed.push(path);
    },
    ...(opts.finalizeTimeoutMs === undefined
      ? {}
      : { finalizeTimeoutMs: opts.finalizeTimeoutMs }),
  });
  return { recorder, calls, signals, removed, spawnPaths };
}

describe("ScreenRecorder", () => {
  test("start spawns screencapture and marks the task recording", async () => {
    const { recorder, calls, spawnPaths } = makeRecorder();

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));

    expect(spawnPaths).toHaveLength(1);
    expect(spawnPaths[0]).toEndWith("task-1.mov");
    const post = calls.find((c) => c.url.endsWith("/devbox/recording"));
    expect(post?.init?.headers).toMatchObject({ "x-devbox-secret": "s3cr3t" });
    expect(bodyOf(post as FetchCall)).toMatchObject({
      taskId: "task-1",
      devboxId: "devbox-1",
      status: "recording",
    });
  });

  test("finish SIGINTs, uploads via the upload-URL flow, and marks available", async () => {
    const { recorder, calls, signals } = makeRecorder({
      fetch: { storageId: "blob-xyz" },
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    // The capture was signalled to finalize.
    expect(signals).toEqual(["SIGINT"]);
    // Status went recording -> uploading -> available.
    expect(statusPosts(calls)).toEqual(["recording", "uploading", "available"]);
    // The bytes were POSTed to the upload URL with the video content type.
    const upload = calls.find((c) => c.url === UPLOAD_URL);
    expect(upload?.init?.method).toBe("POST");
    expect(upload?.init?.headers).toMatchObject({
      "content-type": "video/quicktime",
    });
    // The available transition carries the storageId + byte count.
    const available = calls
      .filter((c) => c.url.endsWith("/devbox/recording"))
      .map(bodyOf)
      .find((b) => b.status === "available");
    expect(available).toMatchObject({ storageId: "blob-xyz", bytes: 4 });
  });

  test("finish is a no-op for an unknown / already-finished task", async () => {
    const { recorder, calls } = makeRecorder();

    await recorder.finish("never-started");
    expect(calls).toHaveLength(0);

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");
    const after = calls.length;
    // A second finish for the same task does nothing.
    await recorder.finish("task-1");
    expect(calls.length).toBe(after);
  });

  test("an empty recording file is reported as failed", async () => {
    const { recorder, calls } = makeRecorder({ bytes: new Uint8Array([]) });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
    // No bytes were uploaded.
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
  });

  test("an upload-URL failure is reported as failed", async () => {
    const { recorder, calls } = makeRecorder({
      fetch: { uploadUrlOk: false },
      bytes: new Uint8Array([1, 2, 3]),
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
  });

  test("an upload POST failure is reported as failed", async () => {
    const { recorder, calls } = makeRecorder({
      fetch: { uploadOk: false },
      bytes: new Uint8Array([1, 2, 3]),
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
  });

  test("the recording file is cleaned up after finish", async () => {
    const { recorder, calls, removed } = makeRecorder({
      bytes: new Uint8Array([1, 2, 3]),
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(removed).toHaveLength(1);
    expect(removed[0]).toEndWith("task-1.mov");
  });

  test("abort kills the capture without uploading", async () => {
    const { recorder, calls, signals } = makeRecorder();

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    recorder.abort();

    // abort() kills the capture once the (async) spawn has resolved.
    await until(() => signals.includes("SIGINT"));
    expect(signals).toEqual(["SIGINT"]);
    // No upload happened; a later finish is a no-op.
    await recorder.finish("task-1");
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
    expect(statusPosts(calls)).toEqual(["recording"]);
  });

  test("a same-tick finish() right after start() still finalizes (no orphan)", async () => {
    // Regression: start() is async (mkdir + spawn happen after it returns), so
    // a finish() in the same tick used to see no active recording and drop it —
    // start() then spawned screencapture AFTER the task was already done,
    // orphaning the process and leaving the status stuck at "recording".
    const { recorder, calls, signals, spawnPaths } = makeRecorder({
      fetch: { storageId: "fast-blob" },
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    recorder.start("task-fast");
    await recorder.finish("task-fast");

    // The capture was spawned exactly once and signalled to finalize — never
    // left running.
    expect(spawnPaths).toHaveLength(1);
    expect(signals).toEqual(["SIGINT"]);
    // It reached a terminal status (available), with the file uploaded.
    expect(statusPosts(calls).at(-1)).toBe("available");
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(true);
    // A second finish for the claimed-and-done task is a no-op.
    const after = calls.length;
    await recorder.finish("task-fast");
    expect(calls.length).toBe(after);
  });

  test("a capture that won't finalize on SIGINT is force-killed and failed", async () => {
    // Regression: if SIGINT doesn't make screencapture exit within the window,
    // the .mov has no finalized moov atom — we must NOT upload it, and must not
    // leave the process running.
    const { recorder, calls, signals } = makeRecorder({
      exitsOnKill: false,
      bytes: new Uint8Array([1, 2, 3]),
      finalizeTimeoutMs: 20,
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    // SIGINT was tried, then SIGKILL to avoid an orphaned capture.
    expect(signals).toEqual(["SIGINT", "SIGKILL"]);
    // Failed, and nothing was uploaded.
    expect(statusPosts(calls).at(-1)).toBe("failed");
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
  });
});
