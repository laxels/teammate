import {
  type DevboxEvent,
  type DevboxEventType,
  MAX_TRANSCRIPT_BYTES,
  type TranscriptUpload,
} from "../../shared/protocol";

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
  // Deliveries are serialized: adjacent events (e.g. the final progress and
  // the completed event it precedes) must not race each other on the wire,
  // or the receiver may apply them out of order.
  let queue: Promise<void> = Promise.resolve();
  return (taskId, type, summary) => {
    const event: DevboxEvent = {
      devboxId: config.devboxId,
      taskId,
      type,
      summary,
      ts: now(),
    };
    queue = queue.then(async () => {
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
    });
    return queue;
  };
}

export type TranscriptSender = (
  taskId: string,
  messages: unknown[],
) => Promise<void>;

const utf8 = new TextEncoder();

/**
 * Drops oldest messages until the payload fits the byte cap. Measures UTF-8
 * BYTES (TextEncoder), not string length — JSON.stringify leaves non-ASCII
 * unescaped, so CJK/emoji-heavy transcripts are up to 3x their UTF-16 unit
 * count on the wire (and in Convex's ~1 MiB document limit). If even the
 * newest message alone is oversized, a small marker survives so the
 * dashboard never renders an unexplained blank.
 */
export function fitTranscript(
  upload: TranscriptUpload,
  maxBytes: number = MAX_TRANSCRIPT_BYTES,
): TranscriptUpload {
  let messages = upload.messages;
  while (
    messages.length > 0 &&
    utf8.encode(JSON.stringify({ ...upload, messages })).byteLength > maxBytes
  ) {
    messages = messages.slice(Math.max(1, Math.floor(messages.length / 10)));
  }
  if (messages.length === 0 && upload.messages.length > 0) {
    messages = [
      {
        type: "meta",
        note: `transcript too large to persist (${upload.messages.length} messages dropped)`,
      },
    ];
  }
  return { ...upload, messages };
}

/**
 * POSTs the task's transcript to {CONVEX_SITE_URL}/devbox/transcript once a
 * task ends, so the session record outlives the VM. Best-effort: failures are
 * logged and swallowed.
 */
export function createTranscriptSender(
  config: EventSenderConfig,
  fetchFn: FetchLike = fetch,
): TranscriptSender {
  const endpoint = new URL(
    "/devbox/transcript",
    config.convexSiteUrl,
  ).toString();
  return async (taskId, messages) => {
    const upload = fitTranscript({
      devboxId: config.devboxId,
      taskId,
      messages,
    });
    try {
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-devbox-secret": config.devboxSharedSecret,
        },
        body: JSON.stringify(upload),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.error(
          `[gateway] transcript POST failed (${response.status}): ${body}`,
        );
      }
    } catch (error) {
      console.error("[gateway] transcript POST error:", error);
    }
  };
}
