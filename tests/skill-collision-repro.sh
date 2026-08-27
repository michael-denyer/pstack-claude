#!/usr/bin/env bash
# Regression checks for the pstack plugin layout (CHANGES 0.9.7-0.9.13).
#
# Claude Code renders a plugin's commands AND its user-invocable skills in the
# slash menu, so a command trampoline paired with a same-named skill shows the
# entry twice (#22). 0.9.13 moved the trampolines to .codex-plugin/prompts/,
# where only the Codex symlink path reads them. The invariant here keeps a
# future upstream sync from reintroducing plugins/pstack/commands/.
#
# This also enforces the static maintenance invariants from CHANGES.md: the
# principle-* leaf flags. The static checks need no CLI; only the behavioral
# leg below does. (Version parity, the model quad, and prompt<->skill
# correspondence are no longer checked here: tools/generate.mjs stamps each
# from its source file and CI regenerates and diffs, so none can drift on a
# green build.)
#
# Each static check is a function that prints one finding per line; empty
# output is a pass. `check` names it in the report. tests/invariants.test.mjs
# runs this script against fixture trees (via PSTACK_REPO) to prove every
# check still fails when it should.
#
# Manual test: the behavioral leg needs the claude CLI and API access; one haiku call.
set -euo pipefail

repo="${PSTACK_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0

note() { printf '%s\n' "$*"; }
frontmatter_of() { sed -n '2,/^---$/p' "$1"; }

# check <name> <fn>: run fn, report ok/FAIL under name, indent its findings.
check() {
  local name="$1" fn="$2" out
  out="$("$fn")"
  if [ -n "$out" ]; then
    note "FAIL: $name"
    printf '%s\n' "$out" | sed 's/^/  /'
    fail=1
  else
    note "ok: $name"
  fi
}

# (0.9.13, #22): the Claude Code plugin ships no commands/. Every /pstack:<name>
# is served by the skill itself; a commands/ directory reappearing (typically
# via an upstream sync) duplicates every slash-menu row.
no_commands_dir() {
  [ -e "$repo/plugins/pstack/commands" ] &&
    echo "plugins/pstack/commands/ exists; trampolines belong in .codex-plugin/prompts/ (see CHANGES 0.9.13)"
  return 0
}

# (CHANGES 0.9.8): no skill may carry disable-model-invocation. On a skill the
# flag makes the Skill tool refuse the invocation outright, which breaks the
# SessionStart mandate and model-initiated entry. Frontmatter only: skill
# bodies may mention the flag in prose (automate-me does).
no_disable_model_invocation() {
  local skill
  for skill in "$repo"/plugins/pstack/skills/*/SKILL.md; do
    frontmatter_of "$skill" | grep -q '^disable-model-invocation: true$' && echo "$skill"
  done
  return 0
}

# (CHANGES 0.9.9): every command-less principle-* leaf carries
# user-invocable: false (hidden from the / menu, read by path from poteto-mode)
# and NOT disable-model-invocation (the pair cancels to a dead skill).
principle_leaves_hidden() {
  local skill front
  for skill in "$repo"/plugins/pstack/skills/principle-*/SKILL.md; do
    [ -f "$skill" ] || continue
    front="$(frontmatter_of "$skill")"
    printf '%s\n' "$front" | grep -q '^user-invocable: false$' || echo "$skill (missing user-invocable: false)"
    printf '%s\n' "$front" | grep -q '^disable-model-invocation: true$' && echo "$skill (still carries disable-model-invocation)"
  done
  return 0
}

check "no plugins/pstack/commands/ directory" no_commands_dir
check "no skill carries disable-model-invocation: true" no_disable_model_invocation
check "principle-* leaves carry user-invocable: false and not disable-model-invocation" principle_leaves_hidden

# Behavioral leg: a command-less plugin still serves the user-typed /plugin:name
# via the skill alone. This is the assumption that lets pstack live without
# trampolines; if it fails, upstream changed slash resolution — re-read #22 and
# CHANGES 0.9.13 before reintroducing commands/. Last verified on 2.1.245.
#
# Needs the claude CLI and API access, so CI sets SKIP_BEHAVIORAL=1 and runs the
# static invariants only. Run it locally before a release.
if [ -n "${SKIP_BEHAVIORAL:-}" ]; then
  note "skip: behavioral leg (SKIP_BEHAVIORAL set); static invariants only"
  exit "$fail"
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.claude-plugin" "$scratch/skills/foo"
printf '%s\n' '{"name": "testplug", "version": "0.0.1", "description": "skill-only slash repro"}' \
  > "$scratch/.claude-plugin/plugin.json"
cat > "$scratch/skills/foo/SKILL.md" <<'EOF'
---
name: foo
description: skill-only slash test
---

Say exactly: SKILL-RAN
Then stop. Do not invoke any skill or tool.
EOF

out="$(claude -p --plugin-dir "$scratch" --model haiku --max-turns 3 '/testplug:foo' < /dev/null 2>&1)"
if printf '%s' "$out" | grep -q 'SKILL-RAN'; then
  note "ok: user-typed /plugin:name reaches the skill with no commands/ present"
else
  note "FAIL: /testplug:foo did not run the skill, got: $out"
  fail=1
fi

exit "$fail"
