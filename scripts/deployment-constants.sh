# shellcheck shell=bash
#
# Single source of truth for the fleet scripts' deployment-identity constants
# (issue #81). These name WHICH Convex deployment and tailnet the fleet talks
# to — not secrets, so they live in-repo. The host agent reads the same concepts
# from its own env (hostagent/src/config.ts); these are the values the
# provisioning scripts write INTO that env.
#
# SOURCE this file (don't exec it):
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/deployment-constants.sh"
# It only assigns variables; it sets no shell options and runs no commands, so
# it is safe to source under `set -euo pipefail`.
#
# Every value is overridable from the environment, so a caller can point a run
# at a different deployment without editing this file — the GitHub Actions
# provisioner injects CONVEX_SITE_URL, and the #30 prod cutover will set the
# slug. When no override is present the pinned dev defaults below apply.
#
# NOTE: the YAML manifests that can't source shell — slack-manifest.yaml and
# .github/workflows/provision-host.yml — still carry their own pinned copies of
# these URLs. Keep them in step with this file until the #30 prod cutover
# parameterizes them.

# The Convex deployment slug. The Convex *project* is "teammate"; this is the
# concrete *deployment* (currently the dev deployment, dev:zealous-robin-941).
CONVEX_DEPLOYMENT_SLUG="${CONVEX_DEPLOYMENT_SLUG:-zealous-robin-941}"
# The deployment's two public URLs, derived from the slug.
CONVEX_SITE_URL="${CONVEX_SITE_URL:-https://${CONVEX_DEPLOYMENT_SLUG}.convex.site}"
CONVEX_URL="${CONVEX_URL:-https://${CONVEX_DEPLOYMENT_SLUG}.convex.cloud}"
# The tailnet DNS suffix; VMs/hosts get deterministic <name>.<suffix> names.
TAILNET_SUFFIX="${TAILNET_SUFFIX:-tail4d21c4.ts.net}"
