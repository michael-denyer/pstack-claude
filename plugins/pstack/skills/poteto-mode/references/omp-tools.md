# OMP tool mapping for pstack

OMP loads these skills from the installed pstack marketplace plugin. Skill names are unqualified unless a collision changes their namespace. For a pstack skill named by the routing instruction, read its file under the installed plugin path supplied by that instruction. This avoids resolving a same-named skill from another source. For interactive invocation, use the name shown by OMP; Claude Code's `pstack:` prefix is not an OMP skill name.

| Claude Code action | OMP action |
| --- | --- |
| Read, write, edit, search or run commands | `read`, `write`, `edit`, `grep`, `glob` or `bash` |
| Invoke a pstack skill | Read the installed plugin's `skills/<name>/SKILL.md` path supplied by the routing instruction |
| Dispatch agents | `task`, using its currently advertised schema |
| Wait for a background agent | `wait`, or read the delivered result; use `read agent://<id>` for the full result |
| Ask a question | `ask` |
| Track tasks | `todo` |
| Search the web | `web_search`, when available |

OMP provides its own subagent roster and model selection. Use the agents and model options listed by the active `task` tool. Map Claude's `pstack:poteto-agent` to an available OMP agent and include the poteto-mode instructions in its brief. Map a review panel to separate task items. Do not pass Claude-specific `subagent_type` or model aliases. If a workflow calls for distinct models but the available roster does not provide them, report that limit. Give concurrent writers separate worktrees. Follow the active OMP tool schema for background work, isolation and effort. A task result is evidence; inspect the actual artifact before reporting it as complete.

OMP's `/loop` is an interactive session command, not a subagent tool. For a recurring interactive workflow, provide the user with the appropriate `/loop` command rather than emulating it with a sleep loop. If the current host does not expose it, follow that host's available scheduling mechanism or report the limitation.

The plugin injects its routing instruction before each main-agent turn and this mapping pointer into subagent turns. Disable or remove the plugin and restart OMP to stop the routing extension. The interactive plugin manager can refresh skills in the current session without unloading that extension. This OMP adapter does not read Pi's `pstack-models.md` or `session hook` setting. Configure models through OMP's own model roles and agent overrides. The Pi extension and its agent tools are not loaded by the OMP marketplace plugin.

OMP's marketplace skill discovery does not apply pstack's `paths` frontmatter as a file-triggered invocation rule. Invoke `typescript-best-practices` explicitly for TypeScript work when applicable.

Use the OMP session's available browser or project verification tools to drive applications. Project instructions take precedence over generic driver guidance. OMP session history and task outputs are separate from Claude Code transcript files; use the paths or internal URLs exposed by the active OMP session.

## Setup pstack

List available chat models with `omp models --kind chat` and inspect the active OMP configuration with `omp config`. Ask which available models the user wants for routine, worker and demanding roles. Configure the appropriate OMP `modelRoles` and `task.agentModelOverrides` through OMP's own configuration interface, preserving unrelated settings. Use only models listed by the active installation. Do not create a pstack model sheet or copy Claude model aliases into OMP. If the available agent roster cannot select distinct models for a requested panel, report that the panel lacks model diversity.
