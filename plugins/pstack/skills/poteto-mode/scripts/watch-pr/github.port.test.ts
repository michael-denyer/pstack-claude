import { describe, expect, it } from "bun:test";
import { parseSuiteRead } from "./check-suites.ts";
import { WatchDeadline } from "./deadline.ts";
import {
  ChecksUnavailable,
  WatcherQueryError,
  discoverStack,
  orderStack,
  parseFastCheck,
  parsePullRequest,
  parseReviewThreadPage,
  PR_FACTS_QUERY,
  resolveChecks,
  resolveContext,
  resolveReviewThreads,
  runJson,
  unsettledSuiteChecks,
} from "./github.ts";
import { fakeReader } from "./fakes.test-helper.ts";
import type { PrContext } from "./types.ts";
import { parsePrNumber } from "./types.ts";
import { resolveWorkflowRunChecks } from "./workflow-runs.ts";

const context = {
  owner: "owner",
  repo: "repo",
  number: parsePrNumber(42),
};

const numbers = (stack: readonly PrContext[]): number[] =>
  stack.map((pr) => Number(pr.number));

describe("checks fallback chain", () => {
  it("reads no checks when gh reports none and the head commit has no rollup", async () => {
    const reader = fakeReader({
      fastPath: { kind: "none-reported" },
      rollupPages: [{ kind: "no-rollup" }],
    });
    expect(await resolveChecks(reader, context)).toEqual({
      kind: "no-checks",
      checks: [],
    });
    expect(reader.calls).toEqual(["checksFastPath", "checkRollupPage:null"]);
  });

  it("fails closed when only one read says there are no checks", async () => {
    const oneSided = [
      {
        fastPath: { kind: "unusable", exitCode: 1, stderr: "HTTP 401" },
        rollupPages: [{ kind: "no-rollup" }],
      },
      {
        fastPath: { kind: "checks", checks: [] },
        rollupPages: [{ kind: "no-rollup" }],
      },
      {
        fastPath: { kind: "none-reported" },
        rollupPages: [{ kind: "contexts", checks: [], endCursor: null }],
      },
    ] as const;
    for (const options of oneSided)
      await expect(
        resolveChecks(fakeReader(options), context)
      ).rejects.toBeInstanceOf(ChecksUnavailable);
  });

  it("rejects a rollup cursor that does not advance instead of paging on", async () => {
    const stuck = { kind: "contexts", checks: [], endCursor: "same" } as const;
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [] },
      rollupPages: [
        stuck,
        stuck,
        { kind: "contexts", checks: [], endCursor: null },
      ],
    });
    await expect(resolveChecks(reader, context)).rejects.toMatchObject({
      failure: {
        kind: "missing-field",
        retryable: true,
        detail: expect.stringContaining("must advance"),
      },
    });
    expect(reader.calls).toEqual([
      "checksFastPath",
      "checkRollupPage:null",
      "checkRollupPage:same",
    ]);
  });

  it("rejects a rollup cursor that returns to an earlier page after moving on", async () => {
    const page = (endCursor: string | null) =>
      ({ kind: "contexts", checks: [], endCursor }) as const;
    const reader = fakeReader({
      fastPath: { kind: "checks", checks: [] },
      rollupPages: [page("a"), page("b"), page("a"), page(null)],
    });
    await expect(resolveChecks(reader, context)).rejects.toMatchObject({
      failure: {
        kind: "missing-field",
        detail: expect.stringContaining("must advance"),
      },
    });
    expect(reader.calls).toEqual([
      "checksFastPath",
      "checkRollupPage:null",
      "checkRollupPage:a",
      "checkRollupPage:b",
    ]);
  });

  it("propagates a failed rollup query instead of reading it as no checks", async () => {
    const reader = fakeReader({ fastPath: { kind: "none-reported" } });
    const failure = new WatcherQueryError({
      kind: "command-exit",
      retryable: true,
      code: 1,
      detail: "HTTP 502",
    });
    reader.checkRollupPage = async () => {
      throw failure;
    };
    await expect(resolveChecks(reader, context)).rejects.toBe(failure);
  });
});

describe("check suites no check read shows", () => {
  const head = "a66c327af02be3cd643c1f0a163ee00967fbc6c0";
  const suite = (fields: Record<string, unknown> = {}) => ({
    head_sha: head,
    status: "completed",
    conclusion: "action_required",
    app: { slug: "github-actions", name: "GitHub Actions" },
    latest_check_runs_count: 0,
    ...fields,
  });
  const pages = (...suites: unknown[]) => [
    { total_count: suites.length, check_suites: suites },
  ];
  const checksOf = (...args: Parameters<typeof unsettledSuiteChecks>) =>
    unsettledSuiteChecks(...args).checks;

  it("reads an Actions suite waiting for approval as a failed check that names the approval", () => {
    expect(checksOf(pages(suite()), head, "no-checks")).toEqual([
      {
        kind: "failed",
        source: "check-suites",
        name: "GitHub Actions check suite",
        reportedState: "ACTION_REQUIRED",
        description: expect.stringContaining("maintainer approval"),
        link: "",
        workflow: "",
      },
    ]);
  });

  it("reads a failed suite as a failed check and an unfinished one as pending", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "startup_failure",
      "stale",
    ])
      expect(
        checksOf(pages(suite({ conclusion })), head, "no-checks")
      ).toMatchObject([
        { kind: "failed", reportedState: conclusion.toUpperCase() },
      ]);
    for (const status of ["queued", "in_progress", "waiting", "requested"])
      expect(
        checksOf(pages(suite({ status, conclusion: null })), head, "no-checks")
      ).toMatchObject([
        { kind: "pending", reportedState: status.toUpperCase() },
      ]);
  });

  it("reads no check from no suites or suites that finished cleanly", () => {
    expect(checksOf(pages(), head, "no-checks")).toEqual([]);
    for (const conclusion of ["success", "neutral", "skipped"])
      expect(checksOf(pages(suite({ conclusion })), head, "no-checks")).toEqual(
        []
      );
  });

  it("ignores another app's queued suite with no runs, but not Actions'", () => {
    const idle = { status: "queued", conclusion: null };
    expect(
      checksOf(
        pages(suite({ ...idle, app: { slug: "claude", name: "Claude" } })),
        head,
        "no-checks"
      )
    ).toEqual([]);
    for (const fields of [
      { app: { slug: "github-actions" } },
      { app: null },
      { app: {} },
      { app: { slug: "claude" }, latest_check_runs_count: 1 },
      { app: { slug: "claude" }, latest_check_runs_count: undefined },
    ])
      expect(
        checksOf(pages(suite({ ...idle, ...fields })), head, "no-checks")
      ).toMatchObject([{ kind: "pending", name: "Unknown app check suite" }]);
  });

  it("counts an expected app's queued suite with no runs as pending in both reads, and lists the apps it did not count", () => {
    const azure = suite({
      status: "queued",
      conclusion: null,
      app: { slug: "azure-pipelines", name: "Azure Pipelines" },
    });
    for (const checksRead of ["no-checks", "reported"] as const) {
      expect(
        unsettledSuiteChecks(pages(azure), head, checksRead, [
          "azure-pipelines",
        ])
      ).toEqual({
        checks: [
          {
            kind: "pending",
            source: "check-suites",
            name: "Azure Pipelines check suite",
            reportedState: "QUEUED",
            description: "has not finished",
            link: "",
            workflow: "",
          },
        ],
        queuedWithoutRuns: [],
      });
      expect(unsettledSuiteChecks(pages(azure), head, checksRead)).toEqual({
        checks: [],
        queuedWithoutRuns: [
          { name: "Azure Pipelines", slug: "azure-pipelines" },
        ],
      });
    }
  });

  it("beside reported checks, counts only a suite with no runs that waits for approval or for Actions to start", () => {
    const reported = (fields: Record<string, unknown>) =>
      checksOf(pages(suite(fields)), head, "reported");
    expect(reported({})).toMatchObject([
      { kind: "failed", reportedState: "ACTION_REQUIRED" },
    ]);
    expect(reported({ status: "queued", conclusion: null })).toMatchObject([
      { kind: "pending", reportedState: "QUEUED" },
    ]);
    for (const fields of [
      { conclusion: "cancelled" },
      { conclusion: "failure" },
      { conclusion: "cancelled", latest_check_runs_count: 3 },
      { status: "in_progress", conclusion: null, latest_check_runs_count: 2 },
      {
        status: "in_progress",
        conclusion: null,
        app: { slug: "wip", name: "WIP" },
      },
      {
        app: { slug: "code-review-gate", name: "Gate App" },
        latest_check_runs_count: 1,
      },
    ])
      expect(reported(fields)).toEqual([]);
  });

  it("finds a gated suite on a later page", () => {
    const twoPages = [
      ...pages(suite({ conclusion: "success" })),
      ...pages(suite()),
    ];
    expect(checksOf(twoPages, head, "no-checks")).toMatchObject([
      { kind: "failed", reportedState: "ACTION_REQUIRED" },
    ]);
  });

  it("requires a valid run count to decide whether reported checks cover a suite", () => {
    for (const count of [undefined, null, "0", -1, 0.5]) {
      expect(() =>
        checksOf(
          pages(suite({ latest_check_runs_count: count })),
          head,
          "reported"
        )
      ).toThrow(/latest_check_runs_count/);
    }
    const covered = suite({
      latest_check_runs_count: 1,
      status: null,
      conclusion: null,
    });
    expect(checksOf(pages(covered), head, "reported")).toEqual([]);
    expect(() => checksOf(pages(covered), head, "no-checks")).toThrow(
      /check suite.status/
    );
    expect(() =>
      checksOf(pages({ ...covered, head_sha: "other" }), head, "reported")
    ).toThrow(/must match the queried head/);
    expect(() =>
      checksOf(pages(suite({ conclusion: null })), head, "reported")
    ).toThrow(/conclusion of a completed suite/);
  });

  it("tells the reader which provider requires action", () => {
    for (const mode of ["reported", "no-checks"] as const) {
      const checks = checksOf(
        pages(suite({ app: { slug: "external-ci", name: "External CI" } })),
        head,
        mode
      );
      expect(checks).toMatchObject([
        {
          source: "check-suites",
          kind: "failed",
          reportedState: "ACTION_REQUIRED",
          description: expect.stringContaining(
            "review the check details for External CI"
          ),
        },
      ]);
    }
    expect(
      checksOf(pages(suite({ latest_check_runs_count: 2 })), head, "no-checks")
    ).toMatchObject([
      {
        description: expect.stringContaining(
          "review the check details for GitHub Actions"
        ),
      },
    ]);
  });

  it("fails closed on a response that cannot certify this head", () => {
    for (const [value, detail] of [
      [[], /check suite pages/],
      [[{ total_count: 1 }], /check_suites/],
      [
        pages(suite({ head_sha: "b".repeat(40) })),
        /must match the queried head/,
      ],
      [pages(suite({ conclusion: null })), /conclusion of a completed suite/],
    ] as const)
      expect(() => checksOf(value, head, "no-checks")).toThrow(detail);
  });
});

describe("workflow runs identify current startup failures", () => {
  const head = "a66c327af02be3cd643c1f0a163ee00967fbc6c0";
  const run = (fields: Record<string, unknown> = {}) => ({
    id: 10,
    workflow_id: 20,
    check_suite_id: 30,
    event: "pull_request",
    head_sha: head,
    status: "completed",
    conclusion: "startup_failure",
    created_at: "2026-11-19T10:00:00Z",
    name: "CI",
    html_url: "https://github.com/owner/repo/actions/runs/10",
    ...fields,
  });
  const pages = (...runs: unknown[]) => [
    { total_count: runs.length, workflow_runs: runs },
  ];
  const suitePages = (
    count = 0,
    successors: Record<string, unknown>[] = []
  ) => [
    {
      total_count: 1 + successors.length,
      check_suites: [
        {
          id: 30,
          head_sha: head,
          status: "completed",
          conclusion: "startup_failure",
          app: { slug: "github-actions" },
          latest_check_runs_count: count,
        },
        ...successors,
      ],
    },
  ];
  const resolve = (
    workflowPages: unknown,
    suites: unknown,
    checksRead: "reported" | "no-checks" = "reported"
  ) =>
    resolveWorkflowRunChecks(
      workflowPages,
      parseSuiteRead(suites, head, checksRead),
      head
    ).checks;

  it("blocks on a current startup failure beside reported checks", () => {
    expect(resolve(pages(run()), suitePages())).toMatchObject([
      {
        source: "check-suites",
        kind: "failed",
        name: "CI workflow",
        reportedState: "STARTUP_FAILURE",
        link: "https://github.com/owner/repo/actions/runs/10",
      },
    ]);
  });

  it("suppresses only a later success of the same workflow and event", () => {
    const older = run();
    const newerSuccess = run({
      id: 11,
      conclusion: "success",
      created_at: "2026-11-19T10:01:00Z",
    });
    for (const ordered of [
      [older, newerSuccess],
      [newerSuccess, older],
    ])
      expect(resolve(pages(...ordered), suitePages())).toEqual([]);
    const otherEvent = run({
      id: 11,
      event: "push",
      conclusion: "success",
      created_at: "2026-11-19T10:01:00Z",
    });
    for (const ordered of [
      [older, otherEvent],
      [otherEvent, older],
    ])
      expect(resolve(pages(...ordered), suitePages())).toMatchObject([
        { reportedState: "STARTUP_FAILURE" },
      ]);
  });

  it("preserves a current pending run", () => {
    expect(
      resolve(
        pages(run({ status: "in_progress", conclusion: null })),
        suitePages()
      )
    ).toMatchObject([{ kind: "pending", reportedState: "IN_PROGRESS" }]);
  });

  it("fails closed when workflow identity or status is absent", () => {
    expect(() =>
      resolve(pages(run({ workflow_id: undefined })), suitePages())
    ).toThrow(/workflow run.workflow_id/);
  });

  it("does not duplicate a workflow whose suite already has reported runs", () => {
    expect(
      resolve(pages(run({ conclusion: "success" })), suitePages(1))
    ).toEqual([]);
  });

  it("fails closed when the zero-run evidence is incomplete", () => {
    for (const checksRead of ["reported", "no-checks"] as const)
      expect(() =>
        resolve(pages(run()), suitePages(Number.NaN), checksRead)
      ).toThrow(/check suite.latest_check_runs_count/);
  });

  it("fails closed when a failed zero-run suite has no matching workflow row", () => {
    for (const workflowPages of [
      pages(),
      pages({ ...run(), check_suite_id: 999, conclusion: "success" }),
    ])
      expect(() => resolve(workflowPages, suitePages())).toThrow(
        /workflow runs for failed check suite/
      );
  });

  it("uses display title and path when the workflow name is null", () => {
    expect(
      resolve(
        pages(
          run({
            name: null,
            display_title: "Display title",
            conclusion: "STARTUP_FAILURE",
          })
        ),
        suitePages()
      )
    ).toMatchObject([{ name: "Display title workflow" }]);
    expect(
      resolve(
        pages(
          run({
            name: null,
            display_title: null,
            path: ".github/workflows/ci.yml",
          })
        ),
        suitePages()
      )
    ).toMatchObject([{ name: ".github/workflows/ci.yml workflow" }]);
  });

  it("normalizes REST case and ignores unrelated runs and suites", () => {
    expect(
      resolve(
        pages(
          run({
            status: "COMPLETED",
            conclusion: "STARTUP_FAILURE",
          }),
          run({
            id: 99,
            workflow_id: 99,
            check_suite_id: 999,
            status: "completed",
            conclusion: "success",
          })
        ),
        [
          {
            total_count: 2,
            check_suites: [
              {
                id: 30,
                head_sha: head,
                status: "COMPLETED",
                conclusion: "STARTUP_FAILURE",
                app: { slug: "GITHUB-ACTIONS" },
                latest_check_runs_count: 0,
              },
              {
                head_sha: head,
                status: "completed",
                conclusion: "failure",
                app: { slug: "third-party" },
                latest_check_runs_count: 0,
              },
            ],
          },
        ]
      )
    ).toMatchObject([{ reportedState: "STARTUP_FAILURE" }]);
  });

  it("fails closed on an unknown completed conclusion in an identified workflow", () => {
    expect(() =>
      resolve(pages(run({ conclusion: "new_future_state" })), suitePages())
    ).toThrow(/workflow run.conclusion/);
  });

  it("counts only startup_failure as a failure, leaving cancelled and other conclusions alone", () => {
    for (const conclusion of [
      "action_required",
      "neutral",
      "skipped",
      "cancelled",
      "failure",
      "timed_out",
      "stale",
    ])
      expect(resolve(pages(run({ conclusion })), suitePages())).toEqual([]);
  });

  // Replays grafana/grafana#138385 at 038471dc2a94b1d373bddf1995b9d06249728d49:
  // a cancel-in-progress workflow left a zero-run cancelled suite in the same
  // second as the passing run.
  it("ignores grafana-style zero-run cancelled suites beside a same-second green run", () => {
    const grafanaHead = "038471dc2a94b1d373bddf1995b9d06249728d49";
    const grafanaSuites = [
      {
        total_count: 3,
        check_suites: [
          {
            id: 101,
            head_sha: grafanaHead,
            status: "completed",
            conclusion: "cancelled",
            app: { slug: "github-actions", name: "GitHub Actions" },
            latest_check_runs_count: 1,
          },
          {
            id: 102,
            head_sha: grafanaHead,
            status: "completed",
            conclusion: "success",
            app: { slug: "github-actions", name: "GitHub Actions" },
            latest_check_runs_count: 1,
          },
          {
            id: 103,
            head_sha: grafanaHead,
            status: "completed",
            conclusion: "cancelled",
            app: { slug: "github-actions", name: "GitHub Actions" },
            latest_check_runs_count: 0,
          },
        ],
      },
    ];
    const parsed = parseSuiteRead(grafanaSuites, grafanaHead, "reported");
    expect(parsed.startupFailureSuites).toEqual([]);
    expect(parsed.entries).toEqual([]);

    // Even when workflow runs are queried for another workflow's startup_failure,
    // the cancelled zero-run workflow does not produce a false failure.
    const grafanaRuns = [
      {
        id: 44577615023,
        workflow_id: 500,
        check_suite_id: 103,
        event: "pull_request",
        head_sha: grafanaHead,
        status: "completed",
        conclusion: "cancelled",
        created_at: "2026-11-19T17:28:50Z",
        name: "Unified Storage Compatibility",
        html_url: "https://github.com/grafana/grafana/actions/runs/44577615023",
      },
      {
        id: 44577614969,
        workflow_id: 500,
        check_suite_id: 102,
        event: "pull_request",
        head_sha: grafanaHead,
        status: "completed",
        conclusion: "success",
        created_at: "2026-11-19T17:28:50Z",
        name: "Unified Storage Compatibility",
        html_url: "https://github.com/grafana/grafana/actions/runs/44577614969",
      },
      {
        id: 44577612080,
        workflow_id: 500,
        check_suite_id: 101,
        event: "pull_request",
        head_sha: grafanaHead,
        status: "completed",
        conclusion: "cancelled",
        created_at: "2026-11-19T17:28:49Z",
        name: "Unified Storage Compatibility",
        html_url: "https://github.com/grafana/grafana/actions/runs/44577612080",
      },
    ];
    expect(
      resolveWorkflowRunChecks(pages(...grafanaRuns), parsed, grafanaHead)
        .checks
    ).toEqual([]);
  });

  it("keeps a zero-run failure when a later same-identity run is neutral, skipped, or cancelled regardless of input order", () => {
    for (const conclusion of ["neutral", "skipped", "cancelled"]) {
      const older = run();
      const newer = run({
        id: 11,
        check_suite_id: 31,
        conclusion,
        created_at: "2026-11-19T10:01:00Z",
      });
      const suites = suitePages(0, [
        {
          id: 31,
          head_sha: head,
          status: "completed",
          conclusion,
          app: { slug: "github-actions" },
          latest_check_runs_count: 0,
        },
      ]);
      // Test both oldest-first and the GitHub API's newest-first ordering.
      for (const ordered of [
        [older, newer],
        [newer, older],
      ])
        expect(resolve(pages(...ordered), suites)).toMatchObject([
          { kind: "failed", reportedState: "STARTUP_FAILURE" },
        ]);
    }
  });

  it("reports a newer pending run and clears a newer success even when the successor suite count is nonzero", () => {
    const older = run();
    const newerPending = run({
      id: 11,
      check_suite_id: 31,
      status: "in_progress",
      conclusion: null,
      created_at: "2026-11-19T10:01:00Z",
    });
    const pendingSuites = suitePages(0, [
      {
        id: 31,
        head_sha: head,
        status: "in_progress",
        conclusion: null,
        app: { slug: "github-actions" },
        latest_check_runs_count: 2,
      },
    ]);
    for (const ordered of [
      [older, newerPending],
      [newerPending, older],
    ])
      expect(resolve(pages(...ordered), pendingSuites)).toMatchObject([
        { kind: "pending", reportedState: "IN_PROGRESS" },
      ]);

    const newerSuccess = run({
      id: 12,
      check_suite_id: 32,
      conclusion: "success",
      created_at: "2026-11-19T10:01:00Z",
    });
    const successSuites = suitePages(0, [
      {
        id: 32,
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { slug: "github-actions" },
        latest_check_runs_count: 2,
      },
    ]);
    for (const ordered of [
      [older, newerSuccess],
      [newerSuccess, older],
    ])
      expect(resolve(pages(...ordered), successSuites)).toEqual([]);
  });

  it("lets a newer pending rerun supersede an older failure regardless of input order", () => {
    const older = run();
    const newer = run({
      id: 11,
      check_suite_id: 31,
      status: "in_progress",
      conclusion: null,
      created_at: "2026-11-19T10:01:00Z",
    });
    const suites = [
      {
        total_count: 2,
        check_suites: [
          {
            id: 30,
            head_sha: head,
            status: "completed",
            conclusion: "startup_failure",
            app: { slug: "github-actions" },
            latest_check_runs_count: 0,
          },
          {
            id: 31,
            head_sha: head,
            status: "in_progress",
            conclusion: null,
            app: { slug: "github-actions" },
            latest_check_runs_count: 0,
          },
        ],
      },
    ];
    for (const ordered of [
      [older, newer],
      [newer, older],
    ])
      expect(resolve(pages(...ordered), suites)).toMatchObject([
        { kind: "pending", reportedState: "IN_PROGRESS" },
      ]);
  });

  it("correlates pending and approval successors with non-completed suites", () => {
    expect(
      resolve(
        pages(
          run({
            id: 12,
            workflow_id: 22,
            check_suite_id: 32,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-19T10:02:00Z",
          }),
          run({
            id: 11,
            workflow_id: 20,
            check_suite_id: 31,
            status: "in_progress",
            conclusion: null,
            created_at: "2026-11-19T10:01:00Z",
          }),
          run()
        ),
        suitePages(0, [
          {
            id: 31,
            head_sha: head,
            status: "in_progress",
            conclusion: null,
            app: { slug: "github-actions" },
            latest_check_runs_count: 0,
          },
          {
            id: 32,
            head_sha: head,
            status: "action_required",
            conclusion: "success",
            app: { slug: "github-actions" },
            latest_check_runs_count: 0,
          },
        ])
      )
    ).toMatchObject([
      { kind: "pending", reportedState: "IN_PROGRESS" },
      { kind: "pending", reportedState: "IN_PROGRESS" },
    ]);
  });
});

it("reports a binary that cannot be spawned as a query failure that does not retry", async () => {
  await expect(
    runJson(
      ["/nonexistent/watch-pr-missing-gh", "pr", "view"],
      new WatchDeadline(0, () => 0)
    )
  ).rejects.toMatchObject({
    failure: {
      kind: "spawn-failed",
      retryable: false,
      detail: expect.stringContaining("ENOENT"),
    },
  });
});

describe("fast-path check mapping", () => {
  // gh's aggregate.go files every state it does not name into the pending
  // bucket, including completed conclusions.
  it("fails completed conclusions that gh buckets as pending", () => {
    for (const state of ["STARTUP_FAILURE", "STALE"]) {
      expect(
        parseFastCheck({ name: "ci", state, bucket: "pending" })
      ).toMatchObject({ kind: "failed", reportedState: state });
    }
  });

  it("keeps in-flight states pending", () => {
    for (const state of [
      "EXPECTED",
      "REQUESTED",
      "WAITING",
      "QUEUED",
      "PENDING",
      "IN_PROGRESS",
    ]) {
      expect(
        parseFastCheck({ name: "ci", state, bucket: "pending" })
      ).toMatchObject({ kind: "pending", reportedState: state });
    }
  });
});

describe("closed enum parsing", () => {
  const rawPullRequest = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    baseRef: { target: { oid: "base" } },
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };

  it("uses the current base target when the scalar base OID is stale", () => {
    expect(
      parsePullRequest(
        {
          ...rawPullRequest,
          baseRefOid: "stale-base",
          baseRef: { target: { oid: "current-base" } },
        },
        context
      ).baseRefOid
    ).toBe("current-base");
  });

  it("queries the current base target with the other PR facts", () => {
    expect(PR_FACTS_QUERY).toContain("baseRef { target { oid } }");
    expect(PR_FACTS_QUERY).not.toContain("baseRefOid");
  });

  it("fails closed when the current base ref is null or missing", () => {
    const missingBaseRef = Object.fromEntries(
      Object.entries(rawPullRequest).filter(([key]) => key !== "baseRef")
    );
    for (const value of [{ ...rawPullRequest, baseRef: null }, missingBaseRef])
      expect(() => parsePullRequest(value, context)).toThrow(WatcherQueryError);
  });
});

describe("review thread pagination", () => {
  it("rejects a page that promises more pages without a cursor", () => {
    for (const endCursor of [null, ""]) {
      const response = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor },
                nodes: [],
              },
            },
          },
        },
      };
      expect(() => parseReviewThreadPage(response)).toThrow(WatcherQueryError);
    }
  });

  it("rejects a thread cursor that does not advance instead of paging on", async () => {
    const stuck = { threads: [], endCursor: "same" };
    const reader = fakeReader({
      threadPages: [stuck, stuck, { threads: [], endCursor: null }],
    });
    await expect(resolveReviewThreads(reader, context)).rejects.toMatchObject({
      failure: {
        kind: "missing-field",
        retryable: true,
        detail: expect.stringContaining(
          "reviewThreads.pageInfo.endCursor must advance"
        ),
      },
    });
    expect(reader.calls).toEqual([
      "reviewThreadPage:null",
      "reviewThreadPage:same",
    ]);
  });
});

describe("context and stack discovery", () => {
  it("refuses to pair the checkout's PR number with a different explicit repository", async () => {
    const reader = fakeReader({
      current: { owner: "acme", repo: "web", number: parsePrNumber(57) },
    });
    const resolved = resolveContext({
      reader,
      owner: "acme",
      repo: "api",
      pr: null,
    });
    await expect(resolved).rejects.toBeInstanceOf(WatcherQueryError);
    await expect(resolved).rejects.toMatchObject({
      failure: { retryable: false },
    });
  });

  it("accepts an explicit repository that matches the checkout's PR", async () => {
    const reader = fakeReader({
      current: { owner: "acme", repo: "web", number: parsePrNumber(57) },
    });
    expect(
      await resolveContext({ reader, owner: "ACME", repo: "Web", pr: null })
    ).toEqual({ owner: "ACME", repo: "Web", number: parsePrNumber(57) });
  });

  it("keeps a PR whose head is the default branch out of every stack", () => {
    const repo = { owner: "owner", repo: "repo" };
    const backport = parsePrNumber(2);
    const open = [
      {
        number: backport,
        headRepository: repo,
        headRefName: "main",
        baseRefName: "release",
      },
      {
        number: context.number,
        headRepository: repo,
        headRefName: "feature",
        baseRefName: "main",
      },
      {
        number: parsePrNumber(43),
        headRepository: repo,
        headRefName: "upstack",
        baseRefName: "feature",
      },
    ];
    expect(numbers(orderStack(context, "main", open))).toEqual([42, 43]);
    expect(
      numbers(orderStack({ ...context, number: backport }, "main", open))
    ).toEqual([2]);
  });

  it("keeps a PR that brings the default branch into a feature branch out of that feature's stack", () => {
    const repo = { owner: "owner", repo: "repo" };
    const sync = parsePrNumber(7);
    const open = [
      {
        number: context.number,
        headRepository: repo,
        headRefName: "feature",
        baseRefName: "main",
      },
      {
        number: sync,
        headRepository: repo,
        headRefName: "main",
        baseRefName: "feature",
      },
    ];
    expect(numbers(orderStack(context, "main", open))).toEqual([42]);
    expect(
      numbers(orderStack({ ...context, number: sync }, "main", open))
    ).toEqual([7]);
  });

  it("still stacks a fork PR whose head branch has the default branch's name", () => {
    const fork = parsePrNumber(50);
    const open = [
      {
        number: context.number,
        headRepository: { owner: "owner", repo: "repo" },
        headRefName: "feature",
        baseRefName: "main",
      },
      {
        number: fork,
        headRepository: { owner: "contributor", repo: "repo" },
        headRefName: "main",
        baseRefName: "feature",
      },
    ];
    expect(numbers(orderStack(context, "main", open))).toEqual([42, 50]);
    expect(
      numbers(orderStack({ ...context, number: fork }, "main", open))
    ).toEqual([42, 50]);
  });

  it("stops at the default branch when it is an integration branch with a release PR", () => {
    const repo = { owner: "owner", repo: "repo" };
    const open = [
      {
        number: parsePrNumber(500),
        headRepository: repo,
        headRefName: "develop",
        baseRefName: "main",
      },
      {
        number: parsePrNumber(612),
        headRepository: repo,
        headRefName: "feature/login",
        baseRefName: "develop",
      },
      {
        number: parsePrNumber(613),
        headRepository: repo,
        headRefName: "fix/typo",
        baseRefName: "develop",
      },
    ];
    expect(
      numbers(
        orderStack({ ...repo, number: parsePrNumber(612) }, "develop", open)
      )
    ).toEqual([612]);
    expect(
      numbers(
        orderStack({ ...repo, number: parsePrNumber(500) }, "develop", open)
      )
    ).toEqual([500]);
  });

  it("reads the default branch once while discovering a stack", async () => {
    const reader = fakeReader({ defaultBranch: "trunk" });
    expect(await discoverStack(reader, context)).toEqual([context]);
    expect(reader.calls).toEqual(["openPullRequests", "defaultBranch"]);
  });

  it("orders a discovered stack around the default branch the repository reports", async () => {
    const repo = { owner: "owner", repo: "repo" };
    const reader = fakeReader({
      defaultBranch: "develop",
      openPullRequests: [
        {
          number: parsePrNumber(500),
          headRepository: repo,
          headRefName: "develop",
          baseRefName: "main",
        },
        {
          number: context.number,
          headRepository: repo,
          headRefName: "feature",
          baseRefName: "develop",
        },
      ],
    });
    expect(numbers(await discoverStack(reader, context))).toEqual([42]);
  });

  it("refuses a full open-PR page, which may have cut the stack", async () => {
    const openPrs = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        number: parsePrNumber(index + 1),
        headRepository: { owner: "owner", repo: "repo" },
        headRefName: `branch-${index + 1}`,
        baseRefName: "main",
      }));
    await expect(
      discoverStack(fakeReader({ openPullRequests: openPrs(300) }), context)
    ).rejects.toMatchObject({ failure: { kind: "invalid-stack" } });
    expect(
      await discoverStack(
        fakeReader({ openPullRequests: openPrs(299) }),
        context
      )
    ).toEqual([context]);
  });
});
