#!/bin/sh
set -eu

# Each runtime's hooks file passes its own name.
case "${1:-}" in
  claude) sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md" ;;
  codex) sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md" ;;
  pi) sheet="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pstack-models.md" ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude, codex, or pi)" >&2
    exit 2
    ;;
esac

if grep -qs '^session hook: off$' "$sheet"; then
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
if [ "${1:-}" = "pi" ]; then
  sed 's/`pstack:/`/g' "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
else
  cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
fi
