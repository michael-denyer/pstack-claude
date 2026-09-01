# pstack for Claude Code, Codex, Prime Agent, opencode, and Gemini CLI

Claude Code port of [poteto](https://x.com/poteto)'s [pstack](https://github.com/cursor/plugins/tree/main/pstack) plugin. The skill tree is synced against upstream `4612556`, pstack v0.14.2. See [What's deliberately not ported](#whats-deliberately-not-ported). The same `skills/` tree ships as a Codex plugin and is discovered natively by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), [opencode](#opencode), and [Gemini CLI](#gemini-cli). Original by Lauren Tan; ships MIT. Imports seven skills from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit) (also MIT): `deslop`, `thermo-nuclear-code-quality-review`, `make-pr-easy-to-review`, `fix-ci`, `fix-merge-conflicts`, `get-pr-comments`, `what-did-i-get-done`.

> if you want to go fast, go deep first. pstack helps you write less, but higher quality code. rigorous agent workflows you can parallelize with confidence.

This is not a verbatim copy. Skill bodies have been edited so every Cursor-specific primitive resolves to its Claude Code equivalent — see [Differences from upstream](#differences-from-upstream) for the full list. The exhaustive per-skill audit lives in [CHANGES.md](CHANGES.md); license attribution and the upstream pins live in [NOTICE.md](NOTICE.md) and `tools/upstream.json`.

## Install

### Claude Code

This repo ships as a Claude Code marketplace containing one plugin (`pstack`).

```shell
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

From 0.9.5 the plugin auto-fires, the same way superpowers does: a `SessionStart` hook (on `startup`, `/clear`, and post-`compact`) injects a ~0.3k-token mandate that routes any non-trivial engineering task into `poteto-mode` before the first response. The full skill still loads only on invoke. Dispatched subagents are told to ignore the mandate, and explicit user instructions take precedence. To opt out, delete `hooks/hooks.json` from the installed copy (`~/.claude/plugins/cache/pstack-claude/pstack/<version>/hooks/hooks.json`); a plugin update restores it.

### Shared Agent Skills install

Codex, Prime Agent, opencode, and Gemini CLI all discover user skills from `~/.agents/skills/`. Clone the repository and link its shared skill tree once:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
mkdir -p ~/.agents/skills
for s in plugins/pstack/skills/*/; do ln -s "$PWD/$s" ~/.agents/skills/"$(basename "$s")"; done
```

The loop links all 52 skill directories. Thirty-one are public workflows and 21 `principle-*` directories are internal references used by `poteto-mode`. Each runtime decides whether it understands pstack-specific frontmatter such as `user-invocable: false`, so menu visibility differs. Keep the principle directories installed even when a runtime lists them.

Removing a link from `~/.agents/skills/` removes that skill from every runtime using the shared directory. Teardown is `rm ~/.agents/skills/<name>`.

The [`skills` CLI](https://github.com/vercel-labs/skills) installs the same tree without a clone, resolving `plugins/pstack/skills` as a subtree URL:

```shell
npx skills add https://github.com/michael-denyer/pstack-claude/tree/main/plugins/pstack/skills --skill "*" --agent "*" --yes
```

`plugins/pstack/skills` is a supported installation boundary. Everything a skill reads at runtime lives inside it, including the `poteto-agent` and `comment-sicko` definitions under `poteto-mode/references/agents/` and the MIT terms under `poteto-mode/references/licenses/`. Both directories sit inside a skill because the CLI installs skill directories and drops loose files at the tree root. The generator stamps exactly five portable assets from the sources declared in `PORTABLE_ASSETS`, removes stale output from those two generated directories, and validates every local Markdown target. The `Skills-only install` CI job copies the tree with the CLI, compares every installed file with the source, and validates the installed tree again.

Three plugin features do not survive a skills-only install, because they belong to a specific runtime rather than to the skills. Claude Code's `SessionStart` auto-fire lives in `hooks/`, the Codex slash-command stubs live in `.codex-plugin/prompts/`, and Claude Code's native subagent registration reads `agents/`. On a skills-only install, dispatch `comment-sicko` by pointing the runtime's agent primitive at `poteto-mode/references/agents/comment-sicko.md`.

### Codex

The same plugin carries a `.codex-plugin/plugin.json` manifest and a root `.agents/plugins/marketplace.json`. Use the [shared Agent Skills install](#shared-agent-skills-install). This path is verified on a live Codex session.

Codex discovers the linked skills and namespaces them under the plugin, so they list as `pstack:poteto-mode`, `pstack:tdd`, and so on. The namespace comes from `plugins/pstack/.codex-plugin/plugin.json` and resolves through the flat symlinks, even though each linked skill sits one directory below that manifest (verified on a live session via this symlink install). To enable the multi-model and parallel-subagent skills (`interrogate`, `arena`, `how`, `why`, `reflect`, `architect`), turn on subagents in `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

For slash-command shortcuts (`/poteto-mode`, `/tdd`, and the rest), link the command files into Codex's prompts directory:

```shell
mkdir -p ~/.codex/prompts
for c in plugins/pstack/.codex-plugin/prompts/*.md; do ln -s "$PWD/$c" ~/.codex/prompts/"$(basename "$c")"; done
```

Each command invokes its skill, so `/tdd` runs the `tdd` skill. Installing the full plugin through the Codex marketplace (the root `.agents/plugins/marketplace.json`) carries skills and commands together. The skill links plus prompt links are the verified local path. Teardown for a prompt is `rm ~/.codex/prompts/<name>.md`.

### Prime Agent

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) discovers skills from `~/.agents/skills/` and from `.agents/skills/` in the working tree up to the git root ([docs](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md)). The [shared Agent Skills install](#shared-agent-skills-install) is the complete Prime install.

pstack's `SKILL.md` frontmatter is a subset of what Prime reads: it requires `name` (lowercase, matching the parent directory — every pstack skill already conforms) and `description`, honours `disable-model-invocation`, and ignores unknown keys such as pstack's `user-invocable`. `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh` installs Prime itself; `--no-skills` disables discovery, and explicit `--skill <path>` still loads. Prime is model-agnostic, so running these skills against **ChatGPT / OpenAI models is a Prime backend setting, not a plugin change** — keep the multi-model panels in `arena`, `interrogate`, `architect`, and `how` genuinely diverse across whatever models you configure (see the OpenAI panel note under [Running on Codex](#running-on-codex)).

Unverified relative to Codex: the Prime path is derived from Prime's documented discovery paths and frontmatter schema, not yet run on a live Prime session. Prime has no plugin-hook runtime, so the Claude Code auto-fire hook does not apply. Enter `pstack:poteto-mode` by name or add a standing routing instruction to your Prime config.

### opencode

[opencode](https://opencode.ai/docs/skills) loads Agent Skills from `~/.agents/skills/` as well as its own `~/.config/opencode/skills/` directory. Use the [shared Agent Skills install](#shared-agent-skills-install). There is nothing to generate.

opencode ignores the pstack-specific `user-invocable: false` key, so its picker lists the 21 `principle-*` leaves alongside the 31 public workflows. Codex and Claude Code hide the leaves. Keep them linked because `poteto-mode` cites them by name and expects to read each one.

The opencode path is verified on a live opencode 1.18.25 session. It discovers all 31 public skills through the links and reads a linked `SKILL.md` on request. Agents, commands, and permissions are configured in `opencode.json`.

### Gemini CLI

[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md) has native Agent Skills. It discovers user skills from `~/.gemini/skills/` or the `~/.agents/skills/` compatibility alias. Use the [shared Agent Skills install](#shared-agent-skills-install), then run `/skills list` to inspect discovery or `/skills reload` after changing a linked file. Ask Gemini to use `poteto-mode`; its `activate_skill` tool loads the skill and its resources.

The Gemini path follows published Gemini CLI documentation and has not been run on a live session. Neither Gemini CLI nor opencode gets generated command files. Native discovery keeps each `SKILL.md`, its references, and its scripts attached to one installed directory, so the skills work from the repository where the user actually needs them.

Discovery is not a promise that Claude-specific execution details translate automatically. The skill bodies retain Claude Code tool names, `claude-*` model slugs, and Claude built-in skills. [`codex-tools.md`](plugins/pstack/skills/poteto-mode/references/codex-tools.md) maps those names on Codex only. Gemini CLI, opencode, and Prime Agent must use their own tool, model, and configuration equivalents. Delegation-heavy and multi-model workflows remain unverified on those runtimes. None has a plugin-hook equivalent of the Claude Code auto-fire hook, so ask the runtime to use `poteto-mode` explicitly.

## Layout

```text
.
├── .github/workflows/               # CI: invariants, bun tooling, shellcheck, OSV scan
├── .claude-plugin/marketplace.json   # Claude Code marketplace manifest (repo root)
├── .agents/plugins/marketplace.json  # Codex marketplace manifest (repo root)
├── plugins/pstack/                   # the plugin itself
│   ├── .claude-plugin/plugin.json    # Claude Code manifest
│   ├── .codex-plugin/plugin.json     # Codex manifest (skills: ./skills/)
│   ├── skills/                       # 52 Agent Skills (shared by all five runtimes; the skills-only install boundary)
│   │   ├── poteto-mode/references/licenses/  # generated license texts and skills-scoped notice
│   │   ├── poteto-mode/references/codex-tools.md  # Claude→Codex tool/model/skill map
│   │   ├── poteto-mode/references/agents/  # generated copies of agents/, for runtimes that install only skills
│   │   └── poteto-mode/scripts/      # vendored bun/bash tooling: watch-pr, orch, worktree-audit.sh
│   ├── .codex-plugin/prompts/        # 31 slash command stubs, generated (Codex only; link into ~/.codex/prompts)
│   ├── hooks/                        # SessionStart auto-fire: injects the poteto-mode mandate (Claude Code only)
│   └── agents/                       # Claude subagents: poteto-agent, comment-sicko (Codex routes via codex-tools.md)
├── tests/skill-collision-repro.sh    # layout and flag invariants (needs claude CLI)
├── tests/agent-skills.test.mjs       # shared metadata, portable assets, link checks, and Codex prompt boundary
├── tools/generate.mjs                # stamps versioned, model, prompt, README, and portable-asset copies
├── tools/validate-skills.mjs         # rejects escaping Markdown links and prose that opens unreachable paths
├── tools/sync.mjs                    # syncs a component to a new upstream SHA, applying substitutions.json
├── tools/upstream.json               # upstream remote + per-component pinned SHAs
├── tools/substitutions.json          # mechanical Cursor→Claude rewrites + the denylist of manual-only Cursor-isms
├── VERSION                           # canonical plugin version (single source; manifests are stamped)
├── LICENSE                           # pstack upstream MIT
├── LICENSE-cursor-team-kit           # cursor-team-kit upstream MIT
├── LICENSE-superpowers               # superpowers upstream MIT (hook runner)
├── CONTRIBUTING.md                   # sync boundary, local checks, release rules
├── NOTICE.md                         # attribution table
├── CHANGES.md                        # per-skill substitution audit
└── README.md                         # this file
```

Plugin-internal path references in the docs below (`skills/<name>/`, `.codex-plugin/prompts/<name>.md`) are relative to `plugins/pstack/`.

## Running on Codex

The Codex build shares one `skills/` tree with the Claude Code build. Nothing is forked; the only generated files are the prompt stubs, which `tools/generate.mjs` stamps from each skill's `menu-description` frontmatter. One mapping file does the translation. That single-mapping-file spine is the one `superpowers` ships for Codex. pstack diverges in one respect. superpowers writes its skills in tool-neutral language, so no skill names a runtime tool. pstack keeps the upstream Claude-native prose and adds a one-line Platform note to each skill that names a Claude primitive, so the port stays in lockstep with upstream sync.

- **Skill invocation.** Codex loads `SKILL.md` natively. There is no `Skill` tool. You invoke a skill by name (ask for it, or pick `pstack:poteto-mode` from the list).
- **Commands.** The 31 `.codex-plugin/prompts/*.md` files are Codex-only, generated by `tools/generate.mjs` from each public skill's `menu-description` frontmatter (edit the skill, rerun the generator; hand edits to a stub are overwritten). Codex reads their `description` frontmatter and the filename, ignores the keys it doesn't know, and each body invokes its skill. Link them into `~/.codex/prompts/` for `/name` shortcuts (see [Install on Codex](#codex)). Claude Code ships no `commands/` directory: it renders both commands and user-invocable skills in the slash menu, so a trampoline paired with its skill duplicated every `/pstack:<name>` row (see CHANGES 0.9.13). The skill alone serves the slash command there.
- **Tool, model, and built-in mapping.** When a skill names a Claude tool (the `Agent` tool, `AskUserQuestion`), a `claude-*` model slug, or a Claude built-in skill (`run`, `verify`, `loop`, `plugin-dev:skill-development`), it resolves through [`skills/poteto-mode/references/codex-tools.md`](plugins/pstack/skills/poteto-mode/references/codex-tools.md). `poteto-mode` and every skill that names one of those carries a one-line **Platform note** pointing there.
- **Subagents.** The `Agent` tool maps to Codex `spawn_agent` / `wait_agent` / `close_agent`, enabled by `multi_agent = true`. Parallel fan-out is multiple `spawn_agent` calls in one turn. Without the flag, `interrogate`, `arena`, `how`, `why`, `reflect`, and `architect` degrade to a single sequential pass. There is no `poteto-agent` subagent type on Codex; route ad-hoc subagents by dispatching a `spawn_agent` told to read `poteto-mode` first.
- **Auto-fire.** The `hooks/` SessionStart injection is Claude Code-only; Codex has no plugin hook runtime. Enter `pstack:poteto-mode` by name, or add a standing instruction to `~/.codex/AGENTS.md` if you want the same always-on routing.
- **Models.** The `claude-*` slugs in skills are Claude defaults, stamped into each skill's Models section from `plugins/pstack/models.json`. On Codex substitute your configured Codex models, keeping multi-model panels genuinely diverse. `/setup-pstack` writes `~/.codex/pstack-models.md` (referenced from `~/.codex/AGENTS.md`) with Codex slugs instead of `~/.claude/pstack-models.md`.

Verified on a live Codex session installed via the symlinks: the user-facing skills are discovered and namespaced under `pstack` (`pstack:poteto-mode`, `pstack:interrogate`, and so on). The `principle-*` leaf skills carry `user-invocable: false` and no command, so Codex does not surface them in the picker, the same as Claude Code. They stay installed for `poteto-mode` to read by path. The deeper behaviors (mapping resolution mid-task, `spawn_agent` fan-out) follow the proven `superpowers` pattern and are worth confirming in your own session.

## CI

Two workflows run on every pull request and push to `main`.

`ci.yml` runs five jobs. The static plugin invariants run `tests/skill-collision-repro.sh` under `SKIP_BEHAVIORAL=1`, since the behavioral leg needs the `claude` CLI and API access. The generated-files job runs `bun tools/generate.mjs`, rejects a resulting diff, and runs the Bun tests. The skills-only job installs through the `skills` CLI, compares the copied tree with the source, and checks its local Markdown links. The other jobs test the vendored Bun tooling and run `shellcheck` over scripts selected by extension or shebang, so the extensionless hook scripts are covered.

`security.yml` runs `osv-scanner` against the lockfiles and fails the build if no lockfile was found, because an empty scan reads exactly like a clean one. It also rejects any action reference not pinned to a full 40-character commit SHA. It runs weekly on top of the per-PR trigger, so a CVE published after a merge still surfaces. `zizmor` audits the workflows themselves for template injection, over-broad permissions, and credential persistence.

Dependabot keeps the pinned SHAs and the bun dependencies current, on a 7-day cooldown so a compromised release has time to be reported before a PR opens. Because Dependabot cannot regenerate `bun.lock`, `dependabot-lockfile.yml` does it for its PRs and pushes the result back to the branch.

Before a release, run the full `tests/skill-collision-repro.sh` locally (without `SKIP_BEHAVIORAL`) to exercise the behavioral leg CI cannot.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the sync boundary, the local checks to run, and the release rules.

## Dependencies

Nothing is declared in `plugin.json`. Install the one companion plugin yourself:

- **`plugin-dev`** (from the `claude-plugins-official` marketplace) — the rewiring routes skill-authoring tasks (in `automate-me`, `reflect`, `poteto-mode`) to the `plugin-dev:skill-development` skill:

  ```shell
  /plugin marketplace add anthropics/claude-plugins-official
  /plugin install plugin-dev@claude-plugins-official
  ```

  Until 0.9.2 this was a `dependencies` entry in `plugin.json`. The desktop app's `--plugin-dir` load mode can never resolve cross-marketplace dependencies and hard-disables the whole plugin, so 0.9.3 removed the declaration — full mechanism in the 0.9.3 entry of [CHANGES.md](CHANGES.md). Without `plugin-dev` installed, only the skill-authoring routes degrade; everything else works.

Not declared as deps, but referenced in skill bodies:

- **`run`, `verify`, `loop`** — Claude Code CLI built-ins (ship with the binary, always available).
- **`gh` CLI** — system-level requirement of the `babysit` skill and the Babysit / Shipping playbooks. Install via [`brew install gh`](https://cli.github.com) and authenticate with `gh auth login`.
- **`bun`** — runs the vendored `skills/poteto-mode/scripts/` tooling (`watch-pr`, `orch`). Install via [`brew install oven-sh/bun/bun`](https://bun.sh). Only the playbooks that call those scripts need it; `bootstrap.ts` installs the script dependencies on first run.
- **`gt` (Graphite CLI)** — only for the stack playbooks (Shipping, Orchestrate, the autopilots). Everything else works without it.
- **`jq` and `rg` (ripgrep)** — only for `scripts/worktree-audit.sh` (the Worktree cleanup playbook). Without them the audit still runs but blanks its PR and LAST_CHAT columns, so it warns on stderr rather than returning a table that looks complete.

No third-party plugins. The harsher-critique escape hatch lives in the bundled `thermo-nuclear-code-quality-review` skill (imported from cursor-team-kit), not in an external plugin.

## Slash commands

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

## Subagents

`poteto-agent` ships unchanged. Spawn from a parent with `subagent_type: "poteto-agent"`.

`comment-sicko` is the read-only comment reviewer the `no-comments` skill spawns. Upstream names it `Comment Sicko`; the port renames it to `comment-sicko` so the name is a valid `subagent_type`. Invoke it through `/no-comments`, not directly.

## Differences from upstream

The port is editorial, not mechanical. Anywhere upstream pstack assumed Cursor-specific primitives, this port substitutes the Claude Code equivalent so refs actually resolve. Two prior ports ([v1truv1us/ai-eng-system](https://github.com/v1truv1us/ai-eng-system), [Evan-Kim2028/agent-fleet](https://github.com/Evan-Kim2028/agent-fleet)) stop at namespacing — they vendor pstack under `pstack/` and leave the Cursor refs intact. This port does the content surgery.

### What's added

- **`skills/babysit/`** — Claude Code analog of Cursor's closed-source `/babysit` built-in. Wraps `gh pr view` / `gh pr checks` / `gh run view --log-failed` plus the `loop` skill for pacing. Independently authored; workflow informed by Cursor's public `/babysit` behavior — not a copy of Cursor's implementation. Since the v0.14.2 sync, poteto-mode routes PR-status requests to the ported `playbooks/babysit.md` instead, and this skill is the standalone `/babysit` entry point.
- **`skills/deslop/`** — imported verbatim from `cursor-team-kit`. Cleans AI tells out of diffs before commit.
- **`skills/thermo-nuclear-code-quality-review/`** — imported verbatim from `cursor-team-kit`. Used as the harsher-critique escape hatch in `arena`, `interrogate`, `architect`, and `how` (replaces the Cursor-original cross-vendor bridge).
- **`skills/make-pr-easy-to-review/`** — imported verbatim from `cursor-team-kit`. Composes with `opening-a-pr` and `babysit`.
- **`skills/fix-ci/`** — imported verbatim from `cursor-team-kit`. Narrower CI-fix primitive that `babysit` can route to.
- **`skills/fix-merge-conflicts/`** — imported verbatim from `cursor-team-kit`. Pairs with `babysit` step 5.
- **`skills/get-pr-comments/`** — imported verbatim from `cursor-team-kit`. Primitive for `babysit` step 4 and `reflect`.
- **`skills/what-did-i-get-done/`** — imported verbatim from `cursor-team-kit`. Commit summary over a chosen period.

### What's substituted in skill bodies

| Upstream (Cursor) | This port (Claude Code) |
| --- | --- |
| `Task` tool, `subagent_type: generalPurpose`, `readonly: false/true` | `Agent` tool, `subagent_type: "general-purpose"`, no readonly flag (subagent_type controls MCP access) |
| `AskQuestion` tool | `AskUserQuestion` tool |
| Cursor's built-in `/loop` | Claude Code's built-in `loop` skill |
| Cursor's built-in `/babysit` | `babysit` skill bundled in this plugin. From v0.14.0 upstream routes PR-status requests inside poteto-mode to `playbooks/babysit.md` instead; the port does the same, and `/babysit` stays the standalone entry point |
| Cursor's built-in `/create-skill` | `plugin-dev:skill-development` skill |
| `cursor-team-kit` `control-cli` (CLI/TUI driver) | Claude Code's `run` skill |
| `cursor-team-kit` `control-ui` (browser/Electron driver) | Claude Code's `verify` skill |
| Transcripts at `~/.cursor/projects/*/` or `agent-transcripts/` | `~/.claude/projects/<encoded-cwd>/*.jsonl` (where `<encoded-cwd>` is the workspace cwd with `/` → `-`) |
| Skill paths `.cursor/skills/`, `~/.cursor/plugins/` | `.claude/skills/`, `~/.claude/plugins/` |
| MCP discovery via Cursor's `mcps/` directory | Tool list at top of system prompt (`mcp__<server>__<name>` entries), or `.mcp.json`, or `claude mcp list` |
| Cursor cloud agents (`environment: "cloud"`, `cloud_base_branch`) | Local background subagents (`run_in_background: true`), isolated by git worktree |
| Cursor's `/goal` (standing objective across turns) | The program objective written into the run's standing orders and restated in the todolist |
| The Cursor agent store (path in the system prompt) | `~/.claude/orchestrate/<project-slug>/`, which survives the session restarts a multi-day program expects |
| Model rule `~/.cursor/rules/pstack-models.mdc` | Override sheet `~/.claude/pstack-models.md`, included from `CLAUDE.md` |
| Model `composer-2.5-fast` (Cursor) | `claude-sonnet-4-6` |
| Model `claude-opus-4-X-thinking-xhigh` (Cursor UI variant) | `claude-opus-5` (extended thinking configured separately) |
| Models `gpt-5.3-codex-high-fast`, `gpt-5.5-high-fast` (via Cursor) | `claude-sonnet-4-6`, `claude-haiku-4-5` (Claude family) |
| Multi-model panels (arena, architect, interrogate, how-critics) | Default panel is `claude-opus-5` + `claude-fable-5` + `claude-sonnet-5` — three distinct models across three tiers (replaces the cross-vendor diversity lost in translation). |

### What's lost in translation

**Cross-vendor model diversity.** `arena`, `interrogate`, `architect`, and `how` all rely on stress-testing a design against several *different* model families. Claude Code is single-vendor, so the split collapses to three Claude variants by tier. Instead of bridging to an external CLI for that diversity, the rewiring routes the "harsher pass" to the bundled `thermo-nuclear-code-quality-review` skill — different style of pressure (strict maintainability rubric), not vendor diversity, but it lives in-plugin with no extra installs.

### What's deliberately kept

- The `poteto-agent` subagent ID and all references to it.
- `run_in_background: true` on Agent calls (Claude Code supports it).
- `/loop`, `/deslop`, `/babysit` slash references in skill bodies — they all resolve in Claude Code now.
- The principle/playbook structure and every word of the principles themselves.

### What's deliberately not ported

- **`automations/benny/`** (upstream `0452e08`, the only pstack change between `e46364b` and v0.10.0) — a dormant Slack issue-triage and reproduce-and-fix automation pack built on Cursor's event-triggered automations. It registers no slash skills even upstream, so excluding it changes nothing about the ported plugin's behavior. Porting it would mean translating Cursor's event-trigger runtime to Claude Code's polling-based scheduled agents plus Slack and tracker plumbing — speculative infrastructure with no local user. Revisit if an unattended issue-intake stream materialises; the likely first step is porting the triage skill onto a single Claude scheduled agent, not the whole pack.
- **`docs/guide/`** (upstream `02c03a9`, `0b7ef5b`, `424829e`) — the ten-chapter usage tutorial and its six screenshots (2.3 MB). It teaches pstack through Cursor's UI, sticky mode, and cloud agents, so a faithful port would be a rewrite rather than a sync, and none of it ships as skill content. Read it upstream at [cursor/plugins/pstack/docs/guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide); the concepts map through the substitution table above. Revisit if the port grows its own tutorial.
- **Sticky mode** (upstream `#144`) — Cursor-only `mode`/`icon`/`color`/`reminder` frontmatter with no Claude Code equivalent. The port's 0.9.5 SessionStart hook is the analog and already carries the non-trivial / trivial / opt-out logic.
- **`is_background: true` on `poteto-agent`** (upstream `99559f2`) — Cursor subagent frontmatter. Claude Code's agent frontmatter has no such key, and `run_in_background: true` on the spawning `Agent` call already covers it.
- **`cursor-team-kit` beyond the seven imported skills** — the rest either duplicate Claude Code built-ins (`verify-this` → the `verify` skill and built-in verification discipline; `check-compiler-errors` → LSP diagnostics; `control-cli`/`control-ui` → `run`/`verify`, already the substitution targets) or overlap skills this port ships (`loop-on-ci`, `review-and-ship`, `weekly-review` vs `babysit`, `fix-ci`, `make-pr-easy-to-review`, `what-did-i-get-done`). `pr-review-canvas` is Cursor-UI-specific.

### Forking note

Editing skill bodies forks this from upstream. Re-syncing to a future pstack release means re-applying the substitution table. The full re-port recipe is in [CHANGES.md](CHANGES.md).

## License

MIT. Three upstream LICENSE files are preserved:

- [LICENSE](LICENSE) — pstack (Lauren Tan)
- [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) — Cursor (covers the `deslop` and `thermo-nuclear-code-quality-review` skills)
- [LICENSE-superpowers](LICENSE-superpowers) — superpowers, Jesse Vincent (covers the vendored `hooks/run-hook.cmd`)

[NOTICE-skills.md](NOTICE-skills.md) is the scoped notice copied into skills-only installations. The root [NOTICE.md](NOTICE.md) covers the full plugin, including runtime-specific files.
