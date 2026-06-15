import { describe, expect, test } from "bun:test";
import type {
  BrowserScreenshot,
  ConsoleMessage,
  PageState,
  TabInfo,
} from "../src/browser/executor";
import {
  type BrowserControl,
  createBrowserTools,
  MAX_SNAPSHOT_CHARS,
} from "../src/browser/mcp";

const TAB: TabInfo = {
  index: 0,
  active: true,
  title: "Example",
  url: "https://example.test/",
};

const STATE: PageState = {
  url: "https://example.test/",
  title: "Example",
  tabs: [TAB],
  snapshot: '- button "Go" [ref=e2]',
};

const SHOT: BrowserScreenshot = { base64: "QUJD", width: 800, height: 600 };

type FakeControl = {
  control: BrowserControl;
  log: string[];
};

function createFakeControl(
  overrides: Partial<BrowserControl> = {},
): FakeControl {
  const log: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      log.push(`${name}(${JSON.stringify(args)})`);
    };
  const control: BrowserControl = {
    navigate: record("navigate"),
    navigateBack: record("navigateBack"),
    state: async () => {
      log.push("state");
      return STATE;
    },
    click: record("click"),
    type: record("type"),
    pressKey: record("pressKey"),
    hover: record("hover"),
    selectOption: record("selectOption"),
    evaluate: async (expression: string) => {
      log.push(`evaluate(${JSON.stringify(expression)})`);
      return { ok: true };
    },
    waitFor: record("waitFor"),
    screenshot: async () => {
      log.push("screenshot");
      return SHOT;
    },
    tabList: async () => {
      log.push("tabList");
      return [TAB];
    },
    newTab: record("newTab"),
    selectTab: record("selectTab"),
    closeTab: record("closeTab"),
    consoleMessages: async (onlyErrors?: boolean) => {
      log.push(`consoleMessages(${onlyErrors === true})`);
      const messages: ConsoleMessage[] = [
        { type: "log", text: "hello" },
        { type: "error", text: "boom" },
      ];
      return onlyErrors === true
        ? messages.filter((m) => m.type === "error")
        : messages;
    },
    settle: async () => {
      log.push("settle");
    },
    ...overrides,
  };
  return { control, log };
}

type ToolResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
};

function findTool(tools: ReturnType<typeof createBrowserTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

async function call(
  tools: ReturnType<typeof createBrowserTools>,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  // Tools are a heterogeneous union, so handler's parameter collapses to
  // never; tests call handlers with args matching that tool's schema.
  return (await findTool(tools, name).handler(args as never, {})) as ToolResult;
}

/** Concatenate every text block of a result (the fallback hint is a separate
 * trailing block, so single-block assertions would miss it). */
function allText(result: ToolResult): string {
  return result.content.map((c) => String(c.text ?? "")).join("\n");
}

const FALLBACK_MARKER = "pixel computer-use";

describe("browser MCP tools", () => {
  test("exposes the expected tool surface", () => {
    const { control } = createFakeControl();
    const names = createBrowserTools(control).map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "browser_snapshot",
        "browser_navigate",
        "browser_navigate_back",
        "browser_click",
        "browser_type",
        "browser_press_key",
        "browser_hover",
        "browser_select_option",
        "browser_wait_for",
        "browser_evaluate",
        "browser_tabs",
        "browser_screenshot",
        "browser_console",
        "browser_batch",
      ].sort(),
    );
  });

  test("an action settles, then returns note + fresh page state", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_click", { ref: "e2" });

    expect(log).toEqual(['click(["e2",{}])', "settle", "state"]);
    expect(result.isError).toBeUndefined();
    const text = String(result.content[0]?.text);
    expect(text).toContain("Clicked e2.");
    expect(text).toContain("URL: https://example.test/");
    expect(text).toContain('- button "Go" [ref=e2]');
  });

  test("browser_snapshot returns page state without settling", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_snapshot", {});
    expect(log).toEqual(["state"]);
    const text = String(result.content[0]?.text);
    expect(text).toContain("### Page");
    expect(text).toContain('- button "Go" [ref=e2]');
  });

  test("the tab list is only included when more than one tab is open", async () => {
    const twoTabs: PageState = {
      ...STATE,
      tabs: [TAB, { index: 1, active: false, title: "", url: "about:blank" }],
    };
    const single = createFakeControl();
    const multi = createFakeControl({
      state: async () => twoTabs,
    });
    const singleResult = await call(
      createBrowserTools(single.control),
      "browser_snapshot",
      {},
    );
    const multiResult = await call(
      createBrowserTools(multi.control),
      "browser_snapshot",
      {},
    );
    expect(String(singleResult.content[0]?.text)).not.toContain("### Tabs");
    const multiText = String(multiResult.content[0]?.text);
    expect(multiText).toContain("### Tabs");
    expect(multiText).toContain("- 1: (untitled) — about:blank");
  });

  test("oversized snapshots are truncated", async () => {
    const { control } = createFakeControl({
      state: async () => ({
        ...STATE,
        snapshot: "x".repeat(MAX_SNAPSHOT_CHARS + 1000),
      }),
    });
    const result = await call(
      createBrowserTools(control),
      "browser_snapshot",
      {},
    );
    const text = String(result.content[0]?.text);
    expect(text).toContain("snapshot truncated");
    expect(text.length).toBeLessThan(MAX_SNAPSHOT_CHARS + 1000);
  });

  test("browser_evaluate reports the serialized result", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_evaluate", {
      expression: "1 + 1",
    });
    expect(log[0]).toBe('evaluate("1 + 1")');
    expect(String(result.content[0]?.text)).toContain('Result: {"ok":true}');
  });

  test("browser_screenshot returns the image without page state", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_screenshot", {});
    expect(log).toEqual(["screenshot"]);
    expect(result.content[0]?.text).toBe("Screenshot (800x600):");
    expect(result.content[1]).toEqual({
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    });
  });

  test("browser_console formats messages and respects only_errors", async () => {
    const { control } = createFakeControl();
    const tools = createBrowserTools(control);
    const all = await call(tools, "browser_console", {});
    expect(String(all.content[0]?.text)).toBe("[log] hello\n[error] boom");
    const errors = await call(tools, "browser_console", { only_errors: true });
    expect(String(errors.content[0]?.text)).toBe("[error] boom");
  });

  test("browser_tabs select requires an index", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_tabs", { action: "select" });
    expect(result.isError).toBe(true);
    expect(log).not.toContain("selectTab([0])");
  });

  test("executor failures become isError results with the message", async () => {
    const { control } = createFakeControl({
      click: async () => {
        throw new Error('Ref "e2" was not actionable within 10000ms');
      },
    });
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_click", { ref: "e2" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not actionable");
  });

  test("invalid arguments fail validation rather than reaching the executor", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_click", {
      ref: "e2",
      button: "fourth",
    });
    expect(result.isError).toBe(true);
    expect(log).toEqual([]);
  });

  test("browser_batch runs actions in order with one final snapshot", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_batch", {
      actions: [
        { action: "browser_type", ref: "e3", text: "hi" },
        { action: "browser_click", ref: "e2" },
      ],
    });

    expect(log).toEqual([
      'type(["e3","hi",{}])',
      'click(["e2",{}])',
      "settle",
      "state",
    ]);
    expect(result.isError).toBeUndefined();
    const text = String(result.content[0]?.text);
    expect(text).toContain("1. Typed 2 characters into e3.");
    expect(text).toContain("2. Clicked e2.");
    expect(text).toContain("### Page snapshot");
  });

  test("browser_batch stops at the first failure and reports the step", async () => {
    const { control, log } = createFakeControl({
      type: async () => {
        throw new Error("element detached");
      },
    });
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_batch", {
      actions: [
        { action: "browser_click", ref: "e2" },
        { action: "browser_type", ref: "e3", text: "hi" },
        { action: "browser_press_key", key: "Enter" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(log).not.toContain('pressKey(["Enter"])');
    const text = String(result.content[0]?.text);
    expect(text).toContain("1. Clicked e2.");
    expect(text).toContain("FAILED at step 2: element detached");
    // Still appends fresh page state so the model can re-orient.
    expect(text).toContain("### Page snapshot");
  });

  test("browser_batch validates each item against its action schema", async () => {
    const { control, log } = createFakeControl();
    const tools = createBrowserTools(control);
    const result = await call(tools, "browser_batch", {
      actions: [{ action: "browser_click" }],
    });
    expect(result.isError).toBe(true);
    expect(log).not.toContain('click(["e2",{}])');
  });

  test("a single action failure does not yet nudge toward computer use", async () => {
    const { control } = createFakeControl({
      click: async () => {
        throw new Error("not actionable");
      },
    });
    const tools = createBrowserTools(control);
    const first = await call(tools, "browser_click", { ref: "e2" });
    expect(first.isError).toBe(true);
    expect(allText(first)).toContain("not actionable");
    expect(allText(first)).not.toContain(FALLBACK_MARKER);
  });

  test("repeated action failures append a computer-use fallback hint", async () => {
    const { control } = createFakeControl({
      click: async () => {
        throw new Error("not actionable");
      },
    });
    const tools = createBrowserTools(control);
    await call(tools, "browser_click", { ref: "e2" });
    const second = await call(tools, "browser_click", { ref: "e2" });
    expect(second.isError).toBe(true);
    expect(allText(second)).toContain(FALLBACK_MARKER);
  });

  test("a successful action resets the fallback-hint counter", async () => {
    let shouldFail = true;
    const { control } = createFakeControl({
      click: async () => {
        if (shouldFail) throw new Error("not actionable");
      },
    });
    const tools = createBrowserTools(control);
    await call(tools, "browser_click", { ref: "e2" }); // failure #1
    shouldFail = false;
    const ok = await call(tools, "browser_click", { ref: "e2" }); // success -> reset
    expect(ok.isError).toBeUndefined();
    shouldFail = true;
    const next = await call(tools, "browser_click", { ref: "e2" }); // failure #1 again
    expect(next.isError).toBe(true);
    expect(allText(next)).not.toContain(FALLBACK_MARKER);
  });

  test("read-only calls do not reset the fallback-hint counter", async () => {
    const { control } = createFakeControl({
      click: async () => {
        throw new Error("not actionable");
      },
    });
    const tools = createBrowserTools(control);
    await call(tools, "browser_click", { ref: "e2" }); // failure #1
    await call(tools, "browser_snapshot", {}); // re-orient, must not reset
    const second = await call(tools, "browser_click", { ref: "e2" }); // failure #2
    expect(allText(second)).toContain(FALLBACK_MARKER);
  });

  test("repeated browser_batch failures also drive the fallback hint", async () => {
    const { control } = createFakeControl({
      type: async () => {
        throw new Error("element detached");
      },
    });
    const tools = createBrowserTools(control);
    const actions = [{ action: "browser_type", ref: "e3", text: "hi" }];
    const first = await call(tools, "browser_batch", { actions });
    expect(first.isError).toBe(true);
    expect(allText(first)).not.toContain(FALLBACK_MARKER);
    const second = await call(tools, "browser_batch", { actions });
    expect(second.isError).toBe(true);
    expect(allText(second)).toContain(FALLBACK_MARKER);
  });
});
