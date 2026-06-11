import type { DevboxEvent, DevboxEventType } from "../../shared/protocol";

export type EventSender = (
  taskId: string,
  type: DevboxEventType,
  summary: string,
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
): EventSender {
  const endpoint = new URL("/devbox/events", config.convexSiteUrl).toString();
  return async (taskId, type, summary) => {
    const event: DevboxEvent = {
      devboxId: config.devboxId,
      taskId,
      type,
      summary,
      ts: now(),
    };
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-devbox-secret": config.devboxSharedSecret,
        },
        body: JSON.stringify(event),
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
  };
}
