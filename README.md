# pstack

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/codenyer)

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated Cursor skill stack that improves agent outcomes. This is a port for Claude Code, Codex, Pi, GitHub Copilot and other agent harnesses. It tracks upstream and also carries named policy forks, each declared in [`tools/forks.json`](tools/forks.json).

Tell `poteto-mode` your goal and it will invoke the correct workflow for the task. It keeps your code concise, simple and verified.

For concurrency bugs and invariants that tests cannot reach, `/create-formal-verification-skill` picks the riskiest property in your code, verifies it with a tool that fits, and leaves a project skill the next agent reruns. The separate [agent-formal-verify](https://github.com/michael-denyer/agent-formal-verify) plugin goes deeper on the method, with guided TLA+ model checking, Lean proofs, and Kani.

## Install

<details>
<summary><strong>Claude Code</strong></summary>

Run in Claude Code:

```text
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

</details>

<a id="codex"></a>
<details>
<summary><strong>Codex</strong></summary>

Run in your terminal:

```shell
codex plugin marketplace add michael-denyer/pstack-claude
codex plugin add pstack@pstack-claude
```

</details>

<details>
<summary><strong>Pi</strong></summary>

Run in your terminal:

```shell
pi install git:github.com/michael-denyer/pstack-claude
```

The package loads the skills and the pstack Pi extension, which adds the subagent, question, and wake-up tools the skills use, plus `/loop` and the routing instruction. Invoke a skill with `/skill:<name>`.

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Run in your terminal:

```shell
copilot plugin marketplace add michael-denyer/pstack-claude
copilot plugin install pstack@pstack-claude
```

This installs pstack for the Copilot CLI and the GitHub Copilot app, which share `~/.copilot`. Start a new session afterwards. Copilot ships no default pstack models, so the first skill that needs one runs `setup-pstack` to pick from the models your account lists, and later sessions reuse that choice.

The Copilot build is tested on Copilot CLI 1.0.87 through 1.0.92. On those versions the routing hook's context reaches the session alongside other plugins' session-start context. If a later version keeps only one plugin's context, `setup-pstack` offers a [standing instruction](plugins/pstack/skills/setup-pstack/copilot.md#wire-it-in) for `~/.copilot/copilot-instructions.md` instead. On 1.0.92, once the CLI caches its computer-use experiment assignment, `copilot -p` sessions list no plugin skills and a `skill` call returns "Skill not found". Interactive sessions, the hooks, and the agents are unaffected.

</details>

<a id="other-harnesses"></a>
<details>
<summary><strong>Other harnesses</strong></summary>

OpenCode (the CLI and the desktop app), Gemini CLI, Prime Agent, and skills-only Codex installs read skills from `~/.agents/skills/`. Run in your terminal:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
mkdir -p ~/.agents/skills
for s in plugins/pstack/skills/*/; do
  target=~/.agents/skills/"$(basename "$s")"
  test -e "$target" || test -L "$target" || ln -s "$(pwd)/$s" "$target"
done
```

To update, run `git pull` in the clone, then run the `for` loop again to link skills added since the last run. These installs have no routing hook, so ask for `poteto-mode` by name or add a standing instruction to the harness's instruction file. See [shared installation](docs/reference.md#shared-skills-installation) for per-harness notes and uninstalling.

</details>

### Configure

pstack routes tasks to `poteto-mode` automatically. At session start, a hook injects an instruction that points the agent at it: the plugin's hook on Claude Code, Codex, and GitHub Copilot, and the pstack extension on Pi. Codex runs the hook only after you trust it through `/hooks`. Other harnesses have no hook.

Run `setup-pstack` to turn automatic routing on or off, change model defaults, or set a reasoning effort per role (`arena runners: opus @xhigh, fable @max`).

## Getting started

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

For a bug, it reproduces the failure, uses `how` and `why` to investigate, delegates the fix, then reruns the failing case. If the fix crosses a function boundary, it brings in `architect` before implementation. You receive the fix and the failing and passing evidence.

[Other playbooks](plugins/pstack/skills/poteto-mode/SKILL.md#playbooks) cover planning, features, refactoring, performance issues, investigations, prototypes, PR maintenance, shipping, and longer projects.

![poteto-mode on Claude Code, Codex, and Pi turns a request into verified work. Choose a playbook, plan and delegate with architect, arena, or swarm, then review and verify with interrogate, tests, and measurements. Project playbooks customize the workflow, and setup-pstack configures the model and reasoning effort per role. Supporting skills include how, why, and unslop.](assets/pstack-overview.png)

## Details

- [Skills and slash commands](docs/reference.md#slash-commands)
- [Runtime setup](docs/reference.md#runtime-support)
- [Models and dependencies](docs/reference.md#configuration-and-dependencies)
- [Maintenance and port scope](docs/reference.md#maintenance)

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

## Contributing

Thanks for helping make this port better. Bug reports, documentation fixes, and runtime improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

To support maintenance of this port, [buy the maintainer a coffee](https://buymeacoffee.com/codenyer).

## License

This port, including its modifications and additions, is also [MIT-licensed](LICENSE), © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit and thermos skills © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit), [LICENSE-thermos](LICENSE-thermos), and [NOTICE.md](NOTICE.md).
