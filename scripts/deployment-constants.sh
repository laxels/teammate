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
# It only assigns variables; it sets no shell options and runs no commands, so it
# is safe to source under `set -euo pipefail`.
#
# The two Convex endpoints are the SAME deployment's .convex.site and
# .convex.cloud hosts, so CONVEX_URL is DERIVED from CONVEX_SITE_URL (a TLD swap)
# rather than defaulted on its own. That closes the drift #81 exists to kill:
# overriding only CONVEX_SITE_URL (to repoint a run, or to a mock) can no longer
# leave CONVEX_URL pointing at the old deployment — which would send the fleet's
# lock/status/event HTTP calls to one deployment while writing hostagent.env with
# another. Override precedence (each independently honored, both stay in step):
#   CONVEX_SITE_URL  > derived from CONVEX_DEPLOYMENT_SLUG  (default below)
#   CONVEX_URL       > derived from CONVEX_SITE_URL via .convex.site->.convex.cloud
# To repoint the whole fleet at another deployment, set CONVEX_DEPLOYMENT_SLUG
# (e.g. the #30 prod cutover) — both URLs follow.
#
# NOTE: slack-manifest.yaml hardcodes its request URL and can't source shell, so
# it keeps its own pinned copy; keep it in step until the #30 cutover. (The
# GitHub Actions provisioner pins no URL — it runs these scripts, which derive
# everything from the slug below.)

# The Convex deployment slug. The Convex *project* is "teammate"; this is the
# concrete *deployment* (currently the dev deployment, dev:zealous-robin-941).
CONVEX_DEPLOYMENT_SLUG="${CONVEX_DEPLOYMENT_SLUG:-zealous-robin-941}"
CONVEX_SITE_URL="${CONVEX_SITE_URL:-https://${CONVEX_DEPLOYMENT_SLUG}.convex.site}"
# Same deployment as CONVEX_SITE_URL: derive the .convex.cloud host from it so
# the pair can never silently address different deployments. (A real Convex
# deployment's two endpoints differ only by this TLD; a non-matching site URL,
# e.g. a localhost mock, has no .convex.site to swap and simply carries over.)
CONVEX_URL="${CONVEX_URL:-${CONVEX_SITE_URL/.convex.site/.convex.cloud}}"
# The tailnet DNS suffix; VMs/hosts get deterministic <name>.<suffix> names.
TAILNET_SUFFIX="${TAILNET_SUFFIX:-tail4d21c4.ts.net}"
