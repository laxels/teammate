import { httpRouter } from "convex/server";
import { MAX_OUTBOUND_FILE_BYTES } from "../shared/protocol";
import { parseDevboxEvent } from "../src/orchestration";
import { timingSafeEqual, verifySlackSignature } from "../src/slack";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";

const http = httpRouter();

/**
 * True when the request carries the shared secret in `x-devbox-secret`. Used by
 * every non-Slack endpoint (the `/devbox/*` control plane and the `/fleet/*`
 * provisioner plane) — the same secret host agents pass as a function argument.
 */
function devboxSecretOk(request: Request): boolean {
  const secret = process.env.DEVBOX_SHARED_SECRET;
  const provided = request.headers.get("x-devbox-secret");
  return (
    secret !== undefined &&
    secret !== "" &&
    provided !== null &&
    timingSafeEqual(provided, secret)
  );
}

/** The single global fleet lock name (see convex/fleetLock.ts). The
 * golden-refresh op (#89) takes this SAME lock: it mutates live fleet state, so
 * it must serialize against provisioning and against another roll. */
const FLEET_LOCK_NAME = "fleet";

/** Body parser for the host-control endpoints: { hostId } plus, for the status
 * endpoint, a status restricted to the two states a golden-refresh toggles. */
function parseHostId(raw: unknown): { hostId: string } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as { hostId?: unknown };
  if (typeof body.hostId !== "string" || body.hostId === "") {
    return null;
  }
  return { hostId: body.hostId };
}

function parseHostStatus(
  raw: unknown,
): { hostId: string; status: "active" | "draining" } | null {
  const base = parseHostId(raw);
  if (base === null) {
    return null;
  }
  const status = (raw as { status?: unknown }).status;
  if (status !== "active" && status !== "draining") {
    return null;
  }
  return { hostId: base.hostId, status };
}

function parseLockBody(
  raw: unknown,
): { holder: string; ttlMs?: number } | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const body = raw as { holder?: unknown; ttlMs?: unknown };
  if (typeof body.holder !== "string" || body.holder === "") {
    return null;
  }
  // Only forward a finite, positive ttl; anything else falls back to the
  // server default (the acquire/renew mutations clamp again, authoritatively).
  const ttlOk =
    typeof body.ttlMs === "number" &&
    Number.isFinite(body.ttlMs) &&
    body.ttlMs > 0;
  return {
    holder: body.holder,
    ...(ttlOk ? { ttlMs: body.ttlMs as number } : {}),
  };
}

http.route({
  path: "/slack/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const body = payload as {
      type?: string;
      challenge?: string;
      event_id?: string;
      event?: { type?: string };
    };

    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const verified =
      signingSecret !== undefined &&
      (await verifySlackSignature({
        signingSecret,
        timestamp: request.headers.get("x-slack-request-timestamp"),
        signature: request.headers.get("x-slack-signature"),
        rawBody,
        nowSeconds: Date.now() / 1000,
      }));

    // url_verification is answered even before SLACK_SIGNING_SECRET is
    // configured, so the Slack app's request URL can be verified during
    // bootstrap. Everything else requires a valid signature.
    if (
      body.type === "url_verification" &&
      typeof body.challenge === "string"
    ) {
      if (signingSecret !== undefined && !verified) {
        return new Response("invalid signature", { status: 401 });
      }
      return Response.json({ challenge: body.challenge });
    }

    if (!verified) {
      return new Response("invalid signature", { status: 401 });
    }

    if (body.type === "event_callback" && typeof body.event_id === "string") {
      await ctx.runMutation(internal.slack.recordEvent, {
        eventId: body.event_id,
        type: body.event?.type ?? "unknown",
        payload: rawBody,
      });
    }

    // Always ack within Slack's 3-second window.
    return new Response(null, { status: 200 });
  }),
});

// Gateway -> orchestrator lifecycle events (see shared/protocol.ts).
// Authenticated by the shared secret, not by Slack signatures.
http.route({
  path: "/devbox/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.DEVBOX_SHARED_SECRET;
    const provided = request.headers.get("x-devbox-secret");
    if (
      secret === undefined ||
      provided === null ||
      !timingSafeEqual(provided, secret)
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await request.text());
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const event = parseDevboxEvent(payload);
    if (event === null) {
      return new Response("invalid devbox event", { status: 400 });
    }

    const { taskFound, applied } = await ctx.runMutation(
      internal.devboxes.recordEvent,
      {
        devboxId: event.devboxId,
        taskId: event.taskId,
        type: event.type,
        summary: event.summary,
        ts: event.ts,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        ...(event.tool === undefined ? {} : { tool: event.tool }),
        ...(event.imageStorageId === undefined
          ? {}
          : { imageStorageId: event.imageStorageId as Id<"_storage"> }),
      },
    );
    // Skip Slack noise for events that didn't change task state (e.g. a late
    // progress event racing the completed event it duplicates).
    if (taskFound && applied) {
      await ctx.scheduler.runAfter(0, internal.notify.devboxEvent, {
        devboxId: event.devboxId,
        taskId: event.taskId,
        type: event.type,
        summary: event.summary,
      });
    }
    return new Response(null, { status: 200 });
  }),
});

// Gateway -> orchestrator artifact upload (see shared/protocol.ts): a devbox's
// `share_file` tool POSTs a file here as multipart/form-data; we stage it in
// Convex storage and hand off to artifacts.uploadToSlack, which posts it into
// the task's thread and then deletes the blob.
http.route({
  path: "/devbox/artifact",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.DEVBOX_SHARED_SECRET;
    const provided = request.headers.get("x-devbox-secret");
    if (
      secret === undefined ||
      provided === null ||
      !timingSafeEqual(provided, secret)
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return new Response("expected multipart/form-data", { status: 400 });
    }
    const file = form.get("file");
    const taskId = form.get("taskId");
    const filename = form.get("filename");
    if (
      !(file instanceof Blob) ||
      typeof taskId !== "string" ||
      typeof filename !== "string"
    ) {
      return new Response("expected file, taskId, filename", { status: 400 });
    }
    if (file.size > MAX_OUTBOUND_FILE_BYTES) {
      return new Response("payload too large", { status: 413 });
    }
    const title = form.get("title");
    const comment = form.get("comment");
    const storageId = await ctx.storage.store(file);
    await ctx.scheduler.runAfter(0, internal.artifacts.uploadToSlack, {
      taskId,
      storageId,
      filename,
      ...(typeof title === "string" && title !== "" ? { title } : {}),
      ...(typeof comment === "string" && comment !== "" ? { comment } : {}),
    });
    return new Response(null, { status: 202 });
  }),
});

// Shared storage upload URL: returns a short-lived Convex storage upload URL a
// secret-holder POSTs bytes to (the generateUploadUrl flow keeps large/binary
// blobs off the size-capped HTTP-action path used by /devbox/artifact). Used by
// the gateway recorder (.mov), the gateway's tool-result screenshots (#70), and
// the fleet host's frame-grab endpoint (#70 PNG frames). Path kept under
// /devbox/recording for backwards-compatibility with in-flight gateways.
http.route({
  path: "/devbox/recording/upload-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.DEVBOX_SHARED_SECRET;
    const provided = request.headers.get("x-devbox-secret");
    if (
      secret === undefined ||
      provided === null ||
      !timingSafeEqual(provided, secret)
    ) {
      return new Response("unauthorized", { status: 401 });
    }
    const url = await ctx.storage.generateUploadUrl();
    return Response.json({ url });
  }),
});

// Gateway -> orchestrator screen-recording lifecycle (see shared/protocol.ts):
// JSON { taskId, devboxId, status, storageId?, bytes? } records a recording
// transition on the task row. storageId is required for status "available"
// (the storageId returned by the upload-URL POST above).
http.route({
  path: "/devbox/recording",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.DEVBOX_SHARED_SECRET;
    const provided = request.headers.get("x-devbox-secret");
    if (
      secret === undefined ||
      provided === null ||
      !timingSafeEqual(provided, secret)
    ) {
      return new Response("unauthorized", { status: 401 });
    }

    let payload: {
      taskId?: unknown;
      status?: unknown;
      storageId?: unknown;
      bytes?: unknown;
      startedAt?: unknown;
    };
    try {
      payload = JSON.parse(await request.text()) as typeof payload;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const { taskId, status } = payload;
    if (
      typeof taskId !== "string" ||
      (status !== "recording" &&
        status !== "uploading" &&
        status !== "available" &&
        status !== "failed")
    ) {
      return new Response("expected { taskId, status }", { status: 400 });
    }
    if (status === "available" && typeof payload.storageId !== "string") {
      return new Response("status 'available' requires storageId", {
        status: 400,
      });
    }

    await ctx.runMutation(internal.recordings.setStatus, {
      taskId,
      status,
      ...(typeof payload.storageId === "string"
        ? { storageId: payload.storageId as Id<"_storage"> }
        : {}),
      ...(typeof payload.bytes === "number" ? { bytes: payload.bytes } : {}),
      ...(typeof payload.startedAt === "number"
        ? { startedAt: payload.startedAt }
        : {}),
    });
    return new Response(null, { status: 200 });
  }),
});

// Fleet host -> orchestrator recording URL resolver (#70): the host frame-grab
// endpoint resolves a task's recording to a short-lived signed storage URL it
// can ffmpeg-seek, without the browser ever supplying a URL (SSRF) or seeing a
// raw storageId. Gated by the same shared secret as the rest of /devbox/*.
// GET /devbox/recording-url?taskId=... -> { url: string | null }.
http.route({
  path: "/devbox/recording-url",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    const taskId = new URL(request.url).searchParams.get("taskId");
    if (taskId === null || taskId === "") {
      return new Response("missing taskId", { status: 400 });
    }
    const url = await ctx.runQuery(internal.recordings.signedUrl, { taskId });
    return Response.json({ url });
  }),
});

// Orchestrator -> gateway inbound-file serve (see shared/protocol.ts): the
// gateway GETs a staged Slack attachment by storageId, authenticated with the
// shared secret. Serving the bytes through this secret-gated endpoint (instead
// of a public ctx.storage.getUrl link in the command payload) keeps private
// Slack files from being fetchable by anyone who sees the payload or a log.
http.route({
  path: "/devbox/file",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.DEVBOX_SHARED_SECRET;
    const provided = request.headers.get("x-devbox-secret");
    if (
      secret === undefined ||
      provided === null ||
      !timingSafeEqual(provided, secret)
    ) {
      return new Response("unauthorized", { status: 401 });
    }
    const storageId = new URL(request.url).searchParams.get("storageId");
    if (storageId === null || storageId === "") {
      return new Response("missing storageId", { status: 400 });
    }
    // get() returns null for a missing/pruned blob; an invalid id throws —
    // either way the gateway gets a non-2xx and reports the file as undownloadable.
    let blob: Blob | null;
    try {
      blob = await ctx.storage.get(storageId as Id<"_storage">);
    } catch {
      blob = null;
    }
    if (blob === null) {
      return new Response("not found", { status: 404 });
    }
    return new Response(blob);
  }),
});

// ---- Fleet provisioner plane (GitHub Actions / laptop runs) ----
// The authoritative cross-origin fleet lock (#87) and fleet observability,
// exposed over plain HTTP so a Linux GH Actions runner (and a laptop) can grab
// the lock and stream events with just curl + the shared secret — no Convex
// client or deploy key. All secret-gated by `x-devbox-secret`.

// Acquire the global fleet lock (or renew it if this holder already owns it).
// Body: { holder: string, ttlMs?: number }. 200 with { acquired: true, ... } or
// { acquired: false, heldBy, expiresAt } — callers branch on `acquired`.
http.route({
  path: "/fleet/lock/acquire",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: { holder: string; ttlMs?: number } | null;
    try {
      body = parseLockBody(JSON.parse(await request.text()));
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (body === null) {
      return new Response("expected { holder: string, ttlMs?: number }", {
        status: 400,
      });
    }
    const result = await ctx.runMutation(internal.fleetLock.acquire, {
      name: FLEET_LOCK_NAME,
      holder: body.holder,
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    });
    return Response.json(result);
  }),
});

// Extend the lease — only if this holder still owns it. Body: { holder, ttlMs? }.
http.route({
  path: "/fleet/lock/renew",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: { holder: string; ttlMs?: number } | null;
    try {
      body = parseLockBody(JSON.parse(await request.text()));
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (body === null) {
      return new Response("expected { holder: string, ttlMs?: number }", {
        status: 400,
      });
    }
    const result = await ctx.runMutation(internal.fleetLock.renew, {
      name: FLEET_LOCK_NAME,
      holder: body.holder,
      ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
    });
    return Response.json(result);
  }),
});

// Release the lock — a no-op unless this holder owns it. Body: { holder }.
http.route({
  path: "/fleet/lock/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: { holder: string } | null;
    try {
      body = parseLockBody(JSON.parse(await request.text()));
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (body === null) {
      return new Response("expected { holder: string }", { status: 400 });
    }
    const result = await ctx.runMutation(internal.fleetLock.release, {
      name: FLEET_LOCK_NAME,
      holder: body.holder,
    });
    return Response.json(result);
  }),
});

// Fleet snapshot (hosts/devboxes/queue/recent events) for the provisioner's
// smoke test ("is this host active + recently seen?") and debugging.
http.route({
  path: "/fleet/status",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    const snapshot = await ctx.runQuery(internal.hosts.fleetSnapshot, {});
    return Response.json(snapshot);
  }),
});

// Fleet lifecycle event from the GH Actions provisioner / a laptop run, into
// hostEvents (get_fleet surfaces them). Body: { hostId, type, summary }. A
// "provision_failed" event also drops a stale pre-created provisioning row.
http.route({
  path: "/fleet/event",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let payload: { hostId?: unknown; type?: unknown; summary?: unknown };
    try {
      payload = JSON.parse(await request.text()) as typeof payload;
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (
      typeof payload.hostId !== "string" ||
      typeof payload.type !== "string" ||
      typeof payload.summary !== "string"
    ) {
      return new Response("expected { hostId, type, summary }", {
        status: 400,
      });
    }
    await ctx.runMutation(internal.hosts.recordFleetEvent, {
      hostId: payload.hostId,
      type: payload.type,
      summary: payload.summary,
    });
    return new Response(null, { status: 200 });
  }),
});

// Drain or rejoin a host for a golden-refresh (#89). "draining" makes pickHost
// skip the host (no new VMs) without touching its in-flight VMs; "active"
// rejoins it once it's on the new golden. Body: { hostId, status }. Returns
// { found } so the caller can tell a real host from a typo'd one.
http.route({
  path: "/fleet/host/status",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: { hostId: string; status: "active" | "draining" } | null;
    try {
      body = parseHostStatus(JSON.parse(await request.text()));
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (body === null) {
      return new Response(
        'expected { hostId: string, status: "active" | "draining" }',
        { status: 400 },
      );
    }
    const result = await ctx.runMutation(internal.hosts.setHostStatus, {
      hostId: body.hostId,
      status: body.status,
    });
    return Response.json(result);
  }),
});

// Force-evict every ephemeral VM on a host (all-at-once golden-refresh, after a
// bounded drain): each is marked retiring and a destroy_vm is enqueued so the
// host agent tears it down now. Abandons any in-flight task on them — the caller
// surfaces the count (returned as { evicted, devboxIds }). Body: { hostId }.
http.route({
  path: "/fleet/host/evict",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!devboxSecretOk(request)) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: { hostId: string } | null;
    try {
      body = parseHostId(JSON.parse(await request.text()));
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (body === null) {
      return new Response("expected { hostId: string }", { status: 400 });
    }
    const result = await ctx.runMutation(internal.hosts.evictHostEphemerals, {
      hostId: body.hostId,
    });
    return Response.json(result);
  }),
});

export default http;
