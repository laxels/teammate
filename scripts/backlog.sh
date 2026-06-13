#!/usr/bin/env bash
#
# Backlog helper for the Teammate Backlog GitHub project
# (https://github.com/users/laxels/projects/1). Priority lives ONLY in the
# project's single-select Priority field — no priority labels.
#
# Usage: scripts/backlog.sh list
#          Open issues in priority order (P0 first; project rank within a
#          tier). Open issues not yet in the project show as UNTRACKED.
#        scripts/backlog.sh set <issue#> <P0|P1|P2>
#          Set an issue's priority, adding it to the project if needed.
#
# Requires: gh (token with the `project` scope), jq.

set -euo pipefail

OWNER=laxels
REPO=laxels/teammate
PROJECT_NUMBER=1
# Stable GraphQL IDs. If the project or field is ever recreated, refresh with
# `gh project list` / `gh project field-list 1 --owner laxels --format json`.
PROJECT_ID=PVT_kwHOAApqnc4BahB-
PRIORITY_FIELD_ID=PVTSSF_lAHOAApqnc4BahB-zhVYIWI

option_id() {
  case "$1" in
    P0) echo da1146d2 ;;
    P1) echo 5bb99df4 ;;
    P2) echo 57a11fd7 ;;
    *) echo "priority must be P0, P1, or P2" >&2; exit 1 ;;
  esac
}

project_items() {
  gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json -L 1000 \
    | jq --arg repo "$REPO" '[.items[] | select(.content.repository == $repo)]'
}

cmd_list() {
  local items issues
  items=$(project_items)
  issues=$(gh issue list --repo "$REPO" --state open --json number,title -L 1000)
  jq -nr --argjson items "$items" --argjson issues "$issues" '
    ($items | to_entries
      | map({key: (.value.content.number | tostring),
             value: {priority: (.value.priority // "(none)"), rank: .key}})
      | from_entries) as $by_number
    | $issues
    | map(. + ($by_number[.number | tostring] // {priority: "UNTRACKED", rank: 0}))
    | sort_by([({P0: 0, P1: 1, P2: 2, "(none)": 3, UNTRACKED: 4}[.priority]), .rank])
    | .[] | [.priority, "#\(.number)", .title] | @tsv'
}

cmd_set() {
  local issue="$1" prio="$2" opt item_id
  opt=$(option_id "$prio")
  item_id=$(project_items | jq -r --argjson n "$issue" \
    '.[] | select(.content.number == $n) | .id')
  if [[ -z "$item_id" ]]; then
    item_id=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" \
      --url "https://github.com/$REPO/issues/$issue" --format json | jq -r .id)
  fi
  gh project item-edit --id "$item_id" --project-id "$PROJECT_ID" \
    --field-id "$PRIORITY_FIELD_ID" --single-select-option-id "$opt" > /dev/null
  echo "#$issue -> $prio"
}

case "${1:-}" in
  list) cmd_list ;;
  set)
    if [[ $# -ne 3 ]]; then
      echo "Usage: $0 set <issue#> <P0|P1|P2>" >&2
      exit 1
    fi
    cmd_set "$2" "$3"
    ;;
  *)
    echo "Usage: $0 list | $0 set <issue#> <P0|P1|P2>" >&2
    exit 1
    ;;
esac
