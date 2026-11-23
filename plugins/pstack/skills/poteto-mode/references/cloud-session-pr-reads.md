# Reading a PR from a Claude Code cloud session

A Claude Code cloud session's GitHub proxy refuses GraphQL with HTTP 403. `watch-pr` then exits 7 with a `graphql-refused` failure, `ship-pr inspect` reports `unavailable`, and `gh pr view`, `gh pr list`, `gh pr checks`, and `gh pr merge` fail with the same refusal. The proxy still serves REST for the repositories attached to the session. Use the reads below there, and nowhere else. Where GraphQL works, the watcher stays the source of PR status.

## REST reads

Each command was run in a cloud session with `gh` 2.89.0, most recently on 2026-11-23, except the paginated check-runs, commit statuses, Actions runs, jobs, reviews, and review comments reads, which were run outside one. No read there has yet needed a second page. GitHub's next-page links use `repositories/<id>/` paths, not `repos/<owner>/<repo>/`, and whether the proxy serves them is untested. So when a paginated read reports `total_count`, check that it returned that many rows.

| Fact                                | Command                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| State, draft, mergeability, head    | `gh api "repos/<owner>/<repo>/pulls/<pr>"`                                                       |
| Open PR for a branch                | `gh api "repos/<owner>/<repo>/pulls?head=<owner>:<branch>&state=open"`                           |
| Check runs on the head              | `gh api --paginate --slurp "repos/<owner>/<repo>/commits/<head-sha>/check-runs?per_page=100"`    |
| Commit statuses on the head         | `gh api --paginate --slurp "repos/<owner>/<repo>/commits/<head-sha>/status?per_page=100"`        |
| Check suites on the head            | `gh api --paginate --slurp "repos/<owner>/<repo>/commits/<head-sha>/check-suites?per_page=100"`  |
| Actions runs on the head            | `gh api --paginate --slurp "repos/<owner>/<repo>/actions/runs?head_sha=<head-sha>&per_page=100"` |
| Jobs and steps of an Actions run    | `gh api --paginate --slurp "repos/<owner>/<repo>/actions/runs/<run-id>/jobs?per_page=100"`       |
| Log of one Actions job              | `gh api "repos/<owner>/<repo>/actions/jobs/<job-id>/logs"`                                       |
| Summary of an Actions run           | `gh run view <run-id>`                                                                           |
| Log of an Actions run               | `gh run view <run-id> --log`                                                                     |
| Recent Actions runs                 | `gh run list`                                                                                    |
| Reviews                             | `gh api --paginate --slurp "repos/<owner>/<repo>/pulls/<pr>/reviews?per_page=100"`               |
| Review comments                     | `gh api --paginate --slurp "repos/<owner>/<repo>/pulls/<pr>/comments?per_page=100"`              |
| Review threads and their resolution | `gh api "repos/<owner>/<repo>/pulls/<pr>/ccr/review_threads"`                                    |

A `--paginate --slurp` read prints one JSON array holding every page, so take the rows from each page: `.[].check_runs[]`, `.[].statuses[]`, `.[].check_suites[]`, `.[].workflow_runs[]`, `.[].jobs[]`, or `.[][]` for reviews and review comments. Every page of the commit statuses read repeats the combined `state` across all statuses, `success`, `failure`, or `pending`, so read it from `.[0].state`. A commit with no statuses (`.[0].total_count` is 0) still reports `pending`, so judge it by its check runs alone. `gh` refuses `--jq` with `--slurp`, so pipe the output to `jq`. Without `--paginate`, a list read returns only its first page.

Read `head.sha`, `draft`, `mergeable`, and `mergeable_state` from the first command. `mergeable` is `null` until GitHub computes it, so read again before you trust it.

`gh pr checks` lists both check runs and commit statuses, so read both. A check run is pending until its `status` is `completed`. Its `conclusion` then gives the result: `success` passes; `failure`, `timed_out`, and `action_required` fail; `cancelled`, `skipped`, and `neutral` neither pass nor fail. A commit status carries its result in `state`: `success`, `failure` or `error`, or `pending`. For an Actions check, `details_url` ends in `actions/runs/<run-id>/job/<job-id>`. GitHub answers a log read with HTTP 410 once the log has expired.

`ccr/review_threads` is a route of the cloud session's proxy, not of GitHub's REST API. It returns one object for each thread, with `resolved`, `outdated`, `path`, `line`, and `comment_ids`. Match `comment_ids` to the review comments to read a thread's text.

## Limits

- These reads are single snapshots. Nothing here replaces the watcher's rereads, its merge gates, or its check for a head that moved between reads. Reread the PR's head after the other reads, and start again when it changed.
- Shipping and the merge-safety operations cannot run in a cloud session, because `ship-pr` and `gh pr merge` need GraphQL.
- A repository the session has not attached answers every REST read with HTTP 403.
