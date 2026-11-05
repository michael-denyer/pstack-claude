# OMP tool mapping for pstack

OMP loads these skills from the installed pstack marketplace plugin. Skill names are unqualified unless a collision changes their namespace. For a pstack skill named by the routing instruction, read its file under the installed plugin path supplied by that instruction. This avoids resolving a same-named skill from another source. For interactive invocation, use the name shown by OMP; Claude Code's `pstack:` prefix is not an OMP skill name.

| Claude Code action | OMP action |
| --- | --- |
| Read (`Read`), write (`Write`), edit (`Edit`), search (`Grep` / `Glob`), shell (`Bash`) | `read`, `write`, `edit`, `grep`, `glob`, `bash` |
| Invoke the `Skill` tool | Read `skills/<name>/SKILL.md` in the installed plugin path supplied by the routing instruction |
| Dispatch the `Agent` tool (`subagent_type`, `general-purpose`, `pstack:poteto-agent`) | Use `task` and its advertised agent roster; include the poteto-mode instructions in the brief |
| Background dispatch (`run_in_background`) | Follow the active `task` schema; use `wait` for its result |
| Read-only child (`readonly`) | Select an available read-only agent, or explicitly prohibit writes in its brief |
| Isolated writer (`isolation: "worktree"`) | Use the active `task` schema or create separate worktrees before parallel writes |
| Ask (`AskUserQuestion`) | `ask` |
| Tasks (`TodoWrite` / `TaskCreate` / `TaskUpdate`) | `todo` |
| Web (`WebSearch`) | `web_search` when available |
| `plugin-dev:skill-development` | Use it only if available; otherwise report the missing authoring companion |
| `CLAUDE.md` / `.claude/skills` | Follow OMP's discovered context files and skill catalog; do not install pstack skills into a standalone directory |
| `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects` transcripts | Use OMP session history and the paths or internal URLs exposed by the active session |
| `loop` | Use OMP's interactive `/loop` when available |

OMP provides its own subagent roster and model selection. Use the agents and model options listed by the active `task` tool. Map a review panel to separate task items. Do not pass Claude-specific `subagent_type` or model aliases. Follow the active OMP tool schema for effort. A task result is evidence; inspect the actual artifact before reporting it as complete.

OMP's `/loop` is an interactive session command, not a subagent tool. For a recurring interactive workflow, provide the user with the appropriate `/loop` command rather than emulating it with a sleep loop. If the current host does not expose it, follow that host's available scheduling mechanism or report the limitation.

The plugin injects its routing instruction before each main-agent turn and this mapping pointer into main and subagent turns. Restart a session after changing `session hook` to clear previously injected context. The Pi extension and its agent tools are not loaded by the OMP marketplace plugin.

OMP's marketplace skill discovery does not apply pstack's `paths` frontmatter as a file-triggered invocation rule. Invoke `typescript-best-practices` explicitly for TypeScript work when applicable.

Use the OMP session's available browser or project verification tools to drive applications. Project instructions take precedence over generic driver guidance.

## Model names

OMP uses its own model selection; without a pstack sheet, use the runtime's defaults. The global `~/.omp/pstack-models.md` is shared across OMP profiles; `session hook: off` there disables main-session routing while retaining the subagent mapping. Configure models only when the user asks. List available chat models with `omp models --kind chat` and inspect the active OMP configuration with `omp config`. Ask which available models the user wants for routine, worker and demanding roles. Configure OMP's own `modelRoles` and `task.agentModelOverrides` through its configuration interface, preserving unrelated settings. Use only models listed by the active installation; do not copy Claude model aliases into OMP. If the available agent roster cannot select distinct models for a requested panel, report that limitation.

## Per-skill notes

| Skill | On OMP |
| --- | --- |
| `why` | Use OMP tools and available sources. |
