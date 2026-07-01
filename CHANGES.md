# CHANGES — applied substitutions

This port applies the Cursor → Claude Code substitutions in skill bodies. Earlier drafts left them flagged; this revision resolves them. A later pass added a Codex build that shares the same skills; see [Codex port](#codex-port) below.

## 0.9.6 — hook hardening and duplication trims (thermo-nuclear review)

A strict maintainability review of the 0.9.3–0.9.5 range drove these:

- `hooks/session-start` collapsed from 43 lines to 3: SessionStart hook stdout reaches context directly (per the hooks docs; verified end-to-end on 2.1.197), so the JSON envelope, the `escape_for_json` pass, and the Cursor/Copilot platform branches — dead code here, since `hooks.json` is the only registration — are gone. This also removes a verified failure-path bug: the old `cat ... 2>&1 || echo` fallback was additive, silently injecting raw `cat` stderr plus the fallback string into session context when the context file was unreadable; now a missing file fails the hook cleanly and injects nothing. The script is no longer adapted from superpowers (NOTICE updated; `run-hook.cmd` remains near-verbatim and attributed).
- Panel-quad enumeration trimmed from the `poteto-mode` meta-files (`SKILL.md`, `references/plan.md`, `references/codex-tools.md`) — the slugs now live only in the four panel skills and the `setup-pstack` sheet, with a grep-identical rule added to Maintenance. This drift class already bit once (0.9.4 fixed a three-reviewers-vs-"four different models" mismatch).
- README's desktop-app `dependency-unsatisfied` narrative deduplicated to a two-sentence summary linking the CHANGES 0.9.3 entry.

## Upstream review through `0452e08` (v0.10.0), 2026-07-01

One upstream pstack commit landed after the `e46364b` sync: `0452e08` adds the dormant `automations/benny/` pack (Slack issue triage plus reproduce-and-fix, built on Cursor's event-triggered automations) and bumps upstream to 0.10.0. Deliberately not ported — rationale and revisit criteria in README → What's deliberately not ported. `cursor-team-kit` has no commits since the sync point (its latest, `679fdaf`, 2026-05-28, predates `e46364b`). The port's skill tree therefore matches upstream HEAD for every registered skill.

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

**Maintenance.** The plugin version string now lives in three manifests: `plugins/pstack/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `plugins/pstack/.codex-plugin/plugin.json`. A version bump must update all three. `.agents/plugins/marketplace.json` carries no version field. The default panel quad is enumerated only in the four panel skills (`arena`, `architect`, `how`, `interrogate`) and the `setup-pstack` sheet — keep those lines grep-identical when models change; `poteto-mode` and its references deliberately do not enumerate it. `hooks/session-start-context.md` restates skill one-liners — re-verify it whenever skill names or descriptions change.

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
