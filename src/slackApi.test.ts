import { describe, expect, test } from "bun:test";
import { getSlackPermalink, postSlackMessage } from "./slackApi";

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

function ok(): Response {
  return Response.json({ ok: true });
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
  test("succeeds first try without sleeping", async () => {
    const seq = fetchSequence([ok()]);
    const { sleeps, sleep } = sleepRecorder();
    await postSlackMessage(args, { fetchFn: seq.fetchFn, sleep });
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
