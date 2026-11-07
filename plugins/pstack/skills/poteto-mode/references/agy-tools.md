# Antigravity tool mapping for pstack

The Antigravity CLI (`agy`) loads the native pstack plugin manifest, the skills, the four plugin subagents, and the `SessionStart` hook. Resolve each Claude Code tool, model, and path a pstack skill names here.

## Tool actions

| pstack / Claude action | Antigravity equivalent |
|------------------------|------------------------|
| Read a file | `read_file` |
| Create a file | `write_file` |
| Edit a file | `edit_file` |
| Run a shell command | `run_command` (and `manage_task` to inspect, send input to, or kill background tasks) |
| Search file contents / find files | Run `rg` to search file contents and `rg --files` or `fd` to find files via `run_command` |
| Fetch a URL / search the web | `search_web` or `curl` via `run_command` |
| Invoke a skill (the `Skill` tool, `/command`) | Use `read_file` on the path in the `<skills>` catalog. Read `poteto-mode/SKILL.md` in full: the native loader includes only the first 24,000 bytes of a skill body. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `invoke_subagent` with `TypeName`, `Role`, `Prompt`, `Model`, and `Workspace` |
| Dispatch N parallel subagents in one turn | N `invoke_subagent` calls in one response |
| Wait for a subagent result | End the turn (call no more tools). Antigravity resumes the session automatically when a subagent sends a message or finishes. |
| Continue or steer a subagent (`SendMessage`) | `send_message` with `Recipient` set to the subagent's `conversationId` and `Message` |
| List or stop subagents | `manage_subagents` with `Action: "list"`, `"kill"`, or `"kill_all"` and `ConversationIds` |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | Keep an uncommitted `todo.md` Markdown checklist in the work dir (or `.audit/<task-slug>.todo.md` when sessions share a checkout) |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `ask_question` with `questions` (`question`, `options`, `is_multi_select`) |
| Schedule a self-paced re-invocation (`ScheduleWakeup`, the `loop` skill) | `schedule` with `DurationSeconds` (one-shot timer) or `CronExpression` (recurring schedule) and `Prompt` |
| Call an MCP tool (`mcp__<server>__<tool>`) | Call the MCP tool directly as declared in the session's tool list |
| Search Claude Code transcripts under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/` | Read Antigravity transcripts under `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (or `antigravity` / `antigravity-ide` under `~/.gemini/`). Do not read Claude Code's projects directory. |

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "pstack:poteto-agent"`, `run_in_background: true`). On Antigravity:

- The plugin's four agents register in the `<subagents>` list (`pstack:poteto-agent` / `poteto-agent`, `pstack:comment-sicko` / `comment-sicko`, `pstack:thermo-nuclear-review-subagent` / `thermo-nuclear-review-subagent`, and `pstack:thermo-nuclear-code-quality-review-subagent` / `thermo-nuclear-code-quality-review-subagent`). Pass the agent name as `TypeName` in `invoke_subagent`. `general-purpose` maps to `self` (full tool access) or `research` (read-only sandbox).
- Give each `poteto-agent` the installed path to `poteto-mode/SKILL.md` from the skills catalog. Expand `~` to the user's home directory and tell the agent to read the entire file with `read_file`, including the model and reasoning effort sections at the end.
- `invoke_subagent` always runs asynchronously in the background, so `run_in_background: true` needs no extra flag.
- `readonly: true` (reviewers, explorers, critics) maps to `TypeName: "research"` when no MCP or write tools are needed, or an explicit no-write instruction in `Prompt` when full MCP access is required.
- `isolation: "worktree"` maps to `Workspace: "share"` (creates a shared git worktree-style workspace) or `Workspace: "branch"` on `invoke_subagent`, or a manual `git worktree add` path named in `Prompt`.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, and review every subagent's diff yourself.

## Model names

Skills name Claude Code model aliases in their Models sections. On Antigravity (`agy`), `invoke_subagent`'s `Model` parameter accepts `inherit` (default, uses the parent's model), `flash_lite`, `flash`, and `pro`.

- The model sheet is `~/.gemini/config/pstack-models.md`. Before a skill that needs a role model (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`), read it. With no sheet, read `setup-pstack`'s `SKILL.md` and finish it first.
- Pass the role's model as `Model` on `invoke_subagent`. For `inherit-parent` or `auto`, omit `Model`.
- Roles that default to the worker model (`feature, refactoring`): the worker model the user chose.
- Roles that default to the strongest model (`strongest judgment`): the strongest model the user chose.
- Diverse-model panels (`arena`, `architect`, `interrogate`): the adversarial signal comes from model diversity. Use distinct available models and report when the panel shares a model family.

`/setup-pstack` writes the sheet. Antigravity accepts `flash_lite`; the Copilot sheet checker rejects underscores in model IDs and does not apply to Antigravity.

## Session routing hook

Antigravity runs the plugin's `SessionStart` hook when a new session starts. The hook outputs an `injectSteps` `systemMessage` JSON payload containing the Antigravity routing mandate unless `~/.gemini/config/pstack-models.md` contains `session hook: off`.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these Antigravity equivalents:

| Skill or driver named in pstack | On Antigravity |
|---------------------------------|----------------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `run_command` and observe the real output. |
| Project UI driver | Use the project's verification skill under `.agents/skills/` or `.claude/skills/`, or drive the UI with browser/CLI tools. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | Read Antigravity's built-in `agy-customizations` skill (`docs/skills.md`). Keep `name` plus `description` frontmatter and progressive disclosure under 24 KB per `SKILL.md`. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | Use the `schedule` tool with `DurationSeconds` or `CronExpression`. |

Project skills, the ones `create-verification-skill` writes under `.claude/skills/`, load from `.agents/skills/` (or `.claude/skills/` when registered) in the workspace.

## Per-skill notes

Most skills need only the tables above. These need one more mapping:

| Skill | On Antigravity |
|-------|----------------|
| `interrogate` | Each adversary is an `invoke_subagent` call with `Model` from the sheet. |
| `setup-pstack` | The [Other runtimes](../../setup-pstack/references/runtimes.md) table gives the sheet path. Use the `Model` values listed in [Model names](#model-names). |
| `architect` | The runner panel goes through the **arena** skill: one `invoke_subagent` call per runner, each with a `Model` from the sheet's `architect runners` line. |
| `how` | The parallel explorers and the explainer map to `invoke_subagent` fan-out with the sheet's `how` role models. |
| `arena` | The parallel candidates and the cross-judge map to `invoke_subagent` calls with the sheet's panel lines. |
| `no-comments` | Dispatch `comment-sicko` via `invoke_subagent` with `TypeName: "comment-sicko"`. |
| `thermos` | Dispatch both review subagents via `invoke_subagent` with `TypeName: "thermo-nuclear-review-subagent"` and `"thermo-nuclear-code-quality-review-subagent"`. |
| `swarm` | Each worker is an `invoke_subagent` call; use `Workspace: "share"` or `git worktree add` for writing workers. |
| `teach` | Running `how` and `why` in parallel maps to two `invoke_subagent` calls in one response; image generation uses `image-generator` via `invoke_subagent`. |
| `why` | The parallel investigators and synthesizer map to `invoke_subagent` fan-out. |
| `recall` | Read Antigravity transcripts under `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` instead of `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`. |
| `reflect` | Pass the current session's transcript path (`<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`) to the three review subagents. |
| `show-me-your-work` | Check the log against this session's transcript or context, not a Claude Code transcript. |
| `automate-me` | Follow the `agy-customizations` skill alongside `unslop`, and write the mode skill under `.agents/skills/` or `~/.gemini/config/skills/`. |
| `create-verification-skill` | Write the generated skill where Antigravity discovers project skills, `.agents/skills/verify/`, instead of `.claude/skills/verify/`. |
| `maintain-verification-skill` | The parallel per-feature source readers map to `invoke_subagent` fan-out; the project-local skill lives under `.agents/skills/`. |
| `create-formal-verification-skill` | Write the generated skill to `.agents/skills/<area>/`, named for the area it verifies. |
| `maintain-formal-verification-skill` | Project skills, the formal verification skill among them, live under `.agents/skills/`. |
| `babysit` | `loop` and `AskUserQuestion` resolve through the tables above (`schedule` and `ask_question`). |

## Vendored scripts

Use `run_command` to run the scripts under `skills/poteto-mode/scripts/`. The `watch-pr/watch-pr` watcher needs Bun and the GitHub CLI (`gh`). Run `worktree-audit.mjs` with Node.js. It uses `gh` to look up each branch's PR and imports the transcript walker from the sibling `reflect` skill. It does not read Antigravity transcripts.

## Instructions file

Where a pstack skill says "your instructions file", on Antigravity that is `AGENTS.md` or `GEMINI.md` in the workspace, or `~/.gemini/config/AGENTS.md` globally. On Claude Code it is `CLAUDE.md`.
