import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildInboundFilePromptSuffix,
  type DownloadedFile,
  downloadInboundFiles,
} from "./files";

function file(name: string, url: string) {
  return { name, mimeType: "text/plain", size: 3, url };
}

describe("downloadInboundFiles", () => {
  test("writes each file under <baseDir>/<taskId> and reports paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "inbox-"));
    try {
      const fetchFn = (async (url: string) =>
        new Response(`body:${url}`)) as unknown as typeof fetch;
      const results = await downloadInboundFiles(
        [file("a.txt", "https://x/a"), file("b.txt", "https://x/b")],
        "task-1",
        base,
        fetchFn,
      );
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(results[0]?.path).toBe(join(base, "task-1", "1-a.txt"));
      expect(results[1]?.path).toBe(join(base, "task-1", "2-b.txt"));
      expect(await readFile(join(base, "task-1", "1-a.txt"), "utf8")).toBe(
        "body:https://x/a",
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("sanitizes hostile names (no path escape) and records failures", async () => {
    const base = await mkdtemp(join(tmpdir(), "inbox-"));
    try {
      const fetchFn = (async (url: string) =>
        url.endsWith("bad")
          ? new Response("nope", { status: 403 })
          : new Response("ok")) as unknown as typeof fetch;
      const results = await downloadInboundFiles(
        [
          file("../../etc/passwd", "https://x/good"),
          file("x", "https://x/bad"),
        ],
        "task-2",
        base,
        fetchFn,
      );
      // The traversal name is flattened into a single in-dir filename: the
      // file lands DIRECTLY in the task dir, never a parent.
      expect(results[0]?.ok).toBe(true);
      expect(dirname(results[0]?.path ?? "")).toBe(join(base, "task-2"));
      expect(results[1]?.ok).toBe(false);
      expect(results[1]?.error).toContain("403");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("buildInboundFilePromptSuffix", () => {
  test("returns empty string when there are no files", () => {
    expect(buildInboundFilePromptSuffix([])).toBe("");
  });

  test("lists downloaded paths and names failures", () => {
    const downloaded: DownloadedFile[] = [
      { name: "a.png", path: "/inbox/task/1-a.png", ok: true },
      {
        name: "b.log",
        path: "/inbox/task/2-b.log",
        ok: false,
        error: "HTTP 500",
      },
    ];
    const suffix = buildInboundFilePromptSuffix(downloaded);
    expect(suffix).toContain("/inbox/task/1-a.png");
    expect(suffix).toContain("a.png");
    expect(suffix).toContain("could not be downloaded");
    expect(suffix).toContain("b.log");
  });
});
