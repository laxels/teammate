import { describe, expect, test } from "bun:test";
import {
  buildDevboxEventMessage,
  classifySlackEvent,
  monitoringUrl,
  parseDevboxEvent,
  resolveThreadTarget,
  shouldNudge,
} from "./orchestration";

const BOT_USER_ID = "U0BOT";

// Realistic event_callback envelopes per
// https://docs.slack.dev/reference/events — trimmed to the fields Slack
// actually sends for each shape.
function envelope(event: Record<string, unknown>): string {
  return JSON.stringify({
    token: "verification-token",
    team_id: "T0TEAM",
    api_app_id: "A0APP",
    event,
    type: "event_callback",
    event_id: "Ev12345678",
    event_time: 1749500000,
    authorizations: [
      {
        enterprise_id: null,
        team_id: "T0TEAM",
        user_id: BOT_USER_ID,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
  });
}

describe("classifySlackEvent", () => {
  test("accepts a human DM (message.im)", () => {
    const result = classifySlackEvent(
      envelope({
        type: "message",
        channel: "D0DM",
        user: "U0HUMAN",
        text: "start a task to fix the login bug",
        ts: "1749500000.000100",
        channel_type: "im",
      }),
    );
    expect(result.kind).toBe("trigger");
    if (result.kind !== "trigger") throw new Error("unreachable");
    expect(result.trigger).toEqual({
      type: "message",
      channel: "D0DM",
      channelType: "im",
      user: "U0HUMAN",
      text: "start a task to fix the login bug",
      ts: "1749500000.000100",
      threadTs: undefined,
    });
  });

  test("accepts a channel mention (app_mention has no channel_type)", () => {
    const result = classifySlackEvent(
      envelope({
        type: "app_mention",
        channel: "C0GENERAL",
        user: "U0HUMAN",
        text: `<@${BOT_USER_ID}> what's running?`,
        ts: "1749500001.000200",
      }),
    );
    expect(result.kind).toBe("trigger");
    if (result.kind !== "trigger") throw new Error("unreachable");
    expect(result.trigger.channel).toBe("C0GENERAL");
    expect(result.trigger.channelType).toBeUndefined();
    expect(result.trigger.threadTs).toBeUndefined();
  });

  test("preserves thread_ts on a threaded mention", () => {
    const result = classifySlackEvent(
      envelope({
        type: "app_mention",
        channel: "C0GENERAL",
        user: "U0HUMAN",
        text: `<@${BOT_USER_ID}> status?`,
        ts: "1749500002.000300",
        thread_ts: "1749400000.000001",
      }),
    );
    if (result.kind !== "trigger") throw new Error("expected trigger");
    expect(result.trigger.threadTs).toBe("1749400000.000001");
  });

  test("ignores a bot echo (bot_id set, e.g. our own chat.postMessage)", () => {
    const result = classifySlackEvent(
      envelope({
        type: "message",
        channel: "D0DM",
        user: BOT_USER_ID,
        bot_id: "B0BOT",
        text: "Task started!",
        ts: "1749500003.000400",
        channel_type: "im",
      }),
    );
    expect(result.kind).toBe("ignore");
  });

  test("ignores a message from the authed bot user even without bot_id", () => {
    const result = classifySlackEvent(
      envelope({
        type: "message",
        channel: "D0DM",
        user: BOT_USER_ID,
        text: "Task started!",
        ts: "1749500004.000500",
        channel_type: "im",
      }),
    );
    expect(result.kind).toBe("ignore");
  });

  test("ignores message subtypes (edits, bot_message, joins)", () => {
    const result = classifySlackEvent(
      envelope({
        type: "message",
        subtype: "message_changed",
        channel: "D0DM",
        ts: "1749500005.000600",
        channel_type: "im",
      }),
    );
    expect(result.kind).toBe("ignore");
  });

  test("ignores non-DM plain messages (channel chatter without a mention)", () => {
    const result = classifySlackEvent(
      envelope({
        type: "message",
        channel: "C0GENERAL",
        user: "U0HUMAN",
        text: "unrelated chatter",
        ts: "1749500006.000700",
        channel_type: "channel",
      }),
    );
    expect(result.kind).toBe("ignore");
  });

  test("ignores unsupported event types and malformed payloads", () => {
    expect(
      classifySlackEvent(envelope({ type: "reaction_added", user: "U0HUMAN" }))
        .kind,
    ).toBe("ignore");
    expect(classifySlackEvent("not json").kind).toBe("ignore");
    expect(classifySlackEvent("{}").kind).toBe("ignore");
  });
});

describe("parseDevboxEvent", () => {
  const valid = {
    devboxId: "devbox-1",
    taskId: "task-1a2b3c4d",
    type: "progress",
    summary: "Ran the test suite; 3 failures left.",
    ts: 1749500000000,
  };

  test("accepts a conforming DevboxEvent and echoes it exactly", () => {
    expect(parseDevboxEvent(valid)).toEqual({
      devboxId: "devbox-1",
      taskId: "task-1a2b3c4d",
      type: "progress",
      summary: "Ran the test suite; 3 failures left.",
      ts: 1749500000000,
    });
  });

  test("rejects unknown event types", () => {
    expect(parseDevboxEvent({ ...valid, type: "exploded" })).toBeNull();
  });

  test("rejects missing or mistyped fields", () => {
    expect(parseDevboxEvent({ ...valid, ts: "1749500000000" })).toBeNull();
    const { summary: _summary, ...withoutSummary } = valid;
    expect(parseDevboxEvent(withoutSummary)).toBeNull();
    expect(parseDevboxEvent(null)).toBeNull();
    expect(parseDevboxEvent("started")).toBeNull();
  });
});

describe("resolveThreadTarget", () => {
  const base = {
    type: "message" as const,
    channel: "D0DM",
    user: "U0HUMAN",
    text: "hi",
    ts: "1749500000.000100",
  };

  test("DM: replies top-level (no thread)", () => {
    expect(
      resolveThreadTarget({
        ...base,
        channelType: "im",
        threadTs: undefined,
      }),
    ).toEqual({ channel: "D0DM", threadTs: undefined });
  });

  test("DM inside an existing thread: stays in that thread", () => {
    expect(
      resolveThreadTarget({
        ...base,
        channelType: "im",
        threadTs: "1749400000.000001",
      }),
    ).toEqual({ channel: "D0DM", threadTs: "1749400000.000001" });
  });

  test("channel mention: replies in a thread on the triggering message", () => {
    expect(
      resolveThreadTarget({
        ...base,
        type: "app_mention",
        channel: "C0GENERAL",
        channelType: undefined,
        threadTs: undefined,
      }),
    ).toEqual({ channel: "C0GENERAL", threadTs: "1749500000.000100" });
  });

  test("threaded channel mention: replies in the existing thread", () => {
    expect(
      resolveThreadTarget({
        ...base,
        type: "app_mention",
        channel: "C0GENERAL",
        channelType: undefined,
        threadTs: "1749400000.000001",
      }),
    ).toEqual({ channel: "C0GENERAL", threadTs: "1749400000.000001" });
  });
});

describe("monitoringUrl", () => {
  test("derives https://{host}/ (Tailscale Serve on 443) from the gateway URL", () => {
    expect(monitoringUrl("http://devbox-1.tail1234.ts.net:8787")).toBe(
      "https://devbox-1.tail1234.ts.net/",
    );
  });

  test("drops gateway ports and paths", () => {
    expect(monitoringUrl("http://100.99.1.5:9090/api")).toBe(
      "https://100.99.1.5/",
    );
  });

  test("returns null for an unparseable gateway URL", () => {
    expect(monitoringUrl("not a url")).toBeNull();
  });
});

describe("shouldNudge", () => {
  const MIN = 60_000;
  const now = 1_750_000_000_000;

  test("nudges when the latest event is older than 30 minutes", () => {
    expect(shouldNudge({ nowMs: now, latestActivityMs: now - 31 * MIN })).toBe(
      true,
    );
  });

  test("does not nudge fresh tasks", () => {
    expect(shouldNudge({ nowMs: now, latestActivityMs: now - 29 * MIN })).toBe(
      false,
    );
  });

  test("never double-posts within 30 minutes of the previous nudge", () => {
    expect(
      shouldNudge({
        nowMs: now,
        latestActivityMs: now - 90 * MIN,
        lastNudgedAtMs: now - 10 * MIN,
      }),
    ).toBe(false);
    expect(
      shouldNudge({
        nowMs: now,
        latestActivityMs: now - 90 * MIN,
        lastNudgedAtMs: now - 31 * MIN,
      }),
    ).toBe(true);
  });
});

describe("buildDevboxEventMessage", () => {
  const args = {
    taskId: "task-123",
    title: "Fix login bug",
    summary: "Cloned the repo and started investigating.",
    monitorUrl: "http://devbox-1.tail1234.ts.net:8787/",
  };

  test("started includes the monitoring link", () => {
    const msg = buildDevboxEventMessage({ ...args, type: "started" });
    expect(msg).toContain("http://devbox-1.tail1234.ts.net:8787/");
    expect(msg).toContain("Fix login bug");
    expect(msg).toContain(args.summary);
  });

  test("needs_input is actionable: tells the user where to respond", () => {
    const msg = buildDevboxEventMessage({ ...args, type: "needs_input" });
    expect(msg).toContain("http://devbox-1.tail1234.ts.net:8787/");
    expect(msg.toLowerCase()).toContain("input");
  });

  test("completed and failed state the outcome explicitly", () => {
    expect(
      buildDevboxEventMessage({ ...args, type: "completed" }).toLowerCase(),
    ).toContain("completed");
    expect(
      buildDevboxEventMessage({ ...args, type: "failed" }).toLowerCase(),
    ).toContain("failed");
  });

  test("omits the link gracefully when the gateway URL was unparseable", () => {
    const msg = buildDevboxEventMessage({
      ...args,
      monitorUrl: null,
      type: "started",
    });
    expect(msg).not.toContain("null");
    expect(msg).toContain("Fix login bug");
  });
});
