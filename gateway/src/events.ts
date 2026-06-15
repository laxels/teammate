import type { DevboxEvent, DevboxEventType } from "../../shared/protocol";

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

export type EventSenderConfig = {
  convexSiteUrl: string;
  devboxId: string;
  devboxSharedSecret: string;
};

/** Minimal fetch shape so tests can stub the network boundary. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
  const endpoint = new URL("/devbox/events", config.convexSiteUrl).toString();
  // Deliveries are serialized: adjacent events (e.g. the final progress and
  // the completed event it precedes) must not race each other on the wire,
  // or the receiver may apply them out of order.
  let queue: Promise<void> = Promise.resolve();
  return (taskId, type, summary, extra) => {
    const event: DevboxEvent = {
      devboxId: config.devboxId,
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
            "x-devbox-secret": config.devboxSharedSecret,
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          console.error(
            `[gateway] devbox event POST failed (${response.status}): ${body}`,
          );
        }
      } catch (error) {
        console.error("[gateway] devbox event POST error:", error);
      }
    });
    return queue;
  };
}

/**
 * Uploads a tool-result screenshot (#70) to Convex file storage and returns its
 * storageId (null on any failure — the timeline then shows a text-only tool
 * result). Same generateUploadUrl flow the recorder uses: fetch a one-shot
 * upload URL, POST the bytes, read back the storageId.
 */
export type ScreenshotUploader = (
  bytes: Uint8Array,
  contentType: string,
) => Promise<string | null>;

export function createScreenshotUploader(
  config: EventSenderConfig,
  fetchFn: FetchLike = fetch,
): ScreenshotUploader {
  const uploadUrlEndpoint = new URL(
    "/devbox/recording/upload-url",
    config.convexSiteUrl,
  ).toString();
  const authHeader = { "x-devbox-secret": config.devboxSharedSecret };
  return async (bytes, contentType) => {
    let url: string;
    try {
      const response = await fetchFn(uploadUrlEndpoint, {
        method: "POST",
        headers: authHeader,
      });
      if (!response.ok) {
        console.error(
          `[gateway] screenshot: upload-url POST failed (${response.status})`,
        );
        return null;
      }
      ({ url } = (await response.json()) as { url: string });
    } catch (error) {
      console.error("[gateway] screenshot: upload-url error:", error);
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
          `[gateway] screenshot: upload POST failed (${response.status})`,
        );
        return null;
      }
      const { storageId } = (await response.json()) as { storageId: string };
      return typeof storageId === "string" && storageId !== ""
        ? storageId
        : null;
    } catch (error) {
      console.error("[gateway] screenshot: upload error:", error);
      return null;
    }
  };
}
