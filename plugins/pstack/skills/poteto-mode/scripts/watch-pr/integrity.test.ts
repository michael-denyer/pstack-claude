import { describe, expect, it } from "bun:test";
import { DeadlineExceeded, WatchDeadline } from "./deadline.ts";
import { fakeReader, pendingCheck, failedCheck } from "./fakes.test-helper.ts";
import type { FakeReaderOptions } from "./fakes.test-helper.ts";
import { orderStack, parsePullRequest, WatcherQueryError } from "./github.ts";
import { classifyPr, readSnapshot, runSimple, runQueued } from "./policy.ts";
import { renderPretty } from "./render.ts";
import { parsePrNumber, type ProgressVerdict } from "./types.ts";

const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };
const options = {
  interval: 60,
  sweepInterval: 300,
  timeout: 1,
  maxQueryErrors: 5,
  allowDraft: false,
};
const unbounded = new WatchDeadline(0, () => 0);
const snapshotArgs = {
  context,
  pendingHistory: "include" as const,
  allowDraft: false,
};

describe("commit identity", () => {
  const rawPullRequest = {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "head",
    baseRefOid: "base",
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };

  it("rejects an open PR without a head or base commit where it is parsed", () => {
    for (const missing of [{ headRefOid: null }, { baseRefOid: "" }])
      expect(() =>
        parsePullRequest({ ...rawPullRequest, ...missing }, context)
      ).toThrow(WatcherQueryError);
  });

  it("accepts a merged PR whose head and base commits are gone", () => {
    expect(
      parsePullRequest(
        {
          ...rawPullRequest,
          state: "MERGED",
          mergedAt: "2026-07-26T00:00:00Z",
          headRefOid: null,
          baseRefOid: null,
        },
        context
      )
    ).toMatchObject({ state: "MERGED", headRefOid: null, baseRefOid: null });
  });

  it("rejects a missing expected commit instead of treating it as a null rollup", async () => {
    const reader = fakeReader({
      facts: { headRefOid: "old", mergeStateStatus: "BLOCKED" },
      commitRollups: [{ oid: "new", state: "FAILURE" }],
    });
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      WatcherQueryError
    );
  });

  it("keeps an explicitly absent rollup distinct from a missing commit", async () => {
    const reader = fakeReader({
      commitRollups: [{ oid: "head", state: null }],
    });
    expect(
      classifyPr(await readSnapshot({ ...snapshotArgs, reader })).kind
    ).toBe("ready");
  });

  it("includes the checked commit in a ready proof", async () => {
    expect(
      classifyPr(await readSnapshot({ ...snapshotArgs, reader: fakeReader() }))
    ).toMatchObject({
      kind: "ready",
      pr: {
        proof: {
          revision: {
            context,
            headRefOid: "head",
            baseRefName: "main",
            baseRefOid: "base",
          },
        },
      },
    });
  });

  it("rejects a changed head even when earlier checks and rollups passed", async () => {
    const reader = {
      ...fakeReader(),
      async revision() {
        return {
          context,
          headRefOid: "replacement",
          baseRefName: "main",
          baseRefOid: "base",
        };
      },
    };
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      "PR head or destination changed"
    );
  });

  it("rejects a retarget even when the head and checks remain unchanged", async () => {
    const reader = {
      ...fakeReader(),
      async revision() {
        return {
          context,
          headRefOid: "head",
          baseRefName: "release",
          baseRefOid: "base",
        };
      },
    };
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      "PR head or destination changed"
    );
  });

  it("rejects base movement with the same head and base branch", async () => {
    const reader = {
      ...fakeReader(),
      async revision() {
        return {
          context,
          headRefOid: "head",
          baseRefName: "main",
          baseRefOid: "advanced",
        };
      },
    };
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      "PR head or destination changed"
    );
  });

  it("cannot report ready when the destination query is unavailable", async () => {
    const reader = {
      ...fakeReader(),
      async revision() {
        throw new WatcherQueryError({
          kind: "command-exit",
          retryable: true,
          code: 1,
          detail: "destination unavailable",
        });
      },
    };
    const verdict = await runSimple({
      dependencies: {
        reader,
        emit() {},
        clock: { now: () => 0, observedAt: () => "fixture", async sleep() {} },
        deadline: unbounded,
      },
      contexts: [context],
      mode: "single",
      statusOnly: false,
      options: { ...options, maxQueryErrors: 1 },
    });
    expect(verdict).toMatchObject({
      kind: "BLOCKER",
      blocker: { kind: "status-query" },
    });
  });

  it("retries a changed head and only proves the stable observation", async () => {
    let reads = 0;
    const reader = {
      ...fakeReader(),
      async revision() {
        return {
          context,
          baseRefOid: "base",
          headRefOid: ++reads === 1 ? "replacement" : "head",
          baseRefName: "main",
        };
      },
    };
    const verdict = await runSimple({
      dependencies: {
        reader,
        emit() {},
        clock: { now: () => 0, observedAt: () => "fixture", async sleep() {} },
        deadline: unbounded,
      },
      contexts: [context],
      mode: "single",
      statusOnly: false,
      options,
    });
    expect(reads).toBe(2);
    expect(verdict).toMatchObject({
      kind: "READY",
      scope: {
        pr: {
          proof: {
            revision: {
              context,
              headRefOid: "head",
              baseRefName: "main",
              baseRefOid: "base",
            },
          },
        },
      },
    });
  });
});

describe("stack branch ambiguity", () => {
  const pr = (number: number, headRefName: string, baseRefName: string) => ({
    number: parsePrNumber(number),
    headRepository: context,
    headRefName,
    baseRefName,
  });

  it("ignores duplicate heads outside the requested stack", () => {
    const result = orderStack(context, [
      pr(1, "feature", "main"),
      pr(2, "hotfix", "main"),
      pr(3, "hotfix", "release"),
      pr(4, "child", "feature"),
    ]);
    expect(result.map((row) => row.number)).toEqual([
      parsePrNumber(1),
      parsePrNumber(4),
    ]);
  });

  it("keeps a missing seed independent of unrelated duplicate heads", () => {
    expect(
      orderStack(context, [pr(2, "hotfix", "main"), pr(3, "hotfix", "release")])
    ).toEqual([context]);
  });

  it("rejects an ambiguous downstack parent", () => {
    expect(() =>
      orderStack(context, [
        pr(1, "feature", "hotfix"),
        pr(2, "hotfix", "main"),
        pr(3, "hotfix", "release"),
      ])
    ).toThrow("multiple PRs have the same repository branch: hotfix");
  });

  it("rejects an ambiguous parent when traversing descendants", () => {
    expect(() =>
      orderStack(context, [
        pr(1, "feature", "main"),
        pr(2, "hotfix", "feature"),
        pr(3, "hotfix", "release"),
        pr(4, "child", "hotfix"),
      ])
    ).toThrow("multiple PRs have the same repository branch: hotfix");
  });
});

it("rejects a repository-local cycle without walking forever", () => {
  expect(() =>
    orderStack(context, [
      {
        number: context.number,
        headRepository: context,
        headRefName: "a",
        baseRefName: "b",
      },
      {
        number: parsePrNumber(2),
        headRepository: context,
        headRefName: "b",
        baseRefName: "a",
      },
    ])
  ).toThrow("cycle in PR stack");
});

it("includes a fork PR whose base genuinely depends on a local parent", () => {
  const result = orderStack(context, [
    {
      number: context.number,
      headRepository: context,
      headRefName: "base",
      baseRefName: "main",
    },
    {
      number: parsePrNumber(2),
      headRepository: { owner: "fork", repo: "repo" },
      headRefName: "foreign",
      baseRefName: "base",
    },
  ]);
  expect(result.map((pr) => pr.number)).toEqual([
    context.number,
    parsePrNumber(2),
  ]);
});

it("does not attach children to a same-named branch in a fork", () => {
  const result = orderStack(context, [
    {
      number: context.number,
      headRepository: { owner: "fork", repo: "repo" },
      headRefName: "feature",
      baseRefName: "main",
    },
    {
      number: parsePrNumber(2),
      headRepository: context,
      headRefName: "child",
      baseRefName: "feature",
    },
  ]);
  expect(result).toEqual([context]);
});

describe("deadline", () => {
  for (const mode of ["single", "queued"] as const) {
    it(`${mode} stops at the deadline before another observation`, async () => {
      let now = 0;
      const sleeps: number[] = [];
      const reader = fakeReader({
        fastPath: { kind: "checks", checks: [pendingCheck()] },
      });
      const dependencies = {
        reader,
        emit() {},
        clock: {
          now: () => now,
          observedAt: () => "fixture",
          async sleep(seconds: number) {
            sleeps.push(seconds);
            now += seconds;
          },
        },
        deadline: new WatchDeadline(options.timeout, () => now),
      };
      const result =
        mode === "single"
          ? await runSimple({
              dependencies,
              contexts: [context],
              mode: "single",
              statusOnly: false,
              options,
            })
          : await runQueued({ dependencies, contexts: [context], options });
      expect(result.kind).toBe("TIMEOUT");
      expect(sleeps).toEqual([1]);
      expect(now).toBe(1);
      expect(
        reader.calls.filter((call) => call === "pullRequest")
      ).toHaveLength(1);
    });
  }

  it("bounds a retry by remaining time", async () => {
    let now = 0;
    let reads = 0;
    const reader = {
      ...fakeReader(),
      async pullRequest(): Promise<never> {
        reads++;
        throw new WatcherQueryError({
          kind: "command-exit",
          retryable: true,
          code: 1,
          detail: "fixture",
        });
      },
    };
    const result = await runSimple({
      dependencies: {
        reader,
        emit() {},
        clock: {
          now: () => now,
          observedAt: () => "fixture",
          async sleep(seconds) {
            now += seconds;
          },
        },
        deadline: new WatchDeadline(options.timeout, () => now),
      },
      contexts: [context],
      mode: "single",
      statusOnly: false,
      options,
    });
    expect(result.kind).toBe("TIMEOUT");
    expect(now).toBe(1);
    expect(reads).toBe(1);
  });

  function dependenciesWithReadOutlivingBudget(
    readerOptions: FakeReaderOptions = {},
    failure?: () => Error
  ) {
    let now = 0;
    const base = fakeReader(readerOptions);
    const emitted: ProgressVerdict[] = [];
    return {
      reader: {
        ...base,
        async pullRequest(requested: typeof context) {
          now += 2;
          if (failure !== undefined) throw failure();
          return base.pullRequest(requested);
        },
      },
      emitted,
      emit(verdict: ProgressVerdict) {
        emitted.push(verdict);
      },
      clock: {
        now: () => now,
        observedAt: () => "fixture",
        async sleep(seconds: number) {
          now += seconds;
        },
      },
      deadline: new WatchDeadline(options.timeout, () => now),
    };
  }
  const commandExit = () =>
    new WatcherQueryError({
      kind: "command-exit",
      retryable: true,
      code: 1,
      detail: "fixture",
    });
  const single = {
    contexts: [context],
    mode: "single",
    statusOnly: false,
  } as const;

  it("times out with the read failure when a retryable read fails past the deadline", async () => {
    const dependencies = dependenciesWithReadOutlivingBudget({}, commandExit);
    const result = await runSimple({ ...single, dependencies, options });
    expect(result).toMatchObject({
      kind: "TIMEOUT",
      reason: {
        kind: "status-unavailable",
        failure: { kind: "command-exit" },
      },
    });
    expect(dependencies.emitted).toMatchObject([
      { kind: "RETRY", retryInSeconds: 0 },
    ]);
    expect(dependencies.clock.now()).toBe(2);
  });

  it("reports the status-query blocker when a read past the deadline exhausts the error budget", async () => {
    const result = await runSimple({
      ...single,
      dependencies: dependenciesWithReadOutlivingBudget({}, commandExit),
      options: { ...options, maxQueryErrors: 1 },
    });
    expect(result).toMatchObject({
      kind: "BLOCKER",
      exitCode: 7,
      blocker: { kind: "status-query", failures: 1 },
    });
  });

  it("times out without retrying a cancelled command, even while the loop budget has time left", async () => {
    let cancellations = 0;
    const dependencies = dependenciesWithReadOutlivingBudget({}, () =>
      ++cancellations > 1
        ? new Error("read again after cancellation")
        : new DeadlineExceeded()
    );
    const result = await runSimple({
      ...single,
      dependencies: { ...dependencies, deadline: unbounded },
      options,
    });
    expect(result).toMatchObject({
      kind: "TIMEOUT",
      reason: { kind: "status-unavailable", failure: { kind: "deadline" } },
    });
    expect(cancellations).toBe(1);
  });

  it("reports a READY observation that completes past the deadline", async () => {
    const result = await runSimple({
      dependencies: dependenciesWithReadOutlivingBudget(),
      contexts: [context],
      mode: "single",
      statusOnly: false,
      options,
    });
    expect(result.kind).toBe("READY");
  });

  for (const [mode, reason] of [
    ["single", "pending-checks"],
    ["queued", "queued-stack"],
  ] as const) {
    it(`${mode} keeps the ${reason} reason when a waiting observation completes past the deadline`, async () => {
      const dependencies = dependenciesWithReadOutlivingBudget({
        fastPath: { kind: "checks", checks: [pendingCheck()] },
      });
      const result =
        mode === "single"
          ? await runSimple({
              dependencies,
              contexts: [context],
              mode: "single",
              statusOnly: false,
              options,
            })
          : await runQueued({ dependencies, contexts: [context], options });
      expect(result).toMatchObject({
        kind: "TIMEOUT",
        reason: { kind: reason },
      });
    });
  }
});

it("keeps queued pending checks waiting and stops when they fail without advancing", async () => {
  let failed = false;
  const reader = {
    ...fakeReader(),
    async checksFastPath() {
      return {
        kind: "checks" as const,
        checks: [
          failed
            ? failedCheck("required-build")
            : pendingCheck("required-build"),
        ],
      };
    },
  };
  const events: string[] = [];
  const verdict = await runQueued({
    dependencies: {
      reader,
      emit(event) {
        events.push(event.kind);
      },
      clock: {
        now: () => 0,
        observedAt: () => "fixture",
        async sleep() {
          failed = true;
        },
      },
      deadline: unbounded,
    },
    contexts: [context],
    options,
  });
  expect(events).toContain("WAITING");
  expect(events).not.toContain("ADVANCE");
  expect(events).not.toContain("COMPLETE");
  expect(verdict).toMatchObject({
    kind: "BLOCKER",
    blocker: { kind: "failing-checks" },
  });
});

describe("merge gate", () => {
  const cases: readonly [
    string,
    FakeReaderOptions["facts"],
    boolean,
    ReturnType<typeof classifyPr>,
  ][] = [
    [
      "closed",
      { state: "CLOSED" },
      false,
      {
        kind: "blocker",
        blocker: {
          kind: "merge-gate",
          pr: context,
          reason: "closed-without-merge",
        },
      },
    ],
    [
      "draft",
      { isDraft: true, reviewDecision: "CHANGES_REQUESTED" },
      false,
      {
        kind: "blocker",
        blocker: { kind: "merge-gate", pr: context, reason: "draft-pr" },
      },
    ],
    [
      "changes requested",
      { reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" },
      true,
      {
        kind: "blocker",
        blocker: {
          kind: "merge-gate",
          pr: context,
          reason: "changes-requested",
        },
      },
    ],
    [
      "review required",
      { reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" },
      false,
      {
        kind: "blocker",
        blocker: { kind: "merge-gate", pr: context, reason: "review-required" },
      },
    ],
    [
      "branch protection",
      { mergeStateStatus: "BLOCKED" },
      false,
      {
        kind: "blocker",
        blocker: { kind: "merge-gate", pr: context, reason: "merge-blocked" },
      },
    ],
  ];
  for (const [name, facts, allowDraft, expected] of cases)
    it(`blocks a ${name} PR with its gate reason`, async () => {
      const row = await readSnapshot({
        ...snapshotArgs,
        reader: fakeReader({ facts }),
      });
      expect(classifyPr(row, allowDraft)).toEqual(expected);
    });

  for (const [isDraft, allowDraft, reviewDecision, draft] of [
    [false, false, "APPROVED", "not-draft"],
    [true, true, null, "draft-allowed"],
  ] as const)
    it(`proves an open gate with review ${reviewDecision} and ${draft}`, async () => {
      const row = await readSnapshot({
        ...snapshotArgs,
        reader: fakeReader({ facts: { isDraft, reviewDecision } }),
      });
      expect(classifyPr(row, allowDraft)).toMatchObject({
        kind: "ready",
        pr: { proof: { gate: { state: "OPEN", reviewDecision, draft } } },
      });
    });

  for (const [reason, action] of [
    [
      "closed-without-merge",
      "restore or remove the closed PR from the queued stack",
    ],
    [
      "draft-pr",
      "mark the PR ready for review before waiting for the merge queue",
    ],
    [
      "changes-requested",
      "resolve the changes-requested review before waiting for the merge queue",
    ],
    ["review-required", "get the required approving review"],
    [
      "merge-blocked",
      "find the branch protection rule holding the merge (mergeStateStatus=BLOCKED with clean CI)",
    ],
  ] as const)
    it(`renders the ${reason} action`, () => {
      expect(
        renderPretty({
          schemaVersion: 1,
          sequence: 1,
          observedAt: "fixture",
          mode: "single",
          kind: "BLOCKER",
          terminal: true,
          exitCode: 6,
          blocker: { kind: "merge-gate", pr: context, reason },
        })
      ).toBe(`BLOCKER: ${reason}\npr=1\naction=${action}\n`);
    });
});
