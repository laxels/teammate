import { afterEach, expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";

// Capability manifests (#138): one row per golden tag, upserted on re-bake;
// `current` serves the most recently UPDATED manifest — a re-bake of an old
// tag is what the fleet is now serving, so it must win over a newer tag with
// an older upload.
const modules = {
  "./_generated/api.js": () => import("./_generated/api.js"),
  "./_generated/server.js": () => import("./_generated/server.js"),
  "./capabilities.ts": () => import("./capabilities"),
};

function newT() {
  return convexTest(schema, modules);
}

afterEach(() => {
  setSystemTime();
});

test("current is null before any manifest upload", async () => {
  const t = newT();
  expect(await t.query(internal.capabilities.current, {})).toBeNull();
});

test("record inserts a manifest, then upserts by tag (updatedAt moves)", async () => {
  const t = newT();
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  await t.mutation(internal.capabilities.record, {
    goldenTag: "golden-20260701",
    generated: "apps: Chrome",
    curated: "Chrome is signed in",
  });
  expect(await t.query(internal.capabilities.current, {})).toEqual({
    goldenTag: "golden-20260701",
    generated: "apps: Chrome",
    curated: "Chrome is signed in",
    updatedAt: t0,
  });

  // A re-bake of the same tag replaces the row instead of stacking a second.
  setSystemTime(new Date(t0 + 60_000));
  await t.mutation(internal.capabilities.record, {
    goldenTag: "golden-20260701",
    generated: "apps: Chrome, Slack",
    curated: "Chrome and Slack are signed in",
  });
  const rows = await t.run((ctx) =>
    ctx.db.query("capabilityManifests").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(await t.query(internal.capabilities.current, {})).toEqual({
    goldenTag: "golden-20260701",
    generated: "apps: Chrome, Slack",
    curated: "Chrome and Slack are signed in",
    updatedAt: t0 + 60_000,
  });
});

test("current serves the latest-updated manifest across tags", async () => {
  const t = newT();
  const t0 = Date.now();
  setSystemTime(new Date(t0));
  await t.mutation(internal.capabilities.record, {
    goldenTag: "golden-old",
    generated: "g-old",
    curated: "c-old",
  });
  setSystemTime(new Date(t0 + 1_000));
  await t.mutation(internal.capabilities.record, {
    goldenTag: "golden-new",
    generated: "g-new",
    curated: "c-new",
  });
  expect((await t.query(internal.capabilities.current, {}))?.goldenTag).toBe(
    "golden-new",
  );

  // Re-baking the OLD tag makes it the latest-updated: it wins.
  setSystemTime(new Date(t0 + 2_000));
  await t.mutation(internal.capabilities.record, {
    goldenTag: "golden-old",
    generated: "g-old-rebaked",
    curated: "c-old",
  });
  expect(await t.query(internal.capabilities.current, {})).toMatchObject({
    goldenTag: "golden-old",
    generated: "g-old-rebaked",
    updatedAt: t0 + 2_000,
  });
});
