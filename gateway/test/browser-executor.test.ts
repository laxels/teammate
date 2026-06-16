import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  BrowserError,
  BrowserSession,
  findChrome,
  type ManualBrowserProcess,
} from "../src/browser/executor";

// Integration tests against a real headless Chrome (the same binary the
// devbox uses). Skipped when no Chrome/Chromium is installed; CI runners and
// dev machines have one.
const hasChrome = findChrome() !== null;

const PAGES: Record<string, string> = {
  "/counter": `<!doctype html><title>Counter</title>
    <h1>Counter</h1>
    <script>window.n = 0;</script>
    <button onclick="document.getElementById('out').textContent = 'count: ' + (++window.n)">Increment</button>
    <select onchange="document.getElementById('pick').textContent = 'pet: ' + this.value">
      <option value="">choose</option>
      <option value="dog">Dog</option>
      <option value="cat">Cat</option>
    </select>
    <div onmouseover="this.textContent = 'hovered!'">hover me</div>
    <div id="out">count: 0</div>
    <div id="pick"></div>
    <a href="/form">go to form</a>`,
  "/form": `<!doctype html><title>Form</title>
    <form action="/greet" method="get">
      <input name="q" placeholder="Query">
      <button type="submit">Search</button>
    </form>`,
  "/slow": `<!doctype html><title>Slow</title>
    <div id="status">Loading...</div>
    <script>setTimeout(() => { document.getElementById('status').textContent = 'Loaded!'; }, 600);</script>`,
  "/console": `<!doctype html><title>Console</title>
    <h1>Console page</h1>
    <script>
      console.log("hello log");
      console.error("bad thing");
      setTimeout(() => { throw new Error("uncaught boom"); }, 50);
    </script>`,
};

describe.skipIf(!hasChrome)("BrowserSession (real Chrome)", () => {
  let session: BrowserSession;
  let server: Server<undefined>;
  let base: string;
  let profileDir: string;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "browser-session-test-"));
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const page = PAGES[url.pathname];
        if (page !== undefined) {
          return new Response(page, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.pathname === "/greet") {
          const q = url.searchParams.get("q") ?? "";
          return new Response(
            `<!doctype html><title>Greet</title><h1>Hello ${q}</h1>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    session = new BrowserSession({
      headless: true,
      profileDir,
      actionTimeoutMs: 3_000,
    });
    // Pay the one-time cold Chrome launch here, in fixture setup, rather than
    // inside the first test's timed budget. The launch is an order of magnitude
    // slower than any warmed-up operation, and on contended CI runners it can
    // approach a 20s per-test timeout — flaking whichever test happens to run
    // first while every later test stays fast (#46). The generous hook timeout
    // absorbs a slow launch without masking a genuinely slow operation.
    await session.navigate("about:blank");
  }, 60_000);

  afterAll(async () => {
    await session.close();
    server.stop(true);
    rmSync(profileDir, { recursive: true, force: true });
  });

  function refFor(snapshot: string, pattern: RegExp): string {
    const match = pattern.exec(snapshot);
    if (match?.[1] === undefined) {
      throw new Error(`no ref matching ${pattern} in snapshot:\n${snapshot}`);
    }
    return match[1];
  }

  test("navigate exposes the page as an aria snapshot with refs", async () => {
    await session.navigate(`${base}/counter`);
    const state = await session.state();
    expect(state.url).toBe(`${base}/counter`);
    expect(state.title).toBe("Counter");
    expect(state.snapshot).toContain('button "Increment"');
    expect(state.snapshot).toContain("[ref=");
  }, 20_000);

  test("click by ref drives the page", async () => {
    await session.navigate(`${base}/counter`);
    const { snapshot } = await session.state();
    const buttonRef = refFor(snapshot, /button "Increment" \[ref=(e\d+)\]/);
    await session.click(buttonRef);
    await session.click(buttonRef);
    const after = await session.state();
    expect(after.snapshot).toContain("count: 2");
  }, 20_000);

  test("type with submit fills the field and submits the form", async () => {
    await session.navigate(`${base}/form`);
    const { snapshot } = await session.state();
    const inputRef = refFor(snapshot, /textbox "Query" \[ref=(e\d+)\]/);
    await session.type(inputRef, "hello world", { submit: true });
    await session.waitFor({ text: "Hello hello world" });
    const after = await session.state();
    expect(after.url).toContain("/greet?q=hello+world");
  }, 20_000);

  test("selectOption picks by value and fires change handlers", async () => {
    await session.navigate(`${base}/counter`);
    const { snapshot } = await session.state();
    const selectRef = refFor(snapshot, /combobox \[ref=(e\d+)\]/);
    await session.selectOption(selectRef, ["cat"]);
    const after = await session.state();
    expect(after.snapshot).toContain("pet: cat");
  }, 20_000);

  test("hover triggers mouseover handlers", async () => {
    await session.navigate(`${base}/counter`);
    const { snapshot } = await session.state();
    const hoverRef = refFor(snapshot, /\[ref=(e\d+)\]: hover me/);
    await session.hover(hoverRef);
    const after = await session.state();
    expect(after.snapshot).toContain("hovered!");
  }, 20_000);

  test("pressKey types into the focused element", async () => {
    await session.navigate(`${base}/form`);
    const { snapshot } = await session.state();
    const inputRef = refFor(snapshot, /textbox "Query" \[ref=(e\d+)\]/);
    await session.click(inputRef);
    await session.pressKey("X");
    const value = await session.evaluate(
      "document.querySelector('input').value",
    );
    expect(value).toBe("X");
  }, 20_000);

  test("evaluate returns structured-cloneable results, awaiting promises", async () => {
    await session.navigate(`${base}/counter`);
    expect(await session.evaluate("2 + 2")).toBe(4);
    expect(await session.evaluate("(() => ({ n: 1 + 1 }))()")).toEqual({
      n: 2,
    });
    expect(await session.evaluate("Promise.resolve('done')")).toBe("done");
  }, 20_000);

  test("waitFor text appearing and disappearing", async () => {
    await session.navigate(`${base}/slow`);
    await session.waitFor({ text: "Loaded!" });
    await session.waitFor({ textGone: "Loading..." });
    const state = await session.state();
    expect(state.snapshot).toContain("Loaded!");
  }, 20_000);

  test("navigateBack returns to the previous page", async () => {
    await session.navigate(`${base}/counter`);
    await session.navigate(`${base}/form`);
    await session.navigateBack();
    const state = await session.state();
    expect(state.url).toBe(`${base}/counter`);
  }, 20_000);

  test("tab management: open, select, close", async () => {
    await session.navigate(`${base}/counter`);
    await session.newTab(`${base}/form`);
    let tabs = await session.tabList();
    expect(tabs.length).toBe(2);
    expect(tabs[1]?.active).toBe(true);
    expect(tabs[1]?.title).toBe("Form");

    await session.selectTab(0);
    tabs = await session.tabList();
    expect(tabs[0]?.active).toBe(true);
    const state = await session.state();
    expect(state.title).toBe("Counter");

    await session.closeTab(1);
    tabs = await session.tabList();
    expect(tabs.length).toBe(1);
    expect(tabs[0]?.title).toBe("Counter");
  }, 20_000);

  test("a stale ref fails with guidance instead of a bare timeout", async () => {
    await session.navigate(`${base}/counter`);
    await session.state();
    expect(session.click("e999")).rejects.toThrow(BrowserError);
    try {
      await session.click("e999");
    } catch (error) {
      expect((error as Error).message).toContain("browser_snapshot");
    }
  }, 20_000);

  test("screenshot returns a PNG with its dimensions", async () => {
    await session.navigate(`${base}/counter`);
    const shot = await session.screenshot();
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    const bytes = Buffer.from(shot.base64, "base64");
    // PNG signature
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
  }, 20_000);

  test("console messages and uncaught errors are captured per tab", async () => {
    await session.navigate(`${base}/console`);
    await session.waitFor({ seconds: 0.5 });
    const all = await session.consoleMessages();
    expect(all.some((m) => m.type === "log" && m.text === "hello log")).toBe(
      true,
    );
    const errors = await session.consoleMessages(true);
    expect(errors.some((m) => m.text.includes("bad thing"))).toBe(true);
    expect(errors.some((m) => m.text.includes("uncaught boom"))).toBe(true);
    expect(errors.every((m) => m.type === "error")).toBe(true);
  }, 20_000);

  test("close() then next use relaunches on the same profile", async () => {
    await session.close();
    // This relaunch is a second cold Chrome launch — the beforeAll warm-up
    // can't amortize it because the test's whole point is to close and relaunch.
    // Give it the same generous budget the warm-up uses so the #46 flake class
    // can't resurface here (a cold launch can approach 20s on a contended runner,
    // more if #launchWithRecovery needs its retry).
    await session.navigate(`${base}/counter`);
    const state = await session.state();
    expect(state.title).toBe("Counter");
  }, 60_000);
});

// Unit tests of the non-automated-browser handoff (#117). The spawned Chrome is
// stubbed via the injected launcher, so these run without a real browser and
// assert the exact contract that makes the window non-automated: the same
// persistent profile (so logins carry over) and a command line free of every
// automation tell.
describe("BrowserSession.launchManual", () => {
  // Flags/instrumentation that mark Chrome as automated — exactly what a
  // non-automated handoff window must NOT carry, or the site's bot detection
  // defeats the point of the handoff.
  const AUTOMATION_TELLS =
    /enable-automation|remote-debugging|--headless|webdriver|--load-extension/;
  const FAKE_CHROME =
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  let profileDir: string;

  beforeEach(() => {
    profileDir = mkdtempSync(join(tmpdir(), "ultraclaude-profile-"));
  });
  afterEach(() => {
    rmSync(profileDir, { recursive: true, force: true });
  });

  function recordingLauncher(): {
    launch: (command: string[]) => ManualBrowserProcess;
    commands: string[][];
    kills: number[];
  } {
    const commands: string[][] = [];
    const kills: number[] = [];
    const launch = (command: string[]): ManualBrowserProcess => {
      const index = commands.length;
      commands.push(command);
      return {
        kill: () => {
          kills.push(index);
        },
      };
    };
    return { launch, commands, kills };
  }

  function sessionWith(launch: (command: string[]) => ManualBrowserProcess) {
    return new BrowserSession({
      executablePath: FAKE_CHROME,
      profileDir,
      launchManualProcess: launch,
    });
  }

  test("opens a non-automated Chrome on the same profile, no automation flags", async () => {
    const rec = recordingLauncher();
    await sessionWith(rec.launch).launchManual(
      "https://accounts.google.com/signin",
    );

    expect(rec.commands).toHaveLength(1);
    const argv = rec.commands[0] ?? [];
    // Same binary, same persistent profile -> the manual window inherits the
    // automation profile's cookies/logins.
    expect(argv[0]).toBe(FAKE_CHROME);
    expect(argv).toContain(`--user-data-dir=${profileDir}`);
    // The requested URL is opened (last positional arg).
    expect(argv.at(-1)).toBe("https://accounts.google.com/signin");
    // The crux: nothing on the command line marks the browser as automated.
    expect(argv.some((arg) => AUTOMATION_TELLS.test(arg))).toBe(false);
  });

  test("without a url, opens no page", async () => {
    const rec = recordingLauncher();
    await sessionWith(rec.launch).launchManual();

    const argv = rec.commands[0] ?? [];
    expect(argv).toContain(`--user-data-dir=${profileDir}`);
    // No positional URL argument — every entry past the binary is a flag.
    expect(argv.every((arg, i) => i === 0 || arg.startsWith("--"))).toBe(true);
  });

  test("rejects a non-http(s) url instead of letting Chrome read it as a flag", async () => {
    const rec = recordingLauncher();
    const session = sessionWith(rec.launch);

    // A leading-dash value would otherwise reach argv, where Chrome parses it as
    // a switch — e.g. reintroducing the very automation fingerprint this handoff
    // is supposed to strip.
    await expect(session.launchManual("--enable-automation")).rejects.toThrow(
      BrowserError,
    );
    // Non-web schemes are out too (no javascript:/file:/data: into the window).
    await expect(session.launchManual("file:///etc/passwd")).rejects.toThrow(
      BrowserError,
    );
    await expect(session.launchManual("not a url")).rejects.toThrow(
      BrowserError,
    );

    // A rejected url tears nothing down and launches nothing.
    expect(rec.commands).toHaveLength(0);
  });

  test("a validated url is passed after a -- end-of-switches separator", async () => {
    const rec = recordingLauncher();
    await sessionWith(rec.launch).launchManual(
      "https://accounts.google.com/signin",
    );

    const argv = rec.commands[0] ?? [];
    const sep = argv.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    // Everything after "--" is positional, so the URL can't be read as a switch.
    expect(argv.slice(sep + 1)).toEqual(["https://accounts.google.com/signin"]);
  });

  test("a second handoff replaces the first window", async () => {
    const rec = recordingLauncher();
    const session = sessionWith(rec.launch);
    await session.launchManual();
    await session.launchManual();

    // Two windows launched; the first was killed before the second opened, so
    // only one Chrome ever holds the profile at a time.
    expect(rec.commands).toHaveLength(2);
    expect(rec.kills).toEqual([0]);
  });

  test("close() kills an open manual window", async () => {
    const rec = recordingLauncher();
    const session = sessionWith(rec.launch);
    await session.launchManual();
    await session.close();

    expect(rec.kills).toEqual([0]);
  });
});
