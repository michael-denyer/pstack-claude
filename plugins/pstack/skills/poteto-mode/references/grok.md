# Grok Build tool mapping for pstack

Grok Build loads the pstack plugin's skills. It does not translate Claude Code tool names in those skills. Use the tools the session exposes; availability and permissions can differ.

## Tool actions

| pstack / Claude action | Grok Build equivalent |
| --- | --- |
| Read (`Read`) | `read_file` with `target_file` set to the path in the session's skills list |
| Write (`Write`) / edit (`Edit`) | `write` / `search_replace` |
| Shell (`Bash`) | `run_terminal_command` |
| Search (`Grep` / `Glob`) | `grep` / `list_dir` |
| Web (`WebSearch` / `WebFetch`) | `web_search` / `run_terminal_command` with `curl` |
| Skill (`Skill`) | Read the path from the session's skills list with `read_file`; `/poteto-mode` also expands the skill |
| Subagent (`Agent` / `Task`) | `spawn_subagent` with `prompt`, `description`, and a listed `subagent_type`; use `background` and `isolation: "worktree"` where needed |
| Wait for a subagent (`TaskOutput`) | `get_command_or_subagent_output` with its task ID |
| Send to a subagent (`SendMessage`) | Grok exposes no steering action; do not claim to have sent an update |
| Stop a subagent (`TaskStop`) | `kill_command_or_subagent` |
| Tasks (`TaskCreate` / `TaskUpdate` / `TodoWrite`) | `todo_write` |
| Questions (`AskUserQuestion`) | `ask_user_question` |
| MCP (`mcp__<server>__<tool>`) | `search_tool`, then `use_tool` |
| Wake-up (`ScheduleWakeup`) | For user-authorized recurring work, `scheduler_create` schedules a background subagent while the session is open; `scheduler_list` and `scheduler_delete` inspect or remove it. It is not a one-shot wake-up. |
| Claude transcript search | Grok stores sessions under `${GROK_HOME:-~/.grok}/sessions`; inspect the relevant session there rather than Claude's projects directory |

Grok does not inject the Claude SessionStart hook output. The Grok-only routing skill asks the model to read poteto-mode through its description; this is a model-followed hint, not guaranteed injection. The pstack `session hook: off` setting does not suppress it. Disable the plugin to remove the hint and its other skills.

## Subagent policy

poteto-mode's Subagents section dispatches `subagent_type: "pstack:poteto-agent"`, and other skills name `general-purpose`. The Grok build ships skills and no agent definitions.

- For `pstack:poteto-agent` or `general-purpose`, pass a `subagent_type` that the `spawn_subagent` schema lists.
- Put the absolute path of `poteto-mode`'s `SKILL.md` in every brief that stands in for `pstack:poteto-agent`, as poteto-mode asks.

## Model names

Skills name Claude Code model aliases in their Models sections. Grok Build's available models depend on the user's configuration; do not pass a Claude alias as a Grok model.

- The model sheet is `${GROK_HOME:-~/.grok}/pstack-models.md`. Before a skill that needs a role model (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`), read it. With no sheet, use the runtime default; run `setup-pstack` only when the user asks to configure roles.
- The `spawn_subagent` tool says to omit `model` unless the user explicitly requests one. It has no effort parameter; when it cannot apply a sheet choice, report that limitation instead of claiming model diversity.
- Roles that default to the worker model (`feature, refactoring`): the worker model the user chose.
- Roles that default to the strongest model (`strongest judgment`): the strongest model the user chose.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`) require distinct models. Report when the available dispatch cannot provide that diversity.

`/setup-pstack` writes the sheet. Choose only models the session exposes.

## Per-skill notes

| Skill | On Grok Build |
| --- | --- |
| `why` | The parallel investigators and the synthesizer map to `spawn_subagent` fan-out. List MCP servers with `search_tool`, not from Claude Code's MCP files. |
