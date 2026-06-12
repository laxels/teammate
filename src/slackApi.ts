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
  | { kind: "ok"; ts: string | null }
  | { kind: "permanent"; error: Error }
  | { kind: "retry"; error: Error; delayMs?: number };

async function attemptCall(
  fetchFn: typeof fetch,
  method: string,
  body: Record<string, string>,
  botToken: string,
): Promise<AttemptOutcome> {
  let response: Response;
  try {
    response = await fetchFn(`https://slack.com/api/${method}`, {
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
      error: new Error(`${method} HTTP 429`),
      ...(Number.isFinite(retryAfterS) && retryAfterS > 0
        ? { delayMs: Math.min(retryAfterS * 1000, MAX_RETRY_AFTER_MS) }
        : {}),
    };
  }
  if (response.status >= 500) {
    return {
      kind: "retry",
      error: new Error(`${method} HTTP ${response.status}`),
    };
  }
  if (!response.ok) {
    return {
      kind: "permanent",
      error: new Error(`${method} HTTP ${response.status}`),
    };
  }
  const result = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    ts?: string;
  };
  if (result.ok === true) {
    return { kind: "ok", ts: typeof result.ts === "string" ? result.ts : null };
  }
  if (result.error === "ratelimited") {
    return { kind: "retry", error: new Error(`${method} ratelimited`) };
  }
  return {
    kind: "permanent",
    error: new Error(`${method} failed: ${result.error ?? "unknown"}`),
  };
}

async function callWithRetries(
  method: string,
  body: Record<string, string>,
  botToken: string,
  deps: SlackApiDeps,
): Promise<string | null> {
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

  let lastError = new Error(`${method}: no attempts made`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const outcome = await attemptCall(fetchFn, method, body, botToken);
    if (outcome.kind === "ok") {
      return outcome.ts;
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

/**
 * Resolves a message's Slack permalink via chat.getPermalink (no extra
 * scopes required). Best-effort: returns null on any failure — a permalink
 * is a nice-to-have and must never block or delay task creation.
 */
export async function getSlackPermalink(
  args: { botToken: string; channel: string; messageTs: string },
  deps: SlackApiDeps = {},
): Promise<string | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", args.channel);
    url.searchParams.set("message_ts", args.messageTs);
    const response = await fetchFn(url.toString(), {
      headers: { authorization: `Bearer ${args.botToken}` },
    });
    if (!response.ok) {
      return null;
    }
    const result = (await response.json()) as {
      ok?: boolean;
      permalink?: string;
    };
    return result.ok === true && typeof result.permalink === "string"
      ? result.permalink
      : null;
  } catch {
    return null;
  }
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
): Promise<string | null> {
  const body: Record<string, string> = {
    channel: args.channel,
    text: args.text,
  };
  if (args.threadTs !== undefined) {
    body.thread_ts = args.threadTs;
  }
  // Returns the posted message's ts — callers use it to anchor status cards
  // (chat.update) and to adopt a thread for legacy threadless tasks.
  return await callWithRetries("chat.postMessage", body, args.botToken, deps);
}

/** Edits a previously posted message (status cards). Same retry semantics as
 * postSlackMessage; permanent errors (message_not_found) throw. */
export async function updateSlackMessage(
  args: { botToken: string; channel: string; ts: string; text: string },
  deps: SlackApiDeps = {},
): Promise<void> {
  await callWithRetries(
    "chat.update",
    { channel: args.channel, ts: args.ts, text: args.text },
    args.botToken,
    deps,
  );
}

/** Deletes one of the bot's own messages (duplicate status cards from a
 * first-event race). Best-effort: never throws. */
export async function deleteSlackMessage(
  args: { botToken: string; channel: string; ts: string },
  deps: SlackApiDeps = {},
): Promise<boolean> {
  try {
    await callWithRetries(
      "chat.delete",
      { channel: args.channel, ts: args.ts },
      args.botToken,
      deps,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Adds an emoji reaction to a message (glanceable task status on the original
 * request). Best-effort: returns false on ANY failure — including
 * missing_scope until the reactions:write manifest change is applied — and
 * never throws.
 */
export async function addSlackReaction(
  args: {
    botToken: string;
    channel: string;
    messageTs: string;
    name: string;
  },
  deps: SlackApiDeps = {},
): Promise<boolean> {
  try {
    await callWithRetries(
      "reactions.add",
      { channel: args.channel, timestamp: args.messageTs, name: args.name },
      args.botToken,
      deps,
    );
    return true;
  } catch {
    return false;
  }
}
