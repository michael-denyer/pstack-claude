# pstack for Claude Code, Codex, Prime Agent, opencode, and Gemini CLI

pstack is a collection of agent skills for investigating code, planning changes, writing tests, reviewing diffs, and managing pull requests.

This repository adapts [Lauren Tan’s pstack](https://github.com/cursor/plugins/tree/main/pstack) for Claude Code and shares the same skills with Codex, [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), opencode, and Gemini CLI. It tracks upstream commit `e8d856f`, which includes pstack v0.14.8 and the September editing pass.

The repository also includes seven MIT-licensed skills from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit):

- `deslop`
- `thermo-nuclear-code-quality-review`
- `make-pr-easy-to-review`
- `fix-ci`
- `fix-merge-conflicts`
- `get-pr-comments`
- `what-did-i-get-done`

The port replaces Cursor-specific tools, paths, and instructions with Claude Code equivalents. Codex uses a separate reference that maps those instructions to its own tools. Support for other runtimes varies; the installation sections below distinguish tested behavior from behavior inferred from documentation.

See [CHANGES.md](https://github.com/michael-denyer/pstack-claude/blob/main/CHANGES.md) for the changes to individual skills and [NOTICE.md](https://github.com/michael-denyer/pstack-claude/blob/main/NOTICE.md) for attribution.

## Install

### Claude Code

Add the marketplace, then install its `pstack` plugin:

```shell
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

Since version 0.9.5, a `SessionStart` hook tells Claude Code to invoke `poteto-mode` before its first response to a non-trivial engineering task. The hook runs at startup, after `/clear`, and after compaction.

The hook adds about 300 tokens of instructions. Claude Code loads the full skill only when it invokes it. The instructions exempt dispatched subagents and defer to explicit user instructions.

To disable the hook, delete this file from the installed plugin:

```text
~/.claude/plugins/cache/pstack-claude/pstack/<version>/hooks/hooks.json
```

A plugin update restores the file.

### Shared Agent Skills installation

Codex, Prime Agent, opencode, and Gemini CLI can discover skills from `~/.agents/skills/`. The clone-and-link commands in the Codex section install the shared tree for all four runtimes.

Each runtime handles metadata differently. Some may show the 23 internal `principle-*` skills alongside the 31 public workflows. Leave all 54 installed.

You can also install the tree with the [`skills` CLI](https://github.com/vercel-labs/skills). This downloads and runs an additional tool; the command below uses pnpm 10 or newer:

```shell
pnpm dlx skills add https://github.com/michael-denyer/pstack-claude/tree/main/plugins/pstack/skills --skill "*" --agent "*" --yes
```

Everything the skills read at runtime lives inside `plugins/pstack/skills/`. This includes:

- Agent definitions in `poteto-mode/references/agents/`.
- License files in `poteto-mode/references/licenses/`.
- Scripts in `poteto-mode/scripts/`.

The generator copies five portable assets into the skills tree and removes stale files from the generated agent and license directories. Validation rejects missing local Markdown links, links that leave the skills tree, and direct instructions to open files outside it.

The `Skills-only install` CI job installs the tree with the CLI, compares every installed file with its source, and validates the installed copy.

Installing only the skills does not include:

- Claude Code’s session hook in `hooks/`.
- Codex’s slash-command files in `.codex-plugin/prompts/`.
- Claude Code’s native subagent registration in `agents/`.

When a skills-only installation needs `comment-sicko`, give the runtime’s agent tool the definition at `poteto-mode/references/agents/comment-sicko.md`.

### Prime Agent

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) discovers skills from `~/.agents/skills/` and from `.agents/skills/` directories between the working directory and the Git root. Use the shared installation above.

Prime requires `name` and `description` in each skill’s metadata. Every pstack skill meets its naming requirements. Prime honors `disable-model-invocation` and ignores unknown fields such as `user-invocable`.

Prime’s `--no-skills` option disables discovery. An explicit `--skill <path>` still loads a skill.

Prime’s backend configuration determines which models it uses. Using OpenAI models does not require changing the plugin. Configure distinct models for workflows such as `arena`, `interrogate`, `architect`, and `how`.

This installation follows [Prime’s documentation](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md); the author has not tested it in a live Prime session.

Prime does not run the Claude Code session hook. Ask it to use `poteto-mode` or add a standing instruction to its configuration.

### opencode

[opencode](https://opencode.ai/docs/skills) reads skills from `~/.agents/skills/` and `~/.config/opencode/skills/`. Use the shared installation above.

opencode ignores `user-invocable: false`, so its picker shows the 23 `principle-*` reference skills as well as the 31 public workflows. Keep the reference skills linked because `poteto-mode` needs them.

The author tested discovery in opencode 1.18.25. It found all 31 public skills through the links and read a linked `SKILL.md` when asked.

Configure agents, commands, and permissions in `opencode.json`.

### Codex

Clone the repository and link its skills into the shared Agent Skills directory:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
mkdir -p ~/.agents/skills
for s in plugins/pstack/skills/*/; do
  ln -s "$PWD/$s" ~/.agents/skills/"$(basename "$s")"
done
```

This installs links to all 54 skill directories: 31 public workflows and 23 `principle-*` reference skills. Keep the reference skills installed because `poteto-mode` reads them.

The README’s author tested this installation in a live Codex session. Codex discovered the public skills under names such as `pstack:poteto-mode` and `pstack:tdd`. It did not show the internal `principle-*` skills in the picker.

Ask Codex to use `pstack:poteto-mode` to start.

**Enable subagents**

Several workflows use parallel agents or multiple models: `interrogate`, `arena`, `how`, `why`, `reflect`, and `architect`.

To enable Codex subagents, add this setting to `~/.codex/config.toml`. If a `[features]` section already exists, add the setting to that section:

```toml
[features]
multi_agent = true
```

Without subagents, these workflows run as one sequential pass.

**Add optional slash commands**

From the cloned repository, link the generated command files into Codex’s prompts directory:

```shell
mkdir -p ~/.codex/prompts
for c in plugins/pstack/.codex-plugin/prompts/*.md; do
  ln -s "$PWD/$c" ~/.codex/prompts/"$(basename "$c")"
done
```

Each command invokes its corresponding skill. For example, `/tdd` invokes `tdd`.

The repository also includes a Codex plugin manifest at `plugins/pstack/.codex-plugin/plugin.json` and a marketplace manifest at `.agents/plugins/marketplace.json`. Installing through that marketplace includes both skills and commands. The author’s verified local installation used the symlinks above.

**Choose models**

The skill text contains Claude model names. On Codex, use your configured Codex models instead. Workflows that compare several models should use distinct models.

Run `/setup-pstack` to configure model choices. On Codex, it writes `~/.codex/pstack-models.md` and references that file from `~/.codex/AGENTS.md`.

**Invoke pstack automatically**

The automatic session hook belongs to Claude Code. For Codex, invoke `pstack:poteto-mode` explicitly or add an instruction to `~/.codex/AGENTS.md` telling Codex when to use it.

**Remove the links**

Remove an individual skill or command with:

```shell
rm ~/.agents/skills/<name>
rm ~/.codex/prompts/<name>.md
```

Removing a skill link affects every runtime that reads `~/.agents/skills/`.


### Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md) discovers skills from `~/.gemini/skills/` or the shared `~/.agents/skills/` directory.

After the shared installation:

- Run `/skills list` to check discovery.
- Run `/skills reload` after changing a linked file.
- Ask Gemini to use `poteto-mode`. Its `activate_skill` tool loads the skill and its resources.

This installation follows Gemini CLI’s documentation; the author has not tested it in a live session.

Neither Gemini CLI nor opencode needs generated command files.

**Runtime limitations**

Discovering a skill does not establish that the runtime can execute every instruction in it. The skill text still names Claude Code tools, Claude models, and Claude built-in skills.

The bundled `codex-tools.md` reference maps those names for Codex. Prime Agent, opencode, and Gemini CLI must use their own equivalents. The author has not verified workflows that depend on delegation or multiple models in those runtimes.

They also do not run Claude Code’s session hook. Invoke `poteto-mode` explicitly.

## How pstack runs on Codex

Codex and Claude Code use the same skill files. The generator adds Codex command files and maintains manifest versions, model instructions, and portable assets.

The skills retain Claude Code instructions. A shared reference, [`codex-tools.md`](https://github.com/michael-denyer/pstack-claude/blob/main/plugins/pstack/skills/poteto-mode/references/codex-tools.md), tells Codex which tools, models, and built-in skills to use instead. Affected skills and generated commands point to that reference.

| Feature | Codex behavior |
| --- | --- |
| Skills | Codex loads `SKILL.md` natively. Ask for a skill by name or select it from the picker. |
| Slash commands | Each generated prompt invokes its corresponding skill. Link the files into `~/.codex/prompts/` to use them. |
| Claude tool names | Read `codex-tools.md` for the corresponding Codex tools and any skill-specific instructions. |
| Subagents | Use Codex agent tools with `multi_agent = true`. To create an agent that follows pstack, instruct it to read `poteto-mode` first. |
| Automatic invocation | Invoke `poteto-mode` yourself or configure a standing instruction in `~/.codex/AGENTS.md`. |
| Models | Replace Claude model names with configured Codex models. `/setup-pstack` records those choices. |

The original mapping refers to `spawn_agent`, `wait_agent`, and `close_agent`. Codex does not register a native `poteto-agent` type.

The author verified skill discovery, namespacing, and picker visibility in a live Codex session. Tool mapping during a task and parallel subagent execution still need verification.

The generator creates the 31 Codex prompt files from the command table in this README. To change a command description, edit the table and rerun `tools/generate.mjs`. The generator overwrites manual edits to prompt files.

Claude Code does not need separate command files because it already displays user-invocable skills in its slash menu. Earlier versions included both and produced duplicate entries.

## Commands

| Command | What it does |
| --- | --- |
| `/poteto-mode` | Chooses a workflow for a non-trivial engineering task. |
| `/how` | Explains how a subsystem works. |
| `/why` | Investigates why the code was built that way, gathering evidence from connected sources in parallel. |
| `/architect` | Defines types and module structure before implementing changes across function boundaries. |
| `/arena` | Runs several attempts at the same task in parallel, then selects the best parts. |
| `/interrogate` | Asks three different models to find problems in a diff. |
| `/automate-me` | Drafts a personal workflow skill from recent transcripts. |
| `/reflect` | Updates a skill with lessons from a long task. |
| `/tdd` | Writes a failing test for a bug, then implements the fix. |
| `/typescript-best-practices` | Applies TypeScript type-system practices. |
| `/teach` | Combines `/how` and `/why` to explain a subsystem. |
| `/swarm` | Assigns work to parallel agents and combines their findings into one report. |
| `/technical-writing` | Writes documentation, RFCs, READMEs, PR descriptions, and commit messages. |
| `/bro` | Rewrites the previous message in plain language. |
| `/figure-it-out` | Creates a reviewable procedure for a task the existing playbooks do not cover. |
| `/show-me-your-work` | Records decisions in a TSV file for review. |
| `/blast-radius` | Investigates what a change could break outside the diff and runs code to check it. |
| `/recall` | Reconstructs recent context from chat history, current state, and shared records. |
| `/setup-pstack` | Configures model choices for different roles. |
| `/unslop` | Removes vague, repetitive, or formulaic writing. |
| `/no-comments` | Reviews and removes comments, fixes accepted findings, and puts stated constraints into code where appropriate. |
| `/create-verification-skill` | Creates a project-specific verification skill and feature map. |
| `/maintain-verification-skill` | Updates a verification skill and feature map to match the project. |
| `/deslop` | Removes unnecessary or inconsistent code from a diff before commit. |
| `/babysit` | Monitors a PR, fixes CI failures and review findings, and keeps it ready to merge. |
| `/thermo-nuclear-code-quality-review` | Performs a strict maintainability review. |
| `/make-pr-easy-to-review` | Cleans up commit history and improves the PR description. |
| `/fix-ci` | Reads failing check logs and applies focused fixes. |
| `/fix-merge-conflicts` | Resolves merge conflicts, validates the result, and completes the merge operation. |
| `/get-pr-comments` | Fetches and summarizes review comments on the active PR. |
| `/what-did-i-get-done` | Summarizes authored commits over a chosen period. |

## Dependencies

The plugin manifest declares no dependencies. Some workflows require additional tools.

| Dependency | When it is needed |
| --- | --- |
| Claude Code’s `plugin-dev` plugin | Skill-authoring tasks in `automate-me`, `reflect`, and `poteto-mode`. Codex uses the equivalent listed in `codex-tools.md`. |
| Claude Code’s `run`, `verify`, and `loop` skills | Workflows that invoke those built-ins. Other runtimes need equivalents. |
| GitHub CLI, `gh` | `babysit` and the Babysit and Shipping playbooks. Authenticate with `gh auth login`. |
| Bun | The bundled `watch-pr` and `orch` scripts. Their bootstrap script installs dependencies on first run. |
| Graphite CLI, `gt` | The Orchestrate playbook and stack handling in `orch`. Shipping and the autopilots use `gh`, or Origin’s CLI when available. |
| `jq` and `rg` | The Worktree cleanup audit. Without them, the script warns and leaves the `PR` and `LAST_CHAT` columns blank. |

For Claude Code skill-authoring support:

```shell
/plugin marketplace add anthropics/claude-plugins-official
/plugin install plugin-dev@claude-plugins-official
```

Version 0.9.3 removed `plugin-dev` from the manifest because the desktop app’s `--plugin-dir` loading mode could not resolve dependencies from another marketplace and disabled the entire plugin. Without `plugin-dev`, only the skill-authoring workflows lose functionality.

The stricter review skill, `thermo-nuclear-code-quality-review`, is bundled and requires no separate plugin.

## Repository layout

Paths in this section are relative to the pstack repository.

```text
.
├── .github/workflows/                  CI and security checks
├── .claude-plugin/marketplace.json     Claude Code marketplace
├── .agents/plugins/marketplace.json    Codex marketplace
├── plugins/pstack/
│   ├── .claude-plugin/plugin.json      Claude Code manifest
│   ├── .codex-plugin/plugin.json       Codex manifest
│   ├── .codex-plugin/prompts/          31 generated Codex commands
│   ├── skills/                        54 shared skills
│   │   └── poteto-mode/
│   │       ├── references/
│   │       │   ├── agents/             Generated agent definitions
│   │       │   ├── licenses/           Generated license files
│   │       │   └── codex-tools.md      Claude-to-Codex mapping
│   │       └── scripts/                watch-pr, orch, worktree audit
│   ├── hooks/                         Claude Code session hook
│   ├── agents/                        Claude Code subagent definitions
│   └── models.json                    Default model choices
├── tests/skill-collision-repro.sh       Claude slash-menu test
├── tests/agent-skills.test.mjs         Skill and installation tests
├── tools/generate.mjs                  Generates maintained copies
├── tools/validate-skills.mjs           Checks links and referenced paths
├── tools/sync.mjs                      Updates pinned upstream content
├── tools/upstream.json                 Upstream commits and exclusions
├── tools/substitutions.json            Cursor-to-Claude substitutions
├── VERSION                            Canonical plugin version
├── LICENSE                            pstack MIT license
├── LICENSE-cursor-team-kit             cursor-team-kit MIT license
├── CONTRIBUTING.md                    Development and release instructions
├── NOTICE.md                          Full attribution
├── NOTICE-skills.md                   Attribution for skills-only installs
├── CHANGES.md                         Changes to the port
└── README.md
```

Elsewhere, paths such as `skills/<name>/` and `.codex-plugin/prompts/<name>.md` are relative to `plugins/pstack/`.

## Subagents

Claude Code can spawn the bundled `poteto-agent` with:

```text
subagent_type: "poteto-agent"
```

The port preserves its upstream definition.

The `no-comments` skill uses `comment-sicko`, a read-only comment reviewer. The port changes its upstream name, `Comment Sicko`, to a valid subagent identifier. Invoke it through `/no-comments`.

On Codex, use the instructions in `codex-tools.md`. For installations that include only skills, the agent definitions are also available under `poteto-mode/references/agents/`.

## Differences from upstream

This port edits the skill instructions wherever they depend on Cursor tools, paths, or runtime behavior.

### Added skills

The port adds an independently written `babysit` skill that uses GitHub CLI commands to inspect PRs and failed checks, plus Claude Code’s `loop` skill to repeat checks. It follows Cursor’s publicly described workflow without copying its closed-source implementation.

Since the v0.14.2 sync, `poteto-mode` routes PR-status requests to `playbooks/babysit.md`. The bundled skill remains available as `/babysit`.

The port also imports these seven skills unchanged from cursor-team-kit:

| Skill | Role |
| --- | --- |
| `deslop` | Cleans up a diff before commit. |
| `thermo-nuclear-code-quality-review` | Adds a stricter review in `arena`, `interrogate`, `architect`, and `how`. |
| `make-pr-easy-to-review` | Prepares a PR for review alongside `opening-a-pr` and `babysit`. |
| `fix-ci` | Handles focused CI fixes for `babysit`. |
| `fix-merge-conflicts` | Resolves conflicts during `babysit`. |
| `get-pr-comments` | Retrieves comments for `babysit` and `reflect`. |
| `what-did-i-get-done` | Summarizes commits over a chosen period. |

### Replaced tools and conventions

| Cursor instruction | Claude Code replacement |
| --- | --- |
| `Task` with `subagent_type: generalPurpose` | `Agent` with `subagent_type: "general-purpose"` |
| `readonly: false/true` | No direct flag; the agent type determines MCP access |
| `AskQuestion` | `AskUserQuestion` |
| Built-in `/loop` | Built-in `loop` skill |
| Built-in `/babysit` | Bundled `babysit` skill or the internal Babysit playbook |
| Built-in `/create-skill` | `plugin-dev:skill-development` |
| `control-cli` | `run` skill |
| `control-ui` | `verify` skill |
| Cursor transcript directories | `~/.claude/projects/<encoded-cwd>/*.jsonl`, with `/` replaced by `-` in the working-directory path |
| `.cursor/skills/` and `~/.cursor/plugins/` | `.claude/skills/` and `~/.claude/plugins/` |
| MCP discovery through `mcps/` | Available MCP tools, `.mcp.json`, or `claude mcp list` |
| Cloud agents | Local background subagents in separate Git worktrees |
| `/goal` | An objective recorded in standing instructions and the task list |
| Cursor agent store | `~/.claude/orchestrate/<project-slug>/` |
| `~/.cursor/rules/pstack-models.mdc` | `~/.claude/pstack-models.md`, included from `CLAUDE.md` |

The port also substitutes model names:

| Upstream model | Port default |
| --- | --- |
| `composer-2.5-fast` | `claude-sonnet-4-6` |
| `claude-opus-4-X-thinking-xhigh` | `claude-opus-5`, with extended thinking configured separately |
| `gpt-5.3-codex-high-fast` | `claude-sonnet-4-6` |
| `gpt-5.5-high-fast` | `claude-haiku-4-5` |
| Multi-model review panels | `claude-opus-5`, `claude-fable-5`, and `claude-sonnet-5` |

These are the defaults recorded by the port. Codex users should configure Codex model names.

### Model diversity

Upstream workflows compare results from different model families and vendors. The Claude Code port defaults to three Claude models.

For additional scrutiny, it invokes the bundled `thermo-nuclear-code-quality-review` skill. That adds a stricter maintainability review, but it does not restore cross-vendor model diversity.

### Preserved behavior

The port keeps:

- The `poteto-agent` identifier and its references.
- `run_in_background: true` on Claude Code agent calls.
- `/loop`, `/deslop`, and `/babysit` references, which resolve to the tools described above.
- The principle and playbook organization.
- The full text of the principles.

### Excluded upstream features

`tools/upstream.json` records exclusions so future syncs continue to skip them.

| Exclusion | Reason |
| --- | --- |
| `automations/benny/` | Depends on Cursor’s event-triggered automation runtime and Slack issue handling. It registers no slash skills. |
| `docs/guide/` | The ten-chapter guide and six screenshots teach Cursor-specific UI, sticky mode, and cloud agents. Adapting it would require rewriting it. |
| Sticky-mode metadata | Claude Code has no equivalent for Cursor’s `mode`, `icon`, `color`, and `reminder` fields. The session hook provides similar routing. |
| `is_background: true` on `poteto-agent` | Claude Code controls this through `run_in_background: true` on the agent call. |
| `skills/make-bot-ui/` | Depends on Cursor’s `update_state` tool, Grok Bot webhook routines, and Tailscale. |
| `assets/logo.png` | Claude Code’s plugin manifest has no logo field. |
| `disable-model-invocation: true` on `how`, `why`, `unslop`, and `typescript-best-practices` | In Claude Code, the flag prevents the Skill tool from invoking them and breaks automatic routing. The generator rejects it. |
| Upstream Fable 5.1 defaults | The port generates model instructions from its own `models.json`. |
| Remaining cursor-team-kit skills | They duplicate available workflows or Claude Code features, or depend on Cursor’s UI. |

The upstream [usage guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide) remains available. Use the substitution table above when translating its instructions.

Porting Benny would require a scheduled agent and connections to Slack and an issue tracker. Porting the guide would require a separate tutorial. Neither is included.

### Updating from upstream

Because this port edits skill content, an upstream update must reapply the substitutions. [CHANGES.md](https://github.com/michael-denyer/pstack-claude/blob/main/CHANGES.md) documents that process.

## CI and releases

`ci.yml` and `security.yml` run on pull requests and pushes to `main`.

The CI workflow:

- Regenerates files and checks for differences.
- Runs Bun tests.
- Installs the skills through the `skills` CLI and compares the installed files with the source.
- Typechecks and tests the bundled Bun scripts.
- Lints shell scripts, workflows, Markdown, and relative links.

The security workflow runs `osv-scanner` on lockfiles and `zizmor` on GitHub workflows. It also runs weekly.

Dependabot updates pinned GitHub Action commits after a seven-day cooldown. The bundled scripts’ `commander` dependency follows upstream through `tools/sync.mjs`.

Before releasing, run `tests/skill-collision-repro.sh` locally. It checks slash-menu behavior using the Claude CLI, which CI does not test.

See [CONTRIBUTING.md](https://github.com/michael-denyer/pstack-claude/blob/main/CONTRIBUTING.md) for local checks and release instructions.

## License

MIT.

- `LICENSE` contains the upstream pstack license from Lauren Tan.
- `LICENSE-cursor-team-kit` contains the license for the imported Cursor skills.
- `NOTICE-skills.md` accompanies skills-only installations.
- `NOTICE.md` covers the full plugin, including runtime-specific files.
