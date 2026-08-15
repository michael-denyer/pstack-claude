---
name: setup-pstack
description: Configure which models pstack uses per role. Discover callable Claude or Codex routes and write the applicable override configuration. Use for /setup-pstack, "configure pstack models", or changing pstack's model choices.
---

# Setup pstack

Write `~/.claude/pstack-models.md`, a per-role model override sheet you include from your global `CLAUDE.md`. Each pstack skill names a default model inline; the override sheet is the layer that adapts those defaults to the models you actually have access to.

**Platform note.** On Codex, write the generated sheet to `~/.codex/pstack-models.md` and copy the whole sheet into an idempotent `~/.codex/AGENTS.md` block delimited by `<!-- BEGIN PSTACK MODEL CONFIG -->` and `<!-- END PSTACK MODEL CONFIG -->`. The Codex branch discovers its routes from the current `spawn_agent` declaration, not from local profile names or configuration. [`codex-tools.md`](../poteto-mode/references/codex-tools.md) owns dispatch behavior.

Claude Code has no auto-applied "rules" mechanism like Cursor's `.mdc`. Inclusion is explicit: the user adds a line to `~/.claude/CLAUDE.md` (or their project `CLAUDE.md`) such as:

```text
@~/.claude/pstack-models.md
```

so the file is loaded as context for every session.

## Steps

### 1. Detect available models and Codex routes

Enumerate the model slugs you can pass to an `Agent` subagent in this session — that is the dependable source. Claude family currently available: Opus 5 (`claude-opus-5`), Opus 4.8 (`claude-opus-4-8`), Opus 4.6 (`claude-opus-4-6`), Fable 5 (`claude-fable-5`), Sonnet 5 (`claude-sonnet-5`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5`). The default panels run Opus 5 (`claude-opus-5`), Fable 5 (`claude-fable-5`), Opus 4.6 (`claude-opus-4-6`), and Sonnet 5 (`claude-sonnet-5`) for cross-family, cross-tier diversity. Opus 4.8 stays out of the panels because it is already the single-role default across the skills. Ask the user to confirm or paste any additional slugs they want available. Never write a slug you have not confirmed is available.

On Codex, inspect the current `spawn_agent` declaration. Record generic models that the tool explicitly allows through `model`. Record a fixed route only when the declaration exposes a callable fixed custom `agent_type` and identifies its fixed model. Do not infer routes from installed files or hardcode local profile names.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in step 5 below. If `~/.claude/pstack-models.md` already exists, read it and treat its values as the current choices. Otherwise start from those defaults. On Codex, read `~/.codex/pstack-models.md` when it exists. Otherwise keep the model-only role rows, but require a detected callable route for every selected model instead of reusing the Claude defaults.

### 3. Map and confirm

Show every role with its current model, marking any whose model is not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models as the options. Prefer `AskUserQuestion` over free text. For panel roles (how critics, arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per model, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one model from it whose family differs from the parent's when possible.

### 4. Validate

Every slug written must be in the detected set. If a chosen slug is not available, stop and ask again. An override pointing at a model the user cannot use breaks every delegation that reads it.

On Codex, validate every configured `(role, model)` against callable routes. A generic route needs a currently allowed explicit `model`. A fixed route needs a callable `agent_type` in the exception table. If neither exists, mark the single-model role unresolved. For a panel, report the panel dropout. Do not silently substitute a different model or profile. Follow [`codex-tools.md`](../poteto-mode/references/codex-tools.md) for the dispatch fields.

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
how critics: claude-opus-5, claude-fable-5, claude-opus-4-6, claude-sonnet-5
why investigators: claude-opus-4-8
why synthesizer: claude-opus-4-8
reflect tooling: claude-opus-4-8
reflect judgment, divergent, synthesizer: claude-opus-4-8
arena runners: claude-opus-5, claude-fable-5, claude-opus-4-6, claude-sonnet-5
arena cross-judge pool: claude-opus-5, claude-fable-5, claude-sonnet-5
architect runners: claude-opus-5, claude-fable-5, claude-opus-4-6, claude-sonnet-5
interrogate reviewers: claude-opus-5, claude-fable-5, claude-opus-4-6, claude-sonnet-5
```

On Codex, preserve every model-only role row. Append this section when fixed routes exist, with one row per discovered `(role, model) -> agent_type` route. Omit no model-only row because it also has a fixed exception.

```markdown
## Codex fixed-model exceptions

| Role | Model | Agent type |
| --- | --- | --- |
| <role> | <model> | <agent_type> |
```

### 6. Wire it in

If `~/.claude/CLAUDE.md` does not already include `~/.claude/pstack-models.md`, append the `@~/.claude/pstack-models.md` line so it loads on every session. If the user prefers project scope, add the include to the project's `CLAUDE.md` instead.

On Codex, write the whole generated sheet to `~/.codex/pstack-models.md`. Then replace only the content between these markers in `~/.codex/AGENTS.md`, or append the complete block if it is absent:

```markdown
<!-- BEGIN PSTACK MODEL CONFIG -->
[the whole generated sheet]
<!-- END PSTACK MODEL CONFIG -->
```

Preserve everything outside the block. Start a fresh task after changing fixed profiles so the current `spawn_agent` inventory refreshes.

### 7. Confirm

Tell the user where the override was written and how it loads (via the `@` include in CLAUDE.md, or the managed block in AGENTS.md). Re-running this skill updates the override sheet. On Codex, remind the user to start a fresh task after profile changes.
