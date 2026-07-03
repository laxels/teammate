// Codex-style hard bans for driving the user's real machine (#138), enforced
// mechanically as a ToolGate ahead of every cua-driver call — the prompt
// restates them, but the prompt is not the enforcement. Per the issue, these
// are the mitigation for the prompt-injection path where web content seen by
// a cloud agent becomes requests against the user's machine:
//
//   never drive terminal apps, admin authentication, OS security prompts,
//   or the agent's own app.
//
// Sensitive-action re-asks (payments, sending messages as the user) are a
// judgment call and stay prompt-mandated via AskUserQuestion -> needs_input.

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ToolGate } from "../../shared/agentSession";

/**
 * Case-insensitive substring patterns matched against BOTH launch identifiers
 * (bundle id / app name) and a pid's resolved executable path. Terminal apps
 * give the model an arbitrary-command escape hatch on the user's machine;
 * SecurityAgent/loginwindow/tccd surfaces are macOS auth and permission
 * prompts; CuaDriver is the agent's own app.
 */
const BANNED_PATTERNS: readonly string[] = [
  // Terminal emulators (bundle ids and .app paths).
  "com.apple.terminal",
  "terminal.app",
  "com.googlecode.iterm2",
  "iterm.app",
  "iterm2",
  "dev.warp.warp",
  "warp.app",
  "org.alacritty",
  "io.alacritty",
  "alacritty",
  "net.kovidgoyal.kitty",
  "kitty.app",
  "com.mitchellh.ghostty",
  "ghostty",
  "com.github.wez.wezterm",
  "wezterm",
  "co.zeit.hyper",
  "hyper.app",
  "tmux",
  // Admin authentication + OS security prompts.
  "securityagent",
  "com.apple.securityagent",
  "loginwindow",
  "usernotificationcenter",
  "coreautha",
  "localauthentication",
  // The agent's own app (the cua-driver overlay/daemon).
  "com.trycua.driver",
  "cuadriver",
];

/** Why this app identifier is banned, or null when it isn't. Identifier can
 * be a bundle id, an app name, or a resolved executable path. */
export function bannedAppReason(identifier: string): string | null {
  const lower = identifier.toLowerCase();
  for (const pattern of BANNED_PATTERNS) {
    if (lower.includes(pattern)) {
      return `"${identifier}" matches the hard-ban list (${pattern}). Terminals, admin/OS-security prompts, and the agent's own app are never driven on the user's machine.`;
    }
  }
  return null;
}

/** cua-driver PERCEPTION tools: pid-targeted reads (AX trees, window lists,
 * region screenshots). A banned pid is still refused, but a pid-less call is
 * harmless — reading is not driving. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "get_window_state",
  "list_windows",
  "zoom",
]);

/** cua-driver SIDE-EFFECTING tools. These must be tied to an IDENTIFIED,
 * permitted process: in the pinned driver most of them also accept
 * targetless/desktop-scope forms (e.g. click({ x, y, scope: "desktop" }))
 * that land on whatever window sits under the point — which would let a
 * prompt-injected agent drive a terminal or an OS security prompt without
 * ever naming it. A call with no resolvable pid (or, for `page`, bundle_id)
 * therefore fails CLOSED. */
const ACTION_TOOLS: ReadonlySet<string> = new Set([
  "bring_to_front",
  "kill_app",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "page",
]);

/** Resolves a pid to its executable path ("" when the pid is gone). */
export type PidResolver = (pid: number) => Promise<string>;

/** Default resolver: `ps -o comm= -p <pid>` (the full executable path on
 * macOS, e.g. /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal). */
export async function resolvePidCommand(pid: number): Promise<string> {
  const proc = Bun.spawn(["ps", "-o", "comm=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

function deny(message: string): PermissionResult {
  return { behavior: "deny", message };
}

/** The tool's server name and bare action, e.g. "mcp__cua-driver__click" ->
 * { server: "cua-driver", action: "click" }; non-MCP names have no server. */
function splitToolName(toolName: string): {
  server: string | null;
  action: string;
} {
  if (!toolName.startsWith("mcp__")) {
    return { server: null, action: toolName };
  }
  const parts = toolName.split("__");
  return {
    server: parts.length >= 3 ? (parts[1] ?? null) : null,
    action: parts.at(-1) ?? toolName,
  };
}

/**
 * The localagent's ToolGate: vetoes cua-driver calls that would launch or
 * drive a banned app. Fails CLOSED on an unresolvable pid — a target we can't
 * identify on the user's real machine is not driven. Non-cua tools (the peer
 * reply tool, share_file, Claude Code's own file/bash tools*) pass through.
 *
 * *Claude Code's Bash tool runs as the daemon user like any local dev agent —
 * the terminal-app ban is about driving the USER's interactive terminal
 * windows (session hijack), not about the agent's own subprocesses.
 */
export function createHardBanGate(
  resolvePid: PidResolver = resolvePidCommand,
): ToolGate {
  // pid -> executable path. Bounded: cleared wholesale when it grows past
  // PID_CACHE_MAX (pids recycle, but not within a burst of tool calls).
  const pidCache = new Map<number, string>();
  const PID_CACHE_MAX = 512;

  return async (toolName, input) => {
    const { server, action } = splitToolName(toolName);
    if (server !== "cua-driver") {
      return null;
    }

    if (action === "launch_app") {
      for (const key of ["bundle_id", "name"] as const) {
        const value = input[key];
        if (typeof value === "string") {
          const reason = bannedAppReason(value);
          if (reason !== null) {
            return deny(`launch_app refused: ${reason}`);
          }
        }
      }
      return null;
    }

    const isRead = READ_TOOLS.has(action);
    const isAction = ACTION_TOOLS.has(action);
    if (!isRead && !isAction) {
      return null;
    }
    const pid = input.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      // No pid. Reads are harmless (list_windows without args). Among the
      // side-effecting tools, ONLY `page` genuinely targets by bundle_id in
      // the pinned driver — on every other action a bundle_id key is
      // decoration the driver ignores, so treating it as an identifier would
      // let `click({x, y, scope: "desktop", bundle_id: <anything benign>})`
      // smuggle a targetless click past the ban list. Everything
      // side-effecting without a real identifier fails closed: a
      // desktop-scope/point-only action lands on whatever window sits under
      // the point.
      if (action === "page") {
        const bundleId = input.bundle_id;
        if (typeof bundleId === "string" && bundleId !== "") {
          const reason = bannedAppReason(bundleId);
          return reason === null ? null : deny(`${action} refused: ${reason}`);
        }
      }
      if (isAction) {
        return deny(
          `${action} refused: targetless (desktop-scope / point-only) actions cannot be tied to an identified app, so the hard-ban list cannot vet them. Target a specific pid (from list_apps/list_windows) or, for page, a bundle_id.`,
        );
      }
      return null;
    }
    let command = pidCache.get(pid);
    if (command === undefined) {
      try {
        command = await resolvePid(pid);
      } catch {
        command = "";
      }
      // Only cache successful resolutions: a transient ps failure must not
      // pin a pid as permanently unidentifiable (= permanently denied).
      if (command !== "") {
        if (pidCache.size >= PID_CACHE_MAX) {
          pidCache.clear();
        }
        pidCache.set(pid, command);
      }
    }
    if (command === "") {
      return deny(
        `${action} refused: could not identify the app behind pid ${pid} (it may have exited). Re-run list_apps/list_windows and target a live, permitted app.`,
      );
    }
    const reason = bannedAppReason(command);
    if (reason !== null) {
      return deny(`${action} refused: ${reason}`);
    }
    return null;
  };
}
