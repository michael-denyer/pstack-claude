# T3 Code host mapping for pstack

T3 Code is a host, not a runtime. It runs Claude Code or Codex and adds its own orchestration tools and rules through the `t3-code` MCP server. Read this file when the session's instructions carry a T3 Code orchestration section or list `t3-code` tools. Read it on top of the runtime's own mapping. On Claude Code the skills work as written apart from the changes below. On Codex, [`codex-tools.md`](codex-tools.md) still applies first.

T3's tools are often deferred. On Claude Code their full names start with `mcp__t3-code__`, and `ToolSearch` loads them. This file uses the bare names. Where T3's host instructions and a pstack rule disagree, follow the host. The host enforces its rules, so a pstack default that breaks one fails at runtime. Every rule here keeps its pstack intent and changes only the mechanism.

## Subagents

poteto-mode's [Subagents](../SKILL.md#subagents) section sets `run_in_background: true` on every `Agent` call. T3 splits dispatch by what the child needs.

| Child | On T3 Code |
|-------|------------|
| Same provider, a model the `Agent` tool offers, no settings beyond model and effort, works in your checkout | `Agent` with `run_in_background: false`. Send parallel children as several `Agent` calls in one response. They run concurrently, and your turn resumes when all of them return. |
| Must run in the background while you keep working | `delegate_task`. Never a background `Agent`. |
| Needs its own checkout, which every writer in a parallel fan-out does | `delegate_task` with `isolation: "worktree"`. |
| Another provider's model, or settings `Agent` cannot carry | `delegate_task`, with the settings in `target.options`. |

- Call `orchestrator_capabilities` once per thread before the first `delegate_task`. Call it again only after an error or a provider change the user named. When a provider or model is unavailable, say so. Never switch provider unasked, and never fall back to native tools or a CLI.
- A `delegate_task` child is not a Claude subagent type. In place of `subagent_type: "pstack:poteto-agent"`, tell the child in its brief to read poteto-mode's `SKILL.md` in full before any work. Do the same for `comment-sicko` and the thermo-nuclear reviewers, with the files the [Codex mapping](codex-tools.md#subagent-policy) names.
- A panel entry in the override sheet that names another provider's model dispatches through `delegate_task`. The rest of the panel stays on `Agent`.
- Follow a running delegate's `next`. Never poll it with `task_status`, `sleep`, a watcher, `Monitor`, or `ScheduleWakeup`.
- Fresh subagents by default holds. Every new review or re-check is a new `delegate_task`, never `t3_thread_send`. Stop a delegate you replace with `task_cancel`, never `t3_thread_interrupt` on its `childThreadId`. Stop a native `Agent` with `TaskStop`.
- Never create a child's worktree in the shell or in the brief. The `delegate_task` isolation option makes it.
- The **Autopilot-full** hourly audit tick stays, because it audits the run's record, which T3 cannot see. It judges each delegate by its pushes, PR activity, and trail rows, never by `task_status`. It replaces a stuck delegate with `task_cancel` and a fresh `delegate_task`.
- A child does its work itself and starts no subagents unless its brief says to.

## Threads

A user who says subagent, swarm, delegate, or parallel is not asking for a new top-level thread. A `delegate_task` child runs in a child thread T3 manages, and that is not one either. Call `t3_thread_launch` or `create_threads` only when the user asks for a new thread. Given a thread id, `t3_thread_read` it before you answer about it, which covers the **Session pickup** playbook's transcript step. Mention a thread by its `link`, verbatim.

## Pull requests and waiting

| pstack step | On T3 Code |
|-------------|------------|
| Opening a PR, any playbook | After creating a PR or pushing to one, call `link_pull_request` as the next call, or `link_pull_requests` with every layer of a stack. Say so when linking fails. |
| Babysit `check` | One `watch-pr --status-only` read and a report. No watch. |
| Babysit `drive` and `background` | In place of `/loop` and the polling watcher, finish the push wave, call `watch_pull_request`, and end the turn. T3 wakes you on a change. Read each verdict with `watch-pr --status-only`. Rearm after every push wave. At the stop condition, or before any handback, call `unwatch_pull_request`. |
| Shipping step 5 | Same as `drive`. Read the queue's state with single status reads between wakes. Keep every `ship-pr` safety check. |
| Autonomous run step 2 | A PR or CI event uses `watch_pull_request`. A background command or `Monitor` you started uses `t3_background_wait` before you end the turn. Only external state T3 cannot see, such as a deploy, keeps the `loop` skill. |
| Autopilot-full and Autopilot-stack owners | Delegated children never watch, even when the brief assigns the babysit loop. The owner fixes and pushes, then returns. The root watches each PR and starts a fresh owner for the next round. |

Never wait on a PR with `sleep`, a loop, `gh --watch`, `Monitor`, or `ScheduleWakeup`. A child that worked on a PR ends its report with the line `PR <full URL>, head <SHA>, checks and reviews <state>`.

## Verification and visuals

- Prove a UI change with the project's `verify` skill or `run`. Use the `preview_*` tools only when the current request asks for browser work or names a page or tab, and close any tab you opened before you reply.
- For an iOS Simulator or Android Emulator, use `device_list`, `device_open`, and the `agent-device` command it returns for every launch, tap, and screenshot. Keep `simctl` and `adb` for builds, installs, and logs.
- A trend or comparison in the reply is a chart through `html_preview` and `html_render`, not a screenshot path.

## Human input

- A login, token, PIN, pairing code, or sudo password only the user can give goes through `request_secret`, never `AskUserQuestion` or a chat ask.
- For work on another machine, list linked machines with `t3_environment_links`. Link one the user names with `t3_environment_link`.

## Worktree cleanup

Before the **Worktree and simulator cleanup** playbook prunes anything, list T3's worktrees with `t3_worktree_list` and keep any that a live thread uses.
