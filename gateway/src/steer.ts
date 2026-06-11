import type {
  PermissionMode,
  SteerClientMessage,
  SteerServerMessage,
} from "../../shared/protocol";
import type { SessionManager } from "./session";

const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

/** Validate a raw /ws/steer frame into a SteerClientMessage, or null. */
export function parseSteerClientMessage(
  raw: unknown,
): SteerClientMessage | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  switch (candidate.type) {
    case "user_message":
      return typeof candidate.text === "string" && candidate.text.trim() !== ""
        ? { type: "user_message", text: candidate.text }
        : null;
    case "interrupt":
      return { type: "interrupt" };
    case "set_permission_mode":
      return isPermissionMode(candidate.mode)
        ? { type: "set_permission_mode", mode: candidate.mode }
        : null;
    default:
      return null;
  }
}

/**
 * Parse and dispatch a steer frame against the live session. Returns a
 * SteerServerMessage to send back to the originating client (errors only),
 * or null when the message was handled silently.
 */
export async function dispatchSteerMessage(
  raw: unknown,
  session: SessionManager,
): Promise<SteerServerMessage | null> {
  const message = parseSteerClientMessage(raw);
  if (message === null) {
    return { type: "error", message: "invalid steer message" };
  }
  switch (message.type) {
    case "user_message":
      return session.pushUserMessage(message.text)
        ? null
        : { type: "error", message: "no active session" };
    case "interrupt":
      return (await session.stop())
        ? null
        : { type: "error", message: "no active session" };
    case "set_permission_mode":
      try {
        return (await session.setPermissionMode(message.mode))
          ? null
          : { type: "error", message: "no active session" };
      } catch (error) {
        return {
          type: "error",
          message: `failed to set permission mode: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
  }
}
