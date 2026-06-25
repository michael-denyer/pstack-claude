---
name: setup-pstack
description: Configure which models pstack uses per role. Detects your available Claude models and writes a per-role override file that the user can include from their CLAUDE.md. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `~/.claude/pstack-models.md`, a per-role model override sheet you include from your global `CLAUDE.md`. Each pstack skill names a default model inline; the override sheet is the layer that adapts those defaults to the models you actually have access to.

**Platform note (Codex/non-Claude runtimes).** On Codex the override sheet is `~/.codex/pstack-models.md`, the slugs are your Codex models (for example `gpt-5.5`) not `claude-*`, and you load it by adding the sheet's contents to `~/.codex/AGENTS.md` (Codex has no `@`-include into a rules file). The role rows in step 5 are identical; only the slugs, the file path, and the load mechanism change. Detect Codex slugs from `~/.codex/config.toml` (`model = ...`) plus whatever the user confirms. See `../poteto-mode/references/codex-tools.md`.

Claude Code has no auto-applied "rules" mechanism like Cursor's `.mdc`. Inclusion is explicit: the user adds a line to `~/.claude/CLAUDE.md` (or their project `CLAUDE.md`) such as:

```text
@~/.claude/pstack-models.md
```

so the file is loaded as context for every session.

## Steps

### 1. Detect available models

Enumerate the model slugs you can pass to an `Agent` subagent in this session — that is the dependable source. Claude family currently available: Opus 4.8 (`claude-opus-4-8`), Opus 4.6 (`claude-opus-4-6`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5`). The default panels pair `4-8` with `4-6` for cross-generation diversity inside the opus tier. Ask the user to confirm or paste any additional slugs they want available. Never write a slug you have not confirmed is available.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.claude/pstack-models.md` already exists, read it and treat its values as the current choices. Otherwise start from those defaults.

### 3. Map and confirm

Show every role with its current model, marking any whose model is not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models as the options. Prefer `AskUserQuestion` over free text. For panel roles (how critics, arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per model, so the list length sets the count.

### 4. Validate

Every slug written must be in the detected set. If a chosen slug is not available, stop and ask again. An override pointing at a model the user cannot use breaks every delegation that reads it.

### 5. Write the override sheet

Write `~/.claude/pstack-models.md` with the shape below. Overwrite the whole file so re-runs stay idempotent.

```markdown
# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names a default model inline; the values here override those defaults. Delete a line to fall back to the skill default.

feature, refactoring: claude-opus-4-8
bug-fix: claude-opus-4-8
perf-issue: claude-opus-4-8
hillclimb: claude-opus-4-8
judgment and prose: claude-opus-4-8
how explorer: claude-opus-4-8
how explainer: claude-opus-4-8
how critics: claude-opus-4-8, claude-opus-4-6, claude-sonnet-4-6
why investigators: claude-opus-4-8
why synthesizer: claude-opus-4-8
reflect tooling: claude-opus-4-8
reflect judgment, divergent, synthesizer: claude-opus-4-8
arena runners: claude-opus-4-8, claude-opus-4-6, claude-sonnet-4-6
architect runners: claude-opus-4-8, claude-opus-4-6, claude-sonnet-4-6
interrogate reviewers: claude-opus-4-8, claude-opus-4-6, claude-sonnet-4-6
```

### 6. Wire it in

If `~/.claude/CLAUDE.md` does not already include `~/.claude/pstack-models.md`, append the `@~/.claude/pstack-models.md` line so it loads on every session. If the user prefers project scope, add the include to the project's `CLAUDE.md` instead.

### 7. Confirm

Tell the user where the override was written and how it loads (via the `@` include in CLAUDE.md). Re-running this skill updates the override sheet.
