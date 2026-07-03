import { expect, test } from "bun:test";
import { join } from "node:path";

// adopt-host.sh copies this plist VERBATIM to any host and then gates adoption
// success on tailing ~/hostagent.log for the first-heartbeat line. launchd
// does not expand ~ in StandardOutPath/StandardErrorPath, so a hardcoded
// /Users/<user> log path silently breaks adoption for any other username
// (e.g. the AWS ec2-user backup path): the agent runs, but the log the
// adoption gate tails never appears. Logging must instead go through the
// zsh -lc command string, where ~ does expand.
test("hostagent plist is user-agnostic and still logs to ~/hostagent.log", async () => {
  const plist = await Bun.file(
    join(import.meta.dir, "../launchd/com.ultraclaude.hostagent.plist"),
  ).text();
  expect(plist).not.toContain("/Users/");
  expect(plist).toContain("~/hostagent.log");
});
