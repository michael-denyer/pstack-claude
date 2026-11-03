#!/bin/sh
set -eu

# Each runtime's hooks file passes its own name. MiniMax Code runs Claude
# Code's hooks file, so it is known by the MINIMAX_PLUGIN_ROOT it sets.
runtime="${1:-}"
if [ "$runtime" = claude ] && [ -n "${MINIMAX_PLUGIN_ROOT:-}" ]; then
  runtime=minimax
fi

# Literal plugin paths, so a static reader of the hooks files can follow them.
case "$runtime" in
  claude)
    sheet="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/pstack-models.md"
    reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  minimax)
    # MiniMax Code withholds MINIMAX_DATA_DIR from hooks and its bash tool.
    sheet="$HOME/.minimax/pstack-models.md"
    reader="${MINIMAX_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  codex)
    sheet="${CODEX_HOME:-$HOME/.codex}/pstack-models.md"
    reader="${CLAUDE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  copilot)
    sheet="${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md"
    reader="${COPILOT_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  muse)
    # On Windows the manifest's PowerShell hook owns Muse. `uname -s` names a
    # Windows sh, busybox-w32's as Windows_NT, and OS covers one without uname.
    case "$(uname -s 2>/dev/null || true)" in
      MINGW*|MSYS*|CYGWIN*|Windows_NT) exit 0 ;;
    esac
    [ "${OS:-}" != Windows_NT ] || exit 0
    sheet="${XDG_CONFIG_HOME:-$HOME/.config}/muse/pstack-models.md"
    reader="${MUSE_PLUGIN_ROOT}/skills/setup-pstack/scripts/read-sheet.sh"
    ;;
  *)
    echo "session-start.sh: unknown runtime '${1:-}' (expected claude, codex, copilot, or muse)" >&2
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
# to the mandate, and the agent never reads the file. The hooks directory goes
# through the environment, since awk expands backslash escapes in a -v value.
if [ "$runtime" = copilot ]; then
  printf '%s\n' "$normalized" | PSTACK_HOOKS="${COPILOT_PLUGIN_ROOT}/hooks" LC_ALL=C awk -v found="$found" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/json.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/skills/setup-pstack/scripts/sheet.awk" \
    -f "${COPILOT_PLUGIN_ROOT}/hooks/copilot-context.awk"
  exit 0
fi

# Muse reads stdout as plain additional context. Its sheet has no include
# mechanism, so the hook adds the sheet's known role lines to the Muse
# mandate itself, rebuilt from their checked values.
if [ "$runtime" = muse ]; then
  printf '%s\n' "$normalized" | PSTACK_HOOKS="${MUSE_PLUGIN_ROOT}/hooks" LC_ALL=C awk -v found="$found" \
    -f "${MUSE_PLUGIN_ROOT}/skills/setup-pstack/scripts/sheet.awk" \
    -f "${MUSE_PLUGIN_ROOT}/hooks/muse-context.awk"
  exit 0
fi

if [ "$runtime" = minimax ]; then
  cat "${MINIMAX_PLUGIN_ROOT}/hooks/session-start-minimax.md"
  exit 0
fi

cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
