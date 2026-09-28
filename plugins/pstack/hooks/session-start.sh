#!/bin/sh
set -eu

# Codex exports PLUGIN_ROOT; Claude Code exports only CLAUDE_PLUGIN_ROOT, which
# Codex also sets as an alias, so PLUGIN_ROOT is the only usable runtime tell.
if [ -n "${PLUGIN_ROOT:-}" ]; then
  sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md"
else
  sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md"
fi

if grep -qs '^session hook: off$' "$sheet"; then
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
