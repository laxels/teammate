// Bun test preload (registered in bunfig.toml's [test] block). Runs once, after
// Bun has loaded any .env files and before any test file is imported.
//
// `.env` carries a real SLACK_BOT_TOKEN, and several code paths post to Slack by
// reading `process.env.SLACK_BOT_TOKEN` directly (convex/notify.ts,
// convex/artifacts.ts, convex/orchestrator.ts, ...). A test that exercises one
// of those paths over the ambient env would fire a real Slack API call from a
// developer's machine. `--no-env-file` in package.json keeps `bun run test` /
// `validate` from loading `.env` at all, but an ad-hoc `bun test <file>` skips
// that flag — so we also strip the token here, the one guard that holds for
// every invocation style and for a token exported directly into the shell.
//
// A test that genuinely needs a token sets its own fake one (see
// convex/artifacts.test.ts); this only removes the *real* ambient one.
delete process.env.SLACK_BOT_TOKEN;
