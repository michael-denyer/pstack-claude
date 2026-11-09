# pstack

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/codenyer)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) is an opinionated Cursor skill stack that improves agent outcomes. This is a port for Claude Code, Codex, Pi, GitHub Copilot, Muse, and other agent harnesses. It tracks upstream and also carries named policy forks, each declared in [`tools/forks.json`](tools/forks.json).

Tell `poteto-mode` your goal and it will invoke the correct workflow for the task. It keeps your code concise, simple and verified.

For concurrency bugs and invariants that tests cannot reach, `/create-formal-verification-skill` picks the riskiest property in your code, verifies it with a tool that fits, and leaves a project skill the next agent reruns. The separate [agent-formal-verify](https://github.com/michael-denyer/agent-formal-verify) plugin goes deeper on the method, with guided TLA+ model checking, Lean proofs, and Kani for Rust.

## Built for Claude Code

This port translates upstream's Cursor skills for Claude Code before installation. [Upstream's Claude Code install](https://github.com/cursor/plugins/tree/c742dd6/harness/pstack/claude-code) asks agents to translate Cursor names at runtime, using extra tokens and relying on them to apply the mapping correctly. This port also adds a SessionStart hook that routes tasks to `poteto-mode`.

## Install

<details>
<summary><strong>Claude Code</strong></summary>

Run in Claude Code 2.1.292 or later:

```text
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
```

Claude Code leaves auto-update off for third-party marketplaces, so pstack stays on the version you installed. To turn it on, run `/plugin`, open the **Marketplaces** tab, select `pstack-claude`, and choose **Enable auto-update**. To update once by hand, run `claude plugin update pstack@pstack-claude`.

</details>

<a id="codex"></a>
<details>
<summary><strong>Codex</strong></summary>

Run in your terminal:

```shell
codex plugin marketplace add michael-denyer/pstack-claude
codex plugin add pstack@pstack-claude
```

Invoke a skill by typing `$` and its name, such as `$poteto-mode` or `$babysit`, then choosing its entry, which inserts `$pstack:<name>`. `/skills` lists every skill.

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

<details>
<summary><strong>Muse</strong></summary>

Run in your terminal:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
muse plugins install ./plugins/pstack
muse plugins approve pstack
```

The first command installs the native Muse plugin bundle. The second approves its `SessionStart` hook and agent definitions, which Muse runs only after approval. Start a new session afterwards. Invoke a skill with `/<name>` (for example `/poteto-mode`), which Muse lists for each user-invocable skill.

</details>

<details>
<summary><strong>OMP</strong></summary>

Run in your terminal:

```shell
omp plugin marketplace add michael-denyer/pstack-claude
omp plugin install --scope user pstack@pstack-claude
```

Restart OMP after installing, disabling, or uninstalling pstack. OMP 18.16.0 shares one plugin cache across scopes, so an upgrade or removal can affect other installations; inspect their source and scope before changing them. See [OMP issue 16827](https://github.com/can1357/oh-my-pi/issues/16827).

</details>

<details>
<summary><strong>Kimi Code CLI</strong></summary>

After a release containing `kimi.plugin.json` is published, close other Kimi sessions and install it in a fresh Kimi Code CLI session:

```text
/plugins install https://github.com/michael-denyer/pstack-claude
/reload
```

To test an unreleased checkout, use `/plugins install /absolute/path/to/pstack-claude` instead, followed by `/reload`; Kimi copies the whole checkout, including Git metadata and local files, so use a clean, reviewed copy. To update, close other Kimi sessions, reinstall from the same source in a fresh session, and run `/reload`. Invoke a skill as `/skill:pstack:poteto-mode`; see the [Kimi mapping](plugins/pstack/skills/poteto-mode/references/kimi-tools.md) for tool guidance.

</details>

<details>
<summary><strong>Grok Build</strong></summary>

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
grok plugin install "$PWD/plugins/pstack" --trust
grok plugin enable pstack
```

Start a new session and use `/poteto-mode` to load the skill explicitly. To update a local install, quit Grok sessions, inspect `grok plugin details pstack` and back up any edits in the installed copy, pull the checkout, run `grok plugin uninstall pstack --keep-data`, and repeat the last two commands. If pstack was disabled, disable it again before restarting. `grok plugin update` does not refresh a local install.

</details>

<details>
<summary><strong>MiniMax Code</strong></summary>

For a first install, check that `${MINIMAX_DATA_DIR:-$HOME/.minimax}/plugins/pstack` does not already exist. Then run in your terminal:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
mkdir -p "${MINIMAX_DATA_DIR:-$HOME/.minimax}/plugins"
cp -R plugins/pstack "${MINIMAX_DATA_DIR:-$HOME/.minimax}/plugins/pstack"
```

MiniMax Code loads each directory under `plugins/` in its data directory as a local plugin, and reads pstack through its Claude Code reader with the skills, agents, and routing hook. `mcode plugin list` shows it as `pstack@local`. To update, record its enabled state, quit every `mcode` process, and move `plugins/pstack` to an unused path outside `plugins/`. Run `git pull` and the `cp` line again. Check `mcode plugin list` and restore the previous enabled state if needed.

</details>

<details>
<summary><strong>OpenCode 2</strong></summary>

Clone the repository, then add the absolute path to `plugins/pstack/opencode` to the existing `plugins` array in `~/.config/opencode/opencode.jsonc`. On Windows, use a path such as `C:/Users/name/pstack-claude/plugins/pstack/opencode`. Restart OpenCode after checkout updates.

Alternatively, install, check, or update the native Git package:

```bash
opencode plugin add 'github:michael-denyer/pstack-claude#main'
opencode plugin check 'github:michael-denyer/pstack-claude#main'
opencode plugin update 'github:michael-denyer/pstack-claude#main'
```

A commit-pinned reference does not advance. If a check immediately after installation reports no package plugins, wait for the server to load it and check again.

If you previously installed pstack skills into `~/.agents/skills`, inspect the links and remove only those pointing to your pstack checkout before using the plugin.

The plugin registers `pstack-` skill IDs and adds routing in root sessions. If routing is missing, run `opencode api get /api/skill` and check that each `pstack-` path belongs to this plugin. Resolve any conflicting skill before manually invoking that ID. Use `session hook: off` in the OpenCode model sheet to disable routing. To remove the plugin, remove its configured path and restart the service, or use `opencode plugin remove` with the exact Git specifier. OpenCode 1 is unsupported. See the [OpenCode mapping](plugins/pstack/skills/poteto-mode/references/opencode-tools.md).

</details>

<details>
<summary><strong>Antigravity (agy)</strong></summary>

Run in your terminal:

```shell
git clone https://github.com/michael-denyer/pstack-claude
cd pstack-claude
agy plugin install ./plugins/pstack
```

This installs the native Antigravity plugin bundle (`skills`, `agents`, and `SessionStart` routing hook) into `~/.gemini/config/plugins/pstack`.

</details>

<a id="other-harnesses"></a>
<details>
<summary><strong>Other harnesses</strong></summary>

Gemini CLI, Prime Agent, and skills-only Codex installs read skills from `~/.agents/skills/`. Run in your terminal:

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

pstack provides automatic routing on Claude Code, Codex, GitHub Copilot, Muse, MiniMax Code, Antigravity, Pi, Kimi Code CLI, OMP, and OpenCode 2. The runtimes deliver the instruction at different points: Kimi adds it while the plugin is enabled, OMP adds it before each main-agent turn, and OpenCode adds it at each model step in root sessions. Grok Build exposes a routing hint through a skill description; the model may not follow it. Codex requires hook trust through `/hooks`, and Muse requires `muse plugins approve pstack`. Other harnesses have no automatic routing.

Run `setup-pstack` to turn automatic routing on or off, change model defaults, or set a reasoning effort per role (`arena runners: opus @xhigh, fable @max`). On OMP, the session hook setting applies globally across profiles; on Kimi, enable or disable the plugin to control routing. See the [routing reference](docs/reference.md#automatic-routing).

## Getting started

```text
Use poteto-mode to fix the search filter resetting when I change pages.
```

For a bug, it reproduces the failure, uses `how` and `why` to investigate, delegates the fix, then reruns the failing case. If the fix crosses a function boundary, it brings in `architect` before implementation. You receive the fix and the failing and passing evidence.

A localized bug with a demonstrated cause can use the [focused-fix exception](plugins/pstack/skills/poteto-mode/playbooks/bug-fix.md#focused-fix-exception). One delegate investigates and implements the correction when it preserves existing interfaces and state semantics and has a focused regression check. Reproduction, verification, and required independent review still apply; a small patch alone does not qualify.

[Other playbooks](plugins/pstack/skills/poteto-mode/SKILL.md#playbooks) cover planning, features, refactoring, performance issues, investigations, prototypes, PR maintenance, shipping, and longer projects.

![poteto-mode on Claude Code, Codex, and Pi turns a request into verified work. Choose a playbook, plan and delegate with architect, arena, or swarm, then review and verify with interrogate, tests, and measurements. Project playbooks customize the workflow, and setup-pstack configures the model and reasoning effort per role. Supporting skills include how, why, and unslop.](assets/pstack-overview.png)

## Details

- [Skills and slash commands](docs/reference.md#slash-commands)
- [Runtime setup](docs/reference.md#runtime-support)
- [Models and dependencies](docs/reference.md#configuration-and-dependencies)
- [Maintenance and port scope](docs/reference.md#maintenance)

## Data handling

pstack has no server or telemetry. Anything its skills ask your agent to read, including session transcripts, goes to your model provider. Scripts run locally, and PR tools use your GitHub CLI login.

This port has no automatic agent-diary reporting or diary opt-in setting. For a local decision trail, ask for [`show-me-your-work`](plugins/pstack/skills/show-me-your-work/SKILL.md). Longer or unattended workflows also invoke it. The trail stays uncommitted by default, and pstack never sends it automatically. If you commit it to a shared PR, its reviewers can read it.

To share feedback, submit a short, manually reviewed report through [GitHub issues](https://github.com/michael-denyer/pstack-claude/issues). Include the pstack version, runtime, relevant workflow, and observed result. Remove credentials, customer data, private repository links, and sensitive log or configuration values before posting; share a summary instead of raw transcripts.

## Contributing

Thanks for helping make this port better. Bug reports, documentation fixes, and runtime improvements are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks and where your change belongs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

To support maintenance of this port, [buy the maintainer a coffee](https://buymeacoffee.com/codenyer).

## License

This port, including its modifications and additions, is also [MIT-licensed](LICENSE), © 2026 Michael Denyer. Original pstack © 2026 Lauren Tan; imported cursor-team-kit and thermos skills © 2026 Cursor. See [LICENSE-cursor-team-kit](LICENSE-cursor-team-kit), [LICENSE-thermos](LICENSE-thermos), and [NOTICE.md](NOTICE.md).
