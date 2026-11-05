# OpenCode mapping

OpenCode 2 loads the native pstack plugin, which registers each skill as `pstack-<name>`. Invoke `pstack:how` as `pstack-how` with the `skill` tool, and resolve relative references from the skill's base directory. Map `Read` to `read`, `Bash` to `shell`, and the `Skill` tool to `skill`.

## Claude action mapping

- For the `Agent` tool, use `subagent` with its available `agent`, `description`, and `prompt` fields. A Claude `subagent_type` names a role, not an OpenCode agent ID. The plugin does not register `pstack:poteto-agent`; choose only an available agent and put the absolute path to `poteto-mode/SKILL.md` in its brief. Do not assume `general-purpose` exists.
- Map `run_in_background: true` to the `subagent` tool's `background: true`. Use its returned `sessionID` to continue the same child. A Claude `readonly: true` flag has no direct equivalent; use an available read-only agent or permissions, and do not claim read-only isolation otherwise. `isolation: "worktree"` likewise requires a separately created worktree.
- Map `AskUserQuestion` to the available `question` tool. Map `TaskCreate`, `TaskUpdate`, and `TodoWrite` to `todowrite` with the complete todo list, or use a local checklist if the tool is unavailable.
- The `loop` skill's wake-up mechanism is runtime-specific. Use `schedule_create` only when the user authorizes a schedule; do not silently substitute a recurring schedule for a single wake-up.
- `plugin-dev:skill-development` is a Claude plugin skill, not an OpenCode built-in. Use it only if available. Likewise, `.claude/skills/` and `CLAUDE.md` are Claude-specific paths, not proof that OpenCode loaded an instruction or skill.
- `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/` holds Claude transcripts, not this OpenCode session's history. Use an available OpenCode history source or say the history is unavailable.

## Per-skill notes

| Skill | On OpenCode 2 |
| --- | --- |
| `setup-pstack` | Use the configured models listed by OpenCode and the model names guidance below. |
| `why` | Use connected sources where available and report missing evidence instead of assuming it. |

## Model names

Claude Code model aliases are not OpenCode model IDs. Select a configured chat model only when the user explicitly asks for a model or variant; otherwise let the subagent inherit its model. OpenCode accepts `providerID/modelID` or `providerID/modelID#variant` in the `subagent` tool's `model` field. Look up the ID and variant with the `models` tool; do not guess.

- The model sheet is `${XDG_CONFIG_HOME:-~/.config}/opencode/pstack-models.md`. Add that path to the OpenCode configuration's `instructions` array to load role choices; the plugin reads the `session hook` setting directly.
- For role-model skills (`architect`, `arena`, `how`, `interrogate`, `no-comments`, `poteto-mode`, `reflect`, `swarm`, `thermos`, `why`), treat a saved user choice as an explicit instruction only when it identifies a configured model. The `subagent` input has no separate effort field; use a listed `#variant` when requested. Omit `model` for `inherit-parent` or `auto`.
- For diverse-model panels, use different available providers only when the user requests those models. Otherwise inherit and state that model diversity was not established.

Use the `models` command to inspect configured models before writing the sheet.
