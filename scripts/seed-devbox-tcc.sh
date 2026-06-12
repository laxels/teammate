#!/usr/bin/env bash
#
# Seed the TCC permission grants the gateway's computer-use executor needs,
# directly into the VM's TCC databases. Run INSIDE a devbox VM (as admin,
# passwordless sudo). Requires SIP to be disabled in the guest — true for the
# Cirrus Labs macOS base images our golden images derive from.
#
# Services:
#   kTCCServiceScreenCapture   screenshots (`screencapture`), attributed to
#                              the responsible process — bun (the gateway
#                              LaunchAgent) and sshd for ad-hoc verification
#   kTCCServiceAccessibility   synthetic input via CGEvents (cliclick posts
#                              clicks/keys; osascript posts scroll + chord
#                              CGEvents through the JXA ObjC bridge)
#   kTCCServicePostEvent       event-posting companion to Accessibility
#
# Deliberately NOT seeded: kTCCServiceAppleEvents (System Events automation).
# The executor no longer uses System Events — tccd re-validates AppleEvents
# rows on use and re-prompts/denies synthetic grants, so that path was
# replaced with raw CGEvent keycodes (see gateway/src/computer/executor.ts).
#
# Grants persist across `tart clone`, so running this once before a bake is
# enough for every clone of the image.

set -euo pipefail

SYSTEM_DB="/Library/Application Support/com.apple.TCC/TCC.db"

CLIENTS=(
  "/Users/admin/.bun/bin/bun"
  "/usr/local/bin/cliclick"
  "/usr/bin/osascript"
)
SERVICES=(
  kTCCServiceScreenCapture
  kTCCServiceAccessibility
  kTCCServicePostEvent
)

grant() { # <service> <client>
  sudo sqlite3 "$SYSTEM_DB" \
    "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, flags) VALUES ('$1', '$2', 1, 2, 0, 1, NULL, 0);"
}

for service in "${SERVICES[@]}"; do
  for client in "${CLIENTS[@]}"; do
    grant "$service" "$client"
  done
done

sudo killall tccd 2>/dev/null || true
sleep 2

echo "Seeded rows:"
sudo sqlite3 "$SYSTEM_DB" \
  "SELECT service, client, auth_value FROM access WHERE client IN ('${CLIENTS[0]}', '${CLIENTS[1]}', '${CLIENTS[2]}') ORDER BY service, client;"
