import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS executor for the computer-use MCP tools: screenshots via
// `screencapture`, mouse/keyboard via `cliclick` (with `osascript` for
// modifier chords and the few events cliclick cannot synthesize). Runs inside
// the devbox VM; needs one-time Screen Recording + Accessibility TCC grants,
// baked into the golden image.
//
// Three coordinate spaces are in play:
// - model space: pixels in the (possibly downscaled) screenshot sent to the
//   model — every coordinate the model produces is in this space.
// - pixel space: physical pixels of the raw `screencapture` output.
// - point space: what CGEvent-based input (cliclick) consumes. On the 1x
//   virtual displays of Virtualization.framework guests points == pixels; on
//   Retina hosts they differ by the backing scale factor, so the mapping is
//   measured, never assumed.

export type RunResult = { stdout: string; stderr: string; exitCode: number };
export type CommandRunner = (cmd: string[]) => Promise<RunResult>;

export type Screenshot = {
  base64: string;
  /** Dimensions of the returned image == the model coordinate space. */
  width: number;
  height: number;
};

export type DisplayInfo = {
  modelWidth: number;
  modelHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  pointWidth: number;
  pointHeight: number;
};

export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Images larger than 1568px on the long edge are silently downscaled by the
 * API, desyncing the model's coordinates from the screen — so we downscale
 * ourselves and keep the mapping. (Opus 4.7+ documents 2576px with 1:1
 * coordinates; raise this once that behavior is verified for Opus 4.8 on the
 * devbox display.)
 */
export const MAX_LONG_EDGE = 1568;
/** UI settle time between an input action and its verification screenshot. */
export const SETTLE_MS = 500;
/** cliclick types long strings unreliably in one shot; chunk like xdotool. */
export const TYPE_CHUNK_SIZE = 50;
const MAX_WAIT_SECONDS = 30;
/** One scroll_amount "click" ≈ 3 wheel lines (xdotool convention). */
const SCROLL_LINES_PER_CLICK = 3;

export class ExecutorError extends Error {}

async function defaultRunner(cmd: string[]): Promise<RunResult> {
  const [bin, ...args] = cmd;
  if (bin === undefined) throw new ExecutorError("empty command");
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

export function computeScale(
  pixelWidth: number,
  pixelHeight: number,
  maxLongEdge: number = MAX_LONG_EDGE,
): number {
  const longEdge = Math.max(pixelWidth, pixelHeight);
  if (longEdge <= 0) return 1;
  return Math.min(1, maxLongEdge / longEdge);
}

/** Map a model-space coordinate to screen points for input synthesis. */
export function modelToPoints(
  [x, y]: readonly [number, number],
  info: DisplayInfo,
): [number, number] {
  const pixelX = (x * info.pixelWidth) / info.modelWidth;
  const pixelY = (y * info.pixelHeight) / info.modelHeight;
  return [
    Math.round((pixelX * info.pointWidth) / info.pixelWidth),
    Math.round((pixelY * info.pointHeight) / info.pixelHeight),
  ];
}

// ---- Key handling -----------------------------------------------------------

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: "cmd",
  command: "cmd",
  super: "cmd",
  meta: "cmd",
  win: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  fn: "fn",
};

// xdotool-style names (as the model emits them) -> cliclick `kp:` names.
const NAMED_KEYS: Record<string, string> = {
  return: "return",
  enter: "enter",
  esc: "esc",
  escape: "esc",
  tab: "tab",
  space: "space",
  delete: "delete",
  backspace: "delete",
  forwarddelete: "fwd-delete",
  home: "home",
  end: "end",
  pageup: "page-up",
  pagedown: "page-down",
  up: "arrow-up",
  down: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  arrowup: "arrow-up",
  arrowdown: "arrow-down",
  arrowleft: "arrow-left",
  arrowright: "arrow-right",
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`f${i + 1}`, `f${i + 1}`]),
  ),
};

export type KeyPress = {
  /** cliclick modifier names: cmd | ctrl | alt | shift | fn */
  modifiers: string[];
  key: { kind: "named"; name: string } | { kind: "char"; char: string };
};

/** Parse an xdotool-style key spec ("Return", "Page_Down", "super+s"). */
export function parseKeySpec(spec: string): KeyPress | null {
  const parts = spec
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const last = parts.pop();
  if (last === undefined) return null;

  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier === undefined) return null;
    modifiers.push(modifier);
  }

  const normalized = last.toLowerCase().replace(/[_-]/g, "");
  const named = NAMED_KEYS[normalized];
  if (named !== undefined)
    return { modifiers, key: { kind: "named", name: named } };
  if (last.length === 1)
    return { modifiers, key: { kind: "char", char: last } };
  return null;
}

export function parseModifierList(text: string): string[] | null {
  const modifiers: string[] = [];
  for (const part of text.split("+")) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (modifier === undefined) return null;
    modifiers.push(modifier);
  }
  return modifiers;
}

/** JXA: point size of the primary display (the one `screencapture` grabs). */
export const SCREEN_POINT_SIZE_SCRIPT =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: JXA source — the `${...}` is a template literal evaluated by the osascript/JXA runtime, not a JS substitution. Converting to a JS template string would break it.
  'ObjC.import("AppKit"); const size = $.NSScreen.screens.js[0].frame.size; `${size.width},${size.height}`;';

/** CGEventFlags modifier masks (CGEventTypes.h). */
export const CGEVENT_FLAGS: Record<string, number> = {
  cmd: 0x100000,
  shift: 0x20000,
  ctrl: 0x40000,
  alt: 0x80000,
};

/**
 * ANSI-US virtual keycodes (Carbon kVK_ANSI_*) for chord synthesis. Keycodes
 * are layout-positional; devbox images run the US layout.
 */
export const US_VIRTUAL_KEYCODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  o: 31,
  u: 32,
  "[": 33,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  "'": 39,
  k: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  n: 45,
  m: 46,
  ".": 47,
  "`": 50,
};

// ---- Executor ---------------------------------------------------------------

export type ExecutorDeps = {
  runner?: CommandRunner;
  readFile?: (path: string) => Promise<Uint8Array>;
  removeFile?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxLongEdge?: number;
  settleMs?: number;
  /** Absolute path: the gateway LaunchAgent's PATH lacks /usr/local/bin. */
  cliclickPath?: string;
};

export const DEFAULT_CLICLICK_PATH = "/usr/local/bin/cliclick";

export class ComputerExecutor {
  #run: CommandRunner;
  #readFile: (path: string) => Promise<Uint8Array>;
  #removeFile: (path: string) => Promise<void>;
  #sleep: (ms: number) => Promise<void>;
  #maxLongEdge: number;
  #settleMs: number;
  #cliclickPath: string;
  #display: DisplayInfo | null = null;
  #pointSize: [number, number] | null = null;
  #tempCounter = 0;

  constructor(deps: ExecutorDeps = {}) {
    this.#run = deps.runner ?? defaultRunner;
    this.#readFile =
      deps.readFile ?? (async (path) => await Bun.file(path).bytes());
    this.#removeFile =
      deps.removeFile ??
      (async (path) => {
        await unlink(path).catch(() => {});
      });
    this.#sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxLongEdge = deps.maxLongEdge ?? MAX_LONG_EDGE;
    this.#settleMs = deps.settleMs ?? SETTLE_MS;
    this.#cliclickPath = deps.cliclickPath ?? DEFAULT_CLICLICK_PATH;
  }

  displayInfo(): DisplayInfo | null {
    return this.#display;
  }

  async settle(): Promise<void> {
    await this.#sleep(this.#settleMs);
  }

  async screenshot(): Promise<Screenshot> {
    return await this.#capture([]);
  }

  /** Capture a model-space region at native resolution (the zoom action). */
  async zoom(
    region: readonly [number, number, number, number],
  ): Promise<Screenshot> {
    const display = await this.#requireDisplay();
    const [x1, y1, x2, y2] = region;
    if (x2 <= x1 || y2 <= y1) {
      throw new ExecutorError(
        `Invalid zoom region (${region.join(", ")}): x2/y2 must exceed x1/y1.`,
      );
    }
    this.#assertInBounds([x1, y1], display);
    this.#assertInBounds([x2, y2], display);
    const [px1, py1] = modelToPoints([x1, y1], display);
    const [px2, py2] = modelToPoints([x2, y2], display);
    return await this.#capture([
      "-R",
      `${px1},${py1},${Math.max(1, px2 - px1)},${Math.max(1, py2 - py1)}`,
    ]);
  }

  async leftClick(
    coordinate: readonly [number, number],
    modifiers?: string,
  ): Promise<void> {
    await this.#click("c", coordinate, modifiers);
  }

  async rightClick(
    coordinate: readonly [number, number],
    modifiers?: string,
  ): Promise<void> {
    await this.#click("rc", coordinate, modifiers);
  }

  async doubleClick(
    coordinate: readonly [number, number],
    modifiers?: string,
  ): Promise<void> {
    await this.#click("dc", coordinate, modifiers);
  }

  async tripleClick(
    coordinate: readonly [number, number],
    modifiers?: string,
  ): Promise<void> {
    await this.#click("tc", coordinate, modifiers);
  }

  /** cliclick has no middle-click; synthesize CGEvents via JXA. */
  async middleClick(coordinate: readonly [number, number]): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    const script = [
      'ObjC.import("CoreGraphics");',
      `const p = {x: ${x}, y: ${y}};`,
      "const d = $.CGEventCreateMouseEvent($(), $.kCGEventOtherMouseDown, p, 2);",
      "$.CGEventPost($.kCGHIDEventTap, d);",
      "const u = $.CGEventCreateMouseEvent($(), $.kCGEventOtherMouseUp, p, 2);",
      "$.CGEventPost($.kCGHIDEventTap, u);",
    ].join(" ");
    await this.#exec(["osascript", "-l", "JavaScript", "-e", script]);
  }

  async mouseMove(coordinate: readonly [number, number]): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    await this.#cliclick([`m:${x},${y}`]);
  }

  async mouseDown(coordinate: readonly [number, number]): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    await this.#cliclick([`dd:${x},${y}`]);
  }

  async mouseUp(coordinate: readonly [number, number]): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    await this.#cliclick([`du:${x},${y}`]);
  }

  async drag(
    start: readonly [number, number],
    end: readonly [number, number],
  ): Promise<void> {
    const [sx, sy] = await this.#toPoints(start);
    const [ex, ey] = await this.#toPoints(end);
    await this.#cliclick([
      `dd:${sx},${sy}`,
      "w:100",
      `dm:${ex},${ey}`,
      "w:100",
      `du:${ex},${ey}`,
    ]);
  }

  async typeText(text: string): Promise<void> {
    // cliclick `t:` posts unicode events; newlines must go through the
    // return key, and long strings are chunked for reliability.
    const commands: string[] = [];
    const lines = text.split("\n");
    lines.forEach((line, index) => {
      for (let i = 0; i < line.length; i += TYPE_CHUNK_SIZE) {
        commands.push(`t:${line.slice(i, i + TYPE_CHUNK_SIZE)}`);
      }
      if (index < lines.length - 1) commands.push("kp:return");
    });
    if (commands.length === 0) return;
    await this.#cliclick(commands);
  }

  async pressKey(spec: string): Promise<void> {
    const press = parseKeySpec(spec);
    if (press === null) {
      throw new ExecutorError(
        `Unrecognized key spec "${spec}". Use forms like "Return", "Page_Down", "super+s", "ctrl+shift+t".`,
      );
    }
    if (press.key.kind === "named") {
      const wrap = press.modifiers;
      await this.#cliclick([
        ...wrap.map((mod) => `kd:${mod}`),
        `kp:${press.key.name}`,
        ...wrap.map((mod) => `ku:${mod}`),
      ]);
      return;
    }
    if (press.modifiers.length === 0) {
      await this.#cliclick([`t:${press.key.char}`]);
      return;
    }
    // Character chords (cmd+s): cliclick's unicode typing ignores held
    // modifiers, and System Events needs an AppleEvents TCC grant that has
    // proven unreliable to pre-seed — post raw CGEvent keycodes instead,
    // which ride the same Accessibility grant as the rest of the executor.
    const keyCode = US_VIRTUAL_KEYCODES[press.key.char.toLowerCase()];
    if (keyCode === undefined) {
      throw new ExecutorError(
        `No keycode mapping for "${press.key.char}" in a chord. Use a letter/digit/punctuation key, or click the UI control instead.`,
      );
    }
    let flags =
      press.key.char !== press.key.char.toLowerCase()
        ? (CGEVENT_FLAGS.shift ?? 0)
        : 0;
    for (const mod of press.modifiers) {
      flags |= CGEVENT_FLAGS[mod] ?? 0;
    }
    const script = [
      'ObjC.import("CoreGraphics");',
      `const d = $.CGEventCreateKeyboardEvent($(), ${keyCode}, true);`,
      `$.CGEventSetFlags(d, ${flags});`,
      "$.CGEventPost($.kCGHIDEventTap, d);",
      `const u = $.CGEventCreateKeyboardEvent($(), ${keyCode}, false);`,
      `$.CGEventSetFlags(u, ${flags});`,
      "$.CGEventPost($.kCGHIDEventTap, u);",
    ].join(" ");
    await this.#exec(["osascript", "-l", "JavaScript", "-e", script]);
  }

  async holdKey(spec: string, durationSeconds: number): Promise<void> {
    const press = parseKeySpec(spec);
    if (
      press === null ||
      press.key.kind !== "named" ||
      press.modifiers.length > 0
    ) {
      // Only modifier holds are synthesizable via cliclick kd/ku.
      const modifiers = parseModifierList(spec);
      if (modifiers === null || modifiers.length === 0) {
        throw new ExecutorError(
          `Can only hold modifier keys (shift/ctrl/alt/super), got "${spec}". For repeated keys, use the key tool multiple times.`,
        );
      }
      const ms = this.#clampWait(durationSeconds);
      await this.#cliclick([
        ...modifiers.map((mod) => `kd:${mod}`),
        `w:${ms}`,
        ...modifiers.map((mod) => `ku:${mod}`),
      ]);
      return;
    }
    throw new ExecutorError(
      `Can only hold modifier keys (shift/ctrl/alt/super), got "${spec}".`,
    );
  }

  async scroll(
    coordinate: readonly [number, number],
    direction: ScrollDirection,
    amount: number,
    modifiers?: string,
  ): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    await this.#cliclick([`m:${x},${y}`]);
    const lines = Math.max(1, Math.round(amount)) * SCROLL_LINES_PER_CLICK;
    // CGEvent sign convention: positive wheel1 scrolls up, positive wheel2
    // scrolls left (natural-scrolling-independent HID events).
    const vertical =
      direction === "up" ? lines : direction === "down" ? -lines : 0;
    const horizontal =
      direction === "left" ? lines : direction === "right" ? -lines : 0;
    const wrap =
      modifiers === undefined ? [] : (parseModifierList(modifiers) ?? []);
    if (wrap.length > 0) await this.#cliclick(wrap.map((mod) => `kd:${mod}`));
    try {
      const script = [
        'ObjC.import("CoreGraphics");',
        `const e = $.CGEventCreateScrollWheelEvent2($(), 1, 2, ${vertical}, ${horizontal}, 0);`,
        "$.CGEventPost($.kCGHIDEventTap, e);",
      ].join(" ");
      await this.#exec(["osascript", "-l", "JavaScript", "-e", script]);
    } catch (error) {
      throw new ExecutorError(
        `Scroll failed (${error instanceof Error ? error.message : String(error)}). ` +
          "Fall back to keyboard scrolling: Page_Down/Page_Up or arrow keys via the key tool.",
      );
    } finally {
      if (wrap.length > 0) await this.#cliclick(wrap.map((mod) => `ku:${mod}`));
    }
  }

  async wait(durationSeconds: number): Promise<void> {
    await this.#sleep(this.#clampWait(durationSeconds));
  }

  // ---- internals ----

  #clampWait(durationSeconds: number): number {
    return Math.round(
      Math.min(Math.max(durationSeconds, 0), MAX_WAIT_SECONDS) * 1000,
    );
  }

  async #click(
    command: "c" | "rc" | "dc" | "tc",
    coordinate: readonly [number, number],
    modifiers?: string,
  ): Promise<void> {
    const [x, y] = await this.#toPoints(coordinate);
    const wrap = modifiers === undefined ? [] : parseModifierList(modifiers);
    if (wrap === null) {
      throw new ExecutorError(
        `Unrecognized modifier "${modifiers}". Use shift, ctrl, alt, super (combine with +).`,
      );
    }
    await this.#cliclick([
      ...wrap.map((mod) => `kd:${mod}`),
      `${command}:${x},${y}`,
      ...wrap.map((mod) => `ku:${mod}`),
    ]);
  }

  async #toPoints(
    coordinate: readonly [number, number],
  ): Promise<[number, number]> {
    const display = await this.#requireDisplay();
    this.#assertInBounds(coordinate, display);
    return modelToPoints(coordinate, display);
  }

  #assertInBounds(
    [x, y]: readonly [number, number],
    display: DisplayInfo,
  ): void {
    if (x < 0 || y < 0 || x >= display.modelWidth || y >= display.modelHeight) {
      throw new ExecutorError(
        `Coordinates (${x}, ${y}) are outside display bounds (${display.modelWidth}x${display.modelHeight}). Take a fresh screenshot to re-orient.`,
      );
    }
  }

  /** Input actions need the model->point mapping; calibrate via a throwaway
   * screenshot when no screenshot has been taken yet. */
  async #requireDisplay(): Promise<DisplayInfo> {
    if (this.#display === null) await this.screenshot();
    if (this.#display === null) {
      throw new ExecutorError("screen calibration failed");
    }
    return this.#display;
  }

  async #capture(extraArgs: string[]): Promise<Screenshot> {
    const path = join(
      tmpdir(),
      `gateway-cu-${process.pid}-${++this.#tempCounter}.png`,
    );
    try {
      // -x: no sound; -C: include cursor so the model sees pointer position.
      await this.#exec(["screencapture", "-x", "-C", ...extraArgs, path]);
      const raw = await this.#imageSize(path);
      const scale = computeScale(raw.width, raw.height, this.#maxLongEdge);
      let final = raw;
      if (scale < 1) {
        await this.#exec(["sips", "-Z", String(this.#maxLongEdge), path]);
        final = await this.#imageSize(path);
      }
      const bytes = await this.#readFile(path);
      const isFullScreen = extraArgs.length === 0;
      if (isFullScreen) {
        const [pointWidth, pointHeight] = await this.#screenPointSize(raw);
        this.#display = {
          modelWidth: final.width,
          modelHeight: final.height,
          pixelWidth: raw.width,
          pixelHeight: raw.height,
          pointWidth,
          pointHeight,
        };
      }
      return {
        base64: Buffer.from(bytes).toString("base64"),
        width: final.width,
        height: final.height,
      };
    } finally {
      await this.#removeFile(path);
    }
  }

  async #imageSize(path: string): Promise<{ width: number; height: number }> {
    const { stdout } = await this.#exec([
      "sips",
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      path,
    ]);
    const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1];
    const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1];
    if (width === undefined || height === undefined) {
      throw new ExecutorError(`could not read image dimensions: ${stdout}`);
    }
    return { width: Number(width), height: Number(height) };
  }

  /** Screen size in points (input space). Cached: the VM display is fixed. */
  async #screenPointSize(rawPixels: {
    width: number;
    height: number;
  }): Promise<[number, number]> {
    if (this.#pointSize !== null) return this.#pointSize;
    try {
      // Primary display only: `screencapture` with one output file captures
      // just the main display, so the point size must too. (Finder's desktop
      // bounds span ALL displays and would skew the mapping on multi-monitor
      // machines.)
      const { stdout } = await this.#exec([
        "osascript",
        "-l",
        "JavaScript",
        "-e",
        SCREEN_POINT_SIZE_SCRIPT,
      ]);
      const parts = stdout
        .trim()
        .split(",")
        .map((part) => Number(part.trim()));
      const pointWidth = parts[0];
      const pointHeight = parts[1];
      if (
        parts.length === 2 &&
        pointWidth !== undefined &&
        Number.isFinite(pointWidth) &&
        pointWidth > 0 &&
        pointHeight !== undefined &&
        Number.isFinite(pointHeight) &&
        pointHeight > 0
      ) {
        this.#pointSize = [pointWidth, pointHeight];
        return this.#pointSize;
      }
    } catch (error) {
      console.error("[gateway] screen point-size probe failed:", error);
    }
    // Fallback: assume a 1x display (true for Virtualization.framework
    // guests), where points == raw pixels.
    this.#pointSize = [rawPixels.width, rawPixels.height];
    return this.#pointSize;
  }

  async #cliclick(commands: string[]): Promise<void> {
    await this.#exec([this.#cliclickPath, ...commands]);
  }

  async #exec(cmd: string[]): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.#run(cmd);
    } catch (error) {
      throw new ExecutorError(
        `${cmd[0]} failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (result.exitCode !== 0) {
      throw new ExecutorError(
        `${cmd[0]} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return result;
  }
}
