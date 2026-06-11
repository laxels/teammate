import { httpRouter } from "convex/server";
import { parseDevboxEvent } from "../src/orchestration";
import { timingSafeEqual, verifySlackSignature } from "../src/slack";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

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

    const { taskFound } = await ctx.runMutation(
      internal.devboxes.recordEvent,
      event,
    );
    if (taskFound) {
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

export default http;
