# pi tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names). On pi the skills are the same files; only the tool names resolve differently. Read this when a pstack skill names a Claude tool, a driver or bundled skill, or a Claude model. This file is pi-specific.

## Tool actions

| pstack / Claude action | pi equivalent |
|------------------------|---------------|
| Read a file | `read` |
| Create / edit / delete a file | `edit` or `write` |
| Run a shell command | `bash` |
| Search file contents / find files | `bash` (`rg`, `grep`, `find`, `ls`) |
| Fetch a URL | `bash` with `curl` / `wget`, or an installed web extension |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load via `read`; `/skill:<name>` invokes one. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `Agent` with `subagent_type` (pi-subagents) |
| Wait for / steer a subagent | `get_subagent_result`, `steer_subagent` (pi-subagents) |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | Keep an uncommitted `todo.md` Markdown checklist in the work dir. |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Ask in plain text and let the user answer. |

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "pstack:poteto-agent"`, `run_in_background: true`). On pi:

- There is no `poteto-agent` subagent type. Route an ad-hoc subagent through poteto-mode's style by dispatching an `Agent` whose instructions tell it to read the `poteto-mode` skill in full first.
- There is no `comment-sicko` subagent type either. The **no-comments** skill spawns it on Claude Code; on pi dispatch an `Agent` whose instructions tell it to read `poteto-mode/references/agents/comment-sicko.md` in full first.
- There are no `pstack:effort-<level>` or `pstack:poteto-agent-<level>` types. When a role value carries `@<level>`, pass that level as the `Agent` tool's `thinking` parameter and keep the dispatch otherwise unchanged.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each worker its own worktree or branch when they write, review every subagent's diff yourself.

## Agents provisioning

pi-subagents discovers agents from `$PI_CODING_AGENT_DIR/agents/` (default `~/.pi/agent/agents/`). To make pstack's agents available, run this once from the clone's root:

```shell
for a in plugins/pstack/agents/*.md; do
  dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents"
  mkdir -p "$dir"
  target="$dir/$(basename "$a")"
  test -e "$target" || test -L "$target" || ln -s "$PWD/$a" "$target"
done
```

## Model names

Skills name Claude defaults (a single-role default for code/prose/judgment and a diverse panel for design comparisons; each model-consuming skill lists its own in a Models section). pi-subagents resolves bare family names via fuzzy substring match, but the shortest matching id wins, so bare `opus` resolves to `claude-opus-5` (the older model), not `claude-opus-5-5`. Write provider-qualified ids in the override sheet:

- Single-model roles: `anthropic/claude-opus-5-5`.
- Roles that default to the strongest Claude model (`bug-fix`, `perf-issue`, `hillclimb`, `strongest judgment`): `anthropic/claude-fable-5-1`.
- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): `anthropic/claude-opus-5-5`, `anthropic/claude-fable-5-1`, `anthropic/claude-sonnet-5-5`. The adversarial signal comes from model diversity, so use distinct models. If only one model is reachable, vary reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On pi, the extension loads the override sheet automatically, so there is no manual step.

## Session routing hook

The pstack pi extension registers a `before_agent_start` handler that injects the poteto-mode routing mandate on every turn. The extension reads `session hook` from the pi sheet, at the path in [setup-pstack's runtime table](../../setup-pstack/SKILL.md#other-runtimes). `session hook: off` disables injection. The sheet's model-configuration lines load regardless of the hook setting, matching Claude Code's always-active `@`-include.

## Per-skill notes

Most skills need only the tables above. These need one more mapping:

| Skill | On pi |
|-------|-------|
| `interrogate` | The `subagent_type`/`model`/`readonly` dispatch fields map to `Agent`; write provider-qualified ids (see Model names above). |
| `setup-pstack` | The skill's Other runtimes table names the pi sheet path and how it loads; write provider-qualified ids (see Model names above). |
| `no-comments` | There is no `comment-sicko` subagent type; see Subagent policy above. |
| `teach` | Running `how` and `why` in parallel maps to `Agent` fan-out. |
| `create-verification-skill` | The generated skill lands under the project's skill location for pi. The app-driving harness is platform-neutral. |
