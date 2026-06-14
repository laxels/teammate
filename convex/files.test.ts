import { afterEach, beforeEach, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";

// http.ts registers the router for t.fetch; storage is simulated by convex-test.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./http.ts": () => import("./http"),
};

function newT() {
  return convexTest(schema, modules);
}

const SECRET = "devbox-secret";
let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.DEVBOX_SHARED_SECRET;
  process.env.DEVBOX_SHARED_SECRET = SECRET;
});

afterEach(() => {
  process.env.DEVBOX_SHARED_SECRET = savedSecret;
});

test("/devbox/file rejects a missing/wrong shared secret", async () => {
  const t = newT();
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])])),
  );
  const res = await t.fetch(`/devbox/file?storageId=${storageId}`, {
    headers: { "x-devbox-secret": "wrong" },
  });
  expect(res.status).toBe(401);
});

test("/devbox/file serves the staged blob bytes with the secret", async () => {
  const t = newT();
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array([9, 8, 7])])),
  );
  const res = await t.fetch(`/devbox/file?storageId=${storageId}`, {
    headers: { "x-devbox-secret": SECRET },
  });
  expect(res.status).toBe(200);
  expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([
    9, 8, 7,
  ]);
});

test("/devbox/file 404s a pruned/missing blob (gateway then reports it)", async () => {
  const t = newT();
  const storageId = await t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([new Uint8Array([1])]));
    await ctx.storage.delete(id);
    return id;
  });
  const res = await t.fetch(`/devbox/file?storageId=${storageId}`, {
    headers: { "x-devbox-secret": SECRET },
  });
  expect(res.status).toBe(404);
});
