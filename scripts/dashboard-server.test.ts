import { describe, expect, test } from "bun:test";
import { readAll } from "./dashboard-server";

// Regression for the real #102 bug. Bun's `new Response(subprocessStdout)
// .bytes()` returns a bare ArrayBuffer (no `.buffer`) for MULTI-CHUNK output,
// which silently made the upload body `undefined` → 0-byte image blobs. readAll
// must always yield a real Uint8Array. Reproduced with a generic large
// subprocess stream so the test needs no ffmpeg (unavailable in CI). Importing
// dashboard-server does NOT start the production server (guarded by
// import.meta.main).

/** Spawn a subprocess that writes `n` bytes to stdout, return its stdout stream.
 * `head -c N /dev/zero` reliably produces multi-chunk output past the pipe
 * buffer (~64 KB). */
function stdoutOf(n: number): ReadableStream<Uint8Array> {
  const proc = Bun.spawn(["bash", "-c", `head -c ${n} /dev/zero`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  return proc.stdout;
}

describe("readAll", () => {
  test("returns a real Uint8Array for a LARGE multi-chunk subprocess stream", async () => {
    const bytes = await readAll(stdoutOf(300_000));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(300_000);
    // The exact expression the upload relied on — `undefined` before the fix
    // (because a bare ArrayBuffer has no `.buffer`), now a real backing buffer.
    expect(bytes.slice().buffer.byteLength).toBe(300_000);
  });

  test("returns a real Uint8Array for a small single-chunk stream too", async () => {
    const bytes = await readAll(stdoutOf(64));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(64);
  });

  test("a large readAll result is valid BodyInit that carries all its bytes", async () => {
    // The end-to-end guarantee: a large frame survives a fetch upload intact
    // (the production path POSTs this exact value).
    const bytes = await readAll(stdoutOf(200_000));
    let received = -1;
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        received = (await req.bytes()).byteLength;
        return new Response(null);
      },
    });
    try {
      await fetch(`http://127.0.0.1:${sink.port}/`, {
        method: "POST",
        body: bytes,
      });
      expect(received).toBe(200_000);
    } finally {
      sink.stop(true);
    }
  });
});
