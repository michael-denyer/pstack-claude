#!/bin/sh
set -eu

# Each runtime's hooks file passes its own name.
case "${1:-}" in
  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;
  codex) sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md" ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude or codex)" >&2
    exit 2
    ;;
esac

bom=$(printf '\357\273\277')
if [ -f "$sheet" ] && [ -r "$sheet" ] && sed "1s/^$bom//" "$sheet" | tr -d '\r' | grep -qx 'session hook: off'; then
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
