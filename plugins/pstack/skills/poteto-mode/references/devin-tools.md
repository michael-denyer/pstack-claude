# Devin CLI tool mapping for pstack

pstack skills use Claude Code tool names. On Devin CLI, resolve them through this mapping before following a skill. The shared skills work in native plugins and skills-only installations. This mapping targets local Devin CLI, where custom profiles and lifecycle hooks load.

## Tool actions

| pstack or Claude action | Devin CLI equivalent |
| --- | --- |
| Read a file | `read` |
| Create a file | `write` |
| Edit a file | `edit` |
| Delete a file | `exec` with the explicit path and appropriate authorization |
| Search file contents | `grep` |
| Find files | `find_file_by_name` |
| Run a shell command | `exec` |
| Read a running shell's output | `get_output` |
| Send input to a process | `write_to_process` |
| Stop a shell process | `kill_shell` |
| Fetch a URL | `webfetch` |
| Search the web | `web_search` |
| Invoke a skill | `skill` with the discovered skill name |
| Discover project skills | `skill` with `command: "list"` and the project `path` |
| Discover plugin skills | `skill` with `command: "search"`, `source: "plugins"`, and optional keywords |
| Track tasks with `TaskCreate`, `TaskUpdate`, or `TodoWrite` | `todo_write` |
| Ask the user | `ask_user_question`, or plain conversation when unavailable |
| Discover MCP connections and tools | `mcp_list_servers`, then `mcp_list_tools` |
| Call an MCP tool | `mcp_call_tool` |
| Dispatch a subagent | `run_subagent` |
| Read or wait for a subagent | `read_subagent` |

Use the exact schemas exposed by the current session. The observed file tools are `edit` and `find_file_by_name`; do not substitute Claude or Codex tool names. Skills-only names can differ from native plugin names. Discover before concluding a skill is absent.

## Subagent policy

Devin children cannot see the parent's conversation and cannot ask the user. Every task needs the complete brief, relevant findings, absolute workflow paths, working directory, write permissions, and expected result. The parent owns the final answer and reviews every child's changes.

`run_subagent` accepts only `profile`, `task`, `title`, `is_background`, and `resume`. Its required fields are `profile`, `task`, and `title`. Map Claude `run_in_background` to `is_background`. Use `is_background: true` when independent work can continue. Dispatch independent background children together. When waiting is the only next action, a foreground child avoids background permission problems.

For an inherited ad hoc worker, use this shape with the installed skill's absolute path:

```javascript
run_subagent({
  profile: "subagent_general",
  task: "Read /absolute/path/to/poteto-mode/SKILL.md in full. Work in /absolute/path/to/worktree. Full task brief and permissions...",
  title: "Implement validation",
  is_background: true
});
```

For a pinned role, use the exact generated profile name resolved under [Model names](#model-names). Include the same full brief. `subagent_general` inherits the parent model. A custom profile without `model` uses Devin's router or configured subagent model, so omitting `model` in a custom profile does not express inheritance.

Keep semantic agent instructions when substituting a model profile. For an ad hoc `poteto-agent`, point at [poteto-mode](../SKILL.md). For comment review, point at [comment-sicko](agents/comment-sicko.md). For the thermo reviewers, point at [thermo-nuclear-review](../../thermo-nuclear-review/SKILL.md) or [thermo-nuclear-code-quality-review](../../thermo-nuclear-code-quality-review/SKILL.md). A generic generated profile supplies the model, while these instructions supply the role. Give every reviewer an explicit no-write instruction and the exact diff to review. That instruction is a prompt restriction, not an enforced read-only tool mode. For `readonly: true`, use `subagent_explore` only when its router-selected model is acceptable. A role with a pinned UID keeps its generated profile and the explicit no-write prompt.

Give each writing child an explicit separate worktree or disjoint output directory. Devin dispatch does not create a worktree. Generic generated profiles have all normal tools, including enabled MCP tools, and no default nested delegation. The parent launches the required children when a workflow needs fan-out. Enable nesting only through a deliberately configured profile and within the user's authorized scope.

Devin sends completion notifications for background children. Continue useful work until notified, then collect the result:

```javascript
read_subagent({agent_id: result.agent_id, block: true, timeout: 30});
```

Do not poll unchanged results in a loop. A background permission denial can require a foreground resume. Resume with `run_subagent`, the existing agent ID in `resume`, its profile, and a complete follow-up task. Resumed children always run in the foreground. Prefer a fresh child for new work unless its existing state is needed.

The observed API has no child messaging, child interruption, stop, or close operation. `kill_shell` controls shell processes, not subagents. Do not claim an abandoned child has stopped. If a workflow requires proving its writer stopped, keep that gate closed until completion is observed or the user stops it through the CLI. A required independent review stays blocked when policy, unavailable profiles, permissions, or capacity prevent an independent reviewer from running. Label an exploratory sequential pass and reduced model diversity honestly.

## Model names

Skills name Claude Code aliases in their Models sections. Devin CLI ships no pstack model defaults. Run `setup-pstack` to choose concrete UIDs from `devin models list`; never substitute a Claude alias or invent a UID.

The sheet is `${XDG_CONFIG_HOME:-~/.config}/devin/pstack-models.md`. Read its saved role choices before dispatching. `inherit-parent` and `auto` select `subagent_general`, which inherits the parent's model. A concrete UID selects the pinned profile created by setup. Resolve its exact name with `node <setup-pstack>/scripts/devin-profile.mjs --model <UID> --name-only`, using the installed skill's absolute path. Check that the profile is available before dispatching; if it is missing, finish [Devin setup](../../setup-pstack/devin.md) first.

`run_subagent` takes `profile`, `task`, `title`, `is_background`, and `resume`. It has no model or reasoning-effort parameter. Custom profiles without `model` use the router rather than inheriting the parent. Choose a full UID whose thinking level matches the user's choice. Do not interpret an `@effort` suffix on Devin; keep `default effort: session`.

For diverse-model panels, use distinct available UIDs from different model families when possible. If access limits the panel, report the reduced diversity. A required independent review stays blocked if no independent reviewer can run.

## Session routing hook

The native package registers a top-level `SessionStart` event in its root hook file. The POSIX adapter emits `hookSpecificOutput` with `hookEventName: "SessionStart"` and `additionalContext` containing the routing mandate and this mapping's path. It reads `${XDG_CONFIG_HOME:-~/.config}/devin/pstack-models.md` through the shared decoder. Only an exact decoded line `session hook: off` disables routing. Indented lines, comments after the value, and alternate case leave routing on. It does not inject raw model-sheet text.

The compatibility convention is `CLAUDE_PLUGIN_ROOT`. Check the repository's runtime reference for the recorded native-install verification limits. The repository's Devin smoke check exercises project hooks, shared skills, XDG configuration, and pinned profile dispatch. Plugin hooks fail open in Devin, so verify loaded hooks with `/hooks` before relying on automatic routing. No Windows hook contract is claimed.

A skills-only install carries the mapping, agent references, and profile helper. Run `poteto-mode` explicitly or add a standing routing instruction to the project's `AGENTS.md`. Use the same model sheet and [Devin setup](../../setup-pstack/devin.md).

## Drivers and bundled skills

| Skill or driver named by pstack | On Devin CLI |
| --- | --- |
| `run` | Drive the real CLI through `exec` and its process tools. Inspect actual output. |
| Project UI driver | Use the project's driver and the browser tools exposed by the session. Report missing automation instead of claiming a UI check passed. |
| `plugin-dev:skill-development` | Use available skill-authoring guidance. Keep `name` and `description` frontmatter, relative references, and progressive disclosure. |
| `loop` | No equivalent is assumed. Continue the authorized loop in the current session, or use an explicitly available scheduler. Do not promise a future wakeup without one. |

## Per-skill notes

| Skill | On Devin CLI |
| --- | --- |
| `interrogate` | Dispatch reviewers with configured profiles and complete briefs. State no-write permissions explicitly. Report reduced model diversity or blocked independent review. |
| `setup-pstack` | Follow [Devin setup](../../setup-pstack/devin.md), discover concrete UIDs with `devin models list`, and materialize pinned profiles with its helper. |
| `no-comments` | Use the selected model profile and pass the [comment-sicko instructions](agents/comment-sicko.md). |
| `thermos` | Dispatch both reviewers with the selected profiles and the full corresponding thermo skill paths. Keep reviewer writes forbidden. |
| `teach` | The parent dispatches `how` and `why` work with full briefs. Use available visual tools only. |
| `create-verification-skill` | Put the project skill under `.devin/skills/verify/`. Keep the real app-driving harness portable. |
| `maintain-verification-skill` | Dispatch source readers with `run_subagent`; the parent drives the live session. The project skill lives under `.devin/skills/`. |
| `babysit` | Use `exec` and process tools for the watcher. No scheduled wakeup is assumed. Human questions use `ask_user_question`. |
| `automate-me` | Follow the skill-authoring guidance above. Save personal instructions in the current runtime's skill location. |
| `architect` | Its arena panel uses the selected profiles. The parent owns nested dispatch unless a profile explicitly enables nesting. |
| `arena` | Dispatch each candidate and the cross-judge with their saved profiles, complete briefs, and explicit separate worktrees for writers. |
| `how` | Dispatch explorers and the explainer with saved profiles and full briefs. Collect results with `read_subagent`. |
| `reflect` | Pass the current session digest or use `devin --export /absolute/path/to/transcript.json` for this workspace's session. Do not inspect unrelated Claude transcript directories. |
| `swarm` | Dispatch disjoint workers with `run_subagent`. Create and name each writer's worktree before dispatch. |
| `why` | Discover evidence through `mcp_list_servers` and `mcp_list_tools`, then call tools through `mcp_call_tool`. The parent dispatches investigators with full briefs. |

## Vendored scripts and instructions

Run the shared scripts through `exec` with Node.js or Bun as their shebangs require. GitHub work also needs `gh`; stack work can need `gt`. Where a skill names an instructions file, use the project's `AGENTS.md` or Devin's configured rules. For transcript work, export or read only the current workspace's Devin session and pass the digest the workflow permits.
