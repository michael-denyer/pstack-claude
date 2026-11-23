---
name: fix-ci
description: Find failing PR checks, inspect logs or external check links, and apply focused fixes
---

# Fix CI

## Trigger

Branch or PR CI is failing and needs a fast, iterative path to green checks.

## Workflow

1. Resolve the active PR and inspect `gh pr checks --json name,bucket,state,workflow,link`.
2. Inspect failed jobs and extract the first actionable error. Use GitHub Actions logs when available; otherwise use the check link to identify the failing command or service.
3. Apply the smallest safe fix.
4. Push, re-check the PR check set, and repeat until green.

## Guardrails

- Fix one actionable failure at a time.
- Prefer minimal, low-risk changes before broader refactors.
- Keep `gh pr checks` as the source of truth for overall PR CI state.
- When `gh pr checks` fails with a GraphQL refusal, as in a Claude Code cloud session, read the check runs and commit statuses on the PR's head with the REST commands in [Reading a PR from a Claude Code cloud session](../poteto-mode/references/cloud-session-pr-reads.md), and treat the two together as the source of truth there.

## Output

- Primary failing job and root error
- Fixes applied in iteration order
- Current CI status and next action
