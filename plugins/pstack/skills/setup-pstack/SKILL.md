---
name: setup-pstack
description: Configure which models pstack uses per role. Detects available models and writes the current runtime's override sheet. Use for /setup-pstack, "configure pstack models", changing pstack's model choices, or turning the SessionStart hook on or off.
---

# Setup pstack

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On another runtime, read [Other runtimes](#other-runtimes) below for where the sheet lives and how it loads; the steps are the same.

Write the current runtime's per-role model override sheet, using the path in [Other runtimes](#other-runtimes). Each pstack skill names a default model inline; the override sheet adapts those defaults to the models you actually have access to.

Claude Code has no auto-applied "rules" mechanism like Cursor's `.mdc`. Inclusion is explicit: the user adds a line to `~/.claude/CLAUDE.md` (or their project `CLAUDE.md`) such as:

```text
@~/.claude/pstack-models.md
```

so the file is loaded as context for every session.

## Steps

### 1. Detect available models

Enumerate the model slugs you can pass to an `Agent` subagent in this session — that is the dependable source. The currently available Claude models and the default panel are listed in [Models](#models) below; the quad is chosen for cross-family, cross-tier diversity, and the single-role default stays out of the panels because it already covers the single-model roles. Ask the user to confirm or paste any additional slugs they want available. Never write a real slug you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected slugs; both mean the role runs on the parent session's model, which the `Agent` call expresses by omitting `model`.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in the Write the override sheet step below. If the current runtime's sheet already exists, read it and treat its values as the current choices. Otherwise start from those defaults.

### 3. Map and confirm

Show every role with its current model, marking any real slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` as the options. Prefer `AskUserQuestion` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Choose whether the session hook routes tasks

On Claude Code and Codex, the plugin's `SessionStart` hook injects the poteto-mode mandate on startup, resume, clear, and compact. Codex asks the user to trust plugin hooks through `/hooks` before running them. Ask whether to keep the hook. The default is on. The answer is the `session hook` line in the current runtime's sheet: `on` or `off`. With no sheet or no line, the hook injects. The line is inert on other runtimes.

### 5. Validate

Every real slug written must be in the detected set; `inherit-parent` and `auto` always pass. If a chosen real slug is not available, stop and ask again.

### 6. Write the override sheet

Write the current runtime's sheet with the shape below. Overwrite the whole file so re-runs stay idempotent.

```markdown
# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names its defaults in a Models section; the values here override those defaults. Delete a line to fall back to the skill default. A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `Agent` call omits `model`); an alias entry in a panel list still counts toward that panel's fan-out. `session hook: off` stops the Claude Code or Codex SessionStart hook from injecting the poteto-mode mandate; any other value, or no line, leaves it on.

feature, refactoring: claude-opus-5
bug-fix: claude-fable-5-1
perf-issue: claude-fable-5-1
hillclimb: claude-fable-5-1
judgment and prose: claude-opus-5
strongest judgment: claude-fable-5-1
how explorer: claude-opus-5
how explainer: claude-opus-5
why investigators: claude-opus-5
why synthesizer: claude-opus-5
reflect tooling: claude-opus-5
reflect judgment, divergent, synthesizer: claude-opus-5
arena runners: claude-opus-5, claude-fable-5-1, claude-sonnet-5
arena cross-judge pool: claude-opus-5, claude-fable-5-1, claude-sonnet-5
swarm workers: claude-opus-5
architect runners: claude-opus-5, claude-fable-5-1, claude-sonnet-5
interrogate reviewers: claude-opus-5, claude-fable-5-1, claude-sonnet-5

session hook: on
```

### 7. Wire it in

On Claude Code, if `~/.claude/CLAUDE.md` does not already include `~/.claude/pstack-models.md`, append the `@~/.claude/pstack-models.md` line so the model rows load on every session. If the user prefers project scope, add the include to the project's `CLAUDE.md` instead.

On Codex, paste the model rows into `~/.codex/AGENTS.md`; Codex has no `@` include. Do not paste the `session hook` line there: the plugin hook reads it directly from `~/.codex/pstack-models.md`.

### 8. Confirm

Tell the user where the override was written, how its model rows load, and whether the plugin hook is on. Re-running this skill updates the override sheet.

## Other runtimes

The role lines are the same everywhere. What differs is the sheet path, how the runtime loads it, and how you list models. Detect models with the runtime's own tool and never write a slug you have not seen listed. A runtime whose subagent call has no model parameter still gets the sheet, as the record of the user's choice, and applies it where it can. The `session hook` line applies to the Claude Code and Codex plugins.

| Runtime | Sheet | Load | List models | Status |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/pstack-models.md` | `@~/.claude/pstack-models.md` in `~/.claude/CLAUDE.md` | the `Agent` tool's model parameter | verified live |
| Codex | `~/.codex/pstack-models.md` | model rows: paste into `~/.codex/AGENTS.md`; hook setting: read by the plugin | your configured Codex models, see [codex-tools.md](../poteto-mode/references/codex-tools.md#model-names) | hook contract tested; discovery verified |
| opencode | `~/.config/opencode/pstack-models.md` | add the path to the `instructions` array in `opencode.json` | the `models` slash command in the session | from published docs, no live session |
| Gemini CLI | `~/.gemini/pstack-models.md` | `@~/.gemini/pstack-models.md` in `~/.gemini/GEMINI.md` | the `model` slash command in the session | from published docs, no live session |
| Prime Agent | no documented sheet path; Prime's configuration chooses models | | | no live session |

## Models

Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`).

- Available Claude models: Opus 5 (`claude-opus-5`), Opus 4.8 (`claude-opus-4-8`), Opus 4.6 (`claude-opus-4-6`), Fable 5.1 (`claude-fable-5-1`), Sonnet 5 (`claude-sonnet-5`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5`)
- Default panel: `claude-opus-5`, `claude-fable-5-1`, `claude-sonnet-5`
- Single-role default: `claude-opus-5`
