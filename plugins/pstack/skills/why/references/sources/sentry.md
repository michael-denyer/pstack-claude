# Sentry Error History

## What this source contains

Sentry is the archive of things that actually went wrong. For defensive, corrective, or error-handling code, Sentry often holds the direct motivation: the specific exceptions, stack traces, and frequencies that pushed someone to add a check, catch, retry, or fallback.

Relevant content:

- **Issues.** Grouped errors with counts, first/last seen timestamps, affected releases, and comments
- **Events.** Individual error instances within an issue (stack traces, tags, user context)
- **Releases.** Deployment records with associated issues (useful for "which version fixed this?")
- **Replays.** Session recordings of user-facing errors (if enabled)
- **Profiles.** Performance profiling data (less useful for "why" questions; more for "how slow")
- **Issue comments & assignments.** Sometimes contain engineer notes on root cause

The most valuable thing Sentry provides is **temporal correlation**: "issue X was created 2024-01-02, peaked at 500 events/day, stopped appearing after release v2.14.0 on 2024-01-15, which is the release that shipped the defensive check."

## How to search it

Use the Sentry MCP available in your environment.

1. **Orient.** If you don't already know the project slug and organization, use:

   ```
   find_organizations
   find_projects
   ```

2. **Search for issues related to the target.**

   ```
   search_issues (natural language, e.g., "errors in PaymentService timeout", "unhandled exceptions in uploadFile")
   ```

   Good query components:
   - Exception class names the target handles
   - Function or class name of the target
   - Error message strings the target checks for
   - File path of the target

3. **Narrow by release and time window.**

   ```
   search_issue_events (filter by release, time, environment, trace ID, tags)
   get_issue_tag_values (for a specific issue, see how it's distributed across versions, users, environments)
   ```

   When you have a suspected issue, check:
   - **First seen.** When did this error start appearing?
   - **Last seen.** When did it stop? Does it line up with the target's ship date?
   - **Affected releases.** Which versions saw the issue? Which was the fix?
   - **Frequency trajectory.** Did it spike, then get resolved?

4. **Pull the full event for context.**

   ```
   get_sentry_resource (pass a Sentry URL or type+ID)
   ```

   Look at the stack trace. Does it pass through the target code? Look at tags and breadcrumbs. Do they match the conditions the target defends against?

5. **Check releases that landed near the target.**

   ```
   find_releases (around the commit date of the target)
   ```

   Cross-reference release version with the PR's merge date.

6. **Use Seer sparingly.**

   ```
   analyze_issue_with_seer
   ```

   Seer produces AI root-cause analyses. They're useful as a hypothesis generator, but treat them as another source of inference, not as authoritative. The actual events and stack traces are the primary evidence; Seer's narrative is secondary.

## What good evidence looks like here

- An issue whose **first seen** is shortly before the target's PR, and **last seen** shortly after, suggesting the target addressed this error
- Stack traces that pass through or land on the target function, showing the exact failure mode being defended against
- A comment on the issue from the PR author describing the fix
- The target's PR description or commit message referencing a Sentry issue URL or ID
- An issue with high event counts that stops after the release containing the target

## Common pitfalls

- **Grouping drift.** Sentry groups errors by fingerprint. Changes to the code (e.g., refactors, renames) can cause the "same" error to be tracked under a new issue ID. If an issue ends abruptly, the error may have just been regrouped. Check for new issues immediately after.
- **Release correlation is noisy.** A release contains many commits. An issue stopping at v2.14.0 doesn't prove the target code fixed it. Another change in the same release might have. Cross-reference with the target's exact commit.
- **Silent fixes.** Sometimes the error stops because upstream changed, not because of the defensive code. The correlation suggests the fix; it doesn't prove authorship.
- **Resolved != fixed.** Issues in Sentry can be marked "resolved" manually without any code change. Treat `resolved` as a human marker, not as evidence that code fixed it.
- **Seer hallucinations.** Seer can generate confident-sounding explanations that aren't right. Always fall back to the actual events, stack traces, and timestamps when making claims.
- **Sampling.** Some projects sample events aggressively. A low event count doesn't mean the error was rare. It may just mean sampling was high. If in doubt, note the gap.

## What to return

For each relevant issue:
- Issue ID and title
- Project and organization
- First seen / last seen timestamps
- Event count (and sampling rate if known)
- Affected releases
- A representative stack trace snippet showing relevance to the target (verbatim excerpt, not summary)
- First/last-seen correlation with the target's ship date
- Link to the issue
- Any author comments or resolution notes
