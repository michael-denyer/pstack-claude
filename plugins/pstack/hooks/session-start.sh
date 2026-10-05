#!/bin/sh
set -eu

# Each runtime's hooks file passes its own name.
# Literal plugin paths, so a static reader of the hooks files can follow them.
case "${1:-}" in
  claude)
    sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md"
    reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  codex)
    sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md"
    reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  copilot)
    sheet="${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md"
    reader="${COPILOT_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude, codex, or copilot)" >&2
    exit 2
    ;;
esac

# A sheet that cannot be decoded counts as missing, so injection stays on.
found=0
if [ -f "$sheet" ] && [ -r "$sheet" ] && normalized=$(sh "$reader" "$sheet"); then
  found=1
else
  normalized=
fi
if printf '%s\n' "$normalized" | grep -qx 'session hook: off'; then
  exit 0
fi

# GitHub Copilot parses stdout as one JSON object. Its sheet sits outside
# Copilot's path sandbox, so the hook checks the sheet and adds its role lines
# to the mandate, and the agent never reads the file.
if [ "$1" = copilot ]; then
  printf '%s\n' "$normalized" | LC_ALL=C awk -v found="$found" -v hooks="${COPILOT_PLUGIN_ROOT}/hooks" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/json.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/skills/setup-pstack/scripts/sheet.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/copilot-context.awk"
  exit 0
fi

cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
