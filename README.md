# pstack

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated Cursor skill stack that improves agent outcomes. This is a port for Claude Code, Codex and other agent harnesses. It tracks upstream and also carries named policy forks, each declared in [`tools/forks.json`](tools/forks.json).

Tell `poteto-mode` your goal and it will invoke the correct workflow for the task. It keeps your code concise, simple and verified.

## Install

### Claude Code

Run in Claude Code:

```text
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

### Codex

Run in your terminal:

```shell
codex plugin marketplace add michael-denyer/pstack-claude
codex plugin add pstack@pstack-claude
```

Run `setup-pstack` to change model defaults, set a reasoning effort per role (for example `arena runners: opus @xhigh, fable @max`, which Claude Code dispatches through the plugin's `pstack:effort-<level>` or `pstack:poteto-agent-<level>` agents; roles without a level keep the session's effort unless the sheet's `default effort` line names one), or turn automatic routing off. The plugin installs the routing hook on Claude Code and Codex; Codex asks you to trust it through `/hooks` before it runs. In Claude Code, use `/pstack:setup-pstack`.

For Prime Agent, OpenCode, Gemini CLI, or skills-only installs for any harness, see [shared installation](docs/reference.md#shared-skills-installation).

## Getting started

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

For a bug, it reproduces the failure, uses `how` and `why` to investigate, delegates the fix, then reruns the failing case. If the fix crosses a function boundary, it brings in `architect` before implementation. You receive the fix and the failing and passing evidence.

[Other playbooks](plugins/pstack/skills/poteto-mode/SKILL.md#playbooks) cover planning, features, refactoring, performance issues, investigations, prototypes, PR maintenance, shipping, and longer projects.

![A request enters poteto-mode. Playbook options include Plan, Bugs, Features, and Refactor. Planning can use architect, arena, or swarm; review and verification can use interrogate, tests, and measurements. Supporting skills include how, why, and unslop. The output is Finished work validated.](assets/pstack-overview.png)

## Details

- [Skills and slash commands](docs/reference.md#slash-commands)
- [Runtime setup](docs/reference.md#runtime-support)
- [Models and dependencies](docs/reference.md#configuration-and-dependencies)
- [Maintenance and port scope](docs/reference.md#maintenance)

## Data handling

pstack has no server and no telemetry. Most of it is instructions to your agent, so anything a skill tells the agent to read goes to your model provider, the same as any other file the agent opens. That includes session transcripts. The `recall`, `reflect`, and `automate-me` skills and the `session-pickup` and `eval` playbooks read the current workspace's transcripts under `~/.claude/projects/`.

The hook and scripts run locally:

- The SessionStart hook checks `pstack-models.md` in `$CLAUDE_CONFIG_DIR` (default `~/.claude`) or `$CODEX_HOME` (default `~/.codex`) for `session hook: off`. If that line is absent, it prints the poteto-mode mandate into the session.
- `watch-pr` and `ship-pr` call `gh` with your login. `watch-pr` reads pull request state. `ship-pr` reads a landing record and can cancel its pending merge.
- The first run of `watch-pr`, `ship-pr`, or `orch` runs `bun install`, which downloads `commander` at the version pinned in `bun.lock` into the plugin's `scripts/node_modules`.
- `watch-pr/live-merge-safety.mjs` runs only when you start it with `--live-disposable`. It creates a private repository on your `gh` account, runs `ship-pr` against it, and deletes the repository.
- `worktree-audit.mjs` searches transcripts under `~/.claude/projects/` for each worktree's path to show when a chat last mentioned it.
- `resume.mjs` writes checkpoints under the repository's `.git/pstack/resume/`. `orch` writes its state to the directory you pass with `--store` or `ORCH_STORE`.

## Contributing

Thanks for helping make this port better. Bug reports, documentation fixes, and runtime improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

This port, including its modifications and additions, is also [MIT-licensed](LICENSE), © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit skills © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit) and [NOTICE.md](NOTICE.md).
