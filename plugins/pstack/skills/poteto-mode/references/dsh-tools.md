# DeepSeek Harness tool mapping for pstack

DeepSeek Harness (DSH) uses this mapping regardless of its model provider. This is a skills-only integration, with no native pstack bundle, Pi extension, or routing hook. Check the current session's tool schemas: presets, executor modes, and delegation depth can change the exposed interfaces.

## Tool actions

| pstack / Claude action | DSH equivalent and boundary |
| --- | --- |
| Read a file (`Read`) | `read`, with path and line bounds. |
| Create a file (`Write`) | `write`. |
| Edit a file (`Edit`) | `edit`, with a literal replacement. |
| Find files (`Glob`) | `glob`. |
| Search contents (`Grep`) | `grep`. |
| Run a shell command (`Bash`) | `bash`, or the deployment's platform-specific shell tool. |
| Fetch a URL (`WebFetch`) | `web_fetch`. |
| Search the web (`WebSearch`) | Use an exposed web-search tool; there is no fixed name in this mapping. |
| Invoke a skill (`Skill`) | `skill` by its catalog name. Request `poteto-mode` by name; Claude slash-command syntax is not assumed. |
| Dispatch a subagent (`Agent` / `Task`) | `subagent` for a self-contained brief; `subagent_fork` for conversation context. |
| Continue or steer a subagent (`SendMessage`) | `send_message`, with the returned agent ID. |
| List subagents | `list_agents`. |
| Stop a subagent | `interrupt_agent` requests a stop; observe completion before reusing its worktree. |
| Track tasks (`TaskCreate`, `TaskUpdate`, `TodoWrite`) | `todo_write` replaces the complete list. If absent, use poteto-mode's checklist fallback. |
| Ask the human (`AskUserQuestion`) | `ask_user_question`. |
| Wait for shell output | `job_output`, with the background job ID and `wait: true` when blocked. |
| Cancel a background job | `job_kill`, for a job rather than an agent or Host. |
| Long-running objective | `create_goal`, only for a direct human long-running objective under DSH's goal contract. |
| `ScheduleWakeup` / recurring `loop` | No one-to-one equivalent. Use `schedule_create` only for an explicit scheduling request, with its time-zone and recurrence fields. |

## Subagent policy

- `subagent` takes a short `description` and a complete `prompt`, plus `cwd` for a different working directory. `subagent_fork` inherits conversation context and uses its own schema; use `subagent` for independent reviews.
- Neither tool takes Claude Code's `subagent_type`, `readonly`, `isolation`, or `run_in_background`. Both return an agent ID immediately and run asynchronously.
- Names such as `pstack:poteto-agent` and `pstack:comment-sicko` are role instructions, not DSH agent types. Put the role, task boundary, skill paths, and expected result in the prompt.
- For a read-only reviewer, include that restriction in the brief; DSH has no `readonly` dispatch field. Report when filesystem enforcement is unavailable.
- For separate writing worktrees, prepare them before dispatch and pass each verified directory through `cwd`; there is no automatic `isolation` field.
- Model overrides belong on `subagent` only when its live schema accepts them. Supply `provider` and `model` together, and select `reasoning_effort` from the catalog for that pair. Do not attach these fields to `subagent_fork` when its schema omits them.
- Delegation depth can remove child tools. A required independent review remains unverified when no child level is available.
- Completion arrives through the runtime. `send_message` confirms delivery, not findings; `interrupt_agent` confirms a stop request, not completion. `job_output` waits for shell jobs, not agents.

| Skill | On DeepSeek Harness |
| --- | --- |
| `setup-pstack` | Use `list_subagent_models` when exposed and native delegation defaults; no role sheet is installed. |
| `swarm` | Pass each worker's prepared worktree through `cwd`. |

## Model names

DSH selects providers, models, and reasoning efforts through its current deployment. Do not pass Claude Code model aliases to DSH or use the Pi/Copilot mapping merely because the parent model comes from that provider. Use `list_subagent_models` when exposed: first list providers, then models for a provider, then efforts for the exact provider/model pair. Without that tool, use the deployment's model settings or omit unsupported selectors. Pass `provider`, `model`, and `reasoning_effort` only when the live delegation schema accepts them; omit all selectors to use its documented defaults.

Roles used by `architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why` are prompt responsibilities, not DSH model IDs or built-in agent types. Diverse-model panels (`arena`, `architect`, `interrogate`) require distinct available model families; report when that is unavailable. Do not manufacture diversity by relabeling the same model.

This skills-only integration has no automatic per-role sheet reader. `setup-pstack` uses the native delegation defaults, as its Other runtimes table describes.
