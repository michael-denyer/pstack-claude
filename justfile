set shell := ["bash", "-euo", "pipefail", "-c"]

# List the recipes.
default:
    @just --list

# Install the pinned tools and the root Bun dependencies.
install:
    mise install
    bun install --frozen-lockfile

# Validate generated files and plugin invariants, as CI's first job does.
generate:
    bun tools/generate.mjs --check

# Format the vendored tooling that upstream formats.
fmt:
    cd plugins/pstack/skills/poteto-mode/scripts && bun x prettier@3.6.2 --write .

# Fail if that tooling needs formatting.
fmt-check:
    cd plugins/pstack/skills/poteto-mode/scripts && bun x prettier@3.6.2 --check .

# Lint the workflows and shell scripts.
lint: lint-workflows lint-shell

lint-workflows:
    actionlint
    zizmor --persona pedantic --min-severity low .github/workflows

lint-shell:
    #!/usr/bin/env bash
    set -euo pipefail
    find . -path ./.git -prune -o -path '*/node_modules' -prune -o -name '*.sh' -print |
        sed 's#^\./##' | sort | xargs shellcheck --severity=warning

# Type-check the vendored tooling. The Pi extension needs the Pi package and
# runs only in CI (see AGENTS.md).
typecheck:
    cd plugins/pstack/skills/poteto-mode/scripts && bun install --frozen-lockfile && bun run typecheck

# Run the test suite.
test:
    bun test tests/

# Check the agent skill files: frontmatter, recipes and the .claude symlinks.
agent-files:
    bun scripts/agent-files.ts

# Install the repository-local pre-push guard without changing global settings.
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    existing=$(git config --get core.hooksPath || true)
    if [[ -n "$existing" && "$existing" != .githooks ]]; then
        printf 'Existing hooks path differs; integrate manually rather than replacing it.\n' >&2
        exit 1
    fi
    chmod +x .githooks/pre-push
    git config --local core.hooksPath .githooks
    printf 'Repository-local pre-push guard enabled. No global settings changed.\n'

# Everything that runs locally from the checks upstream's CI requires.
check: fmt-check generate lint typecheck test agent-files
