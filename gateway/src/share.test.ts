import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "./config";
import { shareFile } from "./share";
import { recordingFetch } from "./test-helpers";

const config: GatewayConfig = {
  devboxId: "devbox-1",
  port: 8787,
  convexSiteUrl: "https://example.convex.site",
  convexUrl: "https://example.convex.cloud",
  devboxSharedSecret: "s3cret",
};

describe("shareFile", () => {
  test("POSTs the file as multipart to /devbox/artifact with the shared secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "share-"));
    try {
      const path = join(dir, "shot.png");
      await writeFile(path, new Uint8Array([1, 2, 3]));
      const rec = recordingFetch(() => new Response(null, { status: 202 }));
      const result = await shareFile({
        config,
        taskId: "task-abc",
        path,
        comment: "the result",
        fetchFn: rec.fetchFn,
      });
      expect(result).toEqual({ ok: true, filename: "shot.png" });
      expect(rec.calls[0]?.url).toBe(
        "https://example.convex.site/devbox/artifact",
      );
      const headers = (rec.calls[0]?.init?.headers ?? {}) as Record<
        string,
        string
      >;
      expect(headers["x-devbox-secret"]).toBe("s3cret");
      const form = rec.calls[0]?.init?.body as FormData;
      expect(form.get("taskId")).toBe("task-abc");
      expect(form.get("filename")).toBe("shot.png");
      expect(form.get("comment")).toBe("the result");
      expect(form.get("file")).toBeInstanceOf(Blob);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports a missing file without calling fetch", async () => {
    const rec = recordingFetch(() => new Response(null, { status: 202 }));
    const result = await shareFile({
      config,
      taskId: "task-abc",
      path: "/no/such/file.png",
      fetchFn: rec.fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(rec.calls.length).toBe(0);
  });

  test("surfaces a non-2xx upload as an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "share-"));
    try {
      const path = join(dir, "x.log");
      await writeFile(path, "hello");
      const rec = recordingFetch(() => new Response("no", { status: 500 }));
      const result = await shareFile({
        config,
        taskId: "t",
        path,
        fetchFn: rec.fetchFn,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("500");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
