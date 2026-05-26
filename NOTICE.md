# NOTICE

This plugin is a port of upstream MIT-licensed work. All upstream copyright notices and license terms are preserved.

## Upstream sources

| Component | Upstream | Copyright | License | License file |
|---|---|---|---|---|
| `skills/poteto-mode/`, `skills/architect/`, `skills/arena/`, `skills/automate-me/`, `skills/figure-it-out/`, `skills/how/`, `skills/interrogate/`, `skills/reflect/`, `skills/show-me-your-work/`, `skills/tdd/`, `skills/typescript-best-practices/`, `skills/unslop/`, `skills/why/`, `skills/principle-*/`, `agents/poteto-agent.md` | [cursor/plugins/pstack @ 11ecc12](https://github.com/cursor/plugins/tree/11ecc12a3ffc037b4ef3b64de2be449668e8afc7/pstack) | (c) 2026 Lauren Tan | MIT | [LICENSE](LICENSE) |
| `skills/deslop/` | [cursor/plugins/cursor-team-kit/skills/deslop @ 11ecc12](https://github.com/cursor/plugins/tree/11ecc12a3ffc037b4ef3b64de2be449668e8afc7/cursor-team-kit/skills/deslop) | (c) 2026 Cursor | MIT | [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) |

## What changed in the port

Skill content was copied verbatim from upstream. The port is structural:

- Manifest moved from `.cursor-plugin/plugin.json` to `.claude-plugin/plugin.json` (Claude Code convention).
- `commands/<name>.md` stubs added so each public skill is reachable as a slash command in Claude Code.
- `deslop` skill imported from `cursor-team-kit` (other team-kit skills not included).

Cursor-specific references inside skill bodies (e.g. `/babysit`, `~/.cursor/...` transcript paths, `Task` vs `Agent` tool naming) are NOT rewritten by default. See [CHANGES.md](CHANGES.md) for the full per-skill audit and suggested Claude Code replacements.

## Modifications

Per the MIT license, modifications are permitted. None of the upstream skill bodies were edited in this port. The only files authored for this port are:

- `.claude-plugin/plugin.json`
- `commands/*.md`
- `NOTICE.md` (this file)
- `README.md`
- `CHANGES.md`
- `LICENSE-cursor-team-kit` (copied from upstream cursor-team-kit MIT)
