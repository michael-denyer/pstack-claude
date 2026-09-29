# pstack

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated skill stack that improves agent outcomes. This is the port for Claude Code, Codex, and other agent harnesses: the same skills, with Cursor primitives translated to each runtime's tools.

Tell `poteto-mode` your goal and it invokes the workflow that fits: reproduce and root-cause a bug, sketch a design with `architect`, race candidates in `arena`, review a diff with `interrogate`, cut prose with `unslop`. It keeps code concise, simple, and verified, and it reports what it checked.

## What it contains

- Skills: Markdown instructions the agent reads. Public ones appear as `/pstack:<name>` slash commands.
- Agents: `pstack:poteto-agent` and `pstack:comment-sicko`, plus one agent per reasoning-effort level.
- A SessionStart hook that injects the poteto-mode routing mandate unless your `pstack-models.md` sheet turns it off.
- Local scripts for watching and shipping pull requests, orchestrating multi-phase plans, and auditing worktrees.

## Data handling

pstack has no server and no telemetry. Anything a skill tells your agent to read, including session transcripts, goes to your model provider like any other file the agent opens. The PR scripts call `gh` with your login and install one pinned npm dependency on first use. The full description is in the repository README under [Data handling](https://github.com/michael-denyer/pstack-claude/blob/main/README.md#data-handling).

## Links

- [Skills, slash commands, runtime setup, and model configuration](https://github.com/michael-denyer/pstack-claude/blob/main/docs/reference.md)
- [Issues and support](https://github.com/michael-denyer/pstack-claude/issues)
- [Security policy](https://github.com/michael-denyer/pstack-claude/blob/main/SECURITY.md)

## License

MIT for this port and its additions, © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit skills © 2026 Cursor. See [NOTICE.md](https://github.com/michael-denyer/pstack-claude/blob/main/NOTICE.md).
