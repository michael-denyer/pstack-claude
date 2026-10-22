# OMP tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names). On OMP the skills are the same files, discovered from a custom directory. OMP has its own batch subagent tool, question tool, todo tool, `/loop` command, and model roles, so read this when a pstack skill names a Claude tool, a driver or bundled skill, or a Claude model. This file is OMP-specific. Codex, Pi, GitHub Copilot, Muse, and other runtimes must use their own mappings.

## Tool actions

| pstack / Claude action | OMP equivalent |
|------------------------|----------------|
| Read a file | `read` |
| Create a file | `write` |
| Edit a file | `edit` (exact text replacement) |
| Delete a file | `bash` (`rm`) |
| Run a shell command | `bash` |
| Run Python or JavaScript | `eval` with `language: "py"` or `language: "js"` |
| Search file contents or find files | `grep`, `glob`; `find` for semantic search |
| Fetch a URL | `read` for a static URL; `eval` with the browser prelude for an authenticated or interactive page |
| Search the web | `web_search` |
| Invoke a skill | Skills load natively. Use `/skill:<name>` or `read skill://<name>/SKILL.md`. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `task` |
| Dispatch N parallel subagents in one turn | One `task` call with `context` and `tasks[]`; every item starts in that call |
| Wait for a background result | `wait` when there is no other work. Results also deliver automatically, so do not poll. |
| Read a full subagent result | `read agent://<id>` |
| Read a subagent transcript | `read history://<id>` |
| Send a follow-up to a subagent | `write agent://<id>` when peer messaging is enabled; `agent://all` broadcasts |
| Ask the human a fixed-choice question (`AskUserQuestion`) | `ask` |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `todo` |
| Browser work | `eval` with the browser prelude when `browser.enabled` is on, or the session's browser MCP. Screenshots are mandatory proof. |
| Generate an image | `generate_image` when it is enabled, then `read` the saved file |

`read` takes one path, URL, or internal URL. It also reads skill files, subagent output, and subagent history through `skill://`, `agent://`, and `history://`.

## Task contract

OMP's `task` tool uses the batch shape by default (`task.batch: true`):

```json
{
  "context": "Shared background rendered into every child's instructions.",
  "tasks": [
    {
      "name": "ReviewAuth",
      "agent": "reviewer",
      "task": "Complete, standalone brief for this child.",
      "solutionSpace": "Cause open; no reproduction yet."
    }
  ]
}
```

- `context` is required and reaches every child.
- Each `tasks[]` item requires `task` and `solutionSpace`. `solutionSpace` says how open the problem is, not how large it is.
- `name` is optional. Use a unique CamelCase name so `agent://<id>` is easy to recognize.
- `agent` defaults to `task`. Set it per item when you need `scout`, `reviewer`, `security-reviewer`, or another discovered agent.
- Do not put a `model` field in a normal task item. OMP resolves the model from `task.agentModelOverrides`, then the agent's frontmatter, then the parent. The `seance` agent is the only exception.
- `effort` exists only when `task.enableEffort` is on. Its values are `lo`, `med`, and `hi`; otherwise effort comes from the agent's `thinkingLevel` or the model selector.
- `isolated` exists only when `task.isolation.enabled` is on and plan mode is off. Without it, give each writing worker a separate checkout or disjoint paths.
- A child must not call `task`, start its own subagents, or ask the human. Put that under `FORBIDDEN` in every brief.
- A task result is evidence, not completion. Read `agent://<id>` and inspect the real artifact yourself.

The flat shape is used only when `task.batch` is off. Do not use it otherwise.

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "pstack:poteto-agent"`, `run_in_background: true`, per-call model). On OMP:

- The bundled roster is `scout`, `reviewer`, `security-reviewer`, `task`, `sonic`, and `seance`.
- A skills-only pstack install has no pstack agent types. Route `pstack:poteto-agent` through `task` and tell the child to read the `poteto-mode` skill in full first. Route `pstack:comment-sicko` through `task` and tell it to read [`references/agents/comment-sicko.md`](agents/comment-sicko.md) first.
- If OMP discovers the pstack plugin's agent files, the bare names `poteto-agent` and `comment-sicko` may also be available. Use them only when the session's task tool lists them; otherwise use the `task` fallback.
- There are no Claude `thermo-nuclear-review-subagent` or `thermo-nuclear-code-quality-review-subagent` types. Dispatch one `task` batch with two items: `reviewer` for the correctness and security brief, and `security-reviewer` for the code-quality brief. Give each the same diff and file context, then read both results and synthesize them.
- `readonly: true` has no separate flag. Say in the brief that the child must not change files, and review its work anyway.
- `run_in_background: true` has no separate flag. OMP's task jobs already run asynchronously when `async.enabled` is on; results deliver without polling.
- `isolation: "worktree"` maps to `isolated: true` only when isolation is enabled. Otherwise create the worktree yourself and put the writer in it.
- A role's `@<level>` suffix, or the sheet's `default effort`, maps to the model selector's thinking suffix or the agent's `thinkingLevel`. When `task.enableEffort` is on, use the OMP effort values `lo`, `med`, and `hi` instead of the Claude level names.
- Keep the rest of the policy unchanged. Pass file pointers, not inlined context. Give every writer its own worktree or output directory. Review every child's diff yourself.

## Models

OMP's model authority is native: `modelRoles` and `task.agentModelOverrides` in `~/.omp/agent/config.yml`. A pstack model sheet, the Codex model panel, and per-call task `model` fields are not OMP inputs. Do not copy Claude aliases or Codex panel slugs into OMP configuration.

The roles that matter for pstack are:

| pstack role tier | OMP setting |
|------------------|-------------|
| Single-role default: `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `swarm workers` | `modelRoles.default`; give generic `task` children the same model with `task.agentModelOverrides.task: "@default"` |
| Worker: `feature, refactoring` | `modelRoles.smol`; route `scout` and `sonic` through `task.agentModelOverrides` with `"@smol"` |
| Strongest: `strongest judgment` | `modelRoles.slow`; route `reviewer` and `security-reviewer` through `task.agentModelOverrides` with `"@slow"` |
| Plan and architecture: `architect` runners | `modelRoles.plan` |
| Panels: `arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers` | OMP has no per-item model field. Put distinct models on distinct agent files with `model:` frontmatter, or give each panel agent its own `task.agentModelOverrides` entry. If the panel collapses to one model, say in the verdict that diversity was reduced. |
| `comment-sicko` | `task.agentModelOverrides.comment-sicko` (for example `"@slow"`), or the agent's own `model:` frontmatter |

A role value may carry a thinking suffix such as `:high` or `:xhigh`. The pstack effort levels map to that suffix, or to an agent's `thinkingLevel`. OMP's `task.enableEffort` is off by default; when it is on, a task item takes `effort: "lo"`, `"med"`, or `"hi"` instead.

Model choices stay in `modelRoles`; `task.agentModelOverrides` may point at a role alias such as `"@smol"`, so changing the role changes every agent that follows it. A model role accepts one primary selector; put fallbacks in `retry.fallbackChains`.

If two panel agents resolve to the same model, report that model diversity is reduced rather than claiming a second opinion.

`/setup-pstack` on OMP does not write a Markdown sheet. It asks the same role questions, then sets the native roles through OMP's model Roles view or the OMP config. List candidates with `omp models --kind chat`. The [setup-pstack runtime table](../../setup-pstack/SKILL.md#other-runtimes) names the OMP entry.

## `/loop`

`/loop` is an interactive OMP session command, not a subagent tool. A skill must give the user the exact command and must not emulate it with a sleep loop:

```text
/loop
/loop 5 Review the next unreviewed migration
/loop 30m Process the next item in the queue
/loop 1h30m Check the next repository and record the result
```

- Without an interval, `/loop` repeats the next prompt after each turn.
- A positive integer limits automatic re-submissions.
- A duration stops at the wall-clock deadline.
- Run `/loop` again to disable it. `Esc` aborts an iteration or pauses between iterations.
- For active CI, `gh pr checks --watch` blocks until checks finish, so that pass needs no interval.
- For an awaiting reviewer, use `/loop 20m ...`; for idle polling, use `/loop 1h ...`.

## Skills and paths

- `skill://<name>` resolves a skill; `skill://<name>/SKILL.md` resolves its body.
- `/skill:<name>` invokes a skill in an interactive session.
- OMP scans a custom skills directory one level deep for `<name>/SKILL.md`. Point the directory at the pstack `skills` root, not at a parent that adds another level.
- The pstack clone is the catalog. Add its `plugins/pstack/skills` directory to `skills.customDirectories` in `~/.omp/agent/config.yml`, preserving the entries already there.
- Project skills live under `.omp/skills/<name>/SKILL.md`.
- Claude's `.claude/skills` is not the OMP project root.
- `CLAUDE.md` maps to `AGENTS.md`.
- pstack ships no OMP extension in this port. OMP's own `task`, `ask`, `todo`, `wait`, `/loop`, models, and transcript URLs supply what the pstack Pi extension supplies on Pi.

## Session routing

OMP has no pstack `SessionStart` hook. Add a standing instruction to the global `~/.omp/agent/AGENTS.md`, or to a project `AGENTS.md`:

```text
Before following a pstack skill, read <clone>/plugins/pstack/skills/poteto-mode/references/omp-tools.md.
For a task that touches more than one file, changes a signature other files call, involves a design choice, or is a bug with an unknown cause or a performance issue, load the poteto-mode skill and follow it.
```

Replace `<clone>` with the absolute path of the pstack checkout. The first line resolves OMP tool, subagent, model, and path names; the second is the routing mandate. `session hook: off` is inert on OMP because no pstack OMP hook reads it. If an OMP extension is added later, update this section and the mapping together.

## Driver and bundled skills

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these OMP equivalents:

| Skill or driver named in pstack | On OMP |
|---------------------------------|---------|
| `run` (drive a CLI/TUI to see a change work) | Run the app with `bash` or the browser prelude and observe the real output. |
| `verify` (the project's `.claude/skills/verify/`, or Claude Code's bundled `/verify`) | Read the project skill by path, or generate it under `.omp/skills/verify/SKILL.md` with `create-verification-skill`. |
| Project UI driver | Use the browser prelude or the session's browser MCP; keep a screenshot. Never claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | Follow OMP's skill authoring documentation; use `writing-for-agents` or `skill-creator` when installed. |
| `loop` (recurring or self-paced re-invocation, used by `babysit`) | `/loop` as above. |
| `watch-pr`, `ship-pr`, and `orch` scripts | Run them through `bash`; they need `bun` and `gh`. |
| Claude Code session transcripts | OMP sessions live under `~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. Use `history://<id>` for a subagent and pass an OMP session file to `find-transcript.mjs` or `reflect` when the current session is the source. |

## Per-skill notes

Affected skill entry points point here. Most skills need only the tables above. These need one more mapping:

| Skill | On OMP |
|-------|--------|
| `poteto-mode` | Its Subagents section is Claude-specific. Ignore `subagent_type`, `run_in_background`, and per-call model fields. Use one `task` batch with the roster above, and resolve models through the Models section. |
| `thermos` | Dispatch one `task` batch with a `reviewer` item and a `security-reviewer` item; there are no Claude thermo-nuclear agent types. |
| `no-comments` | Dispatch `task` with a brief to read [`references/agents/comment-sicko.md`](agents/comment-sicko.md) first, or use a discovered `comment-sicko` agent when the task tool lists it. |
| `babysit` | Use `ask` for a human choice and `/loop` for a cadence. The `watch-pr` script runs through `bash` and needs `bun` and `gh`. |
| `interrogate` | Map the reviewer panel to one `task` batch. Give each reviewer its own agent name and model override, or report reduced model diversity. |
| `reflect`, `how`, `why`, `swarm`, `arena`, `architect`, `teach` | Map fan-out to `task` batches. Read `agent://<id>` for the full result and `history://<id>` when a report is thin. |
| `recall` | Read this workspace's OMP sessions under `~/.omp/agent/sessions/`, not Claude Code's projects directory. Use `history://<id>` for a subagent. |
| `show-me-your-work` | Check the decision log against this run's OMP session file, not a Claude Code transcript. |
| `setup-pstack` | OMP has no pstack sheet. Use OMP's model Roles view or `modelRoles` and `task.agentModelOverrides`; see [the runtime table](../../setup-pstack/SKILL.md#other-runtimes). Do not write Claude aliases into OMP config. |
| `create-verification-skill`, `maintain-verification-skill`, `create-formal-verification-skill`, `maintain-formal-verification-skill` | Write generated project skills under `.omp/skills/<name>/SKILL.md`, not under `.claude/skills/`. The verification harness is platform-neutral. |
| `automate-me` | Use OMP's skill authoring guidance. A personal mode skill belongs in the OMP user skills directory or `.omp/skills/<name>/SKILL.md`; there is no `plugin-dev` plugin on OMP. |
| `typescript-best-practices` | Its `paths` frontmatter is metadata on OMP, not an automatic invocation rule. Invoke it by name for TypeScript work. |
| `fix-ci`, `get-pr-comments`, `make-pr-easy-to-review`, `fix-merge-conflicts` | These use `gh` and `git` through `bash`. No extra mapping. |
| `deslop`, `what-did-i-get-done` | Plain prompt and git history. No extra mapping. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher, the `orch` store CLI, and `worktree-audit.mjs`. They use bun and Node.js and run the same on OMP; invoke them through `bash`. They need `bun` and `gh`, or `origin` when the forge is Origin.

`worktree-audit.mjs` scans OMP sessions in `~/.omp/agent/sessions` in addition to Claude Code, Codex, Pi, and Copilot transcripts. A profile or a relocated agent directory needs its sessions path passed after the repository path. The audit follows links, classifies worktrees, and never deletes anything; deletion stays a human-gated step in the playbook.

`reflect` uses `find-transcript.mjs`. It reads OMP's title-slot session format, so pass the OMP sessions directory or an OMP session file when the source is this workspace. If the transcript is unavailable, use the session digest the skill allows.

## Instructions file

Where a pstack skill says "your instructions file", on OMP that is `AGENTS.md`: the project root and any parent directory OMP discovers, plus `~/.omp/agent/AGENTS.md` for every workspace. On Claude Code it is `CLAUDE.md`.
