import { describe, expect, test } from "bun:test";
import {
  type CommandRunner,
  ComputerExecutor,
  computeScale,
  type DisplayInfo,
  modelToPoints,
  parseKeySpec,
} from "../src/computer/executor";

const FINDER_BOUNDS_SCRIPT =
  'tell application "Finder" to get bounds of window of desktop';

type FakeScreen = {
  pixelWidth: number;
  pixelHeight: number;
  pointWidth?: number;
  pointHeight?: number;
};

/** Canned responses for the executor's shell-outs; records every command. */
function createFakeRunner(screen: FakeScreen): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let resizedTo: { width: number; height: number } | null = null;
  const runner: CommandRunner = async (cmd) => {
    calls.push(cmd);
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (cmd[0] === "sips" && cmd[1] === "-Z") {
      const max = Number(cmd[2]);
      const scale = computeScale(screen.pixelWidth, screen.pixelHeight, max);
      resizedTo = {
        width: Math.round(screen.pixelWidth * scale),
        height: Math.round(screen.pixelHeight * scale),
      };
      return ok("");
    }
    if (cmd[0] === "sips") {
      const dims = resizedTo ?? {
        width: screen.pixelWidth,
        height: screen.pixelHeight,
      };
      return ok(`  pixelWidth: ${dims.width}\n  pixelHeight: ${dims.height}`);
    }
    if (cmd[0] === "osascript" && cmd.includes(FINDER_BOUNDS_SCRIPT)) {
      const width = screen.pointWidth ?? screen.pixelWidth;
      const height = screen.pointHeight ?? screen.pixelHeight;
      return ok(`0, 0, ${width}, ${height}`);
    }
    return ok("");
  };
  return { runner, calls };
}

function makeExecutor(
  screen: FakeScreen,
  opts: { maxLongEdge?: number } = {},
): { executor: ComputerExecutor; calls: string[][]; sleeps: number[] } {
  const { runner, calls } = createFakeRunner(screen);
  const sleeps: number[] = [];
  const executor = new ComputerExecutor({
    runner,
    readFile: async () => new TextEncoder().encode("fakepng"),
    removeFile: async () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(opts.maxLongEdge !== undefined
      ? { maxLongEdge: opts.maxLongEdge }
      : {}),
  });
  return { executor, calls, sleeps };
}

function cliclickCalls(calls: string[][]): string[][] {
  return calls
    .filter((cmd) => cmd[0] === "cliclick")
    .map((cmd) => cmd.slice(1));
}

describe("pure helpers", () => {
  test("computeScale caps the long edge and never upscales", () => {
    expect(computeScale(1920, 1080, 1568)).toBeCloseTo(1568 / 1920);
    expect(computeScale(1280, 800, 1568)).toBe(1);
    expect(computeScale(1080, 1920, 1568)).toBeCloseTo(1568 / 1920);
  });

  test("modelToPoints maps through pixel space to point space", () => {
    const info: DisplayInfo = {
      modelWidth: 1568,
      modelHeight: 882,
      pixelWidth: 1920,
      pixelHeight: 1080,
      pointWidth: 960, // Retina-style 2x display
      pointHeight: 540,
    };
    // model 100 -> pixel 122.45 -> point 61.2
    expect(modelToPoints([100, 200], info)).toEqual([61, 122]);
  });

  test("parseKeySpec handles named keys, chords, and aliases", () => {
    expect(parseKeySpec("Return")).toEqual({
      modifiers: [],
      key: { kind: "named", name: "return" },
    });
    expect(parseKeySpec("Page_Down")).toEqual({
      modifiers: [],
      key: { kind: "named", name: "page-down" },
    });
    expect(parseKeySpec("super+s")).toEqual({
      modifiers: ["cmd"],
      key: { kind: "char", char: "s" },
    });
    expect(parseKeySpec("ctrl+shift+t")).toEqual({
      modifiers: ["ctrl", "shift"],
      key: { kind: "char", char: "t" },
    });
    expect(parseKeySpec("cmd+Return")).toEqual({
      modifiers: ["cmd"],
      key: { kind: "named", name: "return" },
    });
    expect(parseKeySpec("blorp+x")).toBeNull();
    expect(parseKeySpec("NoSuchKey")).toBeNull();
  });
});

describe("ComputerExecutor screenshots", () => {
  test("downscales large screens and calibrates the display mapping", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1920,
      pixelHeight: 1080,
    });
    const shot = await executor.screenshot();

    expect(shot.width).toBe(1568);
    expect(shot.height).toBe(882);
    expect(shot.base64).toBe(Buffer.from("fakepng").toString("base64"));
    expect(calls.some((cmd) => cmd[0] === "sips" && cmd[1] === "-Z")).toBe(
      true,
    );
    expect(executor.displayInfo()).toEqual({
      modelWidth: 1568,
      modelHeight: 882,
      pixelWidth: 1920,
      pixelHeight: 1080,
      pointWidth: 1920,
      pointHeight: 1080,
    });
  });

  test("leaves small screens at native size", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    const shot = await executor.screenshot();
    expect(shot.width).toBe(1280);
    expect(calls.some((cmd) => cmd[0] === "sips" && cmd[1] === "-Z")).toBe(
      false,
    );
  });

  test("zoom captures the converted point-space region", async () => {
    const { executor, calls } = makeExecutor(
      { pixelWidth: 1280, pixelHeight: 800 },
      { maxLongEdge: 4000 },
    );
    await executor.screenshot(); // 1:1 calibration
    await executor.zoom([100, 100, 300, 250]);

    const regionCapture = calls.find(
      (cmd) => cmd[0] === "screencapture" && cmd.includes("-R"),
    );
    expect(regionCapture).toBeDefined();
    const rectIndex = (regionCapture ?? []).indexOf("-R") + 1;
    expect(regionCapture?.[rectIndex]).toBe("100,100,200,150");
  });

  test("zoom rejects an inverted region", async () => {
    const { executor } = makeExecutor({ pixelWidth: 1280, pixelHeight: 800 });
    await executor.screenshot();
    expect(executor.zoom([300, 100, 100, 250])).rejects.toThrow(
      "Invalid zoom region",
    );
  });
});

describe("ComputerExecutor input", () => {
  test("clicks convert model coordinates through pixels to points", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1920,
      pixelHeight: 1080,
    });
    await executor.screenshot(); // model 1568x882, points == pixels
    await executor.leftClick([100, 200]);
    // 100 * 1920/1568 = 122.45 -> 122; 200 * 1080/882 = 244.9 -> 245
    expect(cliclickCalls(calls).at(-1)).toEqual(["c:122,245"]);
  });

  test("clicks halve coordinates on a 2x (Retina) display", async () => {
    const { executor, calls } = makeExecutor(
      {
        pixelWidth: 1920,
        pixelHeight: 1080,
        pointWidth: 960,
        pointHeight: 540,
      },
      { maxLongEdge: 4000 }, // no model downscale: model space == pixel space
    );
    await executor.screenshot();
    await executor.leftClick([100, 200]);
    expect(cliclickCalls(calls).at(-1)).toEqual(["c:50,100"]);
  });

  test("auto-calibrates with a throwaway screenshot when none was taken", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.leftClick([10, 20]);
    expect(calls.some((cmd) => cmd[0] === "screencapture")).toBe(true);
    expect(cliclickCalls(calls).at(-1)).toEqual(["c:10,20"]);
  });

  test("modifier clicks wrap the click in key-down/key-up", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.screenshot();
    await executor.leftClick([10, 20], "super");
    expect(cliclickCalls(calls).at(-1)).toEqual([
      "kd:cmd",
      "c:10,20",
      "ku:cmd",
    ]);
  });

  test("out-of-bounds coordinates are rejected with the doc-style error", async () => {
    const { executor } = makeExecutor({ pixelWidth: 1280, pixelHeight: 800 });
    await executor.screenshot();
    expect(executor.leftClick([3000, 10])).rejects.toThrow(
      "Coordinates (3000, 10) are outside display bounds (1280x800)",
    );
  });

  test("drag presses, moves, and releases with settle waits", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.screenshot();
    await executor.drag([10, 10], [50, 60]);
    expect(cliclickCalls(calls).at(-1)).toEqual([
      "dd:10,10",
      "w:100",
      "dm:50,60",
      "w:100",
      "du:50,60",
    ]);
  });

  test("typeText chunks long strings and types newlines as Return", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.typeText(`${"a".repeat(120)}\nbye`);
    expect(cliclickCalls(calls).at(-1)).toEqual([
      `t:${"a".repeat(50)}`,
      `t:${"a".repeat(50)}`,
      `t:${"a".repeat(20)}`,
      "kp:return",
      "t:bye",
    ]);
  });

  test("named keys go through cliclick kp, chords through System Events", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.pressKey("Page_Down");
    expect(cliclickCalls(calls).at(-1)).toEqual(["kp:page-down"]);

    await executor.pressKey("super+s");
    const osa = calls.at(-1);
    expect(osa?.[0]).toBe("osascript");
    expect(osa?.at(-1)).toBe(
      'tell application "System Events" to keystroke "s" using {command down}',
    );

    expect(executor.pressKey("NoSuchKey")).rejects.toThrow(
      'Unrecognized key spec "NoSuchKey"',
    );
  });

  test("holdKey holds modifiers only", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.holdKey("shift", 2);
    expect(cliclickCalls(calls).at(-1)).toEqual([
      "kd:shift",
      "w:2000",
      "ku:shift",
    ]);
    expect(executor.holdKey("x", 1)).rejects.toThrow(
      "Can only hold modifier keys",
    );
  });

  test("scroll moves the cursor then posts a CGEvent scroll", async () => {
    const { executor, calls } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.screenshot();
    await executor.scroll([100, 100], "down", 2);

    expect(cliclickCalls(calls).at(-1)).toEqual(["m:100,100"]);
    const osa = calls.at(-1);
    expect(osa?.[0]).toBe("osascript");
    expect(osa?.[1]).toBe("-l");
    expect(osa?.at(-1)).toContain(
      "$.CGEventCreateScrollWheelEvent2($(), 1, 2, -6, 0, 0)",
    );
  });

  test("wait clamps to the maximum", async () => {
    const { executor, sleeps } = makeExecutor({
      pixelWidth: 1280,
      pixelHeight: 800,
    });
    await executor.wait(99);
    expect(sleeps.at(-1)).toBe(30_000);
  });

  test("a failing command surfaces stderr in the error", async () => {
    const executor = new ComputerExecutor({
      runner: async () => ({
        stdout: "",
        stderr: "cliclick: cannot post event",
        exitCode: 1,
      }),
      readFile: async () => new Uint8Array(),
      removeFile: async () => {},
      sleep: async () => {},
    });
    expect(executor.typeText("hi")).rejects.toThrow(
      "cliclick exited 1: cliclick: cannot post event",
    );
  });
});
