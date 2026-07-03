#!/usr/bin/env bash
#
# upload-capability-manifest.sh — record what cloud devboxes can (and cannot)
# do, keyed by golden tag, for the orchestrator's routing decisions (#138).
#
#   scripts/upload-capability-manifest.sh [--tag golden-vN] [--generated FILE]
#
# The manifest has two halves:
#   - curated:   scripts/golden-capabilities.md (hand-maintained: what's
#                authed, what's missing — the part a bake can't enumerate).
#   - generated: enumerable facts from inside a golden VM. bake-golden.sh
#                produces this during a bake (see its manifest step) and calls
#                this script with --generated; a standalone run without it
#                uploads the curated section only (generated stays empty until
#                the next bake).
#
# POSTs to {CONVEX_SITE_URL}/fleet/capability-manifest (x-devbox-secret). The
# orchestrator injects the LATEST manifest, so upload after every bake and
# after every curated edit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ULTRACLAUDE_ENV:-$REPO_ROOT/.env}"
# shellcheck source=deployment-constants.sh
source "$REPO_ROOT/scripts/deployment-constants.sh"
# shellcheck source=golden-constants.sh
source "$REPO_ROOT/scripts/golden-constants.sh"
# shellcheck source=fleet-lib.sh
source "$REPO_ROOT/scripts/fleet-lib.sh"

TAG="$GOLDEN_LOCAL"
GENERATED_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --generated) GENERATED_FILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

CURATED_FILE="$REPO_ROOT/scripts/golden-capabilities.md"
if [[ ! -f "$CURATED_FILE" ]]; then
  echo "ERROR: $CURATED_FILE is missing" >&2
  exit 1
fi
GENERATED=""
if [[ -n "$GENERATED_FILE" ]]; then
  GENERATED="$(cat "$GENERATED_FILE")"
fi

DEVBOX_SHARED_SECRET="$(env_secret DEVBOX_SHARED_SECRET)"

BODY="$(GENERATED="$GENERATED" python3 - "$TAG" "$CURATED_FILE" <<'PY'
import json, os, sys
tag, curated_path = sys.argv[1], sys.argv[2]
with open(curated_path) as f:
    curated = f.read()
print(
    json.dumps(
        {
            "goldenTag": tag,
            "curated": curated,
            "generated": os.environ.get("GENERATED", ""),
        }
    )
)
PY
)"

STATUS="$(curl -sS -o /tmp/manifest-response.$$ -w '%{http_code}' \
  -X POST "$CONVEX_SITE_URL/fleet/capability-manifest" \
  -H "content-type: application/json" \
  -H "x-devbox-secret: $DEVBOX_SHARED_SECRET" \
  --data-binary "$BODY")"
if [[ "$STATUS" != "200" ]]; then
  echo "ERROR: upload failed (HTTP $STATUS): $(cat "/tmp/manifest-response.$$")" >&2
  rm -f "/tmp/manifest-response.$$"
  exit 1
fi
rm -f "/tmp/manifest-response.$$"
echo "Capability manifest uploaded for $TAG (curated: $(wc -c < "$CURATED_FILE") bytes, generated: ${#GENERATED} bytes)"
