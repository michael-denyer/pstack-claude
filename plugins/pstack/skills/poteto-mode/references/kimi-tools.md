# Kimi Code CLI tool mapping for pstack

Kimi Code CLI loads pstack as a native plugin. Its tools differ from Claude Code's. Use the tools and parameters available in the current session if they differ from this guide.

| Claude Code action | Kimi Code CLI action |
| --- | --- |
| Read, write, edit, and search files | `Read`, `Write`, `Edit`, `Grep`, and `Glob` |
| Run a shell command | `Bash` |
| Fetch a URL or search the web | `FetchURL` or `WebSearch`, when available |
| Invoke a skill | `Skill` with the qualified name, for example `pstack:poteto-mode` |
| `Agent` / `Task` with `subagent_type` | `Agent` with `prompt` and `description`; use `coder`, `explore`, or `plan` as appropriate |
| `run_in_background: true` / `TaskOutput` | Use the current `Agent` tool's background option if advertised; otherwise run synchronously. Use `WaitFor` or `TaskOutput` for supported background tasks. |
| Maintain a task list | `TodoList` |
| `AskUserQuestion` | `AskUserQuestion`, or ask in the reply when the host cannot show questions |
| `SendMessage` | Use the current session's supported agent messaging tool; if none is available, do not claim a running agent received an update. |
| `ScheduleWakeup` | Use an available host scheduling tool, or report that scheduling is unavailable. |
| `CLAUDE.md` | Follow Kimi's `AGENTS.md` instructions and any project instructions the user supplies. |

Kimi's built-in subagents do not themselves spawn children. When a pstack skill names a plugin-specific agent that is not available in Kimi, give the matching built-in agent the required instructions in its prompt. Create separate worktrees for concurrent writers.

Kimi's `AgentSwarm` runs only while the user has enabled swarm mode. When it is off, use separate `Agent` calls where the current tool contract permits them. The `Skill` tool has a maximum nesting depth of three; if a workflow exceeds it, read the next skill file directly and follow it.

The plugin contributes routing instructions to the system prompt while enabled. A custom agent prompt must include `${plugin_sections}` or the effective default prompt to receive them. Disable the plugin with `/plugins disable pstack` to stop both routing and its skills, then reload or start a new session. Unlike pstack's shell hooks, this static contribution does not read the `session hook` setting. A resumed session can retain its previous prompt until Kimi rebuilds it.

Kimi does not load Claude Code plugin agent definitions through this package. Kimi's skill parser does not document Claude Code's `user-invocable` flag, so principle skills may appear in its picker; this has not been tested in a session. These limitations and any unverified tool behavior must be reported rather than treated as equivalent to Claude Code.

Before plugin changes, close other Kimi sessions and use a fresh session for each subsequent change. In a Kimi 2.5.0 test, an already-open session overwrote another session's plugin registration. Kimi copies local source installs, including local files and Git metadata; use a clean, reviewed copy. Reinstall to update and reload or start a fresh session. Kimi retains the managed copy after removal.

## Model names

Skills name Claude model aliases, which Kimi does not accept. Use only models advertised by the current `Agent` tool. When permitted, `primary` selects the current model and thinking level; omitting `model` uses the configured default, which may differ. Forced secondary mode can prohibit overrides, including `primary`; omit `model` in that mode. Kimi does not expose a per-call effort parameter.

Read `<KIMI_CODE_HOME>/pstack-models.md` before a skill that needs a role model (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`). KIMI_CODE_HOME defaults to `~/.kimi-code`. If the sheet is absent, use Kimi's configured default. For diverse-model panels, use available distinct models and report if diversity is unavailable. `setup-pstack` writes the model choices; `inherit-parent` and `auto` both omit `model` and use the configured default, which may differ from the parent model.

## Per-skill notes

| Skill | On Kimi Code CLI |
| --- | --- |
| `why` | Run independent investigators with `Agent` where permitted and wait for their results. |
