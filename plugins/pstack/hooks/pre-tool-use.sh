#!/bin/sh
# GitHub Copilot only. pre-tool-use.awk decides the call: it approves `view` of
# this plugin's own files and the strict form of a vendored script run, and it
# denies a pstack agent dispatch on a model the user did not save and a model
# sheet write that drops a role or a panel's second vendor. Anything else gets
# no output and takes the normal permission flow.
# Copilot denies the call when this hook exits non-zero, so every path exits 0,
# and output from a failed awk run is dropped.
[ -n "${COPILOT_PLUGIN_ROOT:-}" ] || exit 0
hooks=$(dirname "$0")
sheet="${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md"
real=$(cd "$COPILOT_PLUGIN_ROOT" 2>/dev/null && pwd -P) || real=
sheet_dir=$(cd "$(dirname "$sheet")" 2>/dev/null && pwd -P) || sheet_dir=
out=$(LC_ALL=C PSTACK_ROOT="${COPILOT_PLUGIN_ROOT%/}" PSTACK_REAL_ROOT="$real" PSTACK_SHEET="$sheet" \
  PSTACK_SHEET_REAL="${sheet_dir:+$sheet_dir/pstack-models.md}" \
  awk -f "$hooks/json.awk" -f "$hooks/sheet.awk" -f "$hooks/pre-tool-use.awk" 2>/dev/null) || out=
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
