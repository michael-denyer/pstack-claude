# OMP tool mapping for pstack

OMP loads these skills from the installed pstack marketplace plugin. A pstack skill's URL is `skill://pstack/<name>` when OMP's skill list names `pstack/<name>`, and `skill://<name>` otherwise; a file inside it is that URL followed by `/<path>`. OMP gives a skill name to one copy, the highest-precedence one, and names pstack's copy `pstack/<name>` only when another skill holds the bare name: a project's `.claude/skills/<name>/` or `.omp/skills/<name>/`, another plugin's skill, or a copy edited with `reflect`. Never read a pstack skill by its path in the plugin install, which can sit in a folder the user restricted with `tools.restrictedFolders`: there every read asks for approval, and without an interactive UI the read is refused. For interactive invocation, use the name shown by OMP; Claude Code's `pstack:` prefix is not an OMP skill name.

Where poteto-mode asks for its absolute path in a `poteto-agent` prompt, write poteto-mode's URL. The first line of an agent's kickoff, `Read <path>/worker.md before anything else.`, becomes `Read skill://poteto-mode/worker.md before anything else.`, or `Read skill://pstack/poteto-mode/worker.md before anything else.` when the list names `pstack/poteto-mode`. Resolve a relative link against the directory of the skill that holds it, then read the result through the URL of the skill it lands in: from `why`, `../poteto-mode/references/codex-tools.md` is poteto-mode's URL followed by `/references/codex-tools.md`, and `../<name>/SKILL.md` is that skill's URL. OMP rejects `..` inside a `skill://` URL.

Where a skill runs a script under the installed plugin, as `<plugin>/skills/<name>/<path>`, run it by the physical path `realpath` prints for the skill's URL, from the repository's working directory: `node "$(realpath skill://poteto-mode)/scripts/check-playbooks.mjs"`. A restricted folder matches a `bash` call by its working directory, not its command text, so do not `cd` into the skill.

| Claude Code action | OMP action |
| --- | --- |
| Read (`Read`), write (`Write`), edit (`Edit`), search (`Grep` / `Glob`), shell (`Bash`) | `read`, `write`, `edit`, `grep`, `glob`, `bash` |
| Invoke the `Skill` tool | Read the skill's URL: `skill://pstack/<name>` when OMP lists `pstack/<name>`, else `skill://<name>` |
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

Use the OMP session's available browser or project verification tools to drive applications. Project instructions take precedence over generic driver guidance. Where poteto-mode names the project `verify` skill at `.claude/skills/verify/`, look under `.omp/skills/verify/` first, where `create-verification-skill` writes it on OMP, then under `.claude/skills/verify/` and `.agents/skills/verify/`.

## Model names

OMP uses its own model selection; without a pstack sheet, use the runtime's defaults. The global `~/.omp/pstack-models.md` is shared across OMP profiles; `session hook: off` there disables main-session routing while retaining the subagent mapping. Configure models only when the user asks. List available chat models with `omp models --kind chat` and inspect the active OMP configuration with `omp config`. Ask which available models the user wants for routine, worker and demanding roles. Configure OMP's own `modelRoles` and `task.agentModelOverrides` through its configuration interface, preserving unrelated settings. Use only models listed by the active installation; do not copy Claude model aliases into OMP. If the available agent roster cannot select distinct models for a requested panel, report that limitation.

## Per-skill notes

| Skill | On OMP |
| --- | --- |
| `why` | Use OMP tools and available sources. |
| `automate-me` | Look for mode skills under `.omp/skills/`, `.agents/skills/`, and the active profile's agent directory (`~/.omp/agent/skills/` by default, `~/.omp/profiles/<name>/agent/skills/` under a named profile) as well as the Claude Code paths. Write a new project mode skill to `.omp/skills/<handle>-mode/SKILL.md`, and a personal one to `<handle>-mode/SKILL.md` in that agent directory's skills folder. OMP does not load a skill nested in a category directory, so keep the mode skill directly under the skills folder. |
| `create-verification-skill` | The generated skill lands under `.claude/skills/verify/` on Claude Code; on OMP write it to `.omp/skills/verify/`, where OMP loads native project skills. The app-driving harness is platform-neutral. |
| `maintain-verification-skill` | Look for the project-local skill under `.omp/skills/` first, then under `.claude/skills/` and `.agents/skills/`. |
| `create-formal-verification-skill` | On OMP write the generated skill to `.omp/skills/<area>/`, named for the area it verifies, with a `description` in its frontmatter, because OMP skips a native skill without one. The verifier and its run command are platform-neutral. |
| `maintain-formal-verification-skill` | Look for project skills, the formal verification skill among them, under `.omp/skills/` first, then under `.claude/skills/` and `.agents/skills/`. |
| `reflect` | For a pstack skill, never edit the installed plugin. Its edited copy is the one exception to keeping pstack skills out of a standalone directory. Before approval, show the destination in OMP's skill folders, and after approval copy the skill folder there: `.omp/skills/<skill>/` for a project copy, or `<skill>/` in the active profile's agent skills folder for a personal one. That folder is `~/.omp/profiles/$OMP_PROFILE/agent/skills/` when `OMP_PROFILE` is set, and `~/.omp/agent/skills/` otherwise. OMP skips Claude Code's personal skills folder by default, and loads it only when `skills.enableClaudeUser` is on, `enabledProviders` lists `claude`, or `CLAUDE_CONFIG_DIR` is set. Edit a project or personal skill where it already lives. OMP gives the edited copy the skill's bare name and lists the plugin's copy as `pstack/<skill>`. pstack's own skill invocations then read `skill://pstack/<skill>`, per the `Skill` row and the routing instruction, so the edited copy runs only when the user or OMP's skill catalog invokes it by its bare name. |
