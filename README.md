# pstack

Agent workflows for understanding a codebase, designing changes, testing fixes, and preparing pull requests. Start with `poteto-mode` to choose a workflow for your task, or invoke a specific skill when you know what you need.

This repository ports Lauren Tan's pstack from Cursor to Claude Code and shares its skills with Codex, Prime Agent, opencode, and Gemini CLI. The skill tree is synced against upstream `e8d856f`. It also includes seven skills from cursor-team-kit and a standalone `babysit` skill.

## Start here

1. Follow the installation instructions for your runtime below.
2. Open the repository you want to work on.
3. Ask your agent to use a skill with a concrete task:

   ```text
   Use poteto-mode to add pagination to the search results.
   ```

For a narrower task, name the skill directly:

```text
Use how to explain the request path from the API handler to the database.
Use tdd to reproduce this failing case, then fix it.
Use interrogate to review my diff for bugs and missing cases.
Use make-pr-easy-to-review to tidy this PR's history and description.
```

On Claude Code, use `/pstack:poteto-mode` or another `/pstack:<skill>` command. On Codex, select the discovered skill, such as `pstack:poteto-mode`, or request it by name. The optional Codex shortcuts described below provide `/poteto-mode`, `/tdd`, and the other short command names.

## Install

### Claude Code

Add the marketplace and install the plugin:

```shell
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

The plugin's `SessionStart` hook loads a short instruction on startup, `/clear`, and after compaction. It directs non-trivial engineering tasks to `poteto-mode`; the full skill loads when invoked. Explicit user instructions take precedence, and dispatched subagents ignore the startup instruction.

To disable automatic routing, delete `hooks/hooks.json` from the installed plugin at `~/.claude/plugins/cache/pstack-claude/pstack/<version>/`. A plugin update restores that file.

### Shared skills for Codex, Prime Agent, opencode, and Gemini CLI

The repository's shared installation uses `~/.agents/skills/`. Clone the repository and link each skill:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
mkdir -p ~/.agents/skills
for s in plugins/pstack/skills/*/; do
  ln -s "$PWD/$s" ~/.agents/skills/"$(basename "$s")"
done
```

This links 54 skill directories. 31 are public workflows; the 23 `principle-*` directories provide guidance that `poteto-mode` reads. Keep all of them installed, even if your runtime shows the principles in its skill picker.

The commands leave existing destinations intact. If a name already exists, inspect it before replacing it. Keep the clone in place while its links are installed. To update linked skills, pull changes in that clone. To uninstall a linked skill, remove its link at `~/.agents/skills/<name>`; that removes it from every runtime using the shared directory.

For an installation without maintaining a clone, the repository also supports the `skills` CLI:

```shell
npx skills add https://github.com/michael-denyer/pstack-claude/tree/main/plugins/pstack/skills --skill "*" --agent "*" --yes
```

A skills-only installation includes the skills, their scripts, reference copies of the agents, and license notices. Runtime-specific plugin files are separate: Claude Code's startup hook and native agent registration, and Codex's command shortcuts.

### Codex setup

After the shared installation, request `pstack:poteto-mode` in your project. The repository records successful skill discovery through these symlinks in a live Codex session.

The port's documented configuration for parallel subagents is:

```toml
[features]
multi_agent = true
```

Merge this setting into `~/.codex/config.toml` if your configuration needs it. Skills such as `arena`, `interrogate`, and `architect` use parallel agents. The port provides a sequential fallback when subagents are unavailable.

For optional slash-command shortcuts, run this from the repository root:

```shell
mkdir -p ~/.codex/prompts
for c in plugins/pstack/.codex-plugin/prompts/*.md; do
  ln -s "$PWD/$c" ~/.codex/prompts/"$(basename "$c")"
done
```

Each shortcut invokes its corresponding skill. Remove a shortcut by deleting its link at `~/.codex/prompts/<name>.md`. The repository also contains a Codex marketplace manifest at `.agents/plugins/marketplace.json`; the symlink installation is the path recorded as verified here.

The shared skill bodies retain Claude tool and model names. The [Codex mapping](plugins/pstack/skills/poteto-mode/references/codex-tools.md) explains their Codex equivalents, including agent dispatch, model selection, and project verification. For automatic routing on Codex, add a standing instruction to use `poteto-mode` in your `AGENTS.md`.

### Other runtimes

Use the shared installation above, then request `poteto-mode` by name.

| Runtime | Installation notes | Verification recorded in this repository |
| --- | --- | --- |
| Prime Agent | Uses the shared skills directory. Choose tools and models through Prime's configuration. | Discovery follows published documentation; no live session recorded. |
| opencode | Uses the shared skills directory. Configure agents, commands, and permissions in `opencode.json`. Its picker also lists the principle skills. | Discovery and reading a linked skill verified on opencode 1.18.25. |
| Gemini CLI | Uses the shared skills compatibility directory. Run `/skills list` to check discovery and `/skills reload` after changes. | Discovery follows published documentation; no live session recorded. |

These verification notes describe prior checks, not a guarantee that every workflow runs on every runtime. Delegation and multi-model workflows remain unverified on Prime Agent, opencode, and Gemini CLI. Those runtimes must translate Claude-specific tool, model, and configuration names themselves. Request `poteto-mode` explicitly; the startup hook ships with the Claude Code plugin only.

## Configure models and dependencies

Use `setup-pstack` to choose models for each role. Defaults live in [models.json](plugins/pstack/models.json). The Claude Code override sheet is `~/.claude/pstack-models.md`; on Codex it is `~/.codex/pstack-models.md`, whose contents belong in `~/.codex/AGENTS.md`. Use distinct available models for panels that compare independent designs or reviews.

Install dependencies for the workflows you plan to use:

| Dependency | When you need it |
| --- | --- |
| GitHub CLI, `gh` | PR monitoring and shipping. Authenticate with `gh auth login`. |
| Bun | The bundled `watch-pr` and `orch` scripts. Their bootstrap installs script dependencies on first run. |
| Graphite CLI, `gt` | The Orchestrate playbook and the `orch` stack frontier. Shipping and autopilot playbooks use plain `gh` or Origin's CLI when available. |
| `jq` and `rg` | Complete PR and transcript columns in `worktree-audit.sh`. Missing tools produce warnings and blank columns. |
| `plugin-dev` | Claude Code skill-authoring routes used by `automate-me`, `reflect`, and `poteto-mode`. |

To install the Claude Code skill-authoring companion:

```shell
/plugin marketplace add anthropics/claude-plugins-official
/plugin install plugin-dev@claude-plugins-official
```

Without it, skill-authoring routes lose their companion guidance. Other workflows remain available. On Codex, use the skill-authoring equivalent described in the [Codex mapping](plugins/pstack/skills/poteto-mode/references/codex-tools.md).

Playbooks use the runtime's task-tracking tools, with an uncommitted `todo.md` fallback. For Claude Code task tools, the repository documents `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; see [poteto-mode's platform adaptation](plugins/pstack/skills/poteto-mode/SKILL.md#platform-adaptation).

App verification follows the [driver policy](plugins/pstack/skills/poteto-mode/SKILL.md#non-negotiables). Use `create-verification-skill` to record how to drive and verify your project.

## Slash commands

The table uses short skill names. Claude Code exposes them as `/pstack:<name>`; Codex's optional prompt links provide `/name`. Other runtimes can invoke skills by name.

| command | use it when |
| --- | --- |
| `/poteto-mode` | default entry point for any non-trivial task |
| `/how` | walk through how a subsystem works |
| `/why` | investigate why something was built this way (parallel multi-MCP evidence) |
| `/architect` | settle types and module shape before writing code that crosses a function boundary |
| `/arena` | run N parallel attempts at the same task and pick the best parts |
| `/interrogate` | have three different models try to break a diff |
| `/automate-me` | draft your own personal -mode skill from recent transcripts |
| `/reflect` | capture a long task's lessons as a skill edit |
| `/tdd` | fix a bug by writing the failing test first, then the fix |
| `/typescript-best-practices` | ground type-system discipline in TypeScript syntax |
| `/teach` | explain a subsystem plainly by composing how + why |
| `/swarm` | fan out N parallel workers across slices or races, then return one aggregated report |
| `/technical-writing` | write docs, RFCs, readmes, PR descriptions, and commit messages to one layered standard |
| `/bro` | restate the last message in plain human language, no jargon |
| `/figure-it-out` | design a rigorous, auditable playbook for a task no bundled playbook fits |
| `/show-me-your-work` | log decisions to a reviewable tsv decision trail |
| `/blast-radius` | find what a change could break beyond the diff and prove safety by running code |
| `/recall` | catch up on recent working context from chat history, live state, and the shared record |
| `/setup-pstack` | configure pstack per-role model choices |
| `/unslop` | clean up writing by removing AI tells |
| `/no-comments` | strip comments before review, fix the accepted findings, encode claimed constraints |
| `/create-verification-skill` | generate a project-local verification skill and feature map |
| `/maintain-verification-skill` | re-sync a drifted verification skill and its feature map |
| `/deslop` | deslop a diff before commit |
| `/babysit` | monitor an open PR, fix CI/comments, keep it merge-ready |
| `/thermo-nuclear-code-quality-review` | extremely strict maintainability audit |
| `/make-pr-easy-to-review` | clean noisy history and improve PR description before review |
| `/fix-ci` | find failing PR checks, inspect logs, apply focused fixes |
| `/fix-merge-conflicts` | non-interactively resolve merge conflicts, validate, finalize |
| `/get-pr-comments` | fetch and summarize review comments from the active PR |
| `/what-did-i-get-done` | summarize authored commits over a user-chosen period |

## How this port differs from upstream

The port replaces Cursor-specific tools, paths, and built-ins with Claude Code equivalents. Codex uses a separate mapping while sharing the same skill tree. [CHANGES.md](CHANGES.md) records the per-skill changes, and [tools/upstream.json](tools/upstream.json) records the upstream revisions and exclusions.

The port includes:

- A Claude Code marketplace, plugin manifests, and the startup routing hook.
- A Codex marketplace manifest, generated command shortcuts, and a tool/model mapping.
- An independently authored `babysit` skill for monitoring PRs and fixing CI or review findings.
- Seven cursor-team-kit skills for reviewing and cleaning changes, fixing CI and merge conflicts, fetching PR comments, and summarizing commits.

Cursor-specific automations, sticky-mode metadata, the Grok Bot UI workflow, and the Cursor UI tutorial are excluded. The exclusion list lives in [tools/upstream.json](tools/upstream.json).

Multi-model review depends on the models your runtime can reach. The default Claude panel uses different Claude models; it does not preserve upstream's cross-vendor diversity. The bundled `thermo-nuclear-code-quality-review` adds a strict maintainability review when a workflow calls for a harsher pass.

## Repository layout

```text
.claude-plugin/marketplace.json    Claude Code marketplace
.agents/plugins/marketplace.json  Codex marketplace
plugins/pstack/
  .claude-plugin/plugin.json      Claude Code plugin manifest
  .codex-plugin/                  Codex manifest and generated prompt stubs
  skills/                        Shared skills, references, and scripts
  agents/                        Claude Code subagent definitions
  hooks/                         Claude Code startup routing
tools/                           Generation, validation, and upstream sync
tests/                           Repository checks
```

The skills-only installation boundary is `plugins/pstack/skills/`. Reference copies of the agents and license files live under `poteto-mode/references/` so they travel with skills-only installations. CI installs that tree through the `skills` CLI and checks its files against the source.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before editing a skill. Upstream owns the workflow content; this repository owns the runtime port. Changes to a skill's behavior usually belong upstream, while broken mappings and other port-specific fixes belong here.

Run the repository checks with Bun:

```shell
bun tools/generate.mjs
bun test tests/
```

The generator stamps versions, model defaults, Codex prompts, and portable reference files. The slash-command table in `README.md` supplies the Codex prompt descriptions and order. Edit that source table when changing a menu description, then regenerate.

CI also checks shell scripts, workflows, Markdown, relative links, and the bundled Bun tools. See [local checks](CONTRIBUTING.md#things-that-will-fail-ci) for commands and [release instructions](CONTRIBUTING.md#releasing) for versioning and the live Claude Code command check.

For a bug report, include the pstack version, runtime and version, and reproduction steps. Use [SECURITY.md](SECURITY.md) for security reports.

## License and attribution

MIT. Original pstack by Lauren Tan; the imported cursor-team-kit skills are copyright Cursor. This repository preserves both [pstack's license](LICENSE) and [cursor-team-kit's license](LICENSE-cursor-team-kit).

[NOTICE.md](NOTICE.md) records attribution for the full plugin. [NOTICE-skills.md](NOTICE-skills.md) contains the notice included in skills-only installations.
