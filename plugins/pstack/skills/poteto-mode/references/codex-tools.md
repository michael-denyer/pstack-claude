# Codex tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, model slugs like `claude-opus-4-8`). On Codex the skills are the same files; only the tool names resolve differently. Read this when a pstack skill names a Claude tool, a Claude built-in skill, or a `claude-*` model.

## Tool actions

| pstack / Claude action | Codex equivalent |
|------------------------|------------------|
| Read a file | `shell` (`cat`, `head`, `tail`) |
| Create / edit / delete a file | `apply_patch` |
| Run a shell command | `shell` |
| Search file contents / find files | `shell` (`rg`, `grep`, `find`, `ls`) |
| Fetch a URL | `shell` with `curl` / `wget` |
| Search the web | `web_search` |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load natively. Follow the instructions presented. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `spawn_agent` |
| Dispatch N parallel subagents in one turn | N `spawn_agent` calls in one response |
| Wait for a subagent result | `wait_agent` |
| Free a finished subagent slot | `close_agent` |
| Track tasks (the todolist / `TodoWrite`) | `update_plan` |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Ask in plain text and let the user answer. Codex has no structured-choice tool. |

Subagent dispatch needs `multi_agent` enabled. Add to `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

Without it, `spawn_agent` is unavailable and the fan-out skills (`interrogate`, `why`, `how`, `arena`, `reflect`) degrade to a single sequential pass.

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "poteto-agent"`, `run_in_background: true`). On Codex:

- There is no `poteto-agent` subagent type. Route an ad-hoc subagent through poteto-mode's style by dispatching a `spawn_agent` whose instructions tell it to read the `poteto-mode` skill in full first.
- `spawn_agent` calls already run concurrently with your turn, so `run_in_background: true` has no separate flag. Issue the dispatch and continue.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each worker its own worktree or branch when they write, review every subagent's diff yourself.

## Model names

Skills name Claude defaults (`claude-opus-4-8` for code/prose/judgment; the `claude-opus-4-8` + `claude-opus-4-6` + `claude-sonnet-4-6` triple for diverse-model panels). These slugs do not resolve on Codex. Substitute your configured Codex models:

- Single-model roles: your primary Codex model (for example `gpt-5.5`).
- Diverse-model panels (`interrogate`, `how` critics, `reflect`): the adversarial signal comes from model diversity, so use the distinct Codex models available to you. If only one model family is reachable, vary reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs.

## Claude built-in skills pstack references

Some triggers name skills that ship with Claude Code, not pstack. They do not exist on Codex. Substitute the behavior:

| Claude built-in named in pstack | On Codex |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `shell` and observe the real output. |
| `verify` (drive a UI to confirm a fix) | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | Follow your platform's skill-authoring guidance; the `writing-skills` skill if present. Keep `name` + `description` frontmatter and progressive disclosure. |

## Instructions file

Where a pstack skill says "your instructions file", on Codex that is `AGENTS.md` (project root, plus `~/.codex/AGENTS.md` global). On Claude Code it is `CLAUDE.md`.
