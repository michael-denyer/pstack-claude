# CHANGES — applied substitutions

This port applies the Cursor → Claude Code substitutions in skill bodies. Earlier drafts left them flagged; this revision resolves them.

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

- Default 4 runners: GPT/composer slugs → Claude family. Added cross-vendor-bridge note.

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
