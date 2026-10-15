# pstack

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated skill stack that improves agent outcomes. This port shares skills across Claude Code, Codex, Pi, GitHub Copilot, and Devin CLI. Platform mappings translate Cursor and Claude instructions to each runtime's tools.

Tell `poteto-mode` your goal and it invokes the workflow that fits: reproduce and root-cause a bug, sketch a design with `architect`, race candidates in `arena`, review a diff with `interrogate`, cut prose with `unslop`. It keeps code concise, simple, and verified, and it reports what it checked.

## What it contains

- Skills: Markdown instructions the agent reads. Public ones appear as `/pstack:<name>` slash commands.
- Agents: `pstack:poteto-agent` and `pstack:comment-sicko`, plus one agent per reasoning-effort level.
- A SessionStart hook that injects the poteto-mode routing mandate unless your `pstack-models.md` sheet turns it off.
- A Pi extension that supplies the subagent, question, and wake-up tools, `/loop`, and the same routing mandate when the repository is installed as a Pi package.
- Local scripts for watching and shipping pull requests, orchestrating multi-phase plans, and auditing worktrees.

## Devin CLI

Install a local checkout with `devin plugins install --local ./plugins/pstack` from the repository root. Start a new session and run `/pstack:setup-pstack` to select concrete model UIDs and create pinned profiles. The Node.js helper is also included in skills-only installations. See the [Devin runtime reference](https://github.com/minatoaquaMK2/pstack-claude/blob/main/docs/reference.md#devin-cli) for setup and verification limits.

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Links

- [Skills, slash commands, runtime setup, and model configuration](https://github.com/michael-denyer/pstack-claude/blob/main/docs/reference.md)
- [Issues and support](https://github.com/michael-denyer/pstack-claude/issues)
- [Security policy](https://github.com/michael-denyer/pstack-claude/blob/main/SECURITY.md)

## License

MIT for this port and its additions, © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit skills © 2026 Cursor. See [NOTICE.md](https://github.com/michael-denyer/pstack-claude/blob/main/NOTICE.md).
