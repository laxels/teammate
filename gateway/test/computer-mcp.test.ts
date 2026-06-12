import { describe, expect, test } from "bun:test";
import type { Screenshot } from "../src/computer/executor";
import {
  type ComputerControl,
  createComputerUseTools,
} from "../src/computer/mcp";

const SHOT: Screenshot = { base64: "QUJD", width: 100, height: 50 };

type FakeControl = {
  control: ComputerControl;
  log: string[];
};

function createFakeControl(
  overrides: Partial<ComputerControl> = {},
): FakeControl {
  const log: string[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      log.push(`${name}(${JSON.stringify(args)})`);
    };
  const control: ComputerControl = {
    screenshot: async () => {
      log.push("screenshot");
      return SHOT;
    },
    zoom: async (region) => {
      log.push(`zoom(${JSON.stringify(region)})`);
      return SHOT;
    },
    leftClick: record("leftClick"),
    rightClick: record("rightClick"),
    middleClick: record("middleClick"),
    doubleClick: record("doubleClick"),
    tripleClick: record("tripleClick"),
    mouseMove: record("mouseMove"),
    mouseDown: record("mouseDown"),
    mouseUp: record("mouseUp"),
    drag: record("drag"),
    typeText: record("typeText"),
    pressKey: record("pressKey"),
    holdKey: record("holdKey"),
    scroll: record("scroll"),
    wait: record("wait"),
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

function findTool(
  tools: ReturnType<typeof createComputerUseTools>,
  name: string,
) {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

async function call(
  tools: ReturnType<typeof createComputerUseTools>,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  // Tools are a heterogeneous union, so handler's parameter collapses to
  // never; tests call handlers with args matching that tool's schema.
  return (await findTool(tools, name).handler(args as never, {})) as ToolResult;
}

describe("computer-use MCP tools", () => {
  test("exposes the native computer-use action surface", () => {
    const { control } = createFakeControl();
    const names = createComputerUseTools(control).map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "screenshot",
        "zoom",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "mouse_move",
        "left_click_drag",
        "left_mouse_down",
        "left_mouse_up",
        "type",
        "key",
        "hold_key",
        "scroll",
        "wait",
        "computer_batch",
      ].sort(),
    );
  });

  test("an input action settles, then returns note + verification screenshot", async () => {
    const { control, log } = createFakeControl();
    const tools = createComputerUseTools(control);
    const result = await call(tools, "left_click", { coordinate: [5, 7] });

    expect(log).toEqual(["leftClick([[5,7],null])", "settle", "screenshot"]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("Left-clicked (5, 7)");
    expect(result.content[1]?.text).toBe("Screenshot (100x50):");
    expect(result.content[2]).toEqual({
      type: "image",
      data: "QUJD",
      mimeType: "image/png",
    });
  });

  test("screenshot returns the image without settling", async () => {
    const { control, log } = createFakeControl();
    const tools = createComputerUseTools(control);
    const result = await call(tools, "screenshot", {});
    expect(log).toEqual(["screenshot"]);
    expect(result.content.at(-1)?.type).toBe("image");
  });

  test("executor failures become isError results with the message", async () => {
    const { control } = createFakeControl({
      leftClick: async () => {
        throw new Error("Coordinates (5, 7) are outside display bounds (1x1).");
      },
    });
    const tools = createComputerUseTools(control);
    const result = await call(tools, "left_click", { coordinate: [5, 7] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("outside display bounds");
  });

  test("invalid arguments fail validation rather than reaching the executor", async () => {
    const { control, log } = createFakeControl();
    const tools = createComputerUseTools(control);
    const result = await call(tools, "scroll", {
      coordinate: [5, 7],
      scroll_direction: "sideways",
      scroll_amount: 2,
    });
    expect(result.isError).toBe(true);
    expect(log).not.toContain("scroll");
  });

  test("computer_batch runs actions in order with one final screenshot", async () => {
    const { control, log } = createFakeControl();
    const tools = createComputerUseTools(control);
    const result = await call(tools, "computer_batch", {
      actions: [
        { action: "left_click", coordinate: [1, 2] },
        { action: "type", text: "hi" },
        { action: "key", text: "Return" },
      ],
    });

    expect(log).toEqual([
      "leftClick([[1,2],null])",
      'typeText(["hi"])',
      'pressKey(["Return"])',
      "settle",
      "screenshot",
    ]);
    expect(result.isError).toBeUndefined();
    const summary = String(result.content[0]?.text);
    expect(summary).toContain("1. Left-clicked (1, 2)");
    expect(summary).toContain("2. Typed 2 characters.");
    expect(summary).toContain("3. Pressed Return.");
  });

  test("computer_batch stops at the first failure and reports the step", async () => {
    const { control, log } = createFakeControl({
      typeText: async () => {
        throw new Error("keyboard unplugged");
      },
    });
    const tools = createComputerUseTools(control);
    const result = await call(tools, "computer_batch", {
      actions: [
        { action: "left_click", coordinate: [1, 2] },
        { action: "type", text: "hi" },
        { action: "key", text: "Return" },
      ],
    });

    expect(result.isError).toBe(true);
    expect(log).not.toContain('pressKey(["Return"])');
    const summary = String(result.content[0]?.text);
    expect(summary).toContain("1. Left-clicked (1, 2)");
    expect(summary).toContain("FAILED at step 2: keyboard unplugged");
    // Still attaches the verification screenshot so the model can re-orient.
    expect(result.content.at(-1)?.type).toBe("image");
  });

  test("computer_batch validates each item against its action schema", async () => {
    const { control, log } = createFakeControl();
    const tools = createComputerUseTools(control);
    const result = await call(tools, "computer_batch", {
      actions: [{ action: "left_click" }],
    });
    expect(result.isError).toBe(true);
    expect(log).not.toContain("leftClick([[1,2],null])");
  });
});
