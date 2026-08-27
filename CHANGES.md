# CHANGES — applied substitutions

This port applies the Cursor → Claude Code substitutions in skill bodies. Earlier drafts left them flagged; this revision resolves them. A later pass added a Codex build that shares the same skills; see [Codex port](#codex-port) below.

## 0.9.15 — retire Opus 4.8 from the model defaults

`plugins/pstack/models.json` no longer names `claude-opus-4-8` as a default. Every single-model role that used it (`feature, refactoring`, `judgment and prose`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `swarm workers`, and the single-role default) now runs `claude-opus-5`. The three roles that carry the hardest code changes (`bug-fix`, `perf-issue`, `hillclimb`) move to `claude-fable-5`, matching the existing `strongest judgment` row. `claude-haiku-4-5` leaves the four panels (`how critics`, `arena runners`, `architect runners`, `interrogate reviewers`), so each runs the three-model panel `claude-opus-5`, `claude-fable-5`, `claude-sonnet-5`; the `models.json` key is now `panel`, not `panelQuad`. The generator restamped the `## Models` sections, the interrogate reviewer table, and the interrogate menu row; the README substitution table rows for the Cursor `claude-opus-4-X-thinking-xhigh` variant and the panel quad now state the current defaults. Opus 4.8 stays in the available-model list for `/setup-pstack` overrides.

## 0.9.14 — single-source the duplicated facts behind a generator

Four PRs (#36, #37, #40, #39) moved every convention-held duplication behind `tools/generate.mjs`, which stamps each fact from one source and fails CI on any diff after regeneration.

- **Version**: the root `VERSION` file stamps the three manifests. The generator refuses to run without a matching `CHANGES.md` heading, so a bump without release notes (or notes without a bump) fails CI. The invariant script's parity check retired.
- **Codex prompt stubs and the README command table**: generated from each public skill's new `menu-description:` frontmatter one-liner. 7 of 31 stub descriptions had already drifted from their README rows; both now render the same string. Orphan stubs are removed; a skill missing a `menu-description` or a `README_COMMAND_ORDER` entry fails by name. The invariant script's one-way orphan check retired.
- **Model policy**: `plugins/pstack/models.json` holds the role vocabulary, per-role defaults, the panel quad, and the Codex equivalents. The generator stamps each model-consuming skill's `## Models` section, setup-pstack's override sheet, interrogate's reviewer table, and codex-tools' Model names section, and fails with file and line on any `claude-*` slug in skill prose outside a stamped region. Skill prose now names roles, not slugs. The override sheet gains a `strongest judgment` row (`claude-fable-5`), previously an unnamed fact in poteto-mode prose. The invariant script's sampled quad check retired.
- **Upstream sync**: `tools/sync.mjs` syncs a component to a new upstream SHA using pins in `tools/upstream.json` and the substitution table plus Cursor-ism denylist in `tools/substitutions.json`, reporting clean updates, new files, and port-edited files needing manual merge. Five fixture tests run in CI. `README-UPSTREAM.md` deleted; NOTICE.md and the pins answer "which upstream, which SHA".

No skill workflow changes; the skill-body edits replace inline model slugs with role references resolved one section down in the same file. This bump exists to ship those prose changes to installed copies.

## 0.9.13 — drop the Claude Code command trampolines

Claude Code renders a plugin's commands and its user-invocable skills in the same slash menu, so every one of the 31 trampolines showed `/pstack:<name>` twice (#22, reported by @razvangirgiz). The trampolines existed for Codex, which has no skill picker of its own; on Claude Code they only shadowed the skill, which is what 0.9.7 and 0.9.8 spent two releases working around.

`plugins/pstack/commands/` moves to `plugins/pstack/.codex-plugin/prompts/`, next to the Codex manifest that is the only thing reading it. Claude Code now ships no commands at all, and `/pstack:<name>` resolves straight to the skill. Verified on CLI 2.1.245: a plugin with only `skills/foo/SKILL.md` serves the user-typed `/testplug:foo` and runs the skill.

The 0.9.7 collision machinery retires with the collision. `tests/skill-collision-repro.sh` drops the three trampoline-precedence legs and the command-flag invariant, and gains two static checks: `plugins/pstack/commands/` must not exist (an upstream sync reintroducing it fails here rather than silently restoring the duplicates), and every Codex prompt must have a matching skill. The 0.9.8 flag invariant widens from command-paired skills to every skill, since none may carry `disable-model-invocation`. The remaining behavioral leg proves the assumption this all rests on: a command-less plugin still serves `/plugin:name`.

## 0.9.12 — pin the thermo-nuclear report format

The 0.9.11 swarm routing flattened thermo-nuclear reviews into one consolidated report, dropping the summary-plus-per-subsystem-file layout earlier reviews produced. `thermo-nuclear-code-quality-review` now carries a Report Format section that pins the layered deliverable (a ~200-line narrative summary plus one detail file per subsystem reviewer) and overrides swarm's aggregation rules for this review (#28).

## 0.9.11 — sync to upstream v0.14.2

Catches the port up with upstream `cursor/plugins/pstack` from `3fe2823` (v0.11.3) to `4612556` (v0.14.2). Skills 48 → 52, commands 27 → 31, subagents 1 → 2, plus a vendored `scripts/` tree under `poteto-mode/`.

**New skills.**

- `swarm` (upstream `b79f8ca`, `91dd7b7`): fan out N parallel workers over slices or races, drain them, return one report. Upstream spawns Cursor cloud agents; Claude Code has no remote worker environment, so the port spawns local background subagents and takes isolation from a worktree or a per-worker output directory. The worker default follows the port's single-role default (`claude-opus-4-8`) and reads `swarm workers` from `~/.claude/pstack-models.md`.
- `no-comments` plus the `comment-sicko` subagent (#185): a comment-stripping review pass. `Task` → `Agent`, and upstream's agent name `Comment Sicko` becomes `comment-sicko` because a `subagent_type` with a space is not addressable.
- `technical-writing` (#185): the layered Diátaxis / Google developer style / STE / Global English standard. No Cursor primitives, copied as-is.
- `bro` (#187): restate the last message in plain language. Copied as-is.

Per the 0.9.8 invariant, all four drop upstream's skill-side `disable-model-invocation: true` and get command trampolines that carry it instead.

**New playbooks** (#185, #187), under `poteto-mode/playbooks/`: `babysit` (drive a PR or stack to merge-ready), `shipping` (verify each PR independently, then land the contiguous verified run), `orchestrate` (a standing multi-day program under one coordinator), `autopilot-full` and `autopilot-stack` (one owner per PR, swarm-verified), and `worktree-cleanup` (safety-gated disk reclamation). They share the new `references/bugbot-triage.md` rubric, which the poteto-mode review-bot trigger now points at.

Substitutions in the six: Cursor cloud agents become local background subagents isolated by worktree; `control-cli` / `control-ui` become the `run` / `verify` built-ins; `Task` becomes `Agent`; `AskQuestion` becomes `AskUserQuestion`; the Cursor agent store becomes `~/.claude/orchestrate/<slug>/`, which outlives the session the way a multi-day program's store has to; a Cursor restart becomes a session restart; the Cursor dashboard becomes the background task list. Cursor's `/goal` has no Claude Code equivalent, so the autopilots keep the program objective in the standing orders and the todolist, and their audit tick re-reads the playbook from the installed plugin instead of `git show origin/main:pstack/...`. Graphite (`gt`) is not Cursor-specific and stays.

**Babysit, skill versus playbook.** Upstream v0.14.0 stopped routing PR-status requests to Cursor's built-in babysit and gave poteto-mode its own playbook. The port's bundled `babysit` skill (the 0.9.2 analog of that built-in) stays as the standalone `/babysit` entry point; inside poteto-mode the playbook supersedes it, and both files say so.

**Vendored scripts.** `poteto-mode/scripts/` carries upstream's `watch-pr` (the PR watcher the Babysit and Shipping playbooks poll), `orch` (the orchestrate store CLI), `worktree-audit.sh`, and the bun bootstrap. Three edits: `worktree-audit.sh` reads `~/.claude/projects/` — scanning the whole projects tree, since a session run inside a worktree gets its own encoded directory — instead of `~/.cursor/projects/<slug>/agent-transcripts`; it warns when `jq` or `rg` is missing, because their absence silently blanks the PR and LAST_CHAT columns and downgrades an in-use worktree to `safe` in the one playbook that deletes user state; and the private workspace package is renamed `@pstack-claude/poteto-mode-tools` in `package.json` and `bun.lock`. `bun` joins `gh` as a documented system dependency, `gt` only for the stack playbooks and `jq`/`rg` only for the worktree audit. `node_modules/` under the scripts dir is gitignored.

**Content refinements over the port's existing translation.** `architect` gains design-it-twice, the `design-red-flags.md` screen, and the interface-depth comparison (#175), with the matching rationale-template and runner-prompt edits. Nine `principle-*` leaves, `unslop`, `typescript-best-practices` (plus 69 new lines of `references/patterns.md`), and `lead-judgment.md` take upstream's HEAD bodies verbatim; their bodies were byte-identical to upstream `3fe2823` beforehand, so the port keeps only its own frontmatter. `interrogate` moves its reviewer defaults into a labelled A/B/C/D table (#167). `create-verification-skill` points at the new `feature-map-example/` and names the four required H2s (#178). `automate-me` learns that mode skills can live in a personal category directory (#187). `opening-a-pr` takes upstream's title, description, readiness, and babysit rewrite (#185, #238), and `autonomous-run` takes mid-run-discovery ownership (#170).

**Model configuration.** Upstream's slug bumps (#165, #166, #169, #210: fable / sol / grok / Opus 5) are not ported — the port keeps its own Claude quad (`claude-opus-5`, `claude-fable-5`, `claude-opus-4-6`, `claude-sonnet-5`) and its `claude-opus-4-8` single-role default. What is ported is the structure: the `inherit-parent` / `auto` aliases (#163), which on Claude Code mean omitting `model` on the `Agent` call so the role runs on the parent session's model, and the config-source-first phrasing (#167) in `arena`, `interrogate`, and `swarm`. `setup-pstack` gains the aliases, the `swarm workers` row, and the alias-aware validation rules.

**Deliberately not ported.** `docs/guide/` (the ten-chapter tutorial and its six screenshots, 2.3 MB) teaches pstack through Cursor's UI, sticky mode, and cloud agents, and ships no skill content; README links it upstream. `is_background: true` on `poteto-agent` is Cursor agent frontmatter with no Claude Code key. Sticky mode and Benny remain out, unchanged from the earlier reviews.

**Test fix.** The quad invariant in `tests/skill-collision-repro.sh` had been searching the panel skills for `claude-sonnet-4-6`, a slug the 0.9.10 panel swap removed, so the check failed on `main` for every skill. It now derives the anchor slug from the canonical `arena runners` row and reads `interrogate`'s quad from its new reviewer table.

**Verified.** 52 skills / 31 commands / 2 subagents; three manifests parse at 0.9.11. Static invariants pass, including the repaired quad check. The vendored scripts pass `bun install --frozen-lockfile`, `bun test orch watch-pr` (52 tests), and `bun run typecheck` from their ported location. Not yet live-verified in a Claude Code or Codex session.

## 0.9.10 — sync to upstream v0.11.3

Catches the port up with upstream `cursor/plugins/pstack` from `0452e08` (v0.10.0) to `3fe2823` (v0.11.3). Skill count 44 → 48, commands 24 → 27.

**New skills.**

- `teach` (#153): composes the `how` and `why` skills into one plain explanation. Command-paired public skill; platform note for the parallel dispatch and image-gen tool.
- `principle-model-the-domain` (#147): encode the domain in a structure instead of scattered conditionals. Verbatim upstream prose, `user-invocable: false` per the 0.9.9 principle convention, woven into `poteto-mode`'s data-shape trigger and Architecture index, and into the `feature` and `refactoring` playbooks.
- `create-verification-skill` and `maintain-verification-skill` (#150, #151): generate and maintain a persistent, repo-tailored project verification skill plus feature map. A different layer from Claude's built-in `run`/`verify` per-session drivers, which they complement. Translation: `.cursor/skills/` → `.claude/skills/`, drop `disable-model-invocation` (command-paired), add command trampolines and platform notes.

**Content refinements (#155, #156), applied over the port's existing Cursor→Claude translation.** The perf playbook's eight strategy families; `interrogate` "four-model" → "multi-model"; the `hillclimb` ground-the-workload-first rewrite; rationale one-liners across five playbooks; `typescript-best-practices` real-tests and structured-telemetry rows; the `why` databricks source `SHOW TABLES` note.

**Model strategy (#143, #156).** `poteto-mode` now tiers code delegates by difficulty — hardest changes to the strongest judgment model (`claude-fable-5`) or the strongest instruction follower, trivial edits to a fast code model, everything else `claude-opus-4-8`. `setup-pstack` gains the configurable `arena cross-judge pool` row. The upstream `grok`/`gpt` slugs stay substituted with `claude-*`.

**Deliberately not ported.** Sticky mode (#144) is Cursor-only frontmatter (`mode`/`icon`/`color`/`reminder`) with no Claude Code equivalent; the port's 0.9.5 SessionStart hook already auto-fires `poteto-mode` with the same non-trivial/trivial/opt-out logic. Benny (#137) remains out, per the earlier review.

## 0.9.9 — principle leaves hide from the slash menu

0.9.8 kept `disable-model-invocation: true` on the 20 `principle-*` leaves, on the reasoning that they have no command and are read by path from `poteto-mode`. But that flag only blocks *model* invocation. It does not hide a skill from the user `/` menu, so all 20 surfaced as bare `/principle-*` slash commands in every session (confirmed across projects on the desktop app). They are internal references; users should never invoke them.

Fix: swap the flag for `user-invocable: false` on all 20 leaves. Per the [Claude Code skills docs](https://code.claude.com/docs/en/skills.md), `user-invocable: false` hides a skill from the `/` menu and controls menu visibility only, not Skill-tool or file access — so `poteto-mode` reading each leaf by path (`../principle-<name>/SKILL.md`, the mechanism the leaves have always used) is untouched. The two flags are mutually exclusive: setting both leaves a skill neither user- nor model-invocable, so this is a swap, not an addition. The visible consequence is that the leaves become model-auto-invocable on description match — the same standing the 12 command-paired skills took in 0.9.8, and immaterial to the by-path reference the leaves actually rely on. The invariant is now: every command carries `disable-model-invocation: true`, no command-paired skill carries it, and every `principle-*` leaf carries `user-invocable: false`.

## 0.9.8 — command-paired skills drop `disable-model-invocation`

The 0.9.7 fix put `disable-model-invocation: true` on all 24 command trampolines so the Skill tool resolves a colliding name to the skill. But 12 of those skills carried the same flag in their own frontmatter (present since the initial port), and the flag on a **skill** makes the Skill tool refuse the invocation outright. Net effect: the 0.9.5 SessionStart mandate ("invoke `pstack:poteto-mode` with the Skill tool") was refused every session, five of the six direct-entry skills it lists (`poteto-mode`, `tdd`, `architect`, `arena`, `interrogate`; only `how` and `why` were unflagged) were model-unreachable, and every user-typed `/pstack:<name>` for a flagged skill expanded to a trampoline body the model then couldn't follow. 0.9.7 didn't cause the skill-side flags, but it surfaced them: before it, the same calls died in the trampoline loop instead.

Fix: remove the flag from the 12 command-paired skills that carried it (`architect`, `arena`, `automate-me`, `blast-radius`, `figure-it-out`, `interrogate`, `poteto-mode`, `recall`, `reflect`, `show-me-your-work`, `tdd`, `thermo-nuclear-code-quality-review`). The resulting invariant is symmetric: every command carries the flag, no command-paired skill does. The `principle-*` leaves keep it — they have no commands and are deliberately read by path from `poteto-mode`. Model auto-invocation on description match is now possible for the 12; that is the 0.9.5 design intent, and the same standing the other 12 always-unflagged skills (`how`, `why`, `babysit`, `deslop`, …) already had.

`tests/skill-collision-repro.sh` gains the mirrored static invariant (no skill with a same-named command may carry the flag) and a fourth behavioral leg preserving the repro: with the flag on the skill, the Skill tool refuses the invocation even though the command no longer shadows it.

## 0.9.7 — command trampolines no longer shadow their skills

Every user-facing skill ships with a same-named `commands/<name>.md` trampoline whose body is "Invoke the `<name>` skill and follow it." On Claude Code, the Skill tool resolves a colliding name to the **command**, not the skill — so a model-initiated invoke of `pstack:<name>` got the trampoline back, which told it to invoke the skill, which resolved to the trampoline again. Mutual recursion; the real `SKILL.md` never loaded. This hit every model-side entry path, including the 0.9.5 SessionStart mandate (whose whole job is telling the model to invoke `pstack:poteto-mode`), and it made each name appear twice in the model's skill list. Observed in desktop-app sessions (inline `--plugin-dir` loading, same path as the 0.9.3 entry); reproduced on CLI 2.1.195 with a minimal two-artifact plugin.

Fix: all 24 command files now carry `disable-model-invocation: true` — the flag the `principle-*` leaf skills already use. Verified on 2.1.195 with the same minimal plugin: the Skill tool then resolves the colliding name to the skill (its `SKILL.md` is what gets injected), while a user-typed `/plugin:<name>` still runs the command trampoline, whose "invoke the skill" body now lands on the skill instead of looping. Command bodies are unchanged, so the Codex prompts path (which reads `description` frontmatter and the filename, and ignores keys it doesn't know — the established `name`-key precedent) is untouched. Whether a full Codex plugin install still surfaces the stubs in its picker with the flag present is unverified; if it hides them, the skills themselves remain the primary Codex surface and are invocable by name. Incidental finding from the same repro, recorded for future use: `${CLAUDE_PLUGIN_ROOT}` **is** substituted inside command markdown bodies on 2.1.195, not just in hooks and MCP configs.

The repro is preserved as `tests/skill-collision-repro.sh` (manual; needs the `claude` CLI, makes three haiku calls). It checks the static invariant (every command carries the flag) and the three behavioral legs: command wins the collision without the flag, skill wins with it, user-typed `/command` still runs. The first leg is a precedence detector — if it ever fails, upstream changed the undocumented resolution order and the flag should be re-evaluated, not the fix declared broken.

## 0.9.6 — hook hardening and duplication trims (thermo-nuclear review)

A strict maintainability review of the 0.9.3–0.9.5 range drove these:

- `hooks/session-start` collapsed from 43 lines to 3: SessionStart hook stdout reaches context directly (per the hooks docs; verified end-to-end on 2.1.197), so the JSON envelope, the `escape_for_json` pass, and the Cursor/Copilot platform branches — dead code here, since `hooks.json` is the only registration — are gone. This also removes a verified failure-path bug: the old `cat ... 2>&1 || echo` fallback was additive, silently injecting raw `cat` stderr plus the fallback string into session context when the context file was unreadable; now a missing file fails the hook cleanly and injects nothing. The script is no longer adapted from superpowers (NOTICE updated; `run-hook.cmd` remains near-verbatim and attributed).
- Panel-quad enumeration trimmed from the `poteto-mode` meta-files (`SKILL.md`, `references/plan.md`, `references/codex-tools.md`) — the slugs now live only in the four panel skills and the `setup-pstack` sheet, with a grep-identical rule added to Maintenance. This drift class already bit once (0.9.4 fixed a three-reviewers-vs-"four different models" mismatch).
- README's desktop-app `dependency-unsatisfied` narrative deduplicated to a two-sentence summary linking the CHANGES 0.9.3 entry.

## Upstream review through `0452e08` (v0.10.0), 2026-07-01

One upstream pstack commit landed after the `e46364b` sync: `0452e08` adds the dormant `automations/benny/` pack (Slack issue triage plus reproduce-and-fix, built on Cursor's event-triggered automations) and bumps upstream to 0.10.0. Deliberately not ported — rationale and revisit criteria in README → What's deliberately not ported. `cursor-team-kit` has no commits since the sync point (its latest, `679fdaf`, 2026-05-28, predates `e46364b`). The port's skill tree was current with upstream HEAD as of this note; the later 0.9.10 sync carries it forward to v0.11.3 (see above).

## 0.9.5 — poteto-mode auto-fires via SessionStart hook

`plugins/pstack/hooks/` is new. `hooks.json` registers a `SessionStart` hook (matcher `startup|clear|compact`) that injects `hooks/session-start-context.md` (~0.3k tokens) as additional context — the same mechanism superpowers uses to auto-load its skill-use mandate. The injected block routes any non-trivial engineering task into `pstack:poteto-mode` before the first response, lists the direct-entry skills, tells dispatched subagents to ignore it, and defers to explicit user instructions. The full poteto-mode skill still loads only on invoke. `run-hook.cmd` (cross-platform polyglot) and the JSON-emission pattern in `session-start` are adapted from superpowers (MIT; see NOTICE.md and LICENSE-superpowers). Codex is unaffected — it has no plugin hook runtime; invoke poteto-mode by name there.

## 0.9.4 — Sonnet 5 joins the default panels

The multi-model panels (`arena` runners, `architect` runners, `interrogate` reviewers, `how` critics) grow from a triple to a quad: `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-6`, `claude-sonnet-4-6` — both generations in each of two tiers. This also restores upstream's four-way `interrogate` split; the port had been running three reviewers under a "four different models" description. `setup-pstack` adds Sonnet 5 (`claude-sonnet-5`) to the available-family enumeration and to the four panel rows of its default sheet. Single-model delegation defaults stay `claude-opus-4-8`. Touched: `arena`, `architect`, `interrogate`, `how`, `setup-pstack`, `poteto-mode` (`SKILL.md`, `references/plan.md`, `references/codex-tools.md`), and the README substitution-table panel row. The historical Cursor→Claude mapping rows (`composer-2.5-fast`, `gpt-5.x`) are unchanged — they record what the 0.9.2 sync substituted, not current defaults.

## 0.9.3 — dependency declaration removed

`plugin.json` no longer declares `dependencies: [{ "name": "plugin-dev", "marketplace": "claude-plugins-official" }]`, and `marketplace.json` drops the matching `allowCrossMarketplaceDependenciesOn`. The Claude Code desktop app passes every enabled plugin to the CLI as a session-only `--plugin-dir`, which strips marketplace identity (`pstack@inline`); a cross-marketplace dependency can never resolve in that mode, and the loader disables the entire plugin with `dependency-unsatisfied`. Result: pstack loaded in the CLI and the VS Code extension but silently vanished from desktop-app sessions. `optional: true` on a dependency entry passes `claude plugin validate` but is not honored by the loader (tested on 2.1.197). `plugin-dev` is now a documented manual install (README → Dependencies); skill bodies still route skill-authoring to `plugin-dev:skill-development` when it is present.

## Codex port

pstack also ships as a Codex plugin. The skill bodies are not forked or regenerated. The same `skills/` tree serves both runtimes. One mapping file does the Claude-to-Codex translation. That single-mapping-file spine is the same one the official `superpowers` plugin ships for Codex.

pstack diverges from superpowers in one respect, and it is deliberate. superpowers writes its skill prose in tool-neutral language ("dispatch a subagent"), so no skill names a runtime tool and no per-skill note is needed. pstack instead keeps the upstream Claude-native prose intact, to stay in lockstep with upstream sync, and adds a one-line Platform note to each skill that names a Claude primitive. The note points at the mapping. Rewriting 44 upstream skills into neutral language would fork them from upstream and was rejected for that reason.

**Added.**

- `plugins/pstack/.codex-plugin/plugin.json` is the Codex plugin manifest (`skills: ./skills/`), with key-parity to the `superpowers` Codex manifest.
- `.agents/plugins/marketplace.json` is the Codex marketplace manifest at the repo root, sourcing `./plugins/pstack` the way the Claude `.claude-plugin/marketplace.json` does.
- `plugins/pstack/skills/poteto-mode/references/codex-tools.md` is the single Claude to Codex map. It covers tool actions (`Agent` becomes `spawn_agent` / `wait_agent` / `close_agent`, `AskUserQuestion` becomes plain text, the todolist becomes `update_plan`), the `multi_agent` config flag, subagent policy (Codex has no `poteto-agent` type, so dispatch a `spawn_agent` told to read `poteto-mode` first), model slugs (`claude-*` becomes your configured Codex models), the Claude built-ins pstack names (`run`, `verify`, `loop`, `plugin-dev:skill-development`), and the instructions file (`AGENTS.md`).

**Platform notes (pointer-only edits).**

- `skills/poteto-mode/SKILL.md` gained a "Platform Adaptation" section pointing at the mapping.
- `skills/{architect,arena,automate-me,babysit,how,interrogate,reflect,why}/SKILL.md` each gained a one-line Platform note, since each names a Claude tool, a `claude-*` slug, or a Claude built-in. The pure-prose skills (the `principle-*` set, `tdd`, `figure-it-out`, and the cursor-team-kit imports) needed nothing.
- `skills/setup-pstack/SKILL.md` gained a Codex branch. It writes `~/.codex/pstack-models.md` referenced from `~/.codex/AGENTS.md`, using Codex slugs instead of `claude-*`.

**Commands.** The 24 `commands/*.md` files are Codex-compatible as written, no rewrite needed. Codex command discovery reads the `description` frontmatter and the filename and ignores the extra `name` key, and each body (`Invoke the <skill> skill and follow it`) is a valid Codex prompt. They surface as slash commands once the full plugin is installed in Codex. For the symlink-based install, drop the same files into `~/.codex/prompts/` for loose `/name` shortcuts alongside the symlinked skills.

**Deliberately not ported.**

- `agents/poteto-agent.md`. Codex has no `subagent_type`, so ad-hoc subagents are dispatched via `spawn_agent` told to read `poteto-mode` first. The mapping covers this.

**Verified.** Codex discovers the skills and namespaces them under `pstack` (`pstack:poteto-mode` and so on) in a live session. Mapping resolution mid-task and `spawn_agent` fan-out follow the `superpowers` pattern and are worth confirming per session.

**Maintenance.** The plugin version string now lives in three manifests: `plugins/pstack/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `plugins/pstack/.codex-plugin/plugin.json`. A version bump must update all three; `tests/skill-collision-repro.sh` checks they match. `.agents/plugins/marketplace.json` carries no version field. The default panel quad is enumerated only in the four panel skills (`arena`, `architect`, `how`, `interrogate`) and the `setup-pstack` sheet — keep those lines grep-identical when models change (`tests/skill-collision-repro.sh` checks they match, deriving the canonical quad from `setup-pstack`'s `arena runners` row and reading `interrogate`'s from its reviewer table); `poteto-mode` and its references deliberately do not enumerate it. After a sync that touches `skills/poteto-mode/scripts/`, run `bun install --frozen-lockfile`, `bun test orch watch-pr`, and `bun run typecheck` from that directory. `hooks/session-start-context.md` restates skill one-liners — re-verify it whenever skill names or descriptions change. `plugins/pstack/commands/` must not exist (see 0.9.13); upstream ships trampolines there and a sync that restores them duplicates every slash-menu row, so move any new ones to `.codex-plugin/prompts/`. No skill may carry `disable-model-invocation` in its frontmatter (see 0.9.8) — on a skill it makes the Skill tool refuse the invocation, breaking the SessionStart mandate. The 21 command-less `principle-*` leaves instead carry `user-invocable: false` (see 0.9.9) to stay out of the `/` menu while `poteto-mode` reads them by path: `grep -L 'user-invocable: false' plugins/pstack/skills/principle-*/SKILL.md` must print nothing, and no leaf may also carry `disable-model-invocation` (the pair cancels to a dead skill). Re-run `tests/skill-collision-repro.sh` after Claude Code upgrades; its behavioral leg depends on undocumented slash resolution. The script checks the static invariants: the absent `commands/` directory, Codex prompts having matching skills, the skill and leaf flags, version parity across the three manifests, and the default model quad's identity across the four panel skills and `setup-pstack`.

## 0.9.2 sync (against upstream `e46364b`)

Upstream pstack jumped from `0.1.0` → `0.9.2` between syncs. 30+ commits, including 11 new files.

**New pstack-native skills/playbooks pulled in (Cursor refs in them re-substituted on the way in):**

- `skills/blast-radius/` — find what a change could break beyond the diff.
- `skills/recall/` — reconstruct recent working context. Cursor transcript path (`~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`) rewritten to Claude Code path (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`).
- `skills/setup-pstack/` — model-per-role configuration. Substantially rewritten: original wrote `~/.cursor/rules/pstack-models.mdc` (Cursor's `.mdc` always-applied-rule feature, no Claude Code analog). Replacement writes `~/.claude/pstack-models.md` and instructs the user to add an `@~/.claude/pstack-models.md` include to `~/.claude/CLAUDE.md` so the override sheet loads each session.
- `skills/principle-build-the-lever/`, `skills/principle-sequence-verifiable-units/` — new principles.
- `skills/poteto-mode/playbooks/{hillclimb,pause-safely,refactoring,session-pickup,trace-forensics}.md` — new playbooks.
- `skills/interrogate/references/code-quality-review.md` — new interrogate reference.

**Re-applied substitutions across changed + new content:**

- Bulk pass through 28 files via Python regex covering all entries in the substitution table above.
- Targeted fixes for variants the bulk pass missed:
  - `recall/SKILL.md` line 15 — Cursor transcript path rewrite.
  - `why/SKILL.md` line 100 — MCP discovery wording variant.
  - `poteto-mode/SKILL.md` lines 22–25 — `cursor-team-kit` qualifiers removed; Bugbot triage refs to `babysit`.
  - `reflect/SKILL.md` lines 37, 45, 49 — readonly/agent-mode language; `Task` → `Agent`.
  - `poteto-mode/playbooks/session-pickup.md` line 7 — `agent-transcripts/` path.
  - `poteto-agent.md` description — `generalPurpose` → `general-purpose`.
- Bumped Opus references from `claude-opus-4-7` to `claude-opus-4-8` (current Claude family head).
- Multi-model panels (`arena`, `architect`, `interrogate`, `how` critics, and the `setup-pstack` defaults) had a duplicate `claude-sonnet-4-6` in the third slot. Replaced one with `claude-opus-4-6` so the panel runs three distinct models (`claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-4-6`) instead of two — cross-generation diversity inside the opus tier where cross-vendor diversity isn't available.
- All single-subagent delegation defaults bumped from `claude-sonnet-4-6` to `claude-opus-4-8`: `bug-fix`, `feature`, `perf-issue`, `refactoring`, `hillclimb` (the five poteto-mode code-writing playbooks); `how-explorer`, `why-investigators`, `reflect-tooling` (the three multi-subagent dispatches that run the same model in parallel rather than a diverse panel). Setup-pstack override sheet updated to match. Meta-defaults in `poteto-mode/SKILL.md` and `plan.md` rephrased: "default `claude-opus-4-8` for code-writing delegations" replaces the old "claude-sonnet-4-6 for code" wording. Sonnet now appears only in the diverse 3-model panels.

**Command stubs added:** `commands/blast-radius.md`, `commands/recall.md`, `commands/setup-pstack.md`.

**Manifest changes:**

- `plugins/pstack/.claude-plugin/plugin.json` — version `0.1.0` → `0.9.2`; added `displayName: "pstack (Claude Code port)"`.
- `.claude-plugin/marketplace.json` — plugin entry version bumped to `0.9.2`.

**Team-kit imports:** unchanged. The upstream diff showed only `verify-this` (which we didn't import) changed in `cursor-team-kit/skills/`.

**`babysit` skill:** unchanged. Locally authored; not affected by upstream sync.

---

## Substitution table

| Cursor primitive | Replaced with | Notes |
| --- | --- | --- |
| `Task` tool | `Agent` tool | Claude Code's `Agent` tool is the equivalent. |
| `subagent_type: generalPurpose` | `subagent_type: "general-purpose"` | Kebab-case in Claude Code. |
| `subagent_type: "poteto-agent"` | `subagent_type: "poteto-agent"` | Unchanged — this plugin ships that agent. |
| `readonly: true` / `readonly: false` | (dropped; rewritten as "pick a subagent_type that retains MCP access") | Claude Code controls tool/MCP access via subagent_type, not a per-call readonly flag. |
| `AskQuestion` | `AskUserQuestion` | Tool rename; semantics match. |
| Cursor `/loop` (built-in) | Claude Code `loop` skill | 1:1 replacement; available as a built-in skill. |
| Cursor `/babysit` (built-in) | This plugin's `babysit` skill | New Claude Code analog at `skills/babysit/` wrapping `gh` + `loop`. |
| Cursor `/create-skill` (built-in) | `plugin-dev:skill-development` skill | Claude Code's authoring guidance for SKILL.md. |
| `cursor-team-kit` `/deslop` | This plugin's `deslop` skill | Ported in (only team-kit skill imported). |
| `cursor-team-kit` `control-cli` | `run` skill (Claude Code built-in) | Drives CLIs/TUIs. |
| `cursor-team-kit` `control-ui` | `verify` skill (Claude Code built-in, VS Code extension) | Drives UIs (browser/Electron). |
| `~/.cursor/projects/*/` transcripts | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `<encoded-cwd>` is the workspace's working directory with `/` → `-`. |
| Cursor `agent-transcripts/` dir | `~/.claude/projects/<encoded-cwd>/` | Same as above. |
| `.cursor/skills/`, `~/.cursor/skills/`, `~/.cursor/plugins/` | `.claude/skills/`, `~/.claude/skills/`, `~/.claude/plugins/` | Path-only translation. |
| Cursor `mcps/` directory | Tool list at top of system prompt (`mcp__<server>__<name>` prefixed entries), or `.mcp.json`, or `claude mcp list` | Discovery surface differs. |
| Model: `composer-2.5-fast` | `claude-sonnet-4-6` | Fast workhorse Claude. |
| Model: `claude-opus-4-X-thinking-xhigh` | `claude-opus-4-8` (with note "extended thinking" where it appeared in a table) | Claude Code uses model IDs without the Cursor UI suffix; extended thinking is a separate knob. Originally substituted to `4-7`, then bumped to `4-8` to match the current Claude family. |
| Model: `gpt-5.3-codex-high-fast`, `gpt-5.5-high-fast` | `claude-sonnet-4-6`, `claude-haiku-4-5` | Within Claude Code, cross-vendor diversity isn't native. Skills that need a harsher pass now route to the bundled `thermo-nuclear-code-quality-review` skill (imported from cursor-team-kit) as the escape hatch. Different style of pressure (strict maintainability rubric), not vendor diversity. |

## New / imported files

- `skills/babysit/SKILL.md` — Claude Code analog of Cursor's `/babysit`. Wraps `gh pr view` / `gh pr checks` / `gh run view --log-failed` plus the `loop` skill for pacing. Provenance: independently authored; workflow informed by Cursor's public `/babysit` behavior. Not a copy of Cursor's closed-source implementation.
- `commands/babysit.md` — slash command routing to the babysit skill.
- `skills/thermo-nuclear-code-quality-review/SKILL.md` — imported verbatim from `cursor-team-kit`. Used as the harsher-critique escape hatch in `arena`, `interrogate`, `architect`, and `how` (replaces the Cursor-original cross-vendor bridge).
- `commands/thermo-nuclear-code-quality-review.md` — slash command stub.
- `skills/make-pr-easy-to-review/`, `skills/fix-ci/`, `skills/fix-merge-conflicts/`, `skills/get-pr-comments/`, `skills/what-did-i-get-done/` — five more skills imported verbatim from `cursor-team-kit`. Audited for Cursor-specific refs; none found, so no rewiring needed. They use only `gh` and `git` primitives.
- `commands/make-pr-easy-to-review.md`, `commands/fix-ci.md`, `commands/fix-merge-conflicts.md`, `commands/get-pr-comments.md`, `commands/what-did-i-get-done.md` — slash command stubs.
- `.claude-plugin/marketplace.json` — marketplace manifest so the repo is installable via `/plugin marketplace add michael-denyer/pstack-claude`. Declares `allowCrossMarketplaceDependenciesOn: ["claude-plugins-official"]` so the cross-marketplace dependency on `plugin-dev` resolves at install time.
- `plugin.json` `dependencies` — declares `plugin-dev` (from `claude-plugins-official` marketplace) as a required dependency, since the rewiring routes skill-authoring tasks to `plugin-dev:skill-development`.

## Per-skill changes applied

### `skills/poteto-mode/SKILL.md`

- Triggers section: `create-skill` → `plugin-dev:skill-development`; `deslop` "from `cursor-team-kit`" qualifier dropped; `control-cli`/`control-ui` line replaced with `run`/`verify` driver guidance; `Cursor's built-in **babysit**` → this plugin's `babysit`.
- Subagents section: `Task` → `Agent`; `composer-2.5-fast` → `claude-sonnet-4-6`; `claude-opus-4-8-thinking-xhigh` → `claude-opus-4-8`; "agent mode (readonly strips MCP)" → "full tool access (do not pick a subagent_type that strips MCP)".

### `skills/poteto-mode/references/plan.md`

- `AskQuestion` → `AskUserQuestion`.
- `generalPurpose` → `"general-purpose"`; built-in `plan` subagent_type → Claude Code's built-in `Plan` agent; both model slugs updated.
- `create-skill` → `plugin-dev:skill-development`.
- `control-ui` / `control-cli` lines replaced with `verify` / `run` driver skills.
- "Cursor's built-in **babysit** skill" → "the **babysit** skill".

### `skills/poteto-mode/playbooks/`

- `authoring-a-skill.md`: `create-skill` → `plugin-dev:skill-development`.
- `autonomous-run.md`: "Cursor's `/loop` command (a built-in, not a pstack skill)" → "Claude Code's `loop` skill (built-in)".
- `bug-fix.md`, `feature.md`, `perf-issue.md`: `composer-2.5-fast` → `claude-sonnet-4-6`; "control skill" → "driver skill (`run` for CLIs/TUIs, `verify` for UIs)".
- `eval.md`: `agent-transcripts/` + `~/.cursor/projects/*/` → `~/.claude/projects/<encoded-cwd>/*.jsonl`.
- `opening-a-pr.md`: `Task` → `Agent`; "Cursor's built-in **babysit** skill" → "the **babysit** skill".
- `prototype.md`, `runtime-forensics.md`, `visual-parity.md`: "control skill" → "driver skill" with `run`/`verify` explicit.

### `skills/automate-me/SKILL.md`

- Description and body: `create-skill` (6 places) → `plugin-dev:skill-development`.
- `AskQuestion` (2 places) → `AskUserQuestion`.
- `.cursor/skills/` / `~/.cursor/skills/` → `.claude/skills/` / `~/.claude/skills/`.
- `agent-transcripts/` + `~/.cursor/projects/*/` → `~/.claude/projects/<encoded-cwd>/*.jsonl`.

### `skills/reflect/SKILL.md` + `references/*.md`

- Transcript paths → `~/.claude/projects/<encoded-cwd>/*.jsonl`.
- `Task` → `Agent` (in SKILL.md and all three reviewer references).
- `generalPurpose` → `"general-purpose"`; `readonly: false` + "agent mode" → "pick a subagent_type that retains MCP access".
- Model slugs updated (`composer-2.5-fast` → `claude-sonnet-4-6`; `claude-opus-4-8-thinking-xhigh` → `claude-opus-4-8`).
- `create-skill` (3 routing rules) → `plugin-dev:skill-development`.
- Reference files: `.cursor/skills/`, `~/.cursor/skills/`, `~/.cursor/plugins/` → `.claude/...`, `~/.claude/...`.

### `skills/why/SKILL.md`

- MCP discovery: Cursor environment / `mcps/` directory → Claude Code tool list / `.mcp.json` / `claude mcp list`.
- `generalPurpose` → `"general-purpose"`; readonly/agent-mode language → "pick a subagent_type that retains MCP access".
- Model slugs updated.

### `skills/how/SKILL.md`

- `generalPurpose` → `"general-purpose"` (all 4 occurrences).
- `composer-2.5-fast` → `claude-sonnet-4-6` (replace_all).
- `claude-opus-4-8-thinking-xhigh` → `claude-opus-4-8` (replace_all for inline; table cell updated separately).
- Critic model table: GPT slugs → Claude family; added note about bridging to `/gsd-review` for cross-vendor critique.
- `readonly: true` lines dropped from subagent config blocks.

### `skills/interrogate/SKILL.md`

- `Task tool` → `Agent` tool.
- Reviewer model table: `claude-opus-4-8-thinking-xhigh` / `gpt-5.3-codex-high-fast` / `gpt-5.5-high-fast` / `composer-2.5-fast` → Claude family variants.
- `generalPurpose` → `"general-purpose"`; `readonly: true` dropped.
- Added cross-vendor-bridge note (`/gsd-review`).

### `skills/arena/SKILL.md`

- Default 3 runners: GPT/composer slugs → Claude family. Added cross-vendor-bridge note.

### `skills/architect/SKILL.md`

- Phase B runner slugs: GPT/composer → Claude family. Added cross-vendor-bridge note.

### `skills/show-me-your-work/SKILL.md`

- Transcript audit path: `agent-transcripts/` + `~/.cursor/projects/*/` → `~/.claude/projects/<encoded-cwd>/*.jsonl`.

## Deliberately not changed

- **`claude-opus-4-8` model ID.** Already a valid Claude model; no edit needed beyond stripping the Cursor `-thinking-xhigh` UI suffix. Extended thinking is configured separately, not as a model variant.
- **`/loop`, `/deslop`, `/babysit` slash references.** These all resolve in Claude Code now (`loop` is a built-in skill; `deslop` and `babysit` ship in this plugin).
- **`run_in_background: true`.** Claude Code's `Agent` tool supports this — kept as-is.
- **"currently open files, recent edits, the cursor location"** in `why/SKILL.md` (line 59). "Cursor location" here means editor cursor (caret position), not the IDE; generic phrasing, no edit.
- **`poteto-agent` subagent ID.** Plugin ships this agent; references stay.
- **Cursor's `/create-skill` writing style guidance referenced indirectly.** Pointed at `plugin-dev:skill-development` which covers the same ground in Claude Code. If you want stricter parity, also install Anthropic's `superpowers:writing-skills` skill.

## Forking note

This port now diverges from upstream pstack content. To track upstream:

```bash
# diff against the pinned commit
diff -ru /tmp/pstack-src/pstack/skills/ skills/  # caveats: ignores the babysit/ and deslop/ dirs
```

If you want a clean re-port (e.g. when upstream releases v0.2.0), the rebuild recipe is:

1. Copy upstream skills verbatim.
2. Re-apply the substitution table above (most of it is mechanical find/replace).
3. Re-add `skills/babysit/`, `commands/babysit.md`, and the cursor-team-kit `deslop` import.

## Provenance

- Upstream pstack: [cursor/plugins/pstack @ e46364b](https://github.com/cursor/plugins/tree/e46364b8be46000b7df0f260550cd712afbb8d36/pstack) — MIT, (c) 2026 Lauren Tan.
- Upstream deslop: [cursor/plugins/cursor-team-kit/skills/deslop @ e46364b](https://github.com/cursor/plugins/tree/e46364b8be46000b7df0f260550cd712afbb8d36/cursor-team-kit/skills/deslop) — MIT, (c) 2026 Cursor.
- babysit: independently authored; workflow informed by Cursor's public `/babysit` behavior — no code or prose copied.
- Inspected for prior-art decisions: [v1truv1us/ai-eng-system](https://github.com/v1truv1us/ai-eng-system) (namespaces pstack under `pstack/` but keeps Cursor refs intact); [Evan-Kim2028/agent-fleet](https://github.com/Evan-Kim2028/agent-fleet) (vendors pstack under `base-kit/pstack/`, same posture).
