import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../src/events";
import {
  createScreenRecorder,
  type RecorderProcess,
  type SpawnRecorder,
} from "../src/recorder";
import { until } from "./helpers";

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
function makeProc(): { proc: RecorderProcess; signals: string[] } {
  const signals: string[] = [];
  let resolve!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolve = r;
  });
  return {
    proc: {
      kill: (signal) => {
        signals.push(signal);
        resolve(0);
      },
      exited,
    },
    signals,
  };
}

function uniqueDir(): string {
  return join(tmpdir(), `recorder-test-${crypto.randomUUID().slice(0, 8)}`);
}

describe("ScreenRecorder", () => {
  test("start spawns screencapture and marks the task recording", async () => {
    const { fetchFn, calls } = makeFetch();
    const { proc } = makeProc();
    const spawnPaths: string[] = [];
    const spawn: SpawnRecorder = (path) => {
      spawnPaths.push(path);
      return proc;
    };
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1]),
      removeFile: async () => undefined,
    });

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
    const { fetchFn, calls } = makeFetch({ storageId: "blob-xyz" });
    const { proc, signals } = makeProc();
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1, 2, 3, 4]),
      removeFile: async () => undefined,
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
    const { fetchFn, calls } = makeFetch();
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => makeProc().proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1]),
      removeFile: async () => undefined,
    });

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
    const { fetchFn, calls } = makeFetch();
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => makeProc().proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([]),
      removeFile: async () => undefined,
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
    // No bytes were uploaded.
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
  });

  test("an upload-URL failure is reported as failed", async () => {
    const { fetchFn, calls } = makeFetch({ uploadUrlOk: false });
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => makeProc().proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1, 2, 3]),
      removeFile: async () => undefined,
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
  });

  test("an upload POST failure is reported as failed", async () => {
    const { fetchFn, calls } = makeFetch({ uploadOk: false });
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => makeProc().proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1, 2, 3]),
      removeFile: async () => undefined,
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(statusPosts(calls)).toEqual(["recording", "uploading", "failed"]);
  });

  test("the recording file is cleaned up after finish", async () => {
    const { fetchFn, calls } = makeFetch();
    const removed: string[] = [];
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => makeProc().proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1, 2, 3]),
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    await recorder.finish("task-1");

    expect(removed).toHaveLength(1);
    expect(removed[0]).toEndWith("task-1.mov");
  });

  test("abort kills the capture without uploading", async () => {
    const { fetchFn, calls } = makeFetch();
    const { proc, signals } = makeProc();
    const recorder = createScreenRecorder({
      config,
      fetchFn,
      spawn: () => proc,
      recordingsDir: uniqueDir(),
      readFile: async () => new Uint8Array([1]),
      removeFile: async () => undefined,
    });

    recorder.start("task-1");
    await until(() => statusPosts(calls).includes("recording"));
    recorder.abort();

    expect(signals).toEqual(["SIGINT"]);
    // No upload happened; a later finish is a no-op.
    await recorder.finish("task-1");
    expect(calls.some((c) => c.url === UPLOAD_URL)).toBe(false);
    expect(statusPosts(calls)).toEqual(["recording"]);
  });
});
