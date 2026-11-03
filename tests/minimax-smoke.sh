#!/usr/bin/env bash
# MiniMax Code smoke test for the pstack plugin.
#
# Installs MiniMax Code into a throwaway npm prefix, or uses $MCODE, copies this
# checkout's plugin into a throwaway MINIMAX_DATA_DIR as a local plugin, and
# proves from `mcode plugin list --json`:
#   1. MiniMax Code finds pstack as pstack@local, enabled, at this checkout's
#      VERSION, reading the Claude Code manifest
#   2. it loads every skill directory and every plugin agent
#
# Needs node, jq, and npm unless MCODE names an installed `mcode`. Makes no
# model calls and needs no sign-in. Skips with exit 0 when neither npm nor
# MCODE is available. CI does not run it.
#
#   tests/minimax-smoke.sh                        # installs @minimax-ai/code@0.7.4
#   MCODE_VERSION=0.7.5 tests/minimax-smoke.sh
#   MCODE=/path/to/node_modules/.bin/mcode tests/minimax-smoke.sh
#   KEEP=1 tests/minimax-smoke.sh                 # keep the temp dir; a failed run always keeps it
set -euo pipefail

if [ -z "${MCODE:-}" ] && ! command -v npm >/dev/null 2>&1; then
  echo "skip: npm not found and MCODE not set"
  exit 0
fi
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/.." && pwd -P)"
root="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/pstack-minimax-smoke.XXXXXX")" && pwd -P)"
data="$root/data"
passed=0

cleanup() {
  status=$?
  if [ "$status" -eq 0 ] && [ -z "${KEEP:-}" ]; then
    # MiniMax Code snapshots the plugin into a read-only hook cache.
    chmod -R u+w "$root"
    rm -rf "$root"
  else
    echo "kept: $root"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  passed=$((passed + 1))
  echo "ok: $*"
}

mcode="${MCODE:-}"
if [ -z "$mcode" ]; then
  version="${MCODE_VERSION:-0.7.4}"
  npm install --prefix "$root/mcode" --no-audit --no-fund "@minimax-ai/code@$version" >"$root/npm.log" 2>&1 ||
    fail "npm install @minimax-ai/code@$version failed; see $root/npm.log"
  mcode="$root/mcode/node_modules/.bin/mcode"
fi
echo "mcode $("$mcode" --version)"

mkdir -p "$data/plugins"
# A checkout that ran the scripts' tests has node_modules no install carries.
tar -C "$repo/plugins" --exclude node_modules -cf - pstack | tar -C "$data/plugins" -xf -

list="$(MINIMAX_DATA_DIR="$data" "$mcode" plugin list --json)"
entry="$(jq -c '.installed[] | select(.pluginId == "pstack@local")' <<<"$list")"
[ -n "$entry" ] || fail "pstack@local is not installed: $list"

want_version="$(tr -d '[:space:]' <"$repo/VERSION")"
claude_name="$(jq -r .displayName "$repo/plugins/pstack/.claude-plugin/plugin.json")"
jq -e --arg v "$want_version" --arg n "$claude_name" '.enabled == true and .version == $v and .displayName == $n' <<<"$entry" >/dev/null ||
  fail "pstack@local is not the enabled Claude Code build at $want_version: $entry"
pass "pstack@local enabled at $want_version, read from .claude-plugin/plugin.json"

skills="$(find "$repo/plugins/pstack/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
agents="$(find "$repo/plugins/pstack/agents" -mindepth 1 -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')"
jq -e --argjson s "$skills" --argjson a "$agents" '.capabilities.skillCount == $s and .capabilities.agentCount == $a' <<<"$entry" >/dev/null ||
  fail "expected $skills skills and $agents agents: $(jq -c .capabilities <<<"$entry")"
pass "$skills skills and $agents agents loaded"

echo "$passed checks passed"
