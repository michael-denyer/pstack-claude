# Pi tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names). On Pi the skills are the same files, loaded from the pstack package, and the package's Pi extension registers tools named after the Claude ones, so most names map one to one. Read this when a pstack skill names a Claude tool, a driver or bundled skill, or a Claude model. This file is Pi-specific.

## Tool actions

| pstack / Claude action | Pi equivalent |
|------------------------|---------------|
| Read a file | `read` |
| Create a file | `write` |
| Edit a file | `edit` (exact text replacement) |
| Delete a file | `bash` (`rm`) |
| Run a shell command | `bash` |
| Search file contents / find files | `grep`, `find`, and `ls` when enabled, otherwise `bash` (`rg`, `grep`, `find`, `ls`). Pi enables only `read`, `bash`, `edit`, and `write` by default. |
| Fetch a URL | `bash` with `curl` / `wget` |
| Search the web | Pi has no web search tool. Use an MCP server that provides one. |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load natively. The model reads a skill when its description matches; `/skill:<name>` forces one. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `agent` |
| Dispatch N parallel subagents in one turn | N `agent` calls with `run_in_background: true` in one response |
| Wait for a subagent result | A foreground `agent` call returns the final text. A background agent's completion arrives as a follow-up message naming its id, status, and final text, so do not poll. |
| Continue a finished subagent (`SendMessage`) | `send_message`, addressed by agent id or description |
| List subagents | `list_agents` |
| Stop a subagent | `stop_agent` |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | Pi has no task-tracking tool. Keep the `todo.md` checklist poteto-mode describes for that case. |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `ask_user_question`, same shape. Without an interactive UI (print or JSON mode) it returns an error, so ask in plain text. |
| Schedule a self-paced re-invocation (`ScheduleWakeup`) | `schedule_wakeup`, same shape |

`agent`, `send_message`, `list_agents`, `stop_agent`, `ask_user_question`, and `schedule_wakeup` come from the pstack Pi extension, which `pi install` of the pstack package loads. A skills-only setup has none of them, and the fan-out skills (`interrogate`, `why`, `how`, `arena`, `reflect`) degrade to a single sequential pass.

## Subagent policy

poteto-mode's Subagents section applies on Pi through the `agent` tool:

- `subagent_type` takes the same values. `pstack:poteto-agent`, `pstack:comment-sicko`, `pstack:poteto-agent-<level>`, and `pstack:effort-<level>` resolve to the plugin's agent files. `general-purpose`, or no `subagent_type`, runs a child with no agent file. Claude Code's built-in types such as `Explore` and `Plan` do not exist on Pi, so use `general-purpose` and put the constraint in the prompt. An unknown type errors and lists the valid ones.
- The `readonly: true` field the `how` and `interrogate` panels set has no Pi parameter. Tell the agent in its prompt not to edit files.
- Each child is its own `pi` process in your working directory and loads the same packages, so it sees the pstack skills. `isolation: "worktree"` runs it in its own git worktree under `.claude/worktrees/`, and a worktree with no changes is removed when the agent finishes.
- `run_in_background: true` returns the agent id at once, and the completion arrives as a follow-up turn.
- An agent's status follows its process. `completed` means the child exited, and `stop_agent` reports `stopped` only once the process tree is gone, so the Claude Code caveat about a `completed` agent that keeps running does not apply.
- `send_message` to a finished agent resumes its session with the context of its earlier runs. A message to a running agent waits until it exits.
- A role value's `@<level>` picks the same effort agent as on Claude Code, and the extension passes its level to the child as `--thinking`. `session` passes no level.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each worker its own worktree when they write, review every subagent's diff yourself.

## Model names

Skills name models by the Claude aliases in their Models sections. On Pi, pass the alias as the `agent` tool's `model`; the pstack extension resolves it to a Pi model:

- `opus`: `anthropic/claude-opus-5.5`
- `fable`: `anthropic/claude-fable-5.1`
- `sonnet`: `anthropic/claude-sonnet-5.5`
- `haiku`: `anthropic/claude-haiku-4.5`

A `pi models: opus=<provider/id>, sonnet=<provider/id>` line in the Pi override sheet points each alias it names at another Pi model, for a machine without Anthropic access. The `agent` tool also takes a full `provider/id`, passed through unchanged, and `inherit-parent`, `auto`, or no `model` runs the child on the parent's current model. Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`) stay diverse only while their aliases resolve to distinct models. If one model family is all you can reach, vary the reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On Pi, keep the aliases and remap them with `pi models:`.

## Session routing

The pstack Pi extension adds the poteto-mode mandate, the text the Claude Code and Codex `SessionStart` hook injects, to the system prompt at every agent start, so the mandate survives compaction. It also adds the Pi override sheet, because Pi has no include syntax for context files. The sheet is `pstack-models.md` in the Pi agent directory, which is `$PI_CODING_AGENT_DIR` when set and `~/.pi/agent` otherwise. `session hook: off` in the sheet stops the mandate. Child agents that the `agent` tool starts get neither.

Without the extension nothing is injected. Request `poteto-mode` explicitly with `/skill:poteto-mode`, or add a standing instruction to `AGENTS.md`.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these Pi equivalents:

| Skill or driver named in pstack | On Pi |
|---------------------------------|-------|
| `run` (drive a CLI/TUI to see a change work) | Pi has no `run` skill. Run the app yourself via `bash` and observe the real output. |
| `verify` (the project's `.claude/skills/verify/`, or Claude Code's bundled `/verify`) | Pi does not discover `.claude/skills/`. Read the project skill's SKILL.md by path, or add `../.claude/skills` to the `skills` list in `.pi/settings.json`. Without a project skill, drive the app as for `run`. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | Follow Pi's skills documentation and the Agent Skills specification. Keep `name` + `description` frontmatter, name the directory after the skill, and use progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | The extension's `/loop [interval] <prompt>` command. With an interval it re-fires on that cadence. Without one the prompt runs now and the model paces itself with `schedule_wakeup`. `/loop stop` cancels. |

## Per-skill notes

Affected skill entry points point here. Most skills need only the tables above. These need one more mapping:

| Skill | On Pi |
|-------|-------|
| `poteto-mode` | The todolist falls back to `todo.md`, and the Subagents defaults map through Subagent policy above. Its Platform Adaptation names `codex-tools.md` for Codex; on Pi this file is the mapping. |
| `interrogate` | Reviewers dispatch through `agent` with the same `subagent_type` and `model`. Put `readonly` in the prompt (see Subagent policy) and keep the panel on distinct models (see Model names). |
| `setup-pstack` | The Pi sheet is `pstack-models.md` in the Pi agent directory (see Session routing), and the extension loads it, so no include line is needed. List models with `pi --list-models`. The role rows are identical, and a `pi models:` line remaps aliases (see Model names). |
| `no-comments` | `pstack:comment-sicko` resolves through `agent` as written. |
| `teach` | Running `how` and `why` in parallel maps to two background `agent` calls. Pi has no image generation tool, so draw with Mermaid or plain text. |
| `create-verification-skill` | The generated skill lands under `.claude/skills/verify/` on Claude Code. Write it where Pi discovers project skills, `.pi/skills/verify/` or `.agents/skills/verify/`, instead. The app-driving harness is platform-neutral. |
| `maintain-verification-skill` | The parallel per-feature source readers map to background `agent` calls. The project-local skill lives under `.pi/skills/` or `.agents/skills/`, not `.claude/skills/`. |
| `babysit` | `loop` and `AskUserQuestion` resolve through the tables above. |
| `automate-me` | `plugin-dev:skill-development` resolves through the skills table above. |
| `architect` | The runner panel goes through the **arena** skill, so its `agent` fan-out and model aliases apply here too. |
| `arena` | The parallel candidates and the cross-judge are background `agent` calls on the configured aliases (see Model names). |
| `how` | The parallel explorers and the explainer are `agent` calls. Put `readonly` in the prompt (see Subagent policy). |
| `reflect` | The three reviewers and the synthesizer are background `agent` calls. The transcript finder reads Claude Code's layout under `~/.claude/projects/`, so pass the session digest step 1 allows instead. |
| `swarm` | Each worker is a background `agent` call on the configured alias. Give each writing worker `isolation: "worktree"` or its own output directory (see Subagent policy above). |
| `why` | The parallel investigators and the synthesizer are background `agent` calls. List MCP servers from the tools Pi exposes to the session or `pi mcp list`, not from `.mcp.json` or `claude mcp list`. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher, the `orch` store CLI, and `worktree-audit.mjs`. These scripts use bun and Node.js and run the same on Pi; invoke them through `bash`. They need `bun`, `gh`, and (for stack work) `gt`. `worktree-audit.mjs` reads Claude Code transcripts under `~/.claude/projects/`; point it at your runtime's transcript directory instead when you run it elsewhere. It imports the transcript walker from `skills/reflect/scripts/find-transcript.mjs`, so keep the `reflect` skill installed beside `poteto-mode`.

## Instructions file

Where a pstack skill says "your instructions file", on Pi that is `AGENTS.md` or `CLAUDE.md`, which Pi loads from the working directory and each parent directory, plus `~/.pi/agent/AGENTS.md` for every directory. On Claude Code it is `CLAUDE.md`.
