#!/bin/sh
set -eu

bom=$(printf '\357\273\277')
cr=$(printf '\r')
# Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
read_sheet() {
  if [ "$(od -An -tx1 -N2 "$sheet" | tr -d ' ')" = fffe ]; then iconv -f UTF-16LE -t UTF-8 "$sheet"; else cat "$sheet"; fi
}
hook_off() {
  [ -f "$sheet" ] && [ -r "$sheet" ] && read_sheet | sed -e "1s/^$bom//" -e "s/$cr\$//" | grep -qx 'session hook: off'
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
  if hook_off; then
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

if hook_off; then
  exit 0
fi

# A literal plugin path, so a static reader of hooks.json can follow it.
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
