#!/usr/bin/env bash
# Repro and regression check for the command/skill name-collision fix (CHANGES 0.9.7).
#
# The Skill tool resolves a name shared by commands/<name>.md and
# skills/<name>/SKILL.md to the command; disable-model-invocation: true on the
# command flips resolution to the skill. That precedence is UNDOCUMENTED
# upstream, so re-run this after Claude Code upgrades. Last verified on 2.1.195.
#
# Manual test: needs the claude CLI and API access; makes four haiku calls.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

note() { printf '%s\n' "$*"; }

# Static invariant: every command trampoline carries the flag.
missing="$(grep -L 'disable-model-invocation: true' "$repo"/plugins/pstack/commands/*.md || true)"
if [ -n "$missing" ]; then
  note "FAIL: commands missing 'disable-model-invocation: true':"
  note "$missing"
  fail=1
else
  note "ok: all commands carry disable-model-invocation: true"
fi

# Mirror invariant (CHANGES 0.9.8): no skill that has a same-named command may
# carry the flag. Every command body is "invoke the skill", so a flagged skill
# makes the Skill tool refuse both the model path and the user-typed /command.
# principle-* leaves have no commands and keep the flag (read by path).
flagged=""
for cmd in "$repo"/plugins/pstack/commands/*.md; do
  skill="$repo/plugins/pstack/skills/$(basename "$cmd" .md)/SKILL.md"
  # Frontmatter only (lines between the opening and closing ---): skill bodies
  # may legitimately mention the flag in prose (automate-me does).
  if [ -f "$skill" ] && sed -n '2,/^---$/p' "$skill" | grep -q '^disable-model-invocation: true$'; then
    flagged="$flagged$skill"$'\n'
  fi
done
if [ -n "$flagged" ]; then
  note "FAIL: skills with a same-named command must not carry 'disable-model-invocation: true':"
  note "$flagged"
  fail=1
else
  note "ok: no command-paired skill carries disable-model-invocation: true"
fi

# Behavioral checks against a minimal colliding plugin.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/.claude-plugin" "$scratch/commands" "$scratch/skills/foo"
printf '%s\n' '{"name": "testplug", "version": "0.0.1", "description": "collision repro"}' \
  > "$scratch/.claude-plugin/plugin.json"
cat > "$scratch/skills/foo/SKILL.md" <<'EOF'
---
name: foo
description: collision test skill
---

Say exactly: SKILL-RAN
Then stop. Do not invoke any skill or tool.
EOF

write_command() { # $1 = extra frontmatter line ("" for none)
  {
    printf -- '---\nname: foo\ndescription: collision test command\n'
    [ -n "$1" ] && printf '%s\n' "$1"
    printf -- '---\n\nSay exactly: CMD-RAN\nThen stop. Do not invoke any skill or tool.\n'
  } > "$scratch/commands/foo.md"
}

run() {
  claude -p --plugin-dir "$scratch" --model haiku --max-turns 3 "$1" < /dev/null 2>&1
}

check() { # $1 label, $2 expected marker, $3 output
  if printf '%s' "$3" | grep -q "$2"; then
    note "ok: $1 -> $2"
  else
    note "FAIL: $1 expected $2, got: $3"
    fail=1
  fi
}

invoke='Call the Skill tool with skill "testplug:foo" exactly once and follow what it says.'

# Precedence detector: without the flag, the command wins. If this check ever
# fails, upstream changed the (undocumented) resolution order — revisit whether
# the flag is still needed rather than treating the fix as broken.
write_command ""
check "collision without flag: Skill tool resolves to command" "CMD-RAN" "$(run "$invoke")"

# The fix: with the flag, the Skill tool reaches the skill...
write_command "disable-model-invocation: true"
check "collision with flag: Skill tool resolves to skill" "SKILL-RAN" "$(run "$invoke")"

# ...and the user-typed command still runs.
check "collision with flag: /command still runs the command" "CMD-RAN" "$(run '/testplug:foo')"

# The 0.9.8 regression: the flag on the SKILL blocks the Skill tool outright,
# so a flagged skill is unreachable even once the command stops shadowing it.
cat > "$scratch/skills/foo/SKILL.md" <<'EOF'
---
name: foo
description: collision test skill
disable-model-invocation: true
---

Say exactly: SKILL-RAN
Then stop. Do not invoke any skill or tool.
EOF
out="$(run "$invoke")"
if printf '%s' "$out" | grep -q 'SKILL-RAN'; then
  note "FAIL: flagged skill unexpectedly ran via Skill tool: $out"
  fail=1
else
  note "ok: flag on the skill blocks Skill-tool invocation (0.9.8 regression guard)"
fi

exit "$fail"
