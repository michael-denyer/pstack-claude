#!/bin/sh
set -eu

# Only an exact `session hook: off` line disables injection, with LF or CRLF
# endings and an optional byte-order mark. An unreadable sheet leaves it on.
bom=$(printf '\357\273\277')
hook_off() {
  [ -f "$1" ] && [ -r "$1" ] && sed "1s/^$bom//" "$1" | tr -d '\r' | grep -qx 'session hook: off'
}

# GitHub Copilot reads hooks.json too, so it passes `claude`, but it also
# exports COPILOT_PLUGIN_ROOT and parses stdout as one JSON object. It gets the
# generator-stamped JSON copy of the mandate, and while no Copilot sheet exists
# or can be read, the copy that says to run setup-pstack first.
if [ -n "${COPILOT_PLUGIN_ROOT:-}" ]; then
  hooks=$(dirname "$0")
  sheet="${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md"
  if [ ! -f "$sheet" ] || [ ! -r "$sheet" ]; then
    cat "$hooks/session-start-context-nosheet.json"
    exit 0
  fi
  if hook_off "$sheet"; then
    exit 0
  fi
  # The sheet sits outside Copilot's path sandbox, so the hook puts its role
  # lines in place of the stamped marker and the agent never reads the file.
  exec env LC_ALL=C PSTACK_SHEET="$sheet" awk -f "$hooks/json.awk" -f "$hooks/sheet.awk" \
    -f "$hooks/saved-model-choices.awk" "$hooks/session-start-context.json"
fi

# Each runtime's hooks file passes its own name.
case "${1:-}" in
  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;
  codex) sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md" ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude or codex)" >&2
    exit 2
    ;;
esac

if hook_off "$sheet"; then
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
