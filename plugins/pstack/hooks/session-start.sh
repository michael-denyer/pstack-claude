#!/bin/sh
set -eu

# Each runtime's hooks file passes its own name.
case "${1:-}" in
  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;
  codex) sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md" ;;
  copilot) sheet="${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md" ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude, codex, or copilot)" >&2
    exit 2
    ;;
esac

bom=$(printf '\357\273\277')
cr=$(printf '\r')
# Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
read_sheet() {
  if [ "$(od -An -tx1 -N2 "$sheet" | tr -d ' ')" = fffe ]; then iconv -f UTF-16LE -t UTF-8 "$sheet"; else cat "$sheet"; fi
}
if [ -f "$sheet" ] && [ -r "$sheet" ] && read_sheet | sed -e "1s/^$bom//" -e "s/$cr\$//" | grep -qx 'session hook: off'; then
  exit 0
fi

# GitHub Copilot parses stdout as one JSON object. Its sheet sits outside
# Copilot's path sandbox, so the hook checks the sheet and adds its role lines
# to the mandate, and the agent never reads the file.
if [ "$1" = copilot ]; then
  found=0
  if [ -f "$sheet" ] && [ -r "$sheet" ]; then found=1; fi
  if [ "$found" = 1 ]; then read_sheet; fi | LC_ALL=C awk -v found="$found" -v hooks="${COPILOT_PLUGIN_ROOT}/hooks" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/json.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/skills/setup-pstack/scripts/sheet.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/copilot-context.awk"
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
