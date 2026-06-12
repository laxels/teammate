// Minimal Slack Web API client used by the Convex actions. Kept in src/ so
// both the default-runtime actions (notifications, cron) and the Node action
// (orchestrator) can share it.

export type PostMessageArgs = {
  botToken: string;
  channel: string;
  text: string;
  threadTs?: string | undefined;
};

/** Injectable boundaries for tests. */
export type SlackApiDeps = {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

// Slack's channel write limit is ~1 msg/sec, so transient 429s are expected
// under bursts (every task posts lifecycle updates into one DM). Retrying
// here makes all callers (orchestrator reply, notify, staleness, cancel)
// resilient without each growing its own retry loop.
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1_000, 2_000, 4_000];
const MAX_RETRY_AFTER_MS = 30_000;

type AttemptOutcome =
  | { kind: "ok" }
  | { kind: "permanent"; error: Error }
  | { kind: "retry"; error: Error; delayMs?: number };

async function attemptPost(
  fetchFn: typeof fetch,
  body: Record<string, string>,
  botToken: string,
): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetchFn("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      kind: "retry",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  if (response.status === 429) {
    const retryAfterS = Number(response.headers.get("retry-after"));
    return {
      kind: "retry",
      error: new Error("chat.postMessage HTTP 429"),
      ...(Number.isFinite(retryAfterS) && retryAfterS > 0
        ? { delayMs: Math.min(retryAfterS * 1000, MAX_RETRY_AFTER_MS) }
        : {}),
    };
  }
  if (response.status >= 500) {
    return {
      kind: "retry",
      error: new Error(`chat.postMessage HTTP ${response.status}`),
    };
  }
  if (!response.ok) {
    return {
      kind: "permanent",
      error: new Error(`chat.postMessage HTTP ${response.status}`),
    };
  }
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (result.ok === true) {
    return { kind: "ok" };
  }
  if (result.error === "ratelimited") {
    return { kind: "retry", error: new Error("chat.postMessage ratelimited") };
  }
  return {
    kind: "permanent",
    error: new Error(`chat.postMessage failed: ${result.error ?? "unknown"}`),
  };
}

/**
 * Posts a message via chat.postMessage. Transient failures (429 honoring
 * Retry-After, 5xx, transport errors) are retried with bounded backoff;
 * permanent Slack errors (channel_not_found, ...) throw immediately so
 * callers can decide how to surface them.
 */
export async function postSlackMessage(
  args: PostMessageArgs,
  deps: SlackApiDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  // Convex's default (non-Node) runtime has no setTimeout; callers there
  // should be "use node" actions. If one isn't, degrade to immediate retries
  // instead of crashing on the first transient failure.
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      typeof setTimeout === "function"
        ? new Promise<void>((resolve) => setTimeout(resolve, ms))
        : Promise.resolve());

  const body: Record<string, string> = {
    channel: args.channel,
    text: args.text,
  };
  if (args.threadTs !== undefined) {
    body.thread_ts = args.threadTs;
  }

  let lastError = new Error("chat.postMessage: no attempts made");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptPost(fetchFn, body, args.botToken);
    if (outcome.kind === "ok") {
      return;
    }
    if (outcome.kind === "permanent") {
      throw outcome.error;
    }
    lastError = outcome.error;
    if (attempt < MAX_ATTEMPTS - 1) {
      await sleep(outcome.delayMs ?? BACKOFF_MS[attempt] ?? 4_000);
    }
  }
  throw lastError;
}
