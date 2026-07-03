import { expect, test } from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentQuery,
  AgentSessionManager,
  type QueryFn,
} from "./agentSession";

// The permission wiring is LOAD-BEARING for #138's hard bans: under
// "bypassPermissions" the CLI auto-allows every tool WITHOUT consulting
// canUseTool (only AskUserQuestion reaches it), so a gated session MUST run
// in "default" mode or the safety layer is dead code. These tests pin the
// mode selection and that the gate actually decides tool calls.

function captureOptionsQueryFn(captured: { options?: Options }): QueryFn {
  return (params) => {
    captured.options = params.options ?? {};
    async function* stream(): AsyncGenerator<
      Awaited<ReturnType<AgentQuery["next"]>> extends never ? never : never,
      void
    > {
      // Never yields; the session idles until stopped. Tests only inspect
      // the captured options.
      await new Promise(() => {});
    }
    const generator = stream() as unknown as AgentQuery;
    generator.interrupt = async () => {};
    return generator;
  };
}

function newManager(args: {
  captured: { options?: Options };
  gated: boolean;
}): AgentSessionManager {
  return new AgentSessionManager({
    emitEvent: async () => {},
    systemPrompt: "test prompt",
    logPrefix: "test",
    queryFn: captureOptionsQueryFn(args.captured),
    ...(args.gated
      ? {
          toolGate: (toolName: string) =>
            toolName === "mcp__cua-driver__click"
              ? { behavior: "deny" as const, message: "banned" }
              : null,
        }
      : {}),
  });
}

test("an ungated session keeps the bypassPermissions fast path", () => {
  const captured: { options?: Options } = {};
  const manager = newManager({ captured, gated: false });
  expect(manager.start({ taskId: "t1", prompt: "go" })).toBe(true);
  expect(captured.options?.permissionMode).toBe("bypassPermissions");
  expect(captured.options?.allowDangerouslySkipPermissions).toBe(true);
  void manager.stop();
});

test("a gated session runs in default mode so canUseTool (and the gate) execute", async () => {
  const captured: { options?: Options } = {};
  const manager = newManager({ captured, gated: true });
  expect(manager.start({ taskId: "t1", prompt: "go" })).toBe(true);
  expect(captured.options?.permissionMode).toBe("default");
  expect(captured.options?.allowDangerouslySkipPermissions).toBeUndefined();

  const canUseTool = captured.options?.canUseTool;
  if (canUseTool === undefined) throw new Error("canUseTool not wired");
  const suggestions = { mode: "default" } as unknown as Parameters<
    typeof canUseTool
  >[2];
  // The gate's deny verdict decides the call...
  expect(
    await canUseTool("mcp__cua-driver__click", { pid: 1 }, suggestions),
  ).toMatchObject({ behavior: "deny" });
  // ...and a null verdict falls through to allow.
  expect(
    await canUseTool("mcp__local-peer__reply_to_cloud", {}, suggestions),
  ).toMatchObject({ behavior: "allow" });
  void manager.stop();
});
