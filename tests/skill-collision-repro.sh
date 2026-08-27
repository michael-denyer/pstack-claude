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
# principle-* leaf flags and the default model quad's identity across the panel
# skills and setup-pstack. The static checks need no CLI; only the behavioral
# leg below does. (Version parity across the manifests is no longer checked
# here: tools/generate.mjs stamps all three from the root VERSION file, and CI
# regenerates and diffs, so a partial bump cannot exist on a green build.)
#
# Manual test: the behavioral leg needs the claude CLI and API access; one haiku call.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

note() { printf '%s\n' "$*"; }

# Static invariant (0.9.13, #22): the Claude Code plugin ships no commands/.
# Every /pstack:<name> is served by the skill itself; a commands/ directory
# reappearing (typically via an upstream sync) duplicates every slash-menu row.
if [ -e "$repo/plugins/pstack/commands" ]; then
  note "FAIL: plugins/pstack/commands/ exists; trampolines belong in .codex-plugin/prompts/ (see CHANGES 0.9.13)"
  fail=1
else
  note "ok: no plugins/pstack/commands/ directory"
fi

# (Codex prompt <-> skill correspondence is no longer checked here:
# tools/generate.mjs emits one prompt per public skill and removes orphans,
# and CI regenerates and diffs, so a mismatch cannot exist on a green build.)

# Flag invariant (CHANGES 0.9.8): no skill may carry disable-model-invocation —
# on a skill the flag makes the Skill tool refuse the invocation outright, which
# breaks the SessionStart mandate and model-initiated entry. Frontmatter only:
# skill bodies may mention the flag in prose (automate-me does).
flagged=""
for skill in "$repo"/plugins/pstack/skills/*/SKILL.md; do
  if sed -n '2,/^---$/p' "$skill" | grep -q '^disable-model-invocation: true$'; then
    flagged="$flagged$skill"$'\n'
  fi
done
if [ -n "$flagged" ]; then
  note "FAIL: skills must not carry 'disable-model-invocation: true':"
  note "$flagged"
  fail=1
else
  note "ok: no skill carries disable-model-invocation: true"
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

# Static invariant (CHANGES maintenance note): the default model quad is duplicated
# verbatim across the four panel skills and the setup-pstack sheet, "kept grep-identical
# when models change." Derive the canonical ordered quad from setup-pstack's arena-runners
# row and assert every other copy matches, so a partial model bump fails here instead of
# drifting silently. (This copy in the test is the assertion anchor; a single generated
# source for the quad would retire all of them, this check included.)
setup="$repo/plugins/pstack/skills/setup-pstack/SKILL.md"
quad_of() { { grep -oE 'claude-[a-z0-9-]+' || true; } | tr '\n' ' ' | sed 's/ $//'; }
canon_quad="$(grep -m1 '^arena runners:' "$setup" | quad_of || true)"
quad_bad=""
[ -n "$canon_quad" ] || quad_bad="could not read the canonical quad from $setup (arena runners row)"$'\n'
# Anchor on the quad's last slug rather than a hard-coded one, so a model swap in
# setup-pstack cannot leave this check hunting for a slug nobody ships any more.
anchor="${canon_quad##* }"
# arena, architect, and how each state the quad on one line; interrogate lists it
# as one slug per row of its Reviewer A/B/C/D table (upstream #167).
for name in arena architect how; do
  skill="$repo/plugins/pstack/skills/$name/SKILL.md"
  n="$(grep -Fc "$anchor" "$skill" || true)"
  if [ "$n" != "1" ]; then
    quad_bad="$quad_bad$skill: expected exactly 1 default-quad line, found $n"$'\n'
    continue
  fi
  got="$(grep -F "$anchor" "$skill" | quad_of)"
  [ "$got" = "$canon_quad" ] || quad_bad="$quad_bad$skill: [$got] != [$canon_quad]"$'\n'
done
interrogate="$repo/plugins/pstack/skills/interrogate/SKILL.md"
got="$(grep -E '^\| Reviewer [A-Z] \|' "$interrogate" | quad_of)"
[ "$got" = "$canon_quad" ] || quad_bad="$quad_bad$interrogate reviewer table: [$got] != [$canon_quad]"$'\n'
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
