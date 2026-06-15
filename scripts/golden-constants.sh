# shellcheck shell=bash
#
# Single source of truth for the fleet's golden-image pin (issue #89). One line —
# GOLDEN_VERSION — names WHICH golden every fleet op converges on; the ghcr remote
# and the local tart image name derive from it. Bumping this constant and running
# the golden-refresh (scripts/refresh-golden.sh / .github/workflows/refresh-golden.yml)
# is the "one coherent op" that lands a new golden on BOTH new and existing hosts:
#   - new hosts:      provision-host.sh pulls+clones $GOLDEN_REMOTE -> $GOLDEN_LOCAL,
#                     adopt-host.sh writes GOLDEN_IMAGE=$GOLDEN_LOCAL into hostagent.env
#   - existing hosts: refresh-golden.sh drains each warm host, pulls+clones the new
#                     image, and rewrites GOLDEN_IMAGE in its hostagent.env
#
# Mirrors deployment-constants.sh (issue #81): SOURCE this file, don't exec it. It
# only assigns variables — no shell options, no commands — so it is safe to source
# under `set -euo pipefail`:
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/golden-constants.sh"
#
# Every value stays env-overridable so a one-off run can target another tag
# (e.g. a rollback to the previous golden) without editing the file:
#   GOLDEN_VERSION=v4 scripts/refresh-golden.sh
#
# The hostagent's TypeScript default (hostagent/src/config.ts, env.GOLDEN_IMAGE ||
# "golden-vN") is a runtime FALLBACK only — adopt-host.sh / refresh-golden.sh write
# the authoritative GOLDEN_IMAGE into hostagent.env from $GOLDEN_LOCAL, and that env
# LEADS the rollout. That fallback deliberately LAGS this pin (a golden guaranteed
# present on every host): deploy-payload ships the hostagent code independently of
# which goldens a host has pulled, so a fallback ahead of the pin would make a host
# with no GOLDEN_IMAGE clone a missing image. Advance it only after a roll lands.

# The golden version tag (the ghcr image tag and the local-image suffix).
GOLDEN_VERSION="${GOLDEN_VERSION:-v5}"
# The ghcr image the fleet pulls. Private repo; pulled with GITHUB_PAT.
GOLDEN_REMOTE="${GOLDEN_REMOTE:-ghcr.io/laxels/ultraclaude-golden:${GOLDEN_VERSION}}"
# The local tart image name VMs are cloned from (hostagent GOLDEN_IMAGE).
GOLDEN_LOCAL="${GOLDEN_LOCAL:-golden-${GOLDEN_VERSION}}"
