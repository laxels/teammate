import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForProvisionReady } from "../src/ready";

describe("waitForProvisionReady", () => {
  test("resolves immediately when the marker already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ready-"));
    const marker = join(dir, "ultraclaude.ready");
    writeFileSync(marker, "");
    try {
      await waitForProvisionReady(marker, { pollMs: 5 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("waits until the marker appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ready-"));
    const marker = join(dir, "ultraclaude.ready");
    try {
      let resolved = false;
      const wait = waitForProvisionReady(marker, { pollMs: 5 }).then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 25));
      expect(resolved).toBe(false);

      writeFileSync(marker, "");
      await wait;
      expect(resolved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
