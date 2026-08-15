#!/usr/bin/env bash
# Repro and regression check for the command/skill name-collision fix (CHANGES 0.9.7).
#
# The Skill tool resolves a name shared by commands/<name>.md and
# skills/<name>/SKILL.md to the command; disable-model-invocation: true on the
# command flips resolution to the skill. That precedence is UNDOCUMENTED
# upstream, so re-run this after Claude Code upgrades. Last verified on 2.1.195.
#
# Beyond the collision repro, this enforces the static maintenance invariants from
# CHANGES.md: the command/skill/leaf flags, version parity across the three manifests,
# and the default model quad's identity across the panel skills and setup-pstack. The
# static checks need no CLI; only the behavioral legs below do.
#
# Manual test: the behavioral legs need the claude CLI and API access; four haiku calls.
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
# The command-less principle-* leaves use user-invocable: false instead (0.9.9).
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

# Principle invariant (CHANGES 0.9.9): every command-less principle-* leaf carries
# user-invocable: false (hidden from the / menu, read by path from poteto-mode) and
# NOT disable-model-invocation (the pair cancels to a dead skill).
bad_principle=""
for skill in "$repo"/plugins/pstack/skills/principle-*/SKILL.md; do
  front="$(sed -n '2,/^---$/p' "$skill")"
  printf '%s\n' "$front" | grep -q '^user-invocable: false$' || bad_principle="$bad_principle$skill (missing user-invocable: false)"$'\n'
  printf '%s\n' "$front" | grep -q '^disable-model-invocation: true$' && bad_principle="$bad_principle$skill (still carries disable-model-invocation)"$'\n'
done
if [ -n "$bad_principle" ]; then
  note "FAIL: principle-* leaves must carry user-invocable: false and not disable-model-invocation:"
  note "$bad_principle"
  fail=1
else
  note "ok: all principle-* leaves carry user-invocable: false"
fi

# Static invariant (CHANGES maintenance note): the plugin version string is
# duplicated across three manifests and must move together on a bump.
verof() { { grep -m1 '"version"' "$1" || true; } | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }
vc="$(verof "$repo/plugins/pstack/.claude-plugin/plugin.json")"
vx="$(verof "$repo/plugins/pstack/.codex-plugin/plugin.json")"
vm="$(verof "$repo/.claude-plugin/marketplace.json")"
if [ -n "$vc" ] && [ "$vc" = "$vx" ] && [ "$vc" = "$vm" ]; then
  note "ok: plugin version matches across the 3 manifests ($vc)"
else
  note "FAIL: plugin version differs across manifests: claude-plugin=$vc codex-plugin=$vx marketplace=$vm"
  fail=1
fi

# Static invariant (CHANGES maintenance note): the default model quad is duplicated
# verbatim across the four panel skills and the setup-pstack sheet, "kept grep-identical
# when models change." Derive the canonical ordered quad from setup-pstack's arena-runners
# row and assert every other copy matches, so a partial model bump fails here instead of
# drifting silently. (This copy in the test is the assertion anchor; a single generated
# source for the quad would retire all of them, this check included.)
setup="$repo/plugins/pstack/skills/setup-pstack/SKILL.md"
quad_of() { { grep -oE 'claude-[a-z0-9-]+' || true; } | tr '\n' ' ' | sed 's/ $//'; }
canon_quad="$(grep -m1 '^arena runners:' "$setup" | quad_of || true)"
quad_anchor="${canon_quad##* }"
quad_bad=""
[ -n "$canon_quad" ] || quad_bad="could not read the canonical quad from $setup (arena runners row)"$'\n'
# Each panel skill states the quad on its one line naming the canonical final member.
for name in arena architect how interrogate; do
  skill="$repo/plugins/pstack/skills/$name/SKILL.md"
  n="$(grep -Fc "$quad_anchor" "$skill" || true)"
  if [ "$n" != "1" ]; then
    quad_bad="$quad_bad$skill: expected exactly 1 default-quad line, found $n"$'\n'
    continue
  fi
  got="$(grep -F "$quad_anchor" "$skill" | quad_of)"
  [ "$got" = "$canon_quad" ] || quad_bad="$quad_bad$skill: [$got] != [$canon_quad]"$'\n'
done
# The setup-pstack role rows must all carry the same quad (excludes the line 24
# "currently available" enumeration, which is a different, longer list by design).
while IFS= read -r line; do
  got="$(printf '%s\n' "$line" | quad_of)"
  [ "$got" = "$canon_quad" ] || quad_bad="$quad_bad$setup role row: [$got] != [$canon_quad]"$'\n'
done < <(grep -E '^(arena runners|architect runners|interrogate reviewers|how critics):' "$setup")
if [ -n "$quad_bad" ]; then
  note "FAIL: the default model quad is not identical across the panel skills and setup-pstack:"
  note "$quad_bad"
  fail=1
else
  note "ok: default model quad identical across 4 panel skills + setup-pstack ($canon_quad)"
fi

# Static invariant: fixed-model Codex agent profiles own their dispatch settings.
codex_tools="$repo/plugins/pstack/skills/poteto-mode/references/codex-tools.md"
plan="$repo/plugins/pstack/skills/poteto-mode/references/plan.md"
fixed_dispatch_bad=""
fixed_check() { grep -Fq "$2" "$1" || fixed_dispatch_bad="$fixed_dispatch_bad$3"$'\n'; }
fixed_line_check() { grep -F "$2" "$1" | grep -Fq "$3" || fixed_dispatch_bad="$fixed_dispatch_bad$4"$'\n'; }
fixed_check "$codex_tools" 'Generic explicit model overrides' "$codex_tools: generic overrides are not distinguished"
fixed_check "$codex_tools" 'fixed-model custom' "$codex_tools: fixed-model custom agent_type profiles are not documented"
fixed_check "$codex_tools" 'fork_turns="none"' "$codex_tools: fixed profiles must set fork_turns=none"
fixed_check "$codex_tools" 'omit `model` and `reasoning_effort`' "$codex_tools: fixed profiles must omit model and reasoning_effort"
fixed_check "$setup" 'callable routes' "$setup: callable routes are not validated"
fixed_check "$setup" '<!-- BEGIN PSTACK MODEL CONFIG' "$setup: missing managed AGENTS block start marker"
fixed_check "$setup" '<!-- END PSTACK MODEL CONFIG -->' "$setup: missing managed AGENTS block end marker"
fixed_check "$setup" '| Role | Model | Agent type |' "$setup: missing (role, model) -> agent_type fixed-route table"
fixed_line_check "$plan" 'fixed-model' 'codex-tools.md' "$plan: fixed-model profile dispatch must defer to codex-tools.md"
if [ -n "$fixed_dispatch_bad" ]; then
  note "FAIL: fixed-model Codex dispatch contract missing:"
  note "$fixed_dispatch_bad"
  fail=1
else
  note "ok: fixed-model Codex dispatch contract is documented"
fi

if [ "${PSTACK_STATIC_ONLY:-0}" = 1 ]; then
  exit "$fail"
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
