# Reading a PR from a Claude Code cloud session

A Claude Code cloud session's GitHub proxy refuses GraphQL with HTTP 403. `watch-pr` then exits 7 with a `graphql-refused` failure, and `gh pr view`, `gh pr list`, and `gh pr checks` fail with the same refusal. The proxy still serves REST for the repositories attached to the session. Use the reads below there, and nowhere else. Where GraphQL works, the watcher stays the source of PR status.

## REST reads

Each command was run in a cloud session on 2026-11-21 with `gh` 2.89.0.

| Fact                                | Command                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| State, draft, mergeability, head    | `gh api "repos/<owner>/<repo>/pulls/<pr>"`                                                      |
| Open PR for a branch                | `gh api "repos/<owner>/<repo>/pulls?head=<owner>:<branch>&state=open"`                          |
| Check runs on the head              | `gh api "repos/<owner>/<repo>/commits/<head-sha>/check-runs"`                                   |
| Commit statuses on the head         | `gh api "repos/<owner>/<repo>/commits/<head-sha>/status"`                                       |
| Check suites on the head            | `gh api --paginate --slurp "repos/<owner>/<repo>/commits/<head-sha>/check-suites?per_page=100"` |
| Actions runs on the head            | `gh api "repos/<owner>/<repo>/actions/runs?head_sha=<head-sha>"`                                |
| Reviews                             | `gh api "repos/<owner>/<repo>/pulls/<pr>/reviews"`                                              |
| Review comments                     | `gh api "repos/<owner>/<repo>/pulls/<pr>/comments"`                                             |
| Review threads and their resolution | `gh api "repos/<owner>/<repo>/pulls/<pr>/ccr/review_threads"`                                   |

Read `head.sha`, `draft`, `mergeable`, and `mergeable_state` from the first command. `mergeable` is `null` until GitHub computes it, so read again before you trust it.

`ccr/review_threads` is a route of the cloud session's proxy, not of GitHub's REST API. It returns one object for each thread, with `resolved`, `outdated`, `path`, `line`, and `comment_ids`. Match `comment_ids` to the review comments to read a thread's text.

## Limits

- These reads are single snapshots. Nothing here replaces the watcher's rereads, its merge gates, or its check for a head that moved between reads. Reread the PR's head after the other reads, and start again when it changed.
- `ship-pr` reads the PR through GraphQL, so Shipping and the merge-safety operations cannot run in a cloud session.
- A repository the session has not attached answers every REST read with HTTP 403.
