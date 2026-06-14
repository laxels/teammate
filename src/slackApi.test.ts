import { describe, expect, test } from "bun:test";
import {
  addSlackReaction,
  downloadSlackFile,
  getSlackPermalink,
  postSlackMessage,
  updateSlackMessage,
  uploadSlackFile,
} from "./slackApi";

const args = {
  botToken: "xoxb-test",
  channel: "D0DM",
  text: "hello",
  threadTs: "1749500000.000100",
};

type CannedResponse = Response | Error;

/** fetch stub that replays a fixed sequence of responses/errors. */
function fetchSequence(responses: CannedResponse[]): {
  fetchFn: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const fetchFn = (async () => {
    const next = responses[state.calls];
    state.calls += 1;
    if (next === undefined) throw new Error("fetchSequence exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return {
    fetchFn,
    get calls() {
      return state.calls;
    },
  };
}

function ok(ts = "1749500001.000200"): Response {
  return Response.json({ ok: true, ts });
}

function slackError(error: string): Response {
  return Response.json({ ok: false, error });
}

function http(status: number, headers: Record<string, string> = {}): Response {
  return new Response("err", { status, headers });
}

function sleepRecorder(): {
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

describe("postSlackMessage retries", () => {
  test("succeeds first try, returns the posted message ts", async () => {
    const seq = fetchSequence([ok("1749500009.000900")]);
    const { sleeps, sleep } = sleepRecorder();
    const ts = await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
    expect(ts).toBe("1749500009.000900");
    expect(seq.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("retries a 429, honoring Retry-After seconds", async () => {
    const seq = fetchSequence([http(429, { "retry-after": "3" }), ok()]);
    const { sleeps, sleep } = sleepRecorder();
    await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
    expect(seq.calls).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  test("caps an absurd Retry-After", async () => {
    const seq = fetchSequence([http(429, { "retry-after": "9999" }), ok()]);
    const { sleeps, sleep } = sleepRecorder();
    await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
    expect(sleeps[0]).toBeLessThanOrEqual(30_000);
  });

  test("retries 5xx and transport errors with backoff", async () => {
    const seq = fetchSequence([http(503), new Error("ECONNRESET"), ok()]);
    const { sleeps, sleep } = sleepRecorder();
    await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
    expect(seq.calls).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  test('retries Slack\'s 200-with-"ratelimited" body', async () => {
    const seq = fetchSequence([slackError("ratelimited"), ok()]);
    const { sleep } = sleepRecorder();
    await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
    expect(seq.calls).toBe(2);
  });

  test("permanent Slack errors throw immediately without retry", async () => {
    const seq = fetchSequence([slackError("channel_not_found")]);
    const { sleeps, sleep } = sleepRecorder();
    await expect(
      postSlackMessage(args, { fetchFn: seq.fetchFn, sleep }),
    ).rejects.toThrow("channel_not_found");
    expect(seq.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("non-429 4xx throws immediately", async () => {
    const seq = fetchSequence([http(403)]);
    const { sleep } = sleepRecorder();
    await expect(
      postSlackMessage(args, { fetchFn: seq.fetchFn, sleep }),
    ).rejects.toThrow("403");
    expect(seq.calls).toBe(1);
  });

  test("gives up after exhausting attempts and throws the last error", async () => {
    const seq = fetchSequence([http(500), http(500), http(500), http(500)]);
    const { sleep } = sleepRecorder();
    await expect(
      postSlackMessage(args, { fetchFn: seq.fetchFn, sleep }),
    ).rejects.toThrow("500");
    expect(seq.calls).toBe(4);
  });
});

describe("getSlackPermalink", () => {
  const linkArgs = {
    botToken: "xoxb-test",
    channel: "D0DM",
    messageTs: "1749500000.000100",
  };

  test("returns the permalink and passes channel + message_ts", async () => {
    let requested = "";
    const fetchFn = (async (url: unknown) => {
      requested = String(url);
      return Response.json({
        ok: true,
        permalink: "https://team.slack.com/archives/D0DM/p1749500000000100",
      });
    }) as unknown as typeof fetch;
    const link = await getSlackPermalink(linkArgs, { fetchFn });
    expect(link).toBe("https://team.slack.com/archives/D0DM/p1749500000000100");
    expect(requested).toContain("channel=D0DM");
    expect(requested).toContain("message_ts=1749500000.000100");
  });

  test("returns null on Slack errors and transport failures (best-effort)", async () => {
    const apiError = fetchSequence([slackError("message_not_found")]);
    expect(
      await getSlackPermalink(linkArgs, { fetchFn: apiError.fetchFn }),
    ).toBeNull();
    const transport = fetchSequence([new Error("ECONNRESET")]);
    expect(
      await getSlackPermalink(linkArgs, { fetchFn: transport.fetchFn }),
    ).toBeNull();
  });
});

describe("updateSlackMessage", () => {
  const updateArgs = {
    botToken: "xoxb-test",
    channel: "D0DM",
    ts: "1749500001.000200",
    text: "updated card",
  };

  test("calls chat.update and retries transient failures", async () => {
    const seq = fetchSequence([http(429, { "retry-after": "1" }), ok()]);
    const { sleep } = sleepRecorder();
    await updateSlackMessage(updateArgs, { fetchFn: seq.fetchFn, sleep });
    expect(seq.calls).toBe(2);
  });

  test("permanent errors throw immediately", async () => {
    const seq = fetchSequence([slackError("message_not_found")]);
    const { sleep } = sleepRecorder();
    await expect(
      updateSlackMessage(updateArgs, { fetchFn: seq.fetchFn, sleep }),
    ).rejects.toThrow("message_not_found");
    expect(seq.calls).toBe(1);
  });
});

describe("addSlackReaction", () => {
  const reactionArgs = {
    botToken: "xoxb-test",
    channel: "D0DM",
    messageTs: "1749500000.000100",
    name: "white_check_mark",
  };

  test("returns true on success", async () => {
    const seq = fetchSequence([ok()]);
    expect(await addSlackReaction(reactionArgs, { fetchFn: seq.fetchFn })).toBe(
      true,
    );
  });

  test("best-effort: missing scope or transport errors return false", async () => {
    const { sleep } = sleepRecorder();
    const noScope = fetchSequence([slackError("missing_scope")]);
    expect(
      await addSlackReaction(reactionArgs, { fetchFn: noScope.fetchFn, sleep }),
    ).toBe(false);
    const transport = fetchSequence([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    expect(
      await addSlackReaction(reactionArgs, {
        fetchFn: transport.fetchFn,
        sleep,
      }),
    ).toBe(false);
  });
});

/** fetch stub that records each call and replays canned responses in order. */
function recordingFetch(responses: CannedResponse[]): {
  fetchFn: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const next = responses[calls.length];
    calls.push({ url: String(url), init });
    if (next === undefined) throw new Error("recordingFetch exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("downloadSlackFile", () => {
  const base = {
    botToken: "xoxb-test",
    urlPrivate: "https://files.slack.com/files-pri/T-F/error.png",
    maxBytes: 1024,
  };

  test("returns bytes + mime and sends the bot token as a bearer", async () => {
    const rec = recordingFetch([
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png" },
      }),
    ]);
    const result = await downloadSlackFile(base, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
      expect(result.mimeType).toBe("image/png");
    }
    const header = (rec.calls[0]?.init?.headers ?? {}) as Record<
      string,
      string
    >;
    expect(header.authorization).toBe("Bearer xoxb-test");
  });

  test("treats an HTML login page as failure (unauthorized)", async () => {
    const rec = recordingFetch([
      new Response("<html>sign in</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ]);
    const result = await downloadSlackFile(base, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(false);
  });

  test("accepts genuine HTML bytes when the file is expected to be HTML", async () => {
    const rec = recordingFetch([
      new Response("<html>real report</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ]);
    const result = await downloadSlackFile(
      { ...base, expectedMimeType: "text/html" },
      { fetchFn: rec.fetchFn },
    );
    expect(result.ok).toBe(true);
  });

  test("fails on non-2xx", async () => {
    const rec = recordingFetch([http(404)]);
    const result = await downloadSlackFile(base, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(false);
  });

  test("rejects a file over the cap by its declared length without buffering", async () => {
    const rec = recordingFetch([
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "999999" },
      }),
    ]);
    const result = await downloadSlackFile(base, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cap");
  });
});

describe("uploadSlackFile", () => {
  const uploadArgs = {
    botToken: "xoxb-test",
    channel: "C0CHAN",
    threadTs: "1749500000.000100",
    filename: "screenshot.png",
    bytes: new Uint8Array([9, 8, 7]),
    initialComment: "here is the screenshot",
  };

  test("runs the 3-step external flow and shares into the thread", async () => {
    const rec = recordingFetch([
      Response.json({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/abc",
        file_id: "F123",
      }),
      new Response("OK", { status: 200 }),
      Response.json({ ok: true }),
    ]);
    const result = await uploadSlackFile(uploadArgs, { fetchFn: rec.fetchFn });
    expect(result).toEqual({ ok: true, fileId: "F123" });
    expect(rec.calls[0]?.url).toBe(
      "https://slack.com/api/files.getUploadURLExternal",
    );
    expect(rec.calls[1]?.url).toBe("https://files.slack.com/upload/v1/abc");
    expect(rec.calls[2]?.url).toBe(
      "https://slack.com/api/files.completeUploadExternal",
    );
    const completeBody = String(rec.calls[2]?.init?.body ?? "");
    expect(completeBody).toContain("thread_ts=1749500000.000100");
    expect(completeBody).toContain("channel_id=C0CHAN");
    expect(completeBody).toContain("F123");
  });

  test("stops and reports when the reserve step fails (single call)", async () => {
    const rec = recordingFetch([slackError("invalid_auth")]);
    const result = await uploadSlackFile(uploadArgs, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(false);
    expect(rec.calls.length).toBe(1);
  });

  test("reports when the completion step fails", async () => {
    const rec = recordingFetch([
      Response.json({
        ok: true,
        upload_url: "https://files.slack.com/upload/v1/abc",
        file_id: "F123",
      }),
      new Response("OK", { status: 200 }),
      slackError("invalid_channel"),
    ]);
    const result = await uploadSlackFile(uploadArgs, { fetchFn: rec.fetchFn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid_channel");
  });
});
