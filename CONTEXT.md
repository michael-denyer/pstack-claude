# CONTEXT — domain glossary

Names for the concepts this repo's design discussions keep reaching for. Architecture reviews use these terms; if a review needs a concept that isn't here, add it.

- **Build** — one of the runtimes the plugin ships to: the Claude Code build (`.claude-plugin/`), the Codex build (`.codex-plugin/`), and the Prime path (`~/.agents/skills/` symlinks). All builds share one `skills/` tree; each build is an adapter over it.
- **Model policy** — the mapping from roles to model slugs. Defaults live in `plugins/pstack/models.json` and are stamped into each skill's Models section; the user's override sheet (`~/.claude/pstack-models.md`, written by `setup-pstack`) is the layer that adapts them at runtime.
- **Role** — a named unit of delegated work with its own model choice (`arena runners`, `how critics`, `swarm workers`). The role vocabulary lives in `models.json` and surfaces in `setup-pstack`'s sheet.
- **Panel** — the three-model diverse panel the multi-model skills (`arena`, `architect`, `interrogate`, `how`) run by default. One fact in `models.json`; the generator stamps every copy and fails on strays.
- **Prompt stub** (or trampoline) — a file under `.codex-plugin/prompts/` whose body invokes its skill. Codex-only, generated from the skill's `menu-description`; the Claude Code build serves slash commands from skills directly.
- **Menu description** — the `menu-description:` frontmatter one-liner every public skill carries. Renders as the Codex slash-menu text and the README command-table row; the long `description:` stays the trigger-matching prose.
- **Generator** — `tools/generate.mjs`. Stamps facts from their single source into every committed copy and validates cross-file contracts. CI reruns it and fails on any diff.
- **Generator-owned copy** — a committed value the generator writes (the `version` field in the three manifests, the prompt stubs, the README slash-command table, every Models section). Hand edits are reverted by the next regeneration and caught by CI.
- **VERSION** — the repo-root file holding the canonical plugin version. Releases edit it, add the matching `CHANGES.md` heading, and regenerate; plugin auto-update installs by this number.
- **Sync boundary** — the split between what upstream pstack owns (skill content) and what this port owns (Cursor-to-Claude-Code translation). Defined in [CONTRIBUTING.md](CONTRIBUTING.md); enforced by `tools/sync.mjs`, whose substitution table and denylist live in `tools/substitutions.json`.
- **Upstream pin** — the per-component upstream SHA in `tools/upstream.json` that the port is synced to. `sync.mjs` advances it only when a sync completes without denylist hits.
- **Invariant script** — `tests/skill-collision-repro.sh`. The repo's check seam: static layout/flag invariants (one named function each, run through `check`) plus a behavioral leg that needs the `claude` CLI. `tests/invariants.test.mjs` proves each static check can fail, against fixture trees.
