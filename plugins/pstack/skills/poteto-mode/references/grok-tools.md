# Grok Build tool mapping for pstack

Grok Build loads the pstack plugin's skills and agents. It does not translate Claude Code tool names in those skills. Use the tools Grok actually exposes to the session; tool availability and permissions can differ between sessions.

| pstack / Claude action | Grok Build equivalent |
| --- | --- |
| Read a file or skill | `read_file` with `target_file` set to the path in the session's skills list. Slash commands such as `/poteto-mode` also expand the named skill. |
| Write or edit a file | `write` or `search_replace` |
| Run a shell command | `run_terminal_command` |
| Search files | `grep` or `list_dir` |
| Dispatch a subagent | `spawn_subagent` with `prompt`, `description`, and a listed `subagent_type`. Use `background` for asynchronous execution and `isolation: "worktree"` for an isolated writer. |
| Wait for a background subagent | `get_command_or_subagent_output` with its task ID |
| Track tasks | `todo_write` |
| Ask the user a fixed-choice question | `ask_user_question` |
| Find and call MCP tools | `search_tool`, then `use_tool` |

Grok's subagent tool says to omit `model` unless the user explicitly requests one. Do not pass a Claude model alias as a Grok model. It has no `effort` parameter. Follow the session tool's current schema when it differs from this mapping. The captured schema does not expose a steering action for a running child; do not claim that a child received an update without a working tool for it.

Grok 1.0.70 discards SessionStart hook output, so the Claude session-start injection does not reach the model. The Grok-only routing skill asks the model to read poteto-mode from its skill description, which Grok includes in the model request. This is a model-followed hint, not guaranteed injection. Disable the pstack plugin to remove the hint; that also disables its other skills. Grok's path-ignore setting did not suppress the plugin-owned routing skill in the tested release. The pstack `session hook: off` setting does not suppress this hint. Users who require the setting to remove routing instructions should disable the plugin instead.
