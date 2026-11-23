// A Claude Code cloud session's GitHub proxy refuses GraphQL and serves REST.
// FallbackGitHubReader reads through GraphQL until the first refusal, then
// through CloudSessionReader for the rest of the process. The cloud reader
// turns each REST answer into the shape the other reader parses, the GraphQL
// response or gh pr checks' JSON, so one parser checks both. Where REST cannot
// say what GraphQL would, it answers the way that keeps the watcher from
// reporting ready.
import type { WatchDeadline } from "./deadline.ts";
import {
  GhGitHubReader,
  parseFastCheck,
  parsePullRequest,
  parseReviewThreadPage,
  run,
  runJson,
} from "./github.ts";
import {
  GRAPHQL_REFUSAL,
  isRecord,
  missing,
  WatcherQueryError,
} from "./query-error.ts";
import type * as T from "./types.ts";
import { parsePrNumber } from "./types.ts";

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) missing(path, value);
  return value;
}
function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) missing(path, value);
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== "string") missing(path, value);
  return value;
}

const refused = (error: unknown): boolean =>
  error instanceof WatcherQueryError &&
  error.failure.kind === "graphql-refused";

export class FallbackGitHubReader implements T.GitHubReader {
  private cloudSession = false;
  constructor(
    private readonly graphql: T.GitHubReader,
    private readonly cloud: T.GitHubReader
  ) {}
  private async read<R>(
    call: (reader: T.GitHubReader) => Promise<R>
  ): Promise<R> {
    if (this.cloudSession) return call(this.cloud);
    try {
      return await call(this.graphql);
    } catch (error) {
      if (!refused(error)) throw error;
      this.cloudSession = true;
      return call(this.cloud);
    }
  }
  originRepo() {
    return this.read((reader) => reader.originRepo());
  }
  currentPr(pr: T.PrNumber | null) {
    return this.read((reader) => reader.currentPr(pr));
  }
  pullRequest(context: T.PrContext) {
    return this.read((reader) => reader.pullRequest(context));
  }
  openPullRequests(repository: T.Repository) {
    return this.read((reader) => reader.openPullRequests(repository));
  }
  defaultBranch(repository: T.Repository) {
    return this.read((reader) => reader.defaultBranch(repository));
  }
  // gh pr checks reports a refusal in its output instead of throwing.
  checksFastPath(context: T.PrContext) {
    return this.read(async (reader) => {
      const fast = await reader.checksFastPath(context);
      if (fast.kind === "unusable" && fast.stderr.includes(GRAPHQL_REFUSAL))
        throw new WatcherQueryError({
          kind: "graphql-refused",
          retryable: false,
          detail: GRAPHQL_REFUSAL,
        });
      return fast;
    });
  }
  checkRollupPage(context: T.PrContext, after: string | null) {
    return this.read((reader) => reader.checkRollupPage(context, after));
  }
  reviewThreadPage(context: T.PrContext, after: string | null) {
    return this.read((reader) => reader.reviewThreadPage(context, after));
  }
  commitRollups(context: T.PrContext) {
    return this.read((reader) => reader.commitRollups(context));
  }
  unsettledSuites(
    context: T.PrContext,
    head: string,
    checksRead: T.CheckRead["kind"],
    expectedApps: readonly string[]
  ) {
    return this.read((reader) =>
      reader.unsettledSuites(context, head, checksRead, expectedApps)
    );
  }
}

// One check as `gh pr checks --json` reports it, which parseFastCheck reads.
interface FastCheck {
  readonly name: string;
  readonly state: string;
  readonly bucket: string;
  readonly link: string;
  readonly workflow: string;
  readonly description: string;
}
// gh's buckets by state; every state it does not name is pending.
const BUCKETS: Readonly<Record<string, string>> = {
  SUCCESS: "pass",
  SKIPPED: "skipping",
  NEUTRAL: "skipping",
  ERROR: "fail",
  FAILURE: "fail",
  TIMED_OUT: "fail",
  ACTION_REQUIRED: "fail",
  CANCELLED: "cancel",
};
const bucketOf = (state: string) => BUCKETS[state] ?? "pending";

// The checks gh pr checks lists for a commit. REST returns every check run,
// including runs a newer workflow run replaced; gh keeps the newest run for
// each name, workflow, and event, and the newest status for each context.
function fastChecks(
  runs: readonly Record<string, unknown>[],
  statuses: readonly Record<string, unknown>[],
  workflowRuns: readonly Record<string, unknown>[]
): readonly FastCheck[] {
  const workflows = new Map(
    workflowRuns.map((run) => [run.check_suite_id, run] as const)
  );
  // gh sorts by start time alone, so its pick on a tie, such as two jobs of one
  // workflow run started in the same second, is arbitrary. Here a tie goes to a
  // run still in flight, then to the run that finished last.
  const unfinished = (run: Record<string, unknown>) =>
    run.status === "completed" ? 0 : 1;
  const newest = [...runs].sort(
    (a, b) =>
      String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")) ||
      unfinished(b) - unfinished(a) ||
      String(b.completed_at ?? "").localeCompare(
        String(a.completed_at ?? "")
      ) ||
      Number(b.id) - Number(a.id)
  );
  const seen = new Set<string>();
  const checks: FastCheck[] = [];
  for (const run of newest) {
    const name = text(run.name, "check run.name");
    const suite = record(run.check_suite, "check run.check_suite").id;
    const workflow = workflows.get(suite);
    // GitHub's rollup leaves out Copilot's code review agent
    // (grafana/grafana#138617) but keeps other dynamic workflows, such as
    // CodeQL default setup (github/docs#47025), so only the agents' path is left out.
    if (String(workflow?.path ?? "").startsWith("dynamic/agents/")) continue;
    const workflowName = workflow === undefined ? "" : String(workflow.name);
    const event = workflow === undefined ? "" : String(workflow.event);
    const key = `${name}/${workflowName}/${event}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = text(
      run.status === "completed" ? run.conclusion : run.status,
      "check run.conclusion"
    ).toUpperCase();
    checks.push({
      name,
      state,
      bucket: bucketOf(state),
      link: typeof run.details_url === "string" ? run.details_url : "",
      workflow: workflowName,
      description: "",
    });
  }
  for (const status of statuses) {
    const state = text(status.state, "status.state").toUpperCase();
    checks.push({
      name: text(status.context, "status.context"),
      state,
      bucket: bucketOf(state),
      link: typeof status.target_url === "string" ? status.target_url : "",
      workflow: "",
      description:
        typeof status.description === "string" ? status.description : "",
    });
  }
  return checks;
}

// The rollup state GitHub's GraphQL reports for a commit. On grafana/grafana
// heads with cancelled runs among gh's checks, GitHub still reported SUCCESS,
// so a cancelled run does not fail the rollup; any other failure does.
function rollupState(checks: readonly FastCheck[]): T.RollupState {
  if (checks.length === 0) return null;
  if (checks.some((check) => check.state === "ERROR")) return "ERROR";
  if (checks.some((check) => check.bucket === "fail")) return "FAILURE";
  if (checks.some((check) => check.bucket === "pending")) return "PENDING";
  return "SUCCESS";
}

// The latest review that counts, per reviewer. GraphQL's reviewDecision also
// weighs required reviewers and write access, which REST does not report; a
// required review that is missing still leaves mergeable_state blocked.
function reviewDecision(reviews: readonly unknown[]): T.ReviewDecision {
  const latest = new Map<string, string>();
  reviews.forEach((value, index) => {
    const review = record(value, `reviews[${index}]`);
    const state = text(review.state, `reviews[${index}].state`);
    const user =
      review.user === null
        ? null
        : record(review.user, `reviews[${index}].user`);
    if (
      user === null ||
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state)
    )
      return;
    latest.set(text(user.login, `reviews[${index}].user.login`), state);
  });
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  return states.includes("APPROVED") ? "APPROVED" : null;
}

// Every list read asks for this many rows per page.
const PAGE_SIZE = 100;

const MERGEABLE: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [true, "MERGEABLE"],
  [false, "CONFLICTING"],
  [null, "UNKNOWN"],
]);

export class CloudSessionReader implements T.GitHubReader {
  // checksFastPath reads the head's checks and checkRollupPage, which
  // resolveChecks calls next, takes that read instead of making it again.
  private lastChecks: {
    readonly pr: string;
    readonly checks: readonly FastCheck[];
  } | null = null;
  constructor(
    private readonly deadline: WatchDeadline,
    private readonly local: GhGitHubReader
  ) {}
  private api(path: string): Promise<unknown> {
    return runJson(["gh", "api", path], this.deadline);
  }
  private async pages(path: string): Promise<readonly unknown[]> {
    return list(
      await runJson(
        ["gh", "api", "--paginate", "--slurp", path],
        this.deadline
      ),
      path
    );
  }
  // Every row of a list read, across its pages. These reads report no
  // total_count, and the proxy's handling of next-page links is untested, so a
  // full last page counts as a read that may have stopped early. A list of
  // exactly 100, 200, or more rows fails the same way.
  private async rows(path: string): Promise<readonly unknown[]> {
    const pages = (await this.pages(path)).map((page, index) =>
      list(page, `${path} page ${index}`)
    );
    if ((pages.at(-1)?.length ?? 0) >= PAGE_SIZE)
      missing(
        `${path} rows: the last page is full, so later pages may be missing`
      );
    return pages.flat();
  }
  // The rows under `key` across every page, checked against the total_count
  // the first page reports, so a page the proxy did not serve is an error.
  private async counted(
    path: string,
    key: string
  ): Promise<readonly Record<string, unknown>[]> {
    const pages = await this.pages(path);
    if (pages.length === 0) missing(`${path} pages`);
    const total = record(pages[0], `${path} page 0`).total_count;
    const rows = pages.flatMap((page, index) =>
      list(record(page, `${path} page ${index}`)[key], `${path}.${key}`)
    );
    if (rows.length !== total)
      missing(`${path} rows (${rows.length} of total_count)`, total);
    return rows.map((row, index) => record(row, `${path}.${key}[${index}]`));
  }
  private slug(context: T.PrContext | T.Repository): string {
    return `repos/${context.owner}/${context.repo}`;
  }
  private prKey(context: T.PrContext): string {
    return `${this.slug(context)}#${context.number}`;
  }
  private async headOf(context: T.PrContext): Promise<string> {
    const pr = record(
      await this.api(`${this.slug(context)}/pulls/${context.number}`),
      "pull request"
    );
    return text(
      record(pr.head, "pull request.head").sha,
      "pull request.head.sha"
    );
  }
  // The workflow runs name each Actions check run's workflow and event, which
  // gh's de-duplication keys on; only Actions check runs need them.
  private async checksAt(
    context: T.PrContext,
    head: string
  ): Promise<readonly FastCheck[]> {
    const [runs, statuses] = await Promise.all([
      this.counted(
        `${this.slug(context)}/commits/${head}/check-runs?per_page=100`,
        "check_runs"
      ),
      this.counted(
        `${this.slug(context)}/commits/${head}/status?per_page=100`,
        "statuses"
      ),
    ]);
    const actions = runs.some(
      (run) => isRecord(run.app) && run.app.slug === "github-actions"
    );
    const workflowRuns = actions
      ? await this.counted(
          `${this.slug(context)}/actions/runs?head_sha=${head}&per_page=100`,
          "workflow_runs"
        )
      : [];
    return fastChecks(runs, statuses, workflowRuns);
  }

  originRepo(): Promise<T.Repository | null> {
    return this.local.originRepo();
  }
  async currentPr(pr: T.PrNumber | null): Promise<T.PrContext> {
    const origin = await this.local.originRepo();
    if (origin === null)
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: "origin",
        detail:
          "the origin remote is not a github.com repository; pass --owner, --repo, and --pr",
      });
    if (pr !== null) return { ...origin, number: pr };
    const shown = await run(["git", "branch", "--show-current"], this.deadline);
    const branch = shown.code === 0 ? shown.stdout.trim() : "";
    if (branch === "")
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: "HEAD",
        detail: "the checkout is not on a branch; pass --pr",
      });
    const open = await this.rows(
      `${this.slug(origin)}/pulls?head=${origin.owner}:${encodeURIComponent(branch)}&state=open&per_page=100`
    );
    if (open.length !== 1)
      throw new WatcherQueryError({
        kind: "invalid-context-url",
        retryable: false,
        rawValue: branch,
        detail: `found ${open.length} open PRs for branch ${branch} in ${origin.owner}/${origin.repo}; pass --pr`,
      });
    return {
      ...origin,
      number: parsePrNumber(
        record(open[0], "open PR").number,
        "open PR.number"
      ),
    };
  }
  async pullRequest(context: T.PrContext): Promise<T.PullRequestFacts> {
    const pr = record(
      await this.api(`${this.slug(context)}/pulls/${context.number}`),
      "pull request"
    );
    const head = record(pr.head, "pull request.head");
    const base = record(pr.base, "pull request.base");
    const baseRefName = text(base.ref, "pull request.base.ref");
    const state =
      pr.merged_at !== null ? "MERGED" : String(pr.state).toUpperCase();
    const open = state === "OPEN";
    const [reviews, baseTip] = open
      ? await Promise.all([
          this.rows(
            `${this.slug(context)}/pulls/${context.number}/reviews?per_page=100`
          ),
          this.api(`${this.slug(context)}/git/ref/heads/${baseRefName}`),
        ])
      : [[], null];
    return parsePullRequest(
      {
        mergeable: MERGEABLE.has(pr.mergeable)
          ? MERGEABLE.get(pr.mergeable)
          : pr.mergeable,
        mergeStateStatus:
          typeof pr.mergeable_state === "string"
            ? pr.mergeable_state.toUpperCase()
            : pr.mergeable_state,
        reviewDecision: reviewDecision(reviews),
        headRefOid: head.sha,
        headRefName: head.ref,
        baseRefName,
        baseRef:
          baseTip === null
            ? null
            : {
                target: {
                  oid: record(
                    record(baseTip, "base ref").object,
                    "base ref.object"
                  ).sha,
                },
              },
        state,
        mergedAt: pr.merged_at,
        isDraft: pr.draft,
      },
      context
    );
  }
  async openPullRequests(
    repository: T.Repository
  ): Promise<readonly T.OpenPullRequest[]> {
    const open = await this.rows(
      `${this.slug(repository)}/pulls?state=open&per_page=100`
    );
    return open.map((value, index) => {
      const pr = record(value, `open PRs[${index}]`);
      const head = record(pr.head, `open PRs[${index}].head`);
      const repo =
        head.repo === null
          ? null
          : record(head.repo, `open PRs[${index}].head.repo`);
      return {
        number: parsePrNumber(pr.number, `open PRs[${index}].number`),
        headRepository:
          repo === null
            ? null
            : {
                owner: text(
                  record(repo.owner, `open PRs[${index}].head.repo.owner`)
                    .login,
                  "head.repo.owner.login"
                ),
                repo: text(repo.name, `open PRs[${index}].head.repo.name`),
              },
        headRefName: text(head.ref, `open PRs[${index}].head.ref`),
        baseRefName: text(
          record(pr.base, `open PRs[${index}].base`).ref,
          `open PRs[${index}].base.ref`
        ),
      };
    });
  }
  async defaultBranch(repository: T.Repository): Promise<string> {
    return text(
      record(await this.api(this.slug(repository)), "repository")
        .default_branch,
      "repository.default_branch"
    );
  }
  async checksFastPath(context: T.PrContext): Promise<T.ChecksFastPath> {
    const checks = await this.checksAt(context, await this.headOf(context));
    this.lastChecks = { pr: this.prKey(context), checks };
    // No checks sends resolveChecks to the rollup page, which must agree
    // before the watcher calls the head unchecked.
    return checks.length === 0
      ? { kind: "none-reported" }
      : { kind: "checks", checks: checks.map(parseFastCheck) };
  }
  async checkRollupPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.RollupPage> {
    if (after !== null) missing("REST check rollup cursor", after);
    const checks =
      this.lastChecks?.pr === this.prKey(context)
        ? this.lastChecks.checks
        : await this.checksAt(context, await this.headOf(context));
    this.lastChecks = null;
    return checks.length === 0
      ? { kind: "no-rollup" }
      : {
          kind: "contexts",
          checks: checks.map(parseFastCheck),
          endCursor: null,
        };
  }
  async reviewThreadPage(
    context: T.PrContext,
    after: string | null
  ): Promise<T.ReviewThreadPage> {
    if (after !== null) missing("REST review thread cursor", after);
    const prPath = `${this.slug(context)}/pulls/${context.number}`;
    const [threads, comments] = await Promise.all([
      this.api(`${prPath}/ccr/review_threads`),
      this.rows(`${prPath}/comments?per_page=100`),
    ]);
    const byId = new Map(
      comments.map((value, index) => {
        const comment = record(value, `review comments[${index}]`);
        return [comment.id, comment] as const;
      })
    );
    // Every review comment that starts a thread must belong to a thread the
    // route returned, so a thread the route left out cannot read as resolved.
    const threaded = new Set(
      list(threads, "ccr/review_threads").flatMap((value, index) =>
        list(
          record(value, `ccr/review_threads[${index}]`).comment_ids,
          `ccr/review_threads[${index}].comment_ids`
        )
      )
    );
    for (const [id, comment] of byId)
      if (comment.in_reply_to_id == null && !threaded.has(id))
        missing(`review comment ${String(id)} in a ccr/review_threads thread`);
    const nodes = list(threads, "ccr/review_threads").map((value, index) => {
      const thread = record(value, `ccr/review_threads[${index}]`);
      const ids = list(
        thread.comment_ids,
        `ccr/review_threads[${index}].comment_ids`
      );
      const first = ids.length === 0 ? undefined : byId.get(ids[0]);
      return {
        // The route gives a thread no id of its own.
        id: `comment-${String(ids[0])}`,
        isResolved: thread.resolved,
        comments: {
          nodes:
            first === undefined
              ? []
              : [
                  {
                    body: first.body,
                    createdAt: first.created_at,
                    path: first.path,
                    line: first.line,
                    author:
                      first.user === null
                        ? null
                        : {
                            login: record(first.user, "review comment.user")
                              .login,
                          },
                  },
                ],
        },
      };
    });
    return parseReviewThreadPage({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
  }
  // The head's rollup, and an earlier commit's only when the head reports
  // nothing: that is the one case where an earlier report changes the verdict,
  // by keeping a head with no checks from reading as a PR without CI. So
  // hadPreviousPassingCi, which only labels a failing head, stays false here.
  async commitRollups(
    context: T.PrContext
  ): Promise<readonly T.CommitRollup[]> {
    const head = await this.headOf(context);
    const state = rollupState(await this.checksAt(context, head));
    if (state !== null) return [{ oid: head, state }];
    const commits = await this.rows(
      `${this.slug(context)}/pulls/${context.number}/commits?per_page=100`
    );
    const earlier = commits
      .map((value, index) =>
        text(record(value, `commits[${index}]`).sha, `commits[${index}].sha`)
      )
      .filter((sha) => sha !== head)
      .slice(-49)
      .reverse();
    for (const sha of earlier) {
      const earlierState = rollupState(await this.checksAt(context, sha));
      if (earlierState !== null)
        return [
          { oid: head, state: null },
          { oid: sha, state: earlierState },
        ];
    }
    return [{ oid: head, state: null }];
  }
  unsettledSuites(
    context: T.PrContext,
    head: string,
    checksRead: T.CheckRead["kind"],
    expectedApps: readonly string[]
  ) {
    return this.local.unsettledSuites(context, head, checksRead, expectedApps);
  }
}
