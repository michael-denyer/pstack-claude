# Contributing

Thanks for helping out. This repo is a **port**, not an original work: the `skills/` tree tracks [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack) and gets synced forward periodically. That one fact shapes most of what follows.

## The sync boundary

Upstream owns skill content. This port owns the Cursor-to-Claude-Code translation.

Before changing a `SKILL.md`, work out which side your change lives on:

- **Fixing the port.** A Cursor primitive that resolves wrong on Claude Code, a broken cross-reference, a stale model slug. Belongs here. Open a PR.
- **Changing what a skill does.** New steps, a different workflow, reworded guidance. Usually belongs upstream. Land it there and it arrives here on the next sync. If you land it only here, the next sync conflicts with it and someone has to re-litigate the change under time pressure.

Local-only changes are fine when they're genuinely port-specific. Say so in the PR description, so the next sync knows it is deliberate and not drift.

Every substitution is recorded per-skill in [CHANGES.md](CHANGES.md). If you add one, record it there in the same PR.

### Running a sync

```shell
bun tools/sync.mjs pstack <new-upstream-sha>
```

`tools/upstream.json` pins the current upstream SHA per component; `tools/substitutions.json` holds the mechanical Cursor-to-Claude rewrites and a denylist of Cursor-isms that need a rewritten sentence rather than a token swap. The tool fetches both upstream revisions, applies the substitutions, writes files whose only local differences came from upstream (new files included), and reports files carrying port-specific edits for manual merge. Any denylist token in a written file fails the run with the file, line, and hint — add a substitution rule or rewrite the sentence, then rerun. The pin advances only on success. Write the CHANGES.md entry from the printed report, then run the generator and the invariant script as usual.

## Before you open a PR

Run the generator, then the invariant script:

```shell
bun tools/generate.mjs
bash tests/skill-collision-repro.sh
```

The generator stamps the root `VERSION` into the three plugin manifests, validates every shared Agent Skill's `name` and `description`, emits one Codex prompt stub per public skill from its `menu-description` frontmatter, rewrites the README slash-command table, and stamps model defaults from `plugins/pstack/models.json`. It also copies the five files declared in `PORTABLE_ASSETS` into the skills-only boundary and removes stale files from their generated directories. `NOTICE-skills.md` is the source for the scoped notice that travels with those skills.

The same run rejects missing or escaping local Markdown links, checks for stray model slugs, requires a matching `CHANGES.md` heading, and validates the Codex marketplace and Claude hook paths. CI reruns it and fails on any resulting diff, so commit whatever it changes. Adding a skill means giving it `name` and `description` frontmatter. A public skill also needs a `menu-description` and a name in `README_COMMAND_ORDER` in `tools/generate.mjs`; the generator fails by name if either is missing. Changing a model default means editing `models.json`, never a skill body. A `claude-*` slug in skill prose outside a stamped region fails the generator with the file and line.

The invariant script checks plugin layout and frontmatter flags. Each static check is a named function; `bun test tests/` runs `tests/invariants.test.mjs`, which points the script at fixture trees (via `PSTACK_REPO`) and asserts every check still fails when it should, alongside the Agent Skills boundary and sync-tool tests. The last check is behavioral: it needs the `claude` CLI and API access and makes one haiku call. CI runs everything except that leg via `SKIP_BEHAVIORAL=1`, so run it unflagged at least once before a release.

If you touched `skills/poteto-mode/scripts/`:

```shell
cd plugins/pstack/skills/poteto-mode/scripts
bun install --frozen-lockfile
bun run typecheck
bun test orch watch-pr
```

If you touched a workflow, audit it before pushing:

```shell
uvx zizmor@1.29.0 --persona pedantic --min-severity low --collect all -- .
```

`--collect all` matches what CI scans. Pointing zizmor at `.github/workflows/` alone skips `dependabot.yml`, so the local run comes back clean on findings CI will fail on.

## Things that will fail CI

- **A `plugins/pstack/commands/` directory.** Claude Code renders commands and user-invocable skills in the same slash menu, so a trampoline paired with its skill duplicates every `/pstack:<name>` row ([#22](https://github.com/michael-denyer/pstack-claude/issues/22)). Codex stubs live in `plugins/pstack/.codex-plugin/prompts/`. An upstream sync will try to reintroduce `commands/`; move any new stubs across.
- **`disable-model-invocation` in a skill's frontmatter.** On a skill it makes the Skill tool refuse the invocation outright, which breaks the SessionStart mandate. The `principle-*` leaves use `user-invocable: false` instead.
- **Stale generated output.** The `Generated files current` job reruns `bun tools/generate.mjs` and fails on any diff. Editing `VERSION` without regenerating, hand-editing a manifest's `version` field, or bumping without a matching `CHANGES.md` heading all land here. The same run validates `hooks/hooks.json`: every command must point at an existing, executable script under the plugin.
- **A missing or escaping local Markdown link.** `tools/validate-skills.mjs` resolves bare, `./`, `../`, and reference-style targets against their Markdown file. Every local target must exist inside `plugins/pstack/skills`. The skills-only CI job repeats the check against the CLI's copied tree.
- **Prose telling the reader to open a path the install does not carry.** The same tool scans backticked paths under `agents/`, `hooks/`, `commands/`, `.codex-plugin/`, `.claude-plugin/`, and `../../`, and fails when the surrounding sentence instructs the reader to read or open one. Naming a directory to explain what a runtime ships is fine. A Markdown link is caught by the link check; this covers the backticked form that is not a link.
- **A shell script that fails shellcheck.** Scripts are selected by `.sh` extension or by shebang, so the extensionless hook scripts (`hooks/session-start`) are linted too.
- **An action pinned to a tag.** Use the full 40-character commit SHA with a version comment. A mutable tag can be force-pushed into our runners.

## Dependency updates

Dependabot updates `package.json` but cannot regenerate `bun.lock`, so a bun dependency PR arrives with the two out of sync and fails `bun install --frozen-lockfile`. The `Dependabot lockfile` workflow regenerates the lockfile and pushes it back to the PR branch, so those PRs go green on their own.

It only runs for PRs authored by `dependabot[bot]`, checked via `github.event.pull_request.user.login` rather than `github.actor`, which is spoofable. It is the one job in this repo with `contents: write`.

If you bump a dependency by hand, run `bun install` and commit the resulting `bun.lock` in the same change.

## Releasing

Plugin auto-update installs **by version number**, not by tracking `main`. A skill fix merged without a version bump is inert on every installed copy, because the updater sees the same version it already has and does nothing.

So: any PR that changes skill behavior either bumps the version itself or is followed by a release PR that does. The bump is three steps: edit the root `VERSION` file, add a `CHANGES.md` entry under a `## <version>` heading describing what changed and why, and run `bun tools/generate.mjs` to stamp the manifests. Forgetting any of the three fails CI. Run the full invariant script (including the behavioral leg) before merging.

## Commit and PR style

- Explain what changed and why. The diff already shows how.
- One concern per PR. A behavior fix and a refactor in the same diff are two separate reviews, and reviewing them together means doing neither properly.
- Claim only what you verified, and name the check. "52/52 bun tests pass" beats "tests pass"; "did not run the behavioral leg" beats silence.

## Reporting bugs

Include the pstack version, the Claude Code (or Codex) version, and the reproduction steps. [#22](https://github.com/michael-denyer/pstack-claude/issues/22) is the model to copy: it named versions, gave numbered steps, and included the experiment that isolated the cause.
