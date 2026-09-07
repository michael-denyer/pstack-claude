#!/usr/bin/env bash
# Behavioral check for the pstack plugin layout (#22, CHANGES 0.9.13).
#
# Claude Code renders a plugin's commands AND its user-invocable skills in the
# slash menu, so a command trampoline paired with a same-named skill shows the
# entry twice. 0.9.13 moved the trampolines to .codex-plugin/prompts/ and left
# the Claude Code plugin with no commands/. That works only if a user-typed
# /plugin:name still reaches the skill on its own; this script proves it with
# one haiku call. If it fails, upstream changed slash resolution: re-read #22
# and CHANGES 0.9.13 before reintroducing commands/. Last verified on 2.1.245.
#
# The static layout invariants (no commands/, flag discipline, namespaced agent
# dispatch) run inside tools/generate.mjs; tests/invariants.test.mjs proves
# each can fail. This leg needs the claude CLI and API access, so CI does not
# run it. Run it locally before a release.
set -euo pipefail

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
if [[ "$out" == *SKILL-RAN* ]]; then
  printf '%s\n' "ok: user-typed /plugin:name reaches the skill with no commands/ present"
else
  printf '%s\n' "FAIL: /testplug:foo did not run the skill, got: $out"
  exit 1
fi
