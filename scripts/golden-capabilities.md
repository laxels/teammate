# Golden-image capability manifest — hand-curated section (#138)

This file is the CURATED half of the capability manifest injected into the
orchestrator's system prompt (the enumerable half — installed apps, tool
versions — is generated at bake time by `upload-capability-manifest.sh`). It
records what a bake can't enumerate: which accounts are AUTHED, which
surfaces are logged in, and the known hard limits of cloud devboxes. Update
it whenever a bake changes any of this, then re-run the upload script; the
deployment's manifest only changes on upload, mirroring how devbox changes
only persist via a bake.

## Authed / logged in (persists across clones)

- Chrome default profile: logged in (Google account), Chrome is the default
  browser. The Claude-in-Chrome extension is removed.
- Chrome automation profile (`~/.ultraclaude/chrome-profile`, the Playwright
  browser): site logins performed at bake time persist; sites needing auth
  must be logged in once in THIS profile to be usable by `browser_*` tools.
- Claude desktop app: logged in.
- Claude Code: subscription OAuth token at `~/claude-oauth-token.txt`.

## NOT available on devboxes (route to the local machine or say so)

- The user's personal files, mail, messages, calendars, and keychains.
- Apps installed only on the user's own machine.
- Signed-in sessions that don't transfer to a cloned VM: Google risk-based
  reauth ("Verify it's you") and similar device-fingerprint walls block
  fresh datacenter logins even with baked cookies (#70).
- Anything requiring the user's phone (2FA taps, passkeys, number-match).

## Standing environment facts

- Fresh ephemeral VM per task; NOTHING persists between tasks except what the
  golden image bakes in.
- macOS Sequoia, 1920x1080 (points == pixels), en-US, never-sleep, DND on.
- Full GUI control via computer-use tools; Playwright browser automation;
  `browser_handoff_to_desktop` fallback for anti-automation walls.
