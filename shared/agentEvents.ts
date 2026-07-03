// Agent-event wire plumbing, shared by the devbox gateway and the localagent
// daemon (#138). Both post the same event shape to their own secret-gated
// endpoint (/devbox/events with x-devbox-secret and a devboxId; /local/events
// with x-local-secret and a machineId) — the endpoint, header, and identity
// field are the only differences, so they are the config surface here.

import type { DevboxEventType } from "./protocol";

/** Info-event enrichment carried alongside a timeline event (#70). */
export type EventExtra = {
  detail?: string;
  tool?: string;
  imageStorageId?: string;
};

export type EventSender = (
  taskId: string,
  type: DevboxEventType,
  summary: string,
  extra?: EventExtra,
) => Promise<void>;

/** Minimal fetch shape so tests can stub the network boundary. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AgentEventSenderConfig = {
  convexSiteUrl: string;
  /** POST target, e.g. "/devbox/events" or "/local/events". */
  endpointPath: string;
  /** Auth header (name -> value), e.g. { "x-devbox-secret": secret }. */
  authHeader: Record<string, string>;
  /** The event's agent-identity field, e.g. { devboxId } or { machineId }. */
  identity: Record<string, string>;
  /** Log prefix, e.g. "gateway" or "localagent". */
  logPrefix: string;
};

/**
 * POSTs lifecycle/info events to the configured endpoint. Delivery failures
 * are logged and swallowed so they can never crash a running session.
 */
export function createAgentEventSender(
  config: AgentEventSenderConfig,
  fetchFn: FetchLike = fetch,
  now: () => number = Date.now,
  timeoutMs = 10_000,
): EventSender {
  const endpoint = new URL(
    config.endpointPath,
    config.convexSiteUrl,
  ).toString();
  // Deliveries are serialized: adjacent events (e.g. the final progress and
  // the completed event it precedes) must not race each other on the wire,
  // or the receiver may apply them out of order.
  let queue: Promise<void> = Promise.resolve();
  return (taskId, type, summary, extra) => {
    const event = {
      ...config.identity,
      taskId,
      type,
      summary,
      ts: now(),
      ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra?.tool === undefined ? {} : { tool: extra.tool }),
      ...(extra?.imageStorageId === undefined
        ? {}
        : { imageStorageId: extra.imageStorageId }),
    };
    queue = queue.then(async () => {
      try {
        // Without the timeout, one POST into a dead network never settles
        // and the serialized queue wedges every later event silently.
        const response = await fetchFn(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...config.authHeader,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(
            `[${config.logPrefix}] agent event POST failed (${response.status}): ${body}`,
          );
        }
      } catch (error) {
        console.error(`[${config.logPrefix}] agent event POST error:`, error);
      }
    });
    return queue;
  };
}

/**
 * Uploads a tool-result screenshot (#70) to Convex file storage and returns its
 * storageId (null on any failure — the timeline then shows a text-only tool
 * result). The generateUploadUrl flow: fetch a one-shot upload URL from the
 * configured endpoint, POST the bytes, read back the storageId.
 */
export type ScreenshotUploader = (
  bytes: Uint8Array,
  contentType: string,
) => Promise<string | null>;

export type AgentScreenshotUploaderConfig = {
  convexSiteUrl: string;
  /** Upload-URL endpoint, e.g. "/devbox/recording/upload-url" or
   * "/local/upload-url". */
  uploadUrlPath: string;
  authHeader: Record<string, string>;
  logPrefix: string;
};

export function createAgentScreenshotUploader(
  config: AgentScreenshotUploaderConfig,
  fetchFn: FetchLike = fetch,
): ScreenshotUploader {
  const uploadUrlEndpoint = new URL(
    config.uploadUrlPath,
    config.convexSiteUrl,
  ).toString();
  return async (bytes, contentType) => {
    let url: string;
    try {
      const response = await fetchFn(uploadUrlEndpoint, {
        method: "POST",
        headers: config.authHeader,
      });
      if (!response.ok) {
        console.error(
          `[${config.logPrefix}] screenshot: upload-url POST failed (${response.status})`,
        );
        return null;
      }
      ({ url } = (await response.json()) as { url: string });
    } catch (error) {
      console.error(
        `[${config.logPrefix}] screenshot: upload-url error:`,
        error,
      );
      return null;
    }
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body: bytes.slice().buffer as ArrayBuffer,
      });
      if (!response.ok) {
        console.error(
          `[${config.logPrefix}] screenshot: upload POST failed (${response.status})`,
        );
        return null;
      }
      const { storageId } = (await response.json()) as { storageId: string };
      return typeof storageId === "string" && storageId !== ""
        ? storageId
        : null;
    } catch (error) {
      console.error(`[${config.logPrefix}] screenshot: upload error:`, error);
      return null;
    }
  };
}
