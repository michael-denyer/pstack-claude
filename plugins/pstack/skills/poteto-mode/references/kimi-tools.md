# Kimi Code CLI tool mapping for pstack

Kimi Code CLI loads pstack as a native plugin. Its tools differ from Claude Code's. Use the tools and parameters available in the current session if they differ from this guide.

| Claude Code action | Kimi Code CLI action |
| --- | --- |
| Read, write, edit, and search files | `Read`, `Write`, `Edit`, `Grep`, and `Glob` |
| Run a shell command | `Bash` |
| Fetch a URL or search the web | `FetchURL` or `WebSearch`, when available |
| Invoke a skill with the `Skill` tool | `Skill` with the qualified name, for example `pstack:poteto-mode` |
| Dispatch a subagent with the `Agent`/`Task` tool and `subagent_type` | `Agent` with `prompt`, `description`, and `subagent_type`. `general-purpose` maps to `coder`, and `readonly: true` maps to `explore`, which never modifies files. Use `plan` for planning. |
| `run_in_background: true` | `Agent` with `run_in_background: true`. Read progress with `TaskOutput` and wait for the result with `WaitFor`. |
| Track tasks with `TaskCreate` / `TaskUpdate`, or `TodoWrite` | `TodoList` with `todos`, each with a `title` and `status` |
| `AskUserQuestion` | `AskUserQuestion`, or ask in the reply when the host cannot show questions |
| `SendMessage` | Kimi has no tool to message a running agent. Wait for it with `WaitFor`, or stop it with `TaskStop` and continue it with `Agent`, setting `resume` to its ID. |
| `ScheduleWakeup` and the `loop` skill | `CronCreate` with `cron`, `prompt`, and `recurring: false` for a one-time wake-up. When `KIMI_DISABLE_CRON=1` turns scheduled tasks off, say that scheduling is unavailable. |
| `CLAUDE.md` | Follow Kimi's `AGENTS.md` instructions and any project instructions the user supplies. |
| Search Claude Code transcripts under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/` | `<KIMI_CODE_HOME>/session_index.jsonl` lists each session's `sessionDir` and `workDir`, and the session's transcript is `agents/main/wire.jsonl` in that `sessionDir`. Do not read Claude Code's projects directory, which holds Claude Code history, not this session's. |
| `plugin-dev:skill-development` | Kimi ships no skill-authoring skill. Write a `SKILL.md` with the `name` and `description` frontmatter Kimi requires. |
| Project skills under `.claude/skills/` | Kimi loads project skills from `.kimi-code/skills/` and `.agents/skills/`. |

Kimi's built-in subagents do not themselves spawn children. When a pstack skill names a plugin agent such as `pstack:poteto-agent`, which Kimi does not load, give the matching built-in agent its instructions in the prompt. `isolation: "worktree"` has no `Agent` parameter, so create a separate worktree for each concurrent writer.

Kimi's `AgentSwarm` runs only while the user has enabled swarm mode. When it is off, use separate `Agent` calls where the current tool contract permits them. The `Skill` tool has a maximum nesting depth of three; if a workflow exceeds it, read the next skill file directly and follow it.

The plugin contributes routing instructions to the system prompt while enabled. A custom agent prompt must include `${plugin_sections}` or the effective default prompt to receive them. Disable the plugin with `/plugins disable pstack` to stop both routing and its skills, then reload or start a new session. Unlike pstack's shell hooks, this static contribution does not read the `session hook` setting. A resumed session can retain its previous prompt until Kimi rebuilds it.

Kimi does not load Claude Code plugin agent definitions through this package. Kimi's skill parser does not document Claude Code's `user-invocable` flag, so principle skills may appear in its picker; this has not been tested in a session. These limitations and any unverified tool behavior must be reported rather than treated as equivalent to Claude Code.

## Model names

Skills name Claude model aliases; do not assume they are available on Kimi. Use only models advertised by the current `Agent` tool; if it has no `model` parameter, omit `model`. Omitting it uses the configured subagent default when present, otherwise the parent's model. Kimi does not expose a per-call effort parameter.

In Kimi 2.5.1, a pool with two or more entries enables the `model` parameter, which accepts pool aliases only. To select the parent's model, its alias must be in the pool; `primary` is not a choice. A single-entry pool pins all subagents to that model without exposing the parameter. In 2.4.1, a configured pool can also offer `primary`, which selects the parent's model and thinking level; forced secondary mode hides the parameter and pins all subagents to the configured default. Follow the current tool's advertised choices.

Read `<KIMI_CODE_HOME>/pstack-models.md` before a skill that needs a role model (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`). KIMI_CODE_HOME defaults to `~/.kimi-code`. If the sheet is absent, omit `model`. For diverse-model panels, use available distinct models and report if diversity is unavailable. `setup-pstack` writes the model choices; `inherit-parent` and `auto` both omit `model` and use Kimi's subagent default when configured, otherwise the parent's model.

## Per-skill notes

| Skill | On Kimi Code CLI |
| --- | --- |
| `why` | Run independent investigators with `Agent` where permitted and wait for their results. |
