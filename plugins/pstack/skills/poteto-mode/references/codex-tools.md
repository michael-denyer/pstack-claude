# Codex tool mapping for pstack

pstack skills are written in Claude Code tool language (the `Skill` tool, the `Agent` tool, `AskUserQuestion`, Claude model names). On Codex the skills are the same files; only the tool names resolve differently. Read this when a pstack skill names a Claude tool, a driver or bundled skill, or a Claude model. This file is Codex-specific. Gemini CLI, opencode, Prime Agent, and other runtimes must use their own concrete tools, model names, and configuration paths.

## Tool actions

| pstack / Claude action | Codex equivalent |
|------------------------|------------------|
| Read a file | `shell` (`cat`, `head`, `tail`) |
| Create / edit / delete a file | `apply_patch` |
| Run a shell command | `shell` |
| Search file contents / find files | `shell` (`rg`, `grep`, `find`, `ls`) |
| Fetch a URL | `shell` with `curl` / `wget` |
| Search the web | `web_search` |
| Invoke a skill (the `Skill` tool, `/command`) | Skills load natively. Follow the instructions presented. |
| Read a principle leaf (the **principle-<title>** skill, or the **<title>** principle skill, a pstack skill names) | Principle leaves are left out of Codex's skill list by their `agents/openai.yaml`. Read the leaf with `shell` at `<poteto-mode-dir>/../principle-<title>/SKILL.md`, with `<poteto-mode-dir>` resolved to the `poteto-mode` skill's directory and `<title>` in kebab case, or the explicit name a Principles entry gives. |
| Dispatch a subagent (the `Agent`/`Task` tool) | `spawn_agent` |
| Dispatch N parallel subagents in one turn | N `spawn_agent` calls in one response |
| Wait for a subagent result | Use `wait_agent` as described under [Agent lifecycle](#agent-lifecycle). |
| Stop a subagent (`TaskStop`) | `close_agent` or `interrupt_agent`, whichever the session exposes. See [Agent lifecycle](#agent-lifecycle). |
| Track tasks (the todolist; `TaskCreate` / `TaskUpdate`, or `TodoWrite` on Claude Code) | `update_plan` |
| Ask the human a fixed-choice question (`AskUserQuestion`) | Use `request_user_input` when the current mode and client support delivering structured questions, such as an interactive Plan mode session. If support is unclear or the tool is unavailable, ask in plain text. Outside Plan mode, ask a required decision or approval in plain text, because Codex continues on its own judgment when `request_user_input` returns no answer. |
| Read this workspace's session transcripts (Claude Code's `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/<encoded-cwd>/`) | Codex sessions live in `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/`. Ordinary names end in `-<thread-id>.jsonl`; replacements after `thread/revert` end in `-<thread-id>_<rollout-id>.jsonl`. Revert keeps the old files. Resolve the current path from the state database's `threads.rollout_path`, matched by thread ID, rather than filename order or modification time. Archived sessions are in `${CODEX_HOME:-~/.codex}/archived_sessions/`. Older rollouts in both directories can end in `.jsonl.zst`; read those with `zstd -dc`. The first line of each rollout is a `session_meta` record. Keep only rollouts whose `payload.cwd` is the workspace or one of its worktrees. Never read other projects' sessions. |

Subagents are enabled by default in current Codex, and `agents.enabled` controls them. Inspect the current tool surface. If dispatch is unavailable, the fan-out skills (`interrogate`, `why`, `how`, `arena`, `reflect`) degrade to a labeled sequential pass. A required independent review does not degrade. It stays blocked, as poteto-mode's [Subagents](../SKILL.md#subagents) section says.

## Agent lifecycle

Codex has two sets of agent tools, and `wait_agent` behaves differently in each. Choose by the tools the current session lists.

- With `close_agent`, `wait_agent` waits until the requested agents reach a final status. Use the final result or the completion notification. Close an agent with `close_agent` when you no longer need it. Its response is the status before shutdown was requested, not a confirmation that the agent stopped.
- With `interrupt_agent`, `wait_agent` returns on mailbox activity from any agent and does not carry the content. Read the delivered message or final-status notification from the delegate you are waiting on. Another agent's message, a timeout, or steering from the user leaves the delegate's result pending. `interrupt_agent` stops the delegate's current turn and returns its previous status; the agent stays available for follow-up tasks. `list_agents` reports each live agent's last known status.
- With neither tool, or without `wait_agent`, use the notification or status tools the session does expose.

Before you replace a writer or reuse its worktree, confirm through a later status (a final status, a completion notification, or `list_agents`) that its turn has ended. A close or interrupt response alone does not confirm it. If you cannot confirm it, leave the worktree with its writer.

A thread-limit error from `spawn_agent` is a capacity error, so changing the model does not fix it. After the first rejection, stop spawning. Close a finished agent with `close_agent` before you try again; a completed agent counts toward the limit until it is closed. Where the session has no `close_agent`, do not assume a finished agent's slot is free. Interrupting a turn does not close the agent.

## Subagent policy

poteto-mode's Subagents section sets Claude-specific defaults (`subagent_type: "pstack:poteto-agent"`, `run_in_background: true`). On Codex:

- There is no `poteto-agent` subagent type. Route an ad-hoc subagent through poteto-mode's style by dispatching a `spawn_agent` whose instructions tell it to read the `poteto-mode` skill in full first.
- When the exposed spawn schema accepts a role, map Claude's `general-purpose` to `agent_type: "default"`, or use `explorer` for exploration when available. Omit the role field when the schema has none, and on a full-history fork (`fork_context: true`), which inherits the parent's role and rejects a new one. Instruct exploration agents to leave files unchanged on either interface. A read-oriented role does not enforce read-only permissions. If the job requires enforced read-only access, use a Codex session with a read-only sandbox or report that the current host cannot provide that guarantee.
- For blind candidates or reviewers who should see only the brief, use `fork_context: false` on the older spawn interface or `fork_turns: "none"` where available. Check the exposed tool schema before dispatching.
- `spawn_agent` calls already run concurrently with your turn, so `run_in_background: true` has no separate flag. Issue the dispatch and continue.
- `spawn_agent` may expose `model` and `reasoning_effort` independently, or neither, so check the exposed schema before resolving either, and pass each only when the schema has it. Without `reasoning_effort`, skip the effort steps below and say that the dispatch set no level; the child runs at whatever effort the host gives it. Without `model`, the Model names substitutions below cannot reach that spawn, so say so instead of claiming a distinct model.
- For `session`, run `node <poteto-mode-dir>/scripts/codex-session-effort.mjs` before dispatching, with `<poteto-mode-dir>` resolved to this skill's directory. The [helper](../scripts/codex-session-effort.mjs) reads the active turn's effort from the exact runtime log identified by `CODEX_THREAD_ID`, under `$CODEX_HOME/sessions` (default `~/.codex/sessions`). It prints only the effort. Run it again on each turn; a UI effort change must not reuse the previous turn's value.
- The helper finds the current log through `threads.rollout_path` in `$CODEX_HOME/state_*.sqlite`, or a single `-<thread-id>.jsonl` log when no indexed path is available and no replacement exists; anything else makes effort unavailable.
- Apply poteto-mode's task adjustment to that starting level, or to the explicit role/default effort, then pass the final level as `reasoning_effort` on `spawn_agent`, including when a model is selected explicitly. An omitted effort can use a configured subagent effort or, when a model is selected, that model's default instead of the parent's level.
- Do not guess the session's effort from the model, a config default, or a previous turn. If the helper cannot identify the active turn's effort, ask for an explicit role or `default effort` level before dispatching. Do not substitute an omitted `reasoning_effort` for the missing starting level. Automatic `session` resolution depends on the host exposing the current thread's runtime log; it is not available on every Codex host.
- There is no `comment-sicko` subagent type either. The **no-comments** skill spawns it on Claude Code; on Codex dispatch a `spawn_agent` whose instructions tell it to read `poteto-mode/references/agents/comment-sicko.md` in full first.
- There are no `thermo-nuclear-review-subagent` or `thermo-nuclear-code-quality-review-subagent` types. The **thermos** skill spawns both on Claude Code; on Codex dispatch two `spawn_agent` calls whose instructions tell each to read the `thermo-nuclear-review` or `thermo-nuclear-code-quality-review` skill in full first and review only the diff and file contents in its prompt.
- Codex `spawn_agent` has no Claude `isolation: "worktree"` argument. For each writer, create a separate worktree from the intended base (use `git worktree add -b <delegate-branch> <path> <base-sha>`), verify the worktree's HEAD, and include its absolute path in the brief. Direct the delegate to use that directory for its edits and commands. Separate branches in one checkout still share the files and index.
- Keep the rest of the policy unchanged. Pass file pointers not inlined context, give each writing worker its own worktree or exclusive output directory, review every subagent's diff yourself.

## Model names

Skills name Claude defaults (a single-role default for code/prose/judgment, a worker model for feature and refactoring code, plus a diverse-model panel for diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not resolve on Codex. Substitute your configured Codex models:

- Single-model roles: your primary Codex model (for example `gpt-6.2-sol`).
- Roles that default to the Claude worker model (`feature, refactoring`): your fast Codex code model (for example `gpt-6.2-sol`).
- Roles that default to the strongest Claude model (`strongest judgment`): your strongest Codex model (for example `gpt-6.2-astra`).
- Diverse-model panels (`arena`, `interrogate`): the adversarial signal comes from model diversity, so use the distinct Codex models available to you. A good default panel on ChatGPT is `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra`, `gpt-6-luna`. If only one model family is reachable, or `spawn_agent` exposes no `model` field, vary reasoning effort where the schema has `reasoning_effort`, and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs.

## Session routing hook

The native pstack plugin bundles the same `SessionStart` routing instruction as the Claude Code plugin, through `session-start.sh` on macOS and Linux and `session-start.ps1` on Windows. Codex runs the hook on startup, resume, clear, compact, and fork after the user trusts the hook through `/hooks`. The hook reads `session hook` from the Codex sheet, at the path in [setup-pstack's runtime table](../../setup-pstack/references/runtimes.md); `session hook: off` disables injection.

A skills-only installation does not include plugin hooks. Request `poteto-mode` explicitly or add a standing instruction to `AGENTS.md` in that case.

## Driver and bundled skills pstack references

The [driver policy](../SKILL.md#non-negotiables) selects the app driver. For skills and drivers named by these workflows, use these Codex equivalents:

| Skill or driver named in pstack | On Codex |
|---------------------------------|----------|
| `run` (drive a CLI/TUI to see a change work) | Run the app yourself via `shell` and observe the real output. |
| Project UI driver | Drive the UI with whatever automation you have, or hand the user a concrete manual check. Do not claim done without observing the artifact. |
| `plugin-dev:skill-development` (Claude's SKILL.md authoring guidance) | Follow your platform's skill-authoring guidance; the `writing-skills` skill if present. Keep `name` + `description` frontmatter and progressive disclosure. |
| `loop` (recurring/self-paced re-invocation, used by `babysit`) | Codex has no `loop` skill. Re-run the step yourself on a cadence, or use a Codex scheduled task if available. |

## Per-skill notes

Affected skill entry points point here. Most skills need only the tables above. These need one more mapping:

| Skill | On Codex |
|-------|----------|
| `interrogate` | The `subagent_type`/`model` dispatch fields map to `spawn_agent`; substitute your configured Codex models and keep the adversary panel model-diverse. |
| `setup-pstack` | The skill's [Other runtimes](../../setup-pstack/references/runtimes.md) table names the Codex sheet path and how it loads; the slugs are your Codex models (see Model names above). The role rows are identical. |
| `no-comments` | There is no `comment-sicko` subagent type; see Subagent policy above. |
| `thermos` | There are no thermo-nuclear subagent types; see Subagent policy above. |
| `teach` | Running `how` and `why` in parallel maps to `spawn_agent` fan-out; image generation uses the configured Codex equivalent. |
| `create-verification-skill` | The generated skill lands under `.claude/skills/verify/` on Claude Code; write it to Codex's project-skill location instead. The app-driving harness is platform-neutral. |
| `maintain-verification-skill` | The parallel per-feature source readers map to `spawn_agent` fan-out; the project-local skill lives under Codex's skills location, not `.claude/skills/`. |
| `create-formal-verification-skill` | Write the generated skill to Codex's project-skill location, named for the area it verifies. The verifier and its run command are platform-neutral. |
| `maintain-formal-verification-skill` | Project skills, the formal verification skill among them, live under Codex's project-skill location. |
| `babysit` | `loop` and `AskUserQuestion` resolve through the tables above. |
| `automate-me` | `plugin-dev:skill-development` resolves through the skills table above. |
| `architect` | A large or contested design goes through the **arena** skill, so its `spawn_agent` fan-out and model substitution apply here too. |
| `arena` | The parallel candidates and the cross-judge map to `spawn_agent`; substitute your configured Codex models for the runners and the cross-judge pool (see Model names above). Run Phase C only when the effective judge and provisional winner are known to be different families. If the judge's family is unknown or repeats the winner's family, report the skipped cross-family check and continue with Phase D scoring. |
| `how` | The one read-only subagent maps to `spawn_agent`. |
| `reflect` | The transcript finder reads Claude Code's layout under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`, so work from the conversation in your context, as the skill allows when the finder finds nothing. For a pstack skill, never edit the installed plugin under `${CODEX_HOME:-~/.codex}/plugins/cache/`. Codex does not discover `.claude/skills/` or Claude Code's personal skills folder, so before approval show the destination in Codex's skill folders, and after approval copy the skill folder there: the repository's `.agents/skills/<skill>/` for a project copy, or `${CODEX_HOME:-~/.codex}/skills/<skill>/` for a personal one. In a skills-only install `~/.agents/skills/<skill>` is a link into a pstack checkout, so do not copy to or edit through it. Edit a project or personal skill where it already lives. Codex lists the plugin's copy as `pstack:<skill>` and the edited copy as `<skill>`, both enabled, and does not merge them. |
| `recall` | Search this workspace's Codex rollouts (see Tool actions). Do not list or read `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`. It holds Claude Code transcripts, not this session's history. In a rollout, chat messages are the `response_item` records whose `payload.type` is `message`, with the speaker in `payload.role`. Skip `developer` records, which are injected instructions. |
| `show-me-your-work` | Check the log against this run's current Codex rollout, using `CODEX_THREAD_ID` and the state index as described in Tool actions. A filename suffix alone cannot select the current file after revert. If the current path is unavailable or ambiguous, report that the audit could not run instead of guessing a rollout. Do not read Claude Code's projects directory. |
| `swarm` | Each worker is a `spawn_agent` call on your configured Codex model, and those calls already run concurrently; give each writing worker its own worktree or output directory (see Subagent policy above). |
| `why` | List MCP servers from the tools Codex exposes to the session, not from `.mcp.json` or `claude mcp list`. |
| `figure-it-out` | Read each principle skill it names through the principle-leaf row in Tool actions, since Codex does not list principle leaves. |
| `typescript-best-practices` | Read each principle skill it names through the principle-leaf row in Tool actions, since Codex does not list principle leaves. |

## Vendored scripts

`skills/poteto-mode/scripts/` ships the `watch-pr` PR watcher and `worktree-audit.mjs`. The `watch-pr/ship-pr` command owns pending-merge inspection and cancellation; `resume.mjs` owns the shared checkpoint locator described in [Resume storage](resume-storage.md). These scripts use bun and Node.js and run the same on Codex; invoke them through `shell`. They need `bun` and `gh`, or `origin` when the forge is Origin. Run `worktree-audit.mjs` with `node`, as its shebang does. The audit follows each link in a worktree's ancestor directories with `stat` and matches it by the directory it lands on, under bun and node alike. A worktree whose own path bun cannot resolve loses its last chat and lands in `review`. A dangling or looping link is ignored. Any other link that `stat` cannot follow puts every worktree under the link's directory in `review`, with a warning that names the link. `worktree-audit.mjs` scans Codex sessions under `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions` (default `~/.codex`), along with any Claude Code or Pi transcript directory that exists. It imports the transcript walker from `skills/reflect/scripts/find-transcript.mjs`, so keep the `reflect` skill installed beside `poteto-mode`.

## Sandbox writes under the Git common directory

The `workspace-write` sandbox makes `.git` read-only inside each writable root. A linked worktree's Git common directory is outside its writable roots. [Resume storage](resume-storage.md) keeps checkpoints under the common directory, so `resume.mjs begin`, the note and artifact writes into the checkpoint directory, and `resume.mjs publish` fail there with `EPERM`. `resume.mjs read` only reads, so it works in the sandbox. Treat any other pstack write under the Git common directory the same way.

- With approval policy `on-request`, run each of those writes as a `shell` command with `sandbox_permissions: "require_escalated"` and a `justification` that asks the user to allow saving the pstack checkpoint.
- With approval policy `never`, Codex rejects escalated commands. To save checkpoints in unattended runs, the user defines a permissions profile in `~/.codex/config.toml` that grants the store, one line per repository. The path is the `pstack` folder inside the directory that `git rev-parse --path-format=absolute --git-common-dir` prints.

  ```toml
  [permissions.pstack]
  extends = ":workspace"

  [permissions.pstack.filesystem]
  "/absolute/path/to/repo/.git/pstack" = "write"
  ```

  Select the profile for each run with `codex exec -c 'default_permissions="pstack"'`, and leave out `-s`/`--sandbox`, which overrides the profile and drops the grant. A profile ignores the `[sandbox_workspace_write]` table, such as its `writable_roots` and `network_access`, so put any setting the run needs into the profile. A relative `.git/pstack` entry under `":project_roots"` works only in a primary checkout. In a linked worktree `.git` is a file, and Codex cannot start the sandbox for any command.
- If neither route is available, tell the user the checkpoint was not saved. A failed `begin` or `publish` is not a ready checkpoint.

## Instructions file

Where a pstack skill says "your instructions file", on Codex that is `AGENTS.md` (project root, plus `~/.codex/AGENTS.md` global). On Claude Code it is `CLAUDE.md`.
