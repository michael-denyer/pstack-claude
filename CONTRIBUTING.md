# Contributing

Thanks for helping out. This repo is a **port**, not an original work: the `skills/` tree tracks [upstream pstack](https://github.com/cursor/plugins/tree/main/pstack) and gets synced forward periodically. That one fact shapes most of what follows.

## The sync boundary

Upstream owns skill content. This port owns the Cursor-to-Claude-Code translation.

Before changing a `SKILL.md`, work out which side your change lives on:

- **Fixing the port.** A Cursor primitive that resolves wrong on Claude Code, a broken cross-reference, a stale model slug. Belongs here. Open a PR.
- **Changing what a skill does.** New steps, a different workflow, reworded guidance. Usually belongs upstream. Land it there and it arrives here on the next sync. If you land it only here, the next sync conflicts with it and someone has to re-litigate the change under time pressure.

Local-only changes are fine when they're genuinely port-specific. Say so in the PR description, so the next sync knows it is deliberate and not drift.

Every substitution is recorded per-skill in [CHANGES.md](CHANGES.md). If you add one, record it there in the same PR.

## Before you open a PR

Run the invariant script:

```shell
bash tests/skill-collision-repro.sh
```

It checks plugin layout, frontmatter flags, version parity across the three manifests, and that the default model quad is identical everywhere it appears. The last check is behavioral: it needs the `claude` CLI and API access and makes one haiku call. CI runs everything except that leg via `SKIP_BEHAVIORAL=1`, so run it unflagged at least once before a release.

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
- **A version bump in only some manifests.** The version string is duplicated in `plugins/pstack/.claude-plugin/plugin.json`, `plugins/pstack/.codex-plugin/plugin.json`, and `.claude-plugin/marketplace.json`. All three move together.
- **An action pinned to a tag.** Use the full 40-character commit SHA with a version comment. A mutable tag can be force-pushed into our runners.

## Dependency updates

Dependabot updates `package.json` but cannot regenerate `bun.lock`, so a bun dependency PR arrives with the two out of sync and fails `bun install --frozen-lockfile`. The `Dependabot lockfile` workflow regenerates the lockfile and pushes it back to the PR branch, so those PRs go green on their own.

It only runs for PRs authored by `dependabot[bot]`, checked via `github.event.pull_request.user.login` rather than `github.actor`, which is spoofable. It is the one job in this repo with `contents: write`.

If you bump a dependency by hand, run `bun install` and commit the resulting `bun.lock` in the same change.

## Releasing

Plugin auto-update installs **by version number**, not by tracking `main`. A skill fix merged without a version bump is inert on every installed copy, because the updater sees the same version it already has and does nothing.

So: any PR that changes skill behavior either bumps the version itself or is followed by a release PR that does. Bump all three manifests, add a `CHANGES.md` entry describing what changed and why, and run the full invariant script (including the behavioral leg) before merging.

## Commit and PR style

- Explain what changed and why. The diff already shows how.
- One concern per PR. A behavior fix and a refactor in the same diff are two separate reviews, and reviewing them together means doing neither properly.
- Claim only what you verified, and name the check. "52/52 bun tests pass" beats "tests pass"; "did not run the behavioral leg" beats silence.

## Reporting bugs

Include the pstack version, the Claude Code (or Codex) version, and the reproduction steps. [#22](https://github.com/michael-denyer/pstack-claude/issues/22) is the model to copy: it named versions, gave numbered steps, and included the experiment that isolated the cause.
