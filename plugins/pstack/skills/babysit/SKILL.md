---
name: babysit
description: Monitor an open PR, fix CI failures, address clear review comments, and keep it merge-ready. Claude Code analog of Cursor's built-in /babysit. Use after opening a PR when the user wants the agent to keep driving it without re-prompts.
---

# Babysit a PR

Claude Code analog of Cursor's built-in `/babysit`. The implementation is a loop over `gh` CLI plus the Claude Code `loop` skill for pacing.

## When to use

- A PR is open and the user explicitly wants the agent to keep it green.
- The poteto-mode opening-a-pr playbook routes here after `gh pr create`.
- A subagent that opens a PR does NOT babysit — return to the parent and let the parent decide.

## Steps

1. **Fetch PR state.**

   ```bash
   gh pr view <number> --json number,title,state,mergeable,reviewDecision,statusCheckRollup,mergeStateStatus,comments,reviews
   ```

2. **Triage in priority order.**
   - Merge conflicts (`mergeStateStatus == DIRTY`): rebase or merge `main`; resolve; force-push only if the branch is yours and not shared.
   - Failing checks (`statusCheckRollup` entries with `conclusion: FAILURE`): pull logs with `gh run view <run-id> --log-failed`. Root-cause the failure; fix the underlying code or test; commit; push.
   - Review comments (`gh pr view --json comments,reviews`): act only on feedback you agree with. For clear fixes (typo, naming, missing null check, style), apply and commit with a message that names the comment. For anything design-shaped or unclear, leave it for the user and write what you would have done in a reply.

3. **Loop.** Use the Claude Code `loop` skill to pace re-checks. Pick the interval from what you're watching:
   - Active CI run: poll `gh pr checks --watch` (it blocks until checks finish, so no separate loop interval needed).
   - Awaiting reviewer: 20–30 min heartbeat.
   - Idle but want to catch new comments: hourly.

4. **Stop conditions.**
   - All checks green, no unresolved comments, no conflicts → report ready.
   - 3 fix-push-check cycles attempted without full resolution → report what's still failing and hand back.
   - A fix requires a design decision → ask the user via `AskUserQuestion`.

5. **Report.** Summarize fixes applied, comments addressed, comments deferred (with reason), current PR status. Cite each commit by SHA.

## Hard rules

- Never force-push to a shared PR branch. If history needs rewriting, ask first.
- Never modify a test assertion to make a test pass unless the behavior change was intentional and the test was tracking the old behavior.
- Never skip hooks (`--no-verify`).
- Never bypass a failing check by marking it as not required.
- `gh pr ready` only when all checks are green and no unresolved review comments remain.

## Cross-refs

- `poteto-mode` opens here after a PR is opened.
- Use `interrogate` before opening if the diff is contested; once open, babysit takes over.
- Use `unslop` on any prose you write here (PR comments, commit messages, status reports).

## Provenance

This is a Claude Code analog of Cursor's `/babysit`, not a port — Cursor's implementation is closed source. The skill is independently authored; the workflow is informed by Cursor's public `/babysit` behavior. No code or prose was copied from any source.
