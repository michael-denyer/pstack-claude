# Pi equivalence

This table lists every Claude Code mechanism the pstack plugin depends on, found by scanning `plugins/pstack/` for tool names, agent fields, hooks, paths, bundled skills, CLIs, and model names. Each row says how Pi 1.0 provides the same behavior and what proves it. `tests/pi-equivalence.test.mjs` fails when a row lacks a valid status, when an `extension` or `script` row names a test that does not exist, or when a `difference` row gives no reason.

Statuses:

- `native`: Pi does it without pstack code.
- `extension`: the [pstack Pi extension](../plugins/pstack/pi/index.ts) does it, proven by the named offline test.
- `script`: a vendored script reads Pi's layout, proven by the named test.
- `mapping`: the skills already describe the behavior in prose, and [pi-tools.md](../plugins/pstack/skills/poteto-mode/references/pi-tools.md) names the Pi equivalent.
- `difference`: Pi behaves differently, and the reason column says why no skill depends on it for a correct result.
- `n/a`: the plugin mentions it but no behavior depends on it.

The Live column records the end-to-end run on real Pi with `PSTACK_PI_LIVE=1` (`tests/pi/live.test.mjs`). A Live value of `n/a` means the live run did not exercise that row. The machine that ran it had only a ChatGPT sign-in on the `openai` provider, so the family names resolved through the shipped `openai` table (X01b). The `anthropic/*` IDs (X01a) and the `openai-codex/*` IDs (X01c) were never called live; `tests/pi/catalog.test.mjs` checks both tables against the model catalog of the installed Pi.

| ID | Claude Code mechanism | On Pi | Status | Evidence | Live |
| --- | --- | --- | --- | --- | --- |
| T01 | `Agent` tool dispatch | `agent` tool runs a child `pi --mode rpc` process and sends the prompt as an RPC command on its stdin | extension | `foreground waits, returns the final text and agentId, and runs the exact child command` | VERIFIED |
| T02 | `subagent_type` | Resolves to the plugin's agent files; unknown types list the valid ones | extension | `unknown subagent_type is an error listing every valid type` | VERIFIED |
| T03 | Per-call `model` | Family names resolve through `models.json` and the sheet's `pi models:` line | extension | `alias, sheet override, inherit-parent, auto, pass-through, and no parent model` | VERIFIED |
| T04 | `run_in_background` | Returns the agent id at once; completion joins the running turn at the next tool boundary, or starts a turn when idle, after the process exits | extension | `background returns at once and the completion notice comes only after the process exits` | VERIFIED |
| T05 | `readonly` (Cursor-era prose, not a Claude Code parameter) | `readonly: true` runs the child without the `edit` and `write` tools | extension | `readonly runs the child without the edit and write tools` | n/a |
| T06 | Worktree per writer | `isolation: "worktree"` creates the worktree under `.claude/worktrees/` and removes it with its branch only when the agent left nothing: a change, a gitignored file it wrote, or a commit on its branch or on any commit its HEAD visited (reflog) keeps it; a retained path is reused on resume only while it is still a linked worktree of the same repository (a directory that is its own Git top level, shares the repository's common Git directory, and is listed by `git worktree list`), and anything else at that path fails the launch without deleting it; manual `git worktree` works through `bash` | extension | `a commit made on a detached HEAD and left behind by checking the branch out again is kept, through the reflog` | VERIFIED |
| T07 | Message an agent (`SendMessage`) | `send_message` to a running agent is an RPC `steer` on the child's stdin, which the agent reads after its current tool calls, in the same run, so it reports once; a message to a finished agent, or to one that has settled and is exiting, resumes the same Pi session, model, and thinking once the process has exited | extension | `a message to a running agent reaches that run before it exits, and the agent reports once` | VERIFIED |
| T08 | Stop an agent and confirm it stopped | `stop_agent` ends the child pi, which kills the bash command it has running, and reports `stopped` only after exit. A process a finished bash command left in the background runs in its own process group and outlives the agent. | extension | `ends the child and the bash command it has running, not a process a finished command left behind, and reports stopped once the child has exited` | VERIFIED |
| T09 | Agent listing and completion notices | `list_agents`; status follows the process, so `completed` always means exited | extension | `list_agents survives a reload through the persisted entries` | VERIFIED |
| T10 | Deferred tool loading (`ToolSearch`) | Every pstack tool registers at startup with `model-only` exposure, so Pi declares it to the model from the first turn, in every `codemode.mode`, and `tool_search` never has to load it | extension | `every pstack tool is model-only, so Pi declares it to the model in every codemode mode and never defers it` | VERIFIED |
| T11 | `Skill` tool and `/command` | Pi lists skills in the system prompt; `/skill:<name>` forces one | native | Pi docs/skills.md | n/a |
| T12 | `pstack:` skill namespace | Skills load under their bare names and run as `/skill:<name>`; agent types keep `pstack:` | difference | Command spelling only. Skills name each other by bare name in prose, and agent types resolve with the prefix. | n/a |
| T13 | `AskUserQuestion` | `ask_user_question` with the same shape; without a UI, and in a child agent, it fails and tells the model to ask in plain text | extension | `a single-select question returns the chosen label` | n/a |
| T14 | `TaskCreate`/`TaskUpdate`/`TodoWrite` | poteto-mode's own `todo.md` fallback | mapping | poteto-mode Platform Adaptation; pi-tools.md Tool actions | n/a |
| T15 | `Read`/`Edit`/`Write`/`Bash`/`Grep`/`Glob` | `read`, `edit`, `write`, `bash`; `grep`, `find`, `ls` when enabled | native | pi-tools.md Tool actions | n/a |
| T16 | `WebFetch`/`WebSearch` | `curl` through `bash`; web search through an MCP server | difference | No skill names either tool. Fetching works through `bash`. | n/a |
| T17 | `ScheduleWakeup` (other named tools are never referenced) | `schedule_wakeup` with the same shape | extension | `clamps to 60 s and fires the prompt as a follow-up user message` | VERIFIED |
| T18 | MCP tool discovery | Pi's built-in MCP; list servers from the session's tools or `pi mcp list` | mapping | pi-tools.md `why` note | n/a |
| T19 | Facts named in the system prompt | Pi's system prompt lists tools and skills; the transcript directory is given in pi-tools.md | mapping | pi-tools.md `reflect` note | n/a |
| T20 | Image-generation tool | None, as on Claude Code; draw with Mermaid or text | difference | Claude Code has no such tool either, so `teach` already falls back. | n/a |
| T21 | Nested agents, up to three layers below the main conversation | A child at the third layer runs without the `agent` tool | extension | `agents nest at most three layers below the main session, as on Claude Code` | n/a |
| A01 | `pstack:poteto-agent` | Resolved from `agents/poteto-agent.md` | extension | `every pstack agent type reaches its child with its own agent file as the system prompt` | VERIFIED |
| A02 | Effort agents | `effort:` frontmatter becomes the child's `--thinking`; no effort inherits the parent's level | extension | `an effort agent passes its body as a 0600 system prompt file and its effort as --thinking; others run at the parent's level` | VERIFIED |
| A03 | `pstack:comment-sicko` | Resolved from `agents/comment-sicko.md` | extension | `every pstack agent type reaches its child with its own agent file as the system prompt` | n/a |
| A04 | Manifest `agents[]` registration | The extension reads `agents/` and `effort-agents/` at runtime | extension | `every pstack agent type reaches its child with its own agent file as the system prompt` | n/a |
| A05 | `general-purpose` agent type | A child with no agent file | extension | `foreground waits, returns the final text and agentId, and runs the exact child command` | n/a |
| A06 | Agent file body as the child's system prompt | Appended with `--append-system-prompt`, keeping Pi's skill list visible to the child | extension | `an effort agent passes its body as a 0600 system prompt file and its effort as --thinking; others run at the parent's level` | VERIFIED |
| H01 | `SessionStart` hook | The routing instruction is added at every agent start, so it survives resume, clear, and compaction | extension | `injects the mandate and the full sheet on every agent start` | VERIFIED |
| H02 | `CLAUDE_PLUGIN_ROOT` | The extension locates the plugin from its own file path | extension | `injects the mandate when there is no sheet` | n/a |
| H03 | `~/.claude` config directory | `$PI_CODING_AGENT_DIR` or `~/.pi/agent` | mapping | setup-pstack Other runtimes | n/a |
| H04 | Override sheet plus `@` include | The extension adds the whole sheet to the system prompt, children included | extension | `a child pi gets the sheet but not the mandate` | VERIFIED |
| H05 | `CLAUDE.md` instructions file | Pi loads `AGENTS.md` or `CLAUDE.md` per directory, plus `~/.pi/agent/AGENTS.md` | native | pi-tools.md Instructions file | n/a |
| H06 | `.claude/settings.local.json` env for todo tools | Pi has no todo tools; the `todo.md` fallback applies | n/a | poteto-mode Platform Adaptation | n/a |
| F01 | `~/.claude/projects` transcripts | `find-transcript.mjs` reads Pi sessions and follows the active branch | script | `a Pi session's opening prompt is the first user message on the branch that ends at the last entry` | VERIFIED |
| F07 | Own transcript as evidence | Same reader; `worktree-audit.mjs` scans Pi session roots | script | `a Pi session in a second transcripts root marks the worktree it ran in as a recent chat` | n/a |
| F02 | `.claude/skills/` project and user skills | `.pi/skills/` or `.agents/skills/` | mapping | pi-tools.md `create-verification-skill` note | n/a |
| F03 | `~/.claude/plugins/` install path | Skill files load from the Pi package directory that `pi list` shows | mapping | pi-tools.md `reflect` note | n/a |
| F04 | `~/.claude/orchestrate/<slug>/` store | A plain directory, used unchanged | native | orchestrate playbook | n/a |
| F05 | `~/.claude/shell-snapshots/` cleanup advice | Cleanup advice only | n/a | worktree-cleanup playbook | n/a |
| F06 | `.claude/worktrees` | The extension uses the same path | extension | `keeps a worktree with changes and reports its path and branch` | n/a |
| S01 | Bundled `run` skill | Run the app through `bash` | mapping | pi-tools.md Driver and bundled skills | n/a |
| S02 | `verify` skill | Read the project skill by path or add it to Pi's `skills` setting | mapping | pi-tools.md Driver and bundled skills | n/a |
| S03 | `loop` skill | `/loop [interval] <prompt>` and self-paced `schedule_wakeup` | extension | `a fixed interval runs now and then on every interval until /loop stop` | VERIFIED |
| S04 | `plugin-dev:skill-development` | Pi's skills docs and the Agent Skills specification | mapping | pi-tools.md Driver and bundled skills | n/a |
| S05 | Bundled `babysit` disambiguation | Pi has no bundled `babysit`, so only pstack's exists | n/a | poteto-mode Non-negotiables | n/a |
| S06 | `superpowers`, `code-review`, `simplify`, `security-review` | Not present on Pi | difference | Mentions only. The hook text defers to other mandates, and no workflow requires these skills. | n/a |
| S07a | Frontmatter `user-invocable: false` | Pi ignores it, so the 23 `principle-*` skills appear in `/skill:` completion | difference | Menu visibility only. The model still loads each principle skill by name, as on Claude Code. | n/a |
| S07b | Frontmatter `paths:` auto-load | The extension notes the skill on the first matching file read or edit | extension | `the first matching file gets a one-line note naming the skill, once per session` | n/a |
| S07c | Frontmatter `disable-model-invocation` | Honored by Pi; no pstack skill sets it | native | Pi docs/skills.md | n/a |
| C01 | `gh` | Same CLI through `bash` | native | pi-tools.md Vendored scripts | n/a |
| C02 | `origin` | Same CLI through `bash` | native | pi-tools.md Vendored scripts | n/a |
| C03 | `gt` | Same CLI through `bash` | native | pi-tools.md Vendored scripts | n/a |
| C04 | `claude`/`codex` CLI | Prose only (`claude mcp list`), mapped in the `why` note | mapping | pi-tools.md `why` note | n/a |
| C05 | `bun` scripts | Same through `bash` | native | pi-tools.md Vendored scripts | n/a |
| C06 | `node` scripts | Same through `bash` | native | pi-tools.md Vendored scripts | n/a |
| X01a | Family names `opus`, `fable`, `sonnet`, `haiku` on an Anthropic session or any provider without its own table | The `anthropic` table of `models.json` maps them to `anthropic/*` IDs | extension | `a family name resolves in the table of the parent's provider, and in the fallback table on any other` | n/a |
| X01b | Family names on a ChatGPT sign-in (`openai`, Pi's Sign in with ChatGPT) | The `openai` table maps them to GPT-6 models of the same tiers as the Codex defaults | extension | `a family name resolves in the table of the parent's provider, and in the fallback table on any other` | VERIFIED |
| X01c | Family names on the legacy OpenAI Codex sign-in (`openai-codex`) | The `openai-codex` table maps them to the same GPT-6 models | extension | `a family name resolves in the table of the parent's provider, and in the fallback table on any other` | n/a |
| X02 | Effort levels and `@level` | Same five levels, passed as `--thinking` | extension | `an effort agent passes its body as a 0600 system prompt file and its effort as --thinking; others run at the parent's level` | VERIFIED |
| X03 | `inherit-parent` / `auto` | The child runs on the parent's current model | extension | `alias, sheet override, inherit-parent, auto, pass-through, and no parent model` | n/a |
| X04 | Compaction and `/clear` | Injection on every agent start keeps the routing instruction | extension | `injects the mandate and the full sheet on every agent start` | VERIFIED |
| X05 | Session scratchpad | Pi has none; the skills only warn against keeping durable state there | difference | The one reference (orchestrate) tells the agent not to use a scratchpad. | n/a |
