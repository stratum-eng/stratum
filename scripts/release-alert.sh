#!/usr/bin/env bash
# Keep one open `release-blocked` issue while releases are failing, so an agent
# or person has a single thing to watch and a daily failure can't flood the
# tracker. Usage: release-alert.sh open <workflow name> | release-alert.sh close
set -euo pipefail

LABEL="release-blocked"
RUN_URL="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
OPEN="$(gh issue list --state open --label "$LABEL" --json number --jq '.[0].number // empty')"

case "${1:-}" in
  open)
    if [ -n "$OPEN" ]; then
      gh issue comment "$OPEN" --body "${2:-A release workflow} failed again: $RUN_URL"
    else
      gh label create "$LABEL" --force --color B60205 \
        --description "A release could not be cut or published"
      gh issue create --label "$LABEL" --title "Releases are blocked" --body \
"${2:-A release workflow} failed: $RUN_URL

Find the cause in that run and fix it. See \"When a release is blocked\" in \`docs/developer/releasing.md\`. This issue closes itself when a release next publishes."
    fi
    ;;
  close)
    if [ -n "$OPEN" ]; then
      gh issue close "$OPEN" --comment "Published successfully: $RUN_URL"
    fi
    ;;
  *)
    echo "usage: release-alert.sh open <workflow name> | close" >&2
    exit 2
    ;;
esac
