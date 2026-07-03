import { describe, expect, test } from "bun:test";
import { bannedAppReason, createHardBanGate, type PidResolver } from "./safety";

// The hard-ban gate is the MECHANICAL enforcement of the #138 safety rails
// (the prompt restates them, but a prompt-injected session ignores prompts):
// never drive terminals, admin auth, OS security prompts, or the agent's own
// app on the user's real machine.

const TERMINAL_BIN =
  "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

/** Resolver stub that records which pids it was asked about. */
function stubResolver(resolve: (pid: number) => string | Promise<string>): {
  resolvePid: PidResolver;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    resolvePid: async (pid) => {
      calls.push(pid);
      return resolve(pid);
    },
  };
}

describe("bannedAppReason", () => {
  test("matches bundle ids, .app paths, and mixed case", () => {
    expect(bannedAppReason("com.apple.Terminal")).not.toBeNull();
    expect(bannedAppReason(TERMINAL_BIN)).not.toBeNull();
    expect(bannedAppReason("COM.GOOGLECODE.ITERM2")).not.toBeNull();
    expect(bannedAppReason("/Applications/Ghostty.app")).not.toBeNull();
  });

  test("passes benign apps", () => {
    expect(bannedAppReason("com.apple.Safari")).toBeNull();
    expect(
      bannedAppReason("/Applications/Obsidian.app/Contents/MacOS/Obsidian"),
    ).toBeNull();
  });
});

describe("createHardBanGate", () => {
  test("non-cua tools pass through without resolving any pid", async () => {
    const { resolvePid, calls } = stubResolver(() => TERMINAL_BIN);
    const gate = createHardBanGate(resolvePid);
    // The agent's own subprocesses are not "driving the user's terminal".
    expect(await gate("Bash", { command: "ls", pid: 1 })).toBeNull();
    expect(
      await gate("mcp__local-peer__reply_to_cloud", {
        requestId: "req-1",
        result: "answer",
      }),
    ).toBeNull();
    expect(
      await gate("mcp__share-file__share_file", { path: "/x" }),
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  test("launch_app refuses banned bundle ids and names, allows benign apps", async () => {
    const gate = createHardBanGate(stubResolver(() => "").resolvePid);
    const byBundleId = await gate("mcp__cua-driver__launch_app", {
      bundle_id: "com.apple.Terminal",
    });
    expect(byBundleId?.behavior).toBe("deny");
    if (byBundleId?.behavior === "deny") {
      expect(byBundleId.message).toContain("hard-ban");
    }
    const byName = await gate("mcp__cua-driver__launch_app", {
      name: "Ghostty",
    });
    expect(byName?.behavior).toBe("deny");
    expect(
      await gate("mcp__cua-driver__launch_app", {
        bundle_id: "com.apple.Notes",
      }),
    ).toBeNull();
  });

  test("pid-targeted tools resolving to a terminal are denied", async () => {
    const gate = createHardBanGate(stubResolver(() => TERMINAL_BIN).resolvePid);
    for (const [action, input] of [
      ["click", { pid: 42, x: 10, y: 10 }],
      ["type_text", { pid: 42, text: "rm -rf /" }],
      ["get_window_state", { pid: 42 }],
    ] as const) {
      const verdict = await gate(`mcp__cua-driver__${action}`, input);
      expect(verdict?.behavior).toBe("deny");
    }
  });

  test("pid-targeted tools resolving to a benign app pass", async () => {
    const gate = createHardBanGate(
      stubResolver(() => "/Applications/Notes.app/Contents/MacOS/Notes")
        .resolvePid,
    );
    expect(await gate("mcp__cua-driver__click", { pid: 7, x: 1, y: 1 })).toBe(
      null,
    );
  });

  test("fails closed when the pid resolves to nothing", async () => {
    const gate = createHardBanGate(stubResolver(() => "").resolvePid);
    const verdict = await gate("mcp__cua-driver__click", {
      pid: 9,
      x: 1,
      y: 1,
    });
    expect(verdict?.behavior).toBe("deny");
    if (verdict?.behavior === "deny") {
      expect(verdict.message).toContain("pid 9");
    }
  });

  test("fails closed when the resolver throws", async () => {
    const gate = createHardBanGate(async () => {
      throw new Error("ps failed");
    });
    const verdict = await gate("mcp__cua-driver__type_text", {
      pid: 11,
      text: "hi",
    });
    expect(verdict?.behavior).toBe("deny");
  });

  test("resolves each pid once within a burst of tool calls", async () => {
    const { resolvePid, calls } = stubResolver(
      () => "/Applications/Notes.app/Contents/MacOS/Notes",
    );
    const gate = createHardBanGate(resolvePid);
    expect(await gate("mcp__cua-driver__click", { pid: 5, x: 1, y: 1 })).toBe(
      null,
    );
    expect(await gate("mcp__cua-driver__scroll", { pid: 5, dy: -3 })).toBe(
      null,
    );
    expect(await gate("mcp__cua-driver__click", { pid: 6, x: 2, y: 2 })).toBe(
      null,
    );
    expect(calls).toEqual([5, 6]);
  });

  test("does not cache a failed resolution — the next call re-resolves", async () => {
    let attempt = 0;
    const { resolvePid, calls } = stubResolver(() => {
      attempt += 1;
      return attempt === 1
        ? "" // transient ps failure
        : "/Applications/Notes.app/Contents/MacOS/Notes";
    });
    const gate = createHardBanGate(resolvePid);
    const first = await gate("mcp__cua-driver__click", { pid: 3, x: 1, y: 1 });
    expect(first?.behavior).toBe("deny");
    const second = await gate("mcp__cua-driver__click", { pid: 3, x: 1, y: 1 });
    expect(second).toBeNull();
    expect(calls).toEqual([3, 3]);
  });

  test("targetless side-effecting actions fail closed (desktop-scope bypass, review finding)", async () => {
    // The reviewer's exact repro: a desktop-scope click carries no pid and no
    // bundle_id, so nothing ties it to an identified app — it must be denied
    // WITHOUT any pid resolution, not silently allowed onto whatever window
    // sits under the point (which could be Terminal or an OS auth prompt).
    const gate = createHardBanGate(async () => {
      throw new Error("should not resolve");
    });
    const click = await gate("mcp__cua-driver__click", {
      x: 100,
      y: 100,
      scope: "desktop",
    });
    expect(click).toMatchObject({ behavior: "deny" });
    for (const action of ["type_text", "press_key", "scroll", "drag"]) {
      expect(await gate(`mcp__cua-driver__${action}`, { x: 1, y: 1 })).toMatchObject(
        { behavior: "deny" },
      );
    }
  });

  test("pid-less perception tools still pass (reading is not driving)", async () => {
    const gate = createHardBanGate(async () => {
      throw new Error("should not resolve");
    });
    expect(await gate("mcp__cua-driver__list_windows", {})).toBeNull();
    expect(await gate("mcp__cua-driver__list_apps", {})).toBeNull();
    expect(await gate("mcp__cua-driver__get_screen_size", {})).toBeNull();
  });

  test("page with a clean bundle_id and no pid stays allowed", async () => {
    const gate = createHardBanGate(async () => {
      throw new Error("should not resolve");
    });
    expect(
      await gate("mcp__cua-driver__page", {
        bundle_id: "com.google.Chrome",
        action: "get_text",
      }),
    ).toBeNull();
  });

  test("page targeting a banned bundle_id without a pid is denied", async () => {
    const { resolvePid, calls } = stubResolver(() => "");
    const gate = createHardBanGate(resolvePid);
    const verdict = await gate("mcp__cua-driver__page", {
      bundle_id: "com.googlecode.iterm2",
    });
    expect(verdict?.behavior).toBe("deny");
    expect(calls).toEqual([]);
  });

  test("admin auth, OS security prompts, and the agent's own app are never driven", async () => {
    for (const path of [
      "/System/Library/CoreServices/SecurityAgent.app/Contents/MacOS/SecurityAgent",
      "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
      "/Applications/CuaDriver.app/Contents/MacOS/CuaDriver",
    ]) {
      const gate = createHardBanGate(stubResolver(() => path).resolvePid);
      const verdict = await gate("mcp__cua-driver__type_text", {
        pid: 100,
        text: "hunter2",
      });
      expect(verdict?.behavior).toBe("deny");
    }
  });
});
