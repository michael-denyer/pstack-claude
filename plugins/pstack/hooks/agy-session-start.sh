#!/bin/sh
set -eu

HOOKS_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$HOOKS_DIR")"
READER="$PLUGIN_ROOT/skills/setup-pstack/scripts/read-sheet.sh"
SHEET="$HOME/.gemini/config/pstack-models.md"

if [ -f "$SHEET" ] && [ -r "$SHEET" ] && normalized=$(sh "$READER" "$SHEET" 2>/dev/null); then
  if printf '%s\n' "$normalized" | grep -qx 'session hook: off'; then
    printf '{}\n'
    exit 0
  fi
fi

LC_ALL=C awk -f "$HOOKS_DIR/json.awk" -f "$HOOKS_DIR/agy-context.awk" "$HOOKS_DIR/session-start-agy.md"
