---
name: babysit
description: Watch an open PR — fix failing CI, handle the straightforward review comments, and drive it to a mergeable state. Claude Code analog of Cursor's built-in /babysit. Use after opening a PR when the user wants the agent to shepherd it without re-prompting.
---

# Babysit a PR

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

On Antigravity, read the [platform mapping](../poteto-mode/references/agy-tools.md), including its per-skill notes, before following this skill.

Claude Code analog of Cursor's built-in `/babysit`. The implementation is a loop over `gh` CLI plus the Claude Code `loop` skill for pacing.

Inside poteto-mode, the **Babysit** playbook ([`../poteto-mode/playbooks/babysit.md`](../poteto-mode/playbooks/babysit.md)) supersedes this skill: it owns mode declaration, the merge frontier, stack safety, and the `watch-pr` watcher. This skill stays the standalone `/babysit` entry point for a single PR outside a poteto-mode run.

## When to use

- There's an open PR and the user explicitly wants it kept green, and you are not already inside a poteto-mode run (the playbook owns that case).
- The user invokes `/babysit` directly.
- A subagent that opens a PR does NOT babysit — return to the parent and let the parent decide.

## Steps

1. **Fetch PR state.**

   ```bash
   gh pr view <number> --json number,title,state,mergeable,reviewDecision,statusCheckRollup,mergeStateStatus,comments,reviews
   ```

   When `gh pr view` fails with a GraphQL refusal, as in a Claude Code cloud session, take status from the watcher at `skills/poteto-mode/scripts/watch-pr/watch-pr` under the installed plugin, with `--owner <owner> --repo <repo> --pr <number> --status-only`. It reads the PR over REST there. In the row of its JSON, a conflict is `facts.mergeable` `CONFLICTING`, failing checks are listed in `ci.failed`, and unresolved review threads are in `threads`. Read comments, reviews, and CI logs with the REST commands in [Reading a PR from a Claude Code cloud session](../poteto-mode/references/cloud-session-pr-reads.md).

2. **Triage in priority order.**
   - Merge conflicts (`mergeStateStatus == DIRTY`): run the **fix-merge-conflicts** skill. Force-push only if the branch is yours and not shared.
   - Failing checks (`statusCheckRollup` entries with `conclusion: FAILURE`): run the **fix-ci** skill. Root-cause the failure; fix the underlying code or test; commit; push.
   - Review comments: run the **get-pr-comments** skill for the summary, then act only on feedback you actually agree with. When a comment has a single mechanical answer — a rename, a guard clause, a formatting nit — make the edit and quote the comment in the commit message. When it hinges on a judgement call, or you can't tell what's being asked, don't guess: leave it and reply with what you would have done.
   - Review-bot comments (Bugbot and similar automation): classify fix/dismiss/ask before acting, per [`bugbot-triage.md`](../poteto-mode/references/bugbot-triage.md). Ask by default on security, data, and high-severity findings.

3. **Loop.** Use the Claude Code `loop` skill to pace re-checks. Pick the interval from what you're watching:
   - Active CI run: poll `gh pr checks --watch` (it blocks until checks finish, so no separate loop interval needed). In a cloud session, where `gh pr checks` fails the same way, re-run the watcher's `--status-only` read every few minutes while its `ci.kind` is `ci-pending` or `ci-unreported`. Its default mode is no substitute here, because it exits at an open thread or a merge gate without waiting for the checks.
   - Awaiting reviewer: 20–30 min heartbeat.
   - Idle but want to catch new comments: hourly.

4. **When to stop.**
   - Build is green, every comment resolved, branch merges cleanly → call it ready.
   - You've run three rounds of fix → push → recheck and it still isn't fully green → stop, summarise what's still broken, and hand control back.
   - The next fix would force a design choice → pause and put it to the user with `AskUserQuestion`.

5. **Report.** Summarize fixes applied, comments addressed, comments deferred (with reason), current PR status. Cite each commit by SHA.

## Hard rules

- Don't rewrite history on a branch others may have pulled. If a rebase or force-push looks necessary, clear it with the user first.
- Don't tweak a test's expected values just to get a pass. Only change an assertion when the behaviour genuinely changed and the assertion was pinned to the old behaviour.
- Never skip hooks (`--no-verify`).
- Never bypass a failing check by marking it as not required.
- `gh pr ready` only when all checks are green and no unresolved review comments remain. In a cloud session, where `gh pr ready` fails the same way, mark the PR ready under the same condition with `gh api --method POST "repos/<owner>/<repo>/pulls/<number>/ccr/ready_for_review"`, a route of the session's proxy.

## Cross-refs

- Opening a PR does not start a babysit; inside poteto-mode the Babysit playbook owns the request and starts only when asked.
- Use `interrogate` before opening if the diff is contested; once open, babysit takes over.
- Use `unslop` on any prose you write here (PR comments, commit messages, status reports).

## Provenance

This is a Claude Code analog of Cursor's `/babysit`, not a port — Cursor's implementation is closed source. The skill is independently authored, with its own prose and structure; the workflow is informed by Cursor's public `/babysit` behavior. The only overlap with other PR tools is the `gh` CLI commands it runs, which are functional invocations rather than copied text.
