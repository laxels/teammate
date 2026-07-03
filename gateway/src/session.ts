// The session core moved to shared/agentSession.ts (#138) so the localagent
// daemon reuses it; this shim binds the gateway's specifics (the devbox
// system prompt, the "gateway" log prefix) and preserves the original module
// surface for the rest of gateway/ and its tests.

import {
  type AgentSessionDeps,
  AgentSessionManager,
} from "../../shared/agentSession";
import { DEVBOX_SYSTEM_PROMPT } from "./prompt";

export {
  type AgentQuery,
  HISTORY_CAPACITY,
  INIT_WATCHDOG_MS,
  PROGRESS_INTERVAL_MS,
  type QueryFn,
  type SessionStatus,
  STALL_WATCHDOG_MS,
  WATCHDOG_INTERVAL_MS,
} from "../../shared/agentSession";

export type SessionManagerDeps = Omit<
  AgentSessionDeps,
  "systemPrompt" | "logPrefix" | "toolGate"
>;

export class SessionManager extends AgentSessionManager {
  constructor(deps: SessionManagerDeps) {
    super({
      ...deps,
      systemPrompt: DEVBOX_SYSTEM_PROMPT,
      logPrefix: "gateway",
    });
  }
}
