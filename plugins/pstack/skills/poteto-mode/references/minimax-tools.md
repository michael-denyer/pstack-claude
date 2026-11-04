# MiniMax Code tool mapping for pstack

MiniMax Code discovers the pstack Claude Code plugin through its Claude Code reader, including the skills, four plugin agents, and `SessionStart` hook. On 0.7.4, guest sessions with a synthetic provider delivered routing and the explicit `pstack:poteto-mode` skill when enabled; disabled controls omitted them. Real-model behavior and agent dispatch are unverified. The model sees MiniMax Code's own tools, so resolve each Claude tool a skill names here.

## Tool actions

| pstack / Claude action | MiniMax Code equivalent |
|------------------------|-------------------------|
| Read a file | `read` |
| Create a file | `write` |
| Edit a file | `edit` |
| Run a shell command | `bash` |
| Search file contents / find files | `grep` (ripgrep syntax) and `glob` |
| Fetch a URL | `web_fetch` |
| Search the web | `web_search` |
| Invoke a skill (the `Skill` tool, `/command`) | `skill` with `name` set to the plugin skill, as in `pstack:poteto-mode` |
| Dispatch a subagent (the `Agent`/`Task` tool) | `task` with `description`, `prompt`, and `agent_name` |
| Dispatch N parallel subagents in one turn | N `task` calls in one response |
| Wait for a subagent result | End the turn. A `<background-task-finished>` notice wakes the session, and `task_output` with the `task_id` reads the result. |
| Continue or steer a subagent (`SendMessage`) | `task_append` with the `task_id` |
| Stop a subagent | `task_stop` with the `task_id` |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `todowrite` with the whole `todos` list, one item `in_progress` |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `ask_user`, one step per question with two to four `options`. Set `async: false` when the next step depends on the answer. |
| Schedule a self-paced re-invocation (`ScheduleWakeup`, the `loop` skill) | `self_reminder` with `action: "set"`, `delay_seconds`, and the `prompt` to run, which wakes this conversation once. Only one reminder can be pending, so set the next one after it fires. Use `cron_create`, an on-demand tool found with `tool_search` and run with `mcp_invoke`, only for a schedule the user asks for. |
| Call an MCP tool (`mcp__<server>__<tool>`) | `tool_search` for the tool, then `mcp_invoke` with its `tool_name` and `arguments` |
| Search Claude Code transcripts under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/` | This mapping names no MiniMax Code transcript location. Do not read Claude Code's projects directory, which holds Claude Code history, not this session's. Say that session history is unavailable instead of reporting that something was never recorded. |

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "pstack:poteto-agent"`, `run_in_background: true`). On MiniMax Code:

- The plugin's four agents register under the plugin namespace: `pstack:poteto-agent`, `pstack:comment-sicko`, `pstack:thermo-nuclear-review-subagent`, and `pstack:thermo-nuclear-code-quality-review-subagent`. Pass the name a skill gives as `subagent_type` as the `task` tool's `agent_name`. `general-purpose` maps to the built-in `worker` agent.
- `poteto-agent` cannot find the `poteto-mode` skill on its own, since it searches Claude Code's plugin cache. Put the absolute path of `poteto-mode`'s `SKILL.md` in every `pstack:poteto-agent` brief, as poteto-mode asks. A local install in the default data directory keeps it at `~/.minimax/plugins/pstack/skills/poteto-mode/SKILL.md`.
- `task` runs in the background by default, so `run_in_background: true` needs no field. Leave it unset when you start several children at once.
- `readonly: true` (reviewers, explorers, critics) has no field. Say in the prompt that the child must not change files, or dispatch the built-in `explore` agent, and review the diff anyway.
- A role's model and effort go in the `task` tool's `model` and `effort` (see Model names).
- `isolation: "worktree"` has no field: every child works in the session's workspace. Before you dispatch a writer, create its worktree with `git worktree add` and name that path in the prompt, so the **swarm** skill's workers and the fan-out playbooks (`orchestrate`, `autopilot-full`, `autopilot-stack`) never share a checkout.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, and review every subagent's diff yourself.

## Model names

Skills name Claude Code model aliases in their Models sections. Those aliases are not MiniMax Code model keys. MiniMax Code names a model `<provider>/<model>`, and the models a session can reach depend on the providers the user connected: MiniMax itself, OpenAI through its Codex sign-in, or a provider added with `mcode provider add`. So the MiniMax Code build ships no default models, and the user picks them once.

- The model sheet is `~/.minimax/pstack-models.md`. Before a skill that needs a role model (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`), read it. With no sheet, load `setup-pstack` with the `skill` tool and finish it first.
- A role line in the sheet is the user's explicit model instruction, so pass it as the `task` tool's `model`. Pass the role's `@level`, or the sheet's `default effort`, as `effort`. The `task` tool fails a model other than the parent's that offers effort levels when `effort` is missing or names a level the model does not offer, such as `high` on MiniMax M3, which offers only `on` and `off`. When the level is not one the model offers, ask the user which to use. `inherit-parent` or `auto` omits `model` and `effort`.
- Roles that default to the worker model (`feature, refactoring`): the worker model the user chose.
- Roles that default to the strongest model (`strongest judgment`): the strongest model the user chose.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial signal comes from model diversity, so fill a panel from distinct providers. If only one model family is reachable, vary reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On MiniMax Code, list the models with `mcode provider list` or the `model` slash command and write only keys they show.

## Session routing hook

The Claude Code plugin's `SessionStart` hook is intended to run through MiniMax Code's Claude Code reader. When given `MINIMAX_PLUGIN_ROOT`, the hook injects the poteto-mode mandate in MiniMax Code wording, which points here. The hook delivered routing in a 0.7.4 guest session with a synthetic provider; a disabled-plugin control omitted it. It reads `session hook` from the MiniMax Code sheet, at the path in [setup-pstack's runtime table](../../setup-pstack/SKILL.md#other-runtimes); `session hook: off` disables injection. MiniMax Code passes hooks and the `bash` tool a fixed set of environment variables that leaves out `MINIMAX_DATA_DIR`, so pstack keeps the sheet at `~/.minimax/pstack-models.md` even when the data directory moves. The hook is a POSIX `sh` script, and it is untested on Windows.

A skills-only installation does not include the hook. Request `poteto-mode` explicitly or add a standing instruction to `AGENTS.md` in that case.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these MiniMax Code equivalents:

| Skill or driver named in pstack | On MiniMax Code |
|---------------------------------|-----------------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `bash` and observe the real output. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | MiniMax Code's built-in `skill-creator` skill. Keep `name` plus `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | `self_reminder`, set again after each check (see Tool actions). |

Project skills, the ones `create-verification-skill` writes under `.claude/skills/`, load from `.claude/skills/`, `.agents/skills/`, or `.minimax/skills/` in the workspace.

## Per-skill notes

Most skills need only the tables above. These need one more mapping:

| Skill | On MiniMax Code |
|-------|-----------------|
| `setup-pstack` | The skill's Other runtimes table names the MiniMax Code sheet path. List models with `mcode provider list` or the `model` slash command. |
| `no-comments` | The `comment-sicko` dispatch is a `task` call with `agent_name: "pstack:comment-sicko"`. |
| `thermos` | Both review dispatches are `task` calls with the agents' `pstack:` names. |
| `swarm` | Each worker is a `task` call. Give each writing worker its own worktree first (see Subagent policy). |
| `why` | The parallel investigators and the synthesizer map to `task` fan-out. List MCP servers with `tool_search`, not from Claude Code's MCP files. |
| `recall` | Do not list or read `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`; it holds Claude Code history, not this session's (see Tool actions). Work from live state and the shared record. |
| `reflect` | The transcript finder reads Claude Code's layout and has no MiniMax Code location to read, so pass the session digest step 1 allows instead. |
| `show-me-your-work` | Check the log against this session's own context, not a Claude Code transcript. |
| `automate-me` | The skill-authoring guidance resolves through the skills table above. This mapping names no MiniMax Code transcript location, so draw on the current session and the user's own account of how they work. Write the mode skill under `.agents/skills/` or `.claude/skills/`. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher and `worktree-audit.mjs`. These scripts use bun and Node.js and run the same on MiniMax Code; invoke them through `bash`. They need `bun` and `gh`, or `origin` when the forge is Origin. Run `worktree-audit.mjs` with `node`, as its shebang does. The audit finds each worktree's last chat only in the transcript directories that exist (Claude Code, Codex, Pi, GitHub Copilot); it does not read MiniMax Code sessions. It imports the transcript walker from the `reflect` skill, so keep the `reflect` skill installed beside `poteto-mode`.

## Instructions file

Where a pstack skill says "your instructions file", on MiniMax Code that is `AGENTS.md` in the workspace, or `AGENTS.md` in MiniMax Code's data directory (`~/.minimax` by default) for every workspace. On Claude Code it is `CLAUDE.md`.
