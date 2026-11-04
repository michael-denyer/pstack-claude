# Kimi Code CLI tool mapping for pstack

Kimi Code CLI loads pstack as a native plugin. Its tools differ from Claude Code's. Use the tools and parameters available in the current session if they differ from this guide.

| Claude Code action | Kimi Code CLI action |
| --- | --- |
| Read, write, edit, and search files | `Read`, `Write`, `Edit`, `Grep`, and `Glob` |
| Run a shell command | `Bash` |
| Fetch a URL or search the web | `FetchURL` or `WebSearch`, when available |
| Invoke a skill | `Skill` with the qualified name, for example `pstack:poteto-mode` |
| Spawn a subagent | `Agent` with `prompt` and `description`; use `coder`, `explore`, or `plan` as appropriate |
| Wait for a background task | `WaitFor`, or `TaskOutput` to inspect its current state |
| Maintain a task list | `TodoList` |
| Ask a question | `AskUserQuestion`, or ask in the reply when the host cannot show questions |

Kimi's built-in subagents do not themselves spawn children. When a pstack skill names a plugin-specific agent that is not available in Kimi, give the matching built-in agent the required instructions in its prompt. Create separate worktrees for concurrent writers. Use only model choices advertised by the current `Agent` tool. When permitted, `primary` selects the current model and thinking level; omitting `model` uses the configured default, which may differ. A forced secondary model can prohibit overrides, including `primary`; in that mode omit `model`. Do not pass Claude model aliases or invent effort parameters. If diverse models are unavailable, say so when reporting a panel's limits.

Kimi's `AgentSwarm` runs only while the user has enabled swarm mode. When it is off, use separate `Agent` calls where the current tool contract permits them. The `Skill` tool has a maximum nesting depth of three; if a workflow exceeds it, read the next skill file directly and follow it.

The plugin contributes routing instructions to the system prompt while enabled. A custom agent prompt must include `${plugin_sections}` or the effective default prompt to receive them. Disable the plugin with `/plugins disable pstack` to stop both routing and its skills, then reload or start a new session. Unlike pstack's shell hooks, this static contribution does not read the `session hook` setting. A resumed session can retain its previous prompt until Kimi rebuilds it.

Kimi does not load Claude Code plugin agent definitions through this package. Kimi's skill parser does not document Claude Code's `user-invocable` flag, so principle skills may appear in its picker; this has not been tested in a session. These limitations and any unverified tool behavior must be reported rather than treated as equivalent to Claude Code.

## Setup pstack

Use this procedure in place of steps 1 through 8 of `setup-pstack`. Kimi's home is `$KIMI_CODE_HOME` when set, otherwise `~/.kimi-code`. Before following a skill that dispatches subagents by role, read `pstack-models.md` in that home if it exists. If it does not exist, omit the `model` parameter and use Kimi's configured default.

To create or update the sheet, inspect the model choices accepted by the current `Agent` tool. In forced-secondary mode, record `auto` for each role and omit `model` when dispatching. Otherwise use only choices the tool advertises, or `auto` to omit `model`. Use `primary` for the current model when the tool permits it; `auto` selects Kimi's configured default, which may differ. Ask the user which choices to assign to the roles and panels shown in `setup-pstack`, retaining existing choices when still available. Write those role lines to `pstack-models.md` in Kimi's home. Do not add effort suffixes, `default effort`, or `session hook` because Kimi's Agent tool and this plugin do not consume them. Tell the user the path and that the agent reads it at skill use, not automatically at session start.

The plugin's system-prompt routing remains on while the plugin is enabled. `/plugins disable pstack` disables both routing and the packaged skills; reload or start a new session afterwards. There is no separate routing switch in this integration.
