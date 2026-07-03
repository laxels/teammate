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

// ---- File handling (files:read download + files:write external upload) ----

export type SlackFileDownload =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; mimeType: string }
  | { ok: false; error: string };

/**
 * Downloads a file a user shared, via its `url_private`/`url_private_download`
 * link. Slack gates these behind the bot token (Authorization: Bearer) and —
 * crucially — answers an UNAUTHORIZED request with a 200 HTML login page
 * rather than an error. So a text/html response is treated as that failure,
 * UNLESS the file was itself expected to be HTML (pass `expectedMimeType` from
 * the Slack metadata), which lets genuine .html attachments through.
 * Best-effort: never throws; returns the reason on failure so the caller can
 * tell the user instead of handing the model garbage bytes.
 */
export async function downloadSlackFile(
  args: {
    botToken: string;
    urlPrivate: string;
    maxBytes: number;
    expectedMimeType?: string | undefined;
  },
  deps: SlackApiDeps = {},
): Promise<SlackFileDownload> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(args.urlPrivate, {
      headers: { authorization: `Bearer ${args.botToken}` },
    });
    if (!response.ok) {
      return { ok: false, error: `download HTTP ${response.status}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    const expectsHtml = (args.expectedMimeType ?? "").includes("html");
    if (contentType.includes("text/html") && !expectsHtml) {
      return {
        ok: false,
        error: "got an HTML page, not file bytes (bot token lacks files:read?)",
      };
    }
    // Honor a declared length before buffering, so a misreported attachment
    // can't make us pull megabytes we will only discard.
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > args.maxBytes) {
      return {
        ok: false,
        error: `file is ${declared} bytes (over the ${args.maxBytes}-byte cap)`,
      };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > args.maxBytes) {
      return {
        ok: false,
        error: `file is ${buffer.byteLength} bytes (over the ${args.maxBytes}-byte cap)`,
      };
    }
    const mimeType =
      contentType.split(";")[0]?.trim() || "application/octet-stream";
    return { ok: true, bytes: new Uint8Array(buffer), mimeType };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type SlackUploadResult =
  | { ok: true; fileId: string }
  | { ok: false; error: string };

/** POSTs a form-encoded Slack Web API call (the upload methods reject JSON
 * bodies) and normalizes HTTP/Slack-level failures into an error string.
 * Transport errors propagate — uploadSlackFile's outer catch formats them. */
async function postSlackForm(
  fetchFn: typeof fetch,
  botToken: string,
  method: string,
  params: URLSearchParams,
): Promise<
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string }
> {
  const response = await fetchFn(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${botToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!response.ok) {
    return { ok: false, error: `${method} HTTP ${response.status}` };
  }
  const result = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (result.ok === true) {
    return { ok: true, result };
  }
  return { ok: false, error: `${method} failed: ${result.error ?? "unknown"}` };
}

/** Step 1 of the external-upload flow: reserve a single-use upload URL. */
async function getUploadUrlExternal(
  fetchFn: typeof fetch,
  botToken: string,
  filename: string,
  length: number,
): Promise<
  { ok: true; uploadUrl: string; fileId: string } | { ok: false; error: string }
> {
  const posted = await postSlackForm(
    fetchFn,
    botToken,
    "files.getUploadURLExternal",
    new URLSearchParams({ filename, length: String(length) }),
  );
  if (!posted.ok) {
    return posted;
  }
  const { upload_url, file_id, error } = posted.result;
  if (typeof upload_url === "string" && typeof file_id === "string") {
    return { ok: true, uploadUrl: upload_url, fileId: file_id };
  }
  return {
    ok: false,
    error: `files.getUploadURLExternal failed: ${error ?? "unknown"}`,
  };
}

/** Step 3: finalize the upload and share the file into the thread. */
async function completeUploadExternal(
  fetchFn: typeof fetch,
  botToken: string,
  args: {
    fileId: string;
    title: string;
    channel: string;
    threadTs?: string | undefined;
    initialComment?: string | undefined;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body = new URLSearchParams({
    files: JSON.stringify([{ id: args.fileId, title: args.title }]),
    channel_id: args.channel,
  });
  if (args.threadTs !== undefined) body.set("thread_ts", args.threadTs);
  if (args.initialComment !== undefined) {
    body.set("initial_comment", args.initialComment);
  }
  const posted = await postSlackForm(
    fetchFn,
    botToken,
    "files.completeUploadExternal",
    body,
  );
  return posted.ok ? { ok: true } : posted;
}

/**
 * Uploads a file into a Slack thread via the modern external-upload flow:
 * reserve an upload URL (files.getUploadURLExternal) -> POST the raw bytes to
 * it -> finalize and share (files.completeUploadExternal). Best-effort: the
 * reserved URL is single-use, so a mid-flow failure isn't retried here —
 * callers log and move on (an artifact failing to post must never crash a
 * task). Returns the reason on failure.
 */
export async function uploadSlackFile(
  args: {
    botToken: string;
    channel: string;
    threadTs?: string | undefined;
    filename: string;
    bytes: Uint8Array<ArrayBuffer>;
    title?: string | undefined;
    initialComment?: string | undefined;
  },
  deps: SlackApiDeps = {},
): Promise<SlackUploadResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const reserved = await getUploadUrlExternal(
      fetchFn,
      args.botToken,
      args.filename,
      args.bytes.byteLength,
    );
    if (!reserved.ok) {
      return reserved;
    }
    const put = await fetchFn(reserved.uploadUrl, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: args.bytes,
    });
    if (!put.ok) {
      return { ok: false, error: `upload POST HTTP ${put.status}` };
    }
    const completed = await completeUploadExternal(fetchFn, args.botToken, {
      fileId: reserved.fileId,
      title: args.title ?? args.filename,
      channel: args.channel,
      threadTs: args.threadTs,
      initialComment: args.initialComment,
    });
    if (!completed.ok) {
      return completed;
    }
    return { ok: true, fileId: reserved.fileId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
