# NOTICE

This plugin is a port of upstream MIT-licensed work. All upstream copyright notices and license terms are preserved.

## Upstream sources

| Component | Upstream | Copyright | License | License file |
| --- | --- | --- | --- | --- |
| `skills/poteto-mode/`, `skills/architect/`, `skills/arena/`, `skills/automate-me/`, `skills/figure-it-out/`, `skills/how/`, `skills/interrogate/`, `skills/reflect/`, `skills/show-me-your-work/`, `skills/tdd/`, `skills/typescript-best-practices/`, `skills/unslop/`, `skills/why/`, `skills/principle-*/`, `agents/poteto-agent.md` | [cursor/plugins/pstack @ 11ecc12](https://github.com/cursor/plugins/tree/11ecc12a3ffc037b4ef3b64de2be449668e8afc7/pstack) | (c) 2026 Lauren Tan | MIT | [LICENSE](LICENSE) |
| `skills/deslop/` | [cursor/plugins/cursor-team-kit/skills/deslop @ 11ecc12](https://github.com/cursor/plugins/tree/11ecc12a3ffc037b4ef3b64de2be449668e8afc7/cursor-team-kit/skills/deslop) | (c) 2026 Cursor | MIT | [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) |
| `skills/thermo-nuclear-code-quality-review/` | [cursor/plugins/cursor-team-kit/skills/thermo-nuclear-code-quality-review @ 11ecc12](https://github.com/cursor/plugins/tree/11ecc12a3ffc037b4ef3b64de2be449668e8afc7/cursor-team-kit/skills/thermo-nuclear-code-quality-review) | (c) 2026 Cursor | MIT | [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) |

## What changed in the port

The port is editorial, not mechanical. See [CHANGES.md](CHANGES.md) for the full per-skill audit of substitutions applied.

Summary of structural changes:

- Manifest moved from `.cursor-plugin/plugin.json` to `.claude-plugin/plugin.json` (Claude Code convention).
- `.claude-plugin/marketplace.json` added so the repo is installable via `/plugin marketplace add`.
- `commands/<name>.md` stubs added so each public skill is reachable as a slash command in Claude Code.
- `deslop` and `thermo-nuclear-code-quality-review` skills imported from `cursor-team-kit` (no other team-kit skills are bundled).
- `skills/babysit/` written from scratch as the Claude Code analog of Cursor's closed-source `/babysit` built-in.

## Modifications

Per the MIT license, modifications are permitted. Skill bodies have been edited to substitute Cursor-specific primitives with their Claude Code equivalents (the full substitution table is in [CHANGES.md](CHANGES.md)). All upstream copyright notices in source files (where present) are preserved.

Files authored for this port (not derived from upstream):

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `commands/*.md`
- `skills/babysit/SKILL.md`
- `NOTICE.md` (this file)
- `README.md`
- `CHANGES.md`
- `LICENSE-cursor-team-kit` (copied verbatim from upstream cursor-team-kit MIT)
