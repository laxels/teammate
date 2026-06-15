import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
  BrowserError,
  BrowserSession,
  findChrome,
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
    await session.navigate(`${base}/counter`);
    const state = await session.state();
    expect(state.title).toBe("Counter");
  }, 30_000);
});
