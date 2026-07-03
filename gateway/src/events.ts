// The event plumbing moved to shared/agentEvents.ts (#138) so the localagent
// daemon reuses it; this shim binds the gateway's specifics (the /devbox/*
// endpoints, the x-devbox-secret header, the devboxId identity) and preserves
// the original module surface for the rest of gateway/ and its tests.

import {
  createAgentEventSender,
  createAgentScreenshotUploader,
  type EventSender,
  type FetchLike,
  type ScreenshotUploader,
} from "../../shared/agentEvents";

export type {
  EventExtra,
  EventSender,
  FetchLike,
  ScreenshotUploader,
} from "../../shared/agentEvents";

export type EventSenderConfig = {
  convexSiteUrl: string;
  devboxId: string;
  devboxSharedSecret: string;
};

/**
 * POSTs DevboxEvents to {CONVEX_SITE_URL}/devbox/events, authenticated with
 * the x-devbox-secret header. Delivery failures are logged and swallowed so
 * they can never crash a running session.
 */
export function createEventSender(
  config: EventSenderConfig,
  fetchFn: FetchLike = fetch,
  now: () => number = Date.now,
  timeoutMs = 10_000,
): EventSender {
  return createAgentEventSender(
    {
      convexSiteUrl: config.convexSiteUrl,
      endpointPath: "/devbox/events",
      authHeader: { "x-devbox-secret": config.devboxSharedSecret },
      identity: { devboxId: config.devboxId },
      logPrefix: "gateway",
    },
    fetchFn,
    now,
    timeoutMs,
  );
}

export function createScreenshotUploader(
  config: EventSenderConfig,
  fetchFn: FetchLike = fetch,
): ScreenshotUploader {
  return createAgentScreenshotUploader(
    {
      convexSiteUrl: config.convexSiteUrl,
      uploadUrlPath: "/devbox/recording/upload-url",
      authHeader: { "x-devbox-secret": config.devboxSharedSecret },
      logPrefix: "gateway",
    },
    fetchFn,
  );
}
