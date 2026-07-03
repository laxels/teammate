import { expect, test } from "bun:test";
import { join } from "node:path";

// scripts/setup-localagent.sh copies this plist VERBATIM and then gates
// installation success on tailing ~/localagent.log for the first-heartbeat
// line. launchd does not expand ~ in StandardOutPath/StandardErrorPath, so a
// hardcoded /Users/<user> path would silently break the gate for any other
// username; logging (and the machine-specific LOCALAGENT_DIR) go through the
// zsh -lc command string + ~/.localagent.env instead.
test("localagent plist is user-agnostic and still logs to ~/localagent.log", async () => {
  const plist = await Bun.file(
    join(import.meta.dir, "../launchd/com.ultraclaude.localagent.plist"),
  ).text();
  expect(plist).not.toContain("/Users/");
  expect(plist).toContain("~/localagent.log");
  expect(plist).toContain("~/.localagent.env");
  expect(plist).toContain("$LOCALAGENT_DIR");
});
