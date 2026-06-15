import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { downloadRecording, removeFile } from "./dashboard-server";

// Exercises the REAL bounded streaming download against a real Bun.serve — no
// stubs, so it proves the actual timeout + max-size behavior the #102 review
// asked for. Importing dashboard-server does NOT start the production server
// (its Bun.serve is guarded by import.meta.main).

/** How many of OUR temp files currently sit in tmpdir — to assert no leak. */
async function frameTmpCount(): Promise<number> {
  const files = await readdir(tmpdir());
  return files.filter((f) => f.startsWith("ultraclaude-frame-")).length;
}

/** Serve a response built from `chunks`: enqueue each, then close — unless
 * `hang` is set, in which case it stalls after the chunks (to exercise the
 * abort timeout). A non-streaming body is used for the size/non-2xx cases. */
function serveStream(chunks: Uint8Array[], hang = false, status = 200) {
  return Bun.serve({
    port: 0,
    fetch() {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          if (!hang) controller.close();
        },
      });
      return new Response(stream, { status });
    },
  });
}

function serveBody(body: Uint8Array, status = 200) {
  return Bun.serve({ port: 0, fetch: () => new Response(body, { status }) });
}

describe("downloadRecording (bounded streaming)", () => {
  const OPTS = { timeoutMs: 5_000, maxBytes: 1_000_000 };
  const url = (s: Bun.Server<undefined>) =>
    `http://127.0.0.1:${s.port}/rec.mov`;

  test("streams the body to a local temp file", async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const server = serveStream([payload.slice(0, 2), payload.slice(2)]);
    try {
      const res = await downloadRecording(url(server), OPTS);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.bytes).toBe(payload.byteLength);
      // The temp file holds exactly the streamed bytes.
      const onDisk = await Bun.file(res.path).bytes();
      expect(new Uint8Array(onDisk)).toEqual(payload);
      await removeFile(res.path);
      expect(await Bun.file(res.path).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("aborts and reports too-large past maxBytes — no temp file leaked", async () => {
    const before = await frameTmpCount();
    const server = serveBody(new Uint8Array(2048));
    try {
      const res = await downloadRecording(url(server), {
        timeoutMs: 5_000,
        maxBytes: 1024,
      });
      expect(res).toEqual({ ok: false, reason: "too-large" });
      expect(await frameTmpCount()).toBe(before);
    } finally {
      server.stop(true);
    }
  });

  test("aborts on the timeout when the server stalls — bounded + no leak", async () => {
    const before = await frameTmpCount();
    const server = serveStream([new Uint8Array([1, 2, 3])], true);
    try {
      const start = Bun.nanoseconds();
      const res = await downloadRecording(url(server), {
        timeoutMs: 250,
        maxBytes: 1_000_000,
      });
      const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
      expect(res).toEqual({ ok: false, reason: "fetch-failed" });
      // The abort must fire near the timeout, not hang the slot indefinitely.
      expect(elapsedMs).toBeLessThan(3_000);
      expect(await frameTmpCount()).toBe(before);
    } finally {
      server.stop(true);
    }
  });

  test("reports empty for a 200 that streams zero bytes — no leak", async () => {
    const before = await frameTmpCount();
    const server = serveStream([]);
    try {
      const res = await downloadRecording(url(server), OPTS);
      expect(res).toEqual({ ok: false, reason: "empty" });
      expect(await frameTmpCount()).toBe(before);
    } finally {
      server.stop(true);
    }
  });

  test("reports fetch-failed on a non-2xx response", async () => {
    const server = serveBody(new Uint8Array([1]), 404);
    try {
      const res = await downloadRecording(url(server), OPTS);
      expect(res).toEqual({ ok: false, reason: "fetch-failed" });
    } finally {
      server.stop(true);
    }
  });
});
