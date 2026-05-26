# pstack for Claude Code

Claude Code port of [poteto](https://x.com/poteto)'s [pstack](https://github.com/cursor/plugins/tree/main/pstack) plugin. Original by Lauren Tan; ships MIT. Includes the `deslop` skill from [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit) (also MIT).

> if you want to go fast, go deep first. pstack helps you write less, but higher quality code. rigorous agent workflows you can parallelize with confidence.

This is not a verbatim copy. Skill bodies have been edited so every Cursor-specific primitive resolves to its Claude Code equivalent — see [Differences from upstream](#differences-from-upstream) for the full list. The exhaustive per-skill audit lives in [CHANGES.md](CHANGES.md); license attribution lives in [NOTICE.md](NOTICE.md); the upstream README is preserved verbatim at [README-UPSTREAM.md](README-UPSTREAM.md).

## Install

This directory is a Claude Code plugin. Point a marketplace or a local-plugin install at this directory; auto-discovery picks up `.claude-plugin/plugin.json`, `commands/`, `skills/`, and `agents/`.

## Slash commands

| command | use it when |
| --- | --- |
| `/poteto-mode` | default entry point for any non-trivial task |
| `/how` | walk through how a subsystem works |
| `/why` | investigate why something was built this way (parallel multi-MCP evidence) |
| `/architect` | settle types and module shape before writing code that crosses a function boundary |
| `/arena` | run N parallel attempts at the same task and pick the best parts |
| `/interrogate` | have four different models try to break a diff |
| `/automate-me` | draft your own personal -mode skill from recent transcripts |
| `/reflect` | capture a long task's lessons as a skill edit |
| `/tdd` | fix a bug by writing the failing test first, then the fix |
| `/typescript-best-practices` | ground type-system discipline in TypeScript syntax |
| `/figure-it-out` | design a rigorous, auditable playbook for a task no bundled playbook fits |
| `/show-me-your-work` | log decisions to a reviewable tsv decision trail |
| `/unslop` | clean up writing by removing AI tells |
| `/deslop` | deslop a diff before commit |
| `/babysit` | monitor an open PR, fix CI/comments, keep it merge-ready |

## Subagent

`poteto-agent` ships unchanged. Spawn from a parent with `subagent_type: "poteto-agent"`.

## Differences from upstream

The port is editorial, not mechanical. Anywhere upstream pstack assumed Cursor-specific primitives, this port substitutes the Claude Code equivalent so refs actually resolve. Two prior ports ([v1truv1us/ai-eng-system](https://github.com/v1truv1us/ai-eng-system), [Evan-Kim2028/agent-fleet](https://github.com/Evan-Kim2028/agent-fleet)) stop at namespacing — they vendor pstack under `pstack/` and leave the Cursor refs intact. This port does the content surgery.

### What's added

- **`skills/babysit/`** — Claude Code analog of Cursor's closed-source `/babysit` built-in. Wraps `gh pr view` / `gh pr checks` / `gh run view --log-failed` plus the `loop` skill for pacing. Workflow informed by Cursor's public /babysit behavior; not a copy of Cursor's implementation.
- **`skills/deslop/`** — imported verbatim from `cursor-team-kit`. No other team-kit skills are bundled.

### What's substituted in skill bodies

| Upstream (Cursor) | This port (Claude Code) |
| --- | --- |
| `Task` tool, `subagent_type: generalPurpose`, `readonly: false/true` | `Agent` tool, `subagent_type: "general-purpose"`, no readonly flag (subagent_type controls MCP access) |
| `AskQuestion` tool | `AskUserQuestion` tool |
| Cursor's built-in `/loop` | Claude Code's built-in `loop` skill |
| Cursor's built-in `/babysit` | `babysit` skill bundled in this plugin |
| Cursor's built-in `/create-skill` | `plugin-dev:skill-development` skill |
| `cursor-team-kit` `control-cli` (CLI/TUI driver) | Claude Code's `run` skill |
| `cursor-team-kit` `control-ui` (browser/Electron driver) | Claude Code's `verify` skill |
| Transcripts at `~/.cursor/projects/*/` or `agent-transcripts/` | `~/.claude/projects/<encoded-cwd>/*.jsonl` (where `<encoded-cwd>` is the workspace cwd with `/` → `-`) |
| Skill paths `.cursor/skills/`, `~/.cursor/plugins/` | `.claude/skills/`, `~/.claude/plugins/` |
| MCP discovery via Cursor's `mcps/` directory | Tool list at top of system prompt (`mcp__<server>__<name>` entries), or `.mcp.json`, or `claude mcp list` |
| Model `composer-2.5-fast` (Cursor) | `claude-sonnet-4-6` |
| Model `claude-opus-4-7-thinking-xhigh` (Cursor UI variant) | `claude-opus-4-7` (extended thinking configured separately) |
| Models `gpt-5.3-codex-high-fast`, `gpt-5.5-high-fast` (via Cursor) | `claude-sonnet-4-6`, `claude-haiku-4-5` (Claude family) |

### What's lost in translation

**Cross-vendor model diversity.** `arena`, `interrogate`, `architect`, and `how` all rely on stress-testing a design against four *different* model families. Claude Code is single-vendor, so the four-way split collapses to four Claude variants by tier and thinking budget. To recover real cross-vendor critique, bridge to an external CLI from the lead — wrappers like `/gsd-review` (from the GSD plugin) spawn GPT/Gemini/Codex CLIs in parallel and feed results back. The skill bodies now mention this escape hatch; the default is Claude-only.

### What's deliberately kept

- The `poteto-agent` subagent ID and all references to it.
- `run_in_background: true` on Agent calls (Claude Code supports it).
- `/loop`, `/deslop`, `/babysit` slash references in skill bodies — they all resolve in Claude Code now.
- The principle/playbook structure and every word of the principles themselves.

### Forking note

Editing skill bodies forks this from upstream. Re-syncing to a future pstack release means re-applying the substitution table. The full re-port recipe is in [CHANGES.md](CHANGES.md).

## License

MIT. Two upstream LICENSE files are preserved:

- [LICENSE](LICENSE) — pstack (Lauren Tan)
- [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) — Cursor (covers the `deslop` skill)
