import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";

// Playwright-backed control of a dedicated Chrome instance. The browser is
// launched by this process over a stdio pipe (--remote-debugging-pipe) rather
// than attached over CDP: playwright-core's bundled WebSocket client never
// completes its HTTP upgrade under Bun, while the pipe transport works.
//
// The instance is headed on devboxes, so it appears on the desktop where the
// VNC viewer and the pixel computer-use tools can also reach it, and it uses a
// persistent profile so logins survive across tasks and gateway restarts.

/** Element targets come from ariaSnapshot(mode:"ai") refs, e.g. "e12". */
export type TabInfo = {
  index: number;
  active: boolean;
  title: string;
  url: string;
};

export type PageState = {
  url: string;
  title: string;
  tabs: TabInfo[];
  /** ariaSnapshot(mode:"ai") of the active tab, refs included. */
  snapshot: string;
};

export type BrowserScreenshot = {
  base64: string;
  width: number;
  height: number;
};

export type ConsoleMessage = { type: string; text: string };

export type ClickOptions = {
  button?: "left" | "right" | "middle";
  doubleClick?: boolean;
  modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
};

export type TypeOptions = { submit?: boolean; slowly?: boolean };

export type WaitForOptions = {
  text?: string;
  textGone?: string;
  seconds?: number;
};

export type BrowserSessionOptions = {
  /** Defaults to findChrome(). */
  executablePath?: string;
  /** Defaults to ~/.ultraclaude/chrome-profile (persists logins). */
  profileDir?: string;
  /** Headed by default so the desktop/VNC shows the window. */
  headless?: boolean;
  actionTimeoutMs?: number;
};

export class BrowserError extends Error {}

const DEFAULT_PROFILE_DIR = join(homedir(), ".ultraclaude", "chrome-profile");
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATE_TIMEOUT_MS = 30_000;
/** Post-navigate grace for the load event; SPAs may never fire it. */
const LOAD_SETTLE_TIMEOUT_MS = 5_000;
/** Post-action delay before the verification snapshot (renders, transitions). */
const SETTLE_MS = 300;
const MAX_CONSOLE_MESSAGES = 200;
const MAX_WAIT_SECONDS = 30;
/** The API rejects images beyond 8000px; refuse before wedging the session. */
const MAX_IMAGE_EDGE = 7_900;

const DARWIN_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const LINUX_CHROME_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium-browser",
  "chromium",
];

export function findChrome(): string | null {
  if (process.platform === "darwin") {
    return DARWIN_CHROME_PATHS.find((path) => existsSync(path)) ?? null;
  }
  for (const command of LINUX_CHROME_COMMANDS) {
    const path = Bun.which(command);
    if (path !== null) return path;
  }
  return null;
}

export class BrowserSession {
  #executablePath: string | null;
  #profileDir: string;
  #headless: boolean;
  #actionTimeoutMs: number;
  #contextPromise: Promise<BrowserContext> | null = null;
  #activePage: Page | null = null;
  #consoleBuffers = new WeakMap<Page, ConsoleMessage[]>();

  constructor(options: BrowserSessionOptions = {}) {
    this.#executablePath = options.executablePath ?? null;
    this.#profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
    this.#headless = options.headless ?? false;
    this.#actionTimeoutMs = options.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
  }

  async navigate(url: string): Promise<void> {
    const page = await this.#ensurePage();
    await page.goto(url, {
      timeout: NAVIGATE_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForLoadState("load", { timeout: LOAD_SETTLE_TIMEOUT_MS })
      .catch(() => {});
  }

  async navigateBack(): Promise<void> {
    const page = await this.#ensurePage();
    const response = await page.goBack({
      timeout: NAVIGATE_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    if (response === null && page.url() === "about:blank") {
      throw new BrowserError("No previous page in this tab's history.");
    }
  }

  async state(): Promise<PageState> {
    const page = await this.#ensurePage();
    const snapshot = await page.ariaSnapshot({
      mode: "ai",
      timeout: this.#actionTimeoutMs,
    });
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      tabs: await this.tabList(),
      snapshot,
    };
  }

  async click(ref: string, options: ClickOptions = {}): Promise<void> {
    await this.#withRef(ref, async (locator) => {
      const clickOptions = {
        timeout: this.#actionTimeoutMs,
        ...(options.button !== undefined ? { button: options.button } : {}),
        ...(options.modifiers !== undefined
          ? { modifiers: options.modifiers }
          : {}),
      };
      if (options.doubleClick === true) {
        await locator.dblclick(clickOptions);
      } else {
        await locator.click(clickOptions);
      }
    });
  }

  async type(
    ref: string,
    text: string,
    options: TypeOptions = {},
  ): Promise<void> {
    await this.#withRef(ref, async (locator) => {
      if (options.slowly === true) {
        await locator.pressSequentially(text, {
          timeout: this.#actionTimeoutMs,
          delay: 50,
        });
      } else {
        await locator.fill(text, { timeout: this.#actionTimeoutMs });
      }
      if (options.submit === true) {
        await locator.press("Enter", { timeout: this.#actionTimeoutMs });
      }
    });
  }

  async pressKey(key: string): Promise<void> {
    const page = await this.#ensurePage();
    await page.keyboard.press(key);
  }

  async hover(ref: string): Promise<void> {
    await this.#withRef(ref, (locator) =>
      locator.hover({ timeout: this.#actionTimeoutMs }),
    );
  }

  async selectOption(ref: string, values: string[]): Promise<void> {
    await this.#withRef(ref, async (locator) => {
      await locator.selectOption(values, { timeout: this.#actionTimeoutMs });
    });
  }

  /**
   * Evaluate a JavaScript expression in the active tab. Promises are awaited;
   * the result must survive structured cloning back out of the page.
   */
  async evaluate(expression: string): Promise<unknown> {
    const page = await this.#ensurePage();
    return await page.evaluate(expression);
  }

  async waitFor(options: WaitForOptions): Promise<void> {
    if (
      options.text === undefined &&
      options.textGone === undefined &&
      options.seconds === undefined
    ) {
      throw new BrowserError(
        "wait_for needs at least one of: text, text_gone, seconds.",
      );
    }
    const page = await this.#ensurePage();
    if (options.text !== undefined) {
      await page
        .getByText(options.text)
        .first()
        .waitFor({ state: "visible", timeout: this.#actionTimeoutMs });
    }
    if (options.textGone !== undefined) {
      await page
        .getByText(options.textGone)
        .first()
        .waitFor({ state: "hidden", timeout: this.#actionTimeoutMs });
    }
    if (options.seconds !== undefined) {
      const capped = Math.min(options.seconds, MAX_WAIT_SECONDS);
      await new Promise((resolve) => setTimeout(resolve, capped * 1000));
    }
  }

  async screenshot(
    options: { fullPage?: boolean } = {},
  ): Promise<BrowserScreenshot> {
    const page = await this.#ensurePage();
    const buffer = await page.screenshot({
      type: "png",
      scale: "css",
      timeout: this.#actionTimeoutMs,
      ...(options.fullPage === true ? { fullPage: true } : {}),
    });
    // PNG IHDR: width/height live at fixed offsets after the 8-byte signature.
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
      throw new BrowserError(
        `Screenshot is ${width}x${height}px, beyond the ${MAX_IMAGE_EDGE}px limit the API accepts — retake without full_page.`,
      );
    }
    return { base64: buffer.toString("base64"), width, height };
  }

  async tabList(): Promise<TabInfo[]> {
    const context = await this.#ensureContext();
    const active = this.#pickActive(context);
    return await Promise.all(
      context.pages().map(async (page, index) => ({
        index,
        active: page === active,
        title: await page.title().catch(() => ""),
        url: page.url(),
      })),
    );
  }

  async newTab(url?: string): Promise<void> {
    const context = await this.#ensureContext();
    this.#activePage = await context.newPage();
    if (url !== undefined) {
      await this.navigate(url);
    }
  }

  async selectTab(index: number): Promise<void> {
    const context = await this.#ensureContext();
    const page = context.pages()[index];
    if (page === undefined) {
      throw new BrowserError(
        `No tab at index ${index} (${context.pages().length} tabs open).`,
      );
    }
    await page.bringToFront();
    this.#activePage = page;
  }

  async closeTab(index?: number): Promise<void> {
    const context = await this.#ensureContext();
    const page =
      index === undefined ? await this.#ensurePage() : context.pages()[index];
    if (page === undefined) {
      throw new BrowserError(
        `No tab at index ${index} (${context.pages().length} tabs open).`,
      );
    }
    await page.close();
    if (this.#activePage === page) {
      this.#activePage = null;
    }
  }

  /** Console + uncaught-error log of the active tab (oldest first). */
  async consoleMessages(onlyErrors = false): Promise<ConsoleMessage[]> {
    const page = await this.#ensurePage();
    const buffer = this.#consoleBuffers.get(page) ?? [];
    return onlyErrors
      ? buffer.filter((message) => message.type === "error")
      : [...buffer];
  }

  /** Let the page react to an action before the verification snapshot. */
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }

  async close(): Promise<void> {
    const pending = this.#contextPromise;
    this.#contextPromise = null;
    this.#activePage = null;
    if (pending !== null) {
      const context = await pending.catch(() => null);
      if (context !== null) {
        await context.close().catch(() => {});
      }
    }
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#contextPromise === null) {
      this.#contextPromise = this.#launchWithRecovery().catch((error) => {
        this.#contextPromise = null;
        throw error;
      });
    }
    return await this.#contextPromise;
  }

  async #launchWithRecovery(): Promise<BrowserContext> {
    try {
      return await this.#launch();
    } catch (firstError) {
      // A gateway killed without cleanup (SIGKILL, crash) can leave an
      // orphaned Chrome holding the profile's ProcessSingleton lock, which
      // makes every subsequent launch fail. Evict it and retry once.
      this.#clearProfileLock();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        return await this.#launch();
      } catch {
        throw firstError;
      }
    }
  }

  async #launch(): Promise<BrowserContext> {
    const executablePath = this.#executablePath ?? findChrome();
    if (executablePath === null) {
      throw new BrowserError(
        "No Chrome or Chromium executable found on this machine.",
      );
    }
    mkdirSync(this.#profileDir, { recursive: true });
    const context = await chromium.launchPersistentContext(this.#profileDir, {
      executablePath,
      headless: this.#headless,
      // Pages use the real window size, matching what VNC users see.
      viewport: null,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
        // Disable the Media Router (Cast/DIAL). At startup it fires mDNS/SSDP
        // multicast onto the LAN, which on macOS Sequoia trips the "Allow bun
        // to find devices on local networks?" prompt — attributed to the
        // gateway (the bun process that spawned Chrome) and left hanging on
        // the headless desktop, stalling the task. We never cast, so killing
        // discovery removes the only LAN traffic Chrome makes at launch. macOS
        // has no supported way to pre-grant Local Network access (it's a
        // Network Extension policy keyed by signing identifier, NOT a TCC
        // service, so scripts/seed-devbox-tcc.sh can't grant it), which makes
        // suppressing the trigger the robust fix; a manually-baked grant is
        // the documented fallback (see scripts/bake-golden.sh). (#93)
        "--disable-features=MediaRouter",
      ],
    });
    for (const page of context.pages()) {
      this.#hookPage(page);
    }
    context.on("page", (page) => this.#hookPage(page));
    // Chrome quitting out from under us (VNC user, crash) must not strand the
    // session: drop the handle so the next tool call relaunches.
    context.on("close", () => {
      this.#contextPromise = null;
      this.#activePage = null;
    });
    return context;
  }

  #clearProfileLock(): void {
    Bun.spawnSync(["pkill", "-f", `user-data-dir=${this.#profileDir}`]);
    for (const name of [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ]) {
      rmSync(join(this.#profileDir, name), { force: true });
    }
  }

  #hookPage(page: Page): void {
    const buffer: ConsoleMessage[] = [];
    this.#consoleBuffers.set(page, buffer);
    const push = (message: ConsoleMessage) => {
      buffer.push(message);
      if (buffer.length > MAX_CONSOLE_MESSAGES) {
        buffer.shift();
      }
    };
    page.on("console", (message) =>
      push({ type: message.type(), text: message.text() }),
    );
    page.on("pageerror", (error) =>
      push({ type: "error", text: String(error) }),
    );
  }

  #pickActive(context: BrowserContext): Page | null {
    if (this.#activePage !== null && !this.#activePage.isClosed()) {
      return this.#activePage;
    }
    this.#activePage = context.pages().at(-1) ?? null;
    return this.#activePage;
  }

  async #ensurePage(): Promise<Page> {
    const context = await this.#ensureContext();
    const existing = this.#pickActive(context);
    if (existing !== null) {
      return existing;
    }
    const page = await context.newPage();
    this.#activePage = page;
    return page;
  }

  async #withRef(
    ref: string,
    run: (locator: ReturnType<Page["locator"]>) => Promise<unknown>,
  ): Promise<void> {
    const page = await this.#ensurePage();
    try {
      await run(page.locator(`aria-ref=${ref}`));
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new BrowserError(
          `Ref "${ref}" was not actionable within ${this.#actionTimeoutMs}ms — it may be stale, hidden, or covered. Take a fresh browser_snapshot and retry with a current ref.`,
        );
      }
      throw error;
    }
  }
}
