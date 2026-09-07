import { describe, expect, it } from "bun:test";
import { fakeReader, pendingCheck } from "./fakes.test-helper.ts";
import { orderStack, WatcherQueryError } from "./github.ts";
import { classifyPr, readSnapshot, runSimple, runQueued } from "./policy.ts";
import { parsePrNumber } from "./types.ts";

const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };
const options = {
  interval: 60,
  sweepInterval: 300,
  timeout: 1,
  maxQueryErrors: 5,
  allowDraft: false,
};
const snapshotArgs = {
  context,
  pendingHistory: "include" as const,
  allowDraft: false,
};

describe("commit identity", () => {
  it("rejects a missing expected commit instead of treating it as a null rollup", async () => {
    const reader = fakeReader({
      facts: { headRefOid: "old", mergeStateStatus: "BLOCKED" },
      commitRollups: [{ oid: "new", state: "FAILURE" }],
    });
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      WatcherQueryError,
    );
  });

  it("keeps an explicitly absent rollup distinct from a missing commit", async () => {
    const reader = fakeReader({
      commitRollups: [{ oid: "head", state: null }],
    });
    expect(
      classifyPr(await readSnapshot({ ...snapshotArgs, reader })).kind,
    ).toBe("ready");
  });

  it("includes the checked commit in a ready proof", async () => {
    expect(
      classifyPr(await readSnapshot({ ...snapshotArgs, reader: fakeReader() })),
    ).toMatchObject({ kind: "ready", pr: { proof: { headRefOid: "head" } } });
  });

  it("rejects a changed head even when earlier checks and rollups passed", async () => {
    const reader = {
      ...fakeReader(),
      async headCommit() {
        return "replacement";
      },
    };
    await expect(readSnapshot({ ...snapshotArgs, reader })).rejects.toThrow(
      "PR head changed",
    );
  });

  it("retries a changed head and only proves the stable observation", async () => {
    let reads = 0;
    const reader = {
      ...fakeReader(),
      async headCommit() {
        return ++reads === 1 ? "replacement" : "head";
      },
    };
    const verdict = await runSimple({
      dependencies: {
        reader,
        emit() {},
        clock: { now: () => 0, observedAt: () => "fixture", async sleep() {} },
      },
      contexts: [context],
      mode: "single",
      statusOnly: false,
      options: { ...options, timeout: 0 },
    });
    expect(reads).toBe(2);
    expect(verdict).toMatchObject({
      kind: "READY",
      scope: { pr: { proof: { headRefOid: "head" } } },
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
    expect(orderStack(context, [
      pr(2, "hotfix", "main"),
      pr(3, "hotfix", "release"),
    ])).toEqual([context]);
  });

  it("rejects an ambiguous downstack parent", () => {
    expect(() => orderStack(context, [
      pr(1, "feature", "hotfix"),
      pr(2, "hotfix", "main"),
      pr(3, "hotfix", "release"),
    ])).toThrow("multiple PRs have the same repository branch: hotfix");
  });

  it("rejects an ambiguous parent when traversing descendants", () => {
    expect(() => orderStack(context, [
      pr(1, "feature", "main"),
      pr(2, "hotfix", "feature"),
      pr(3, "hotfix", "release"),
      pr(4, "child", "hotfix"),
    ])).toThrow("multiple PRs have the same repository branch: hotfix");
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
    ]),
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
        reader.calls.filter((call) => call === "pullRequest"),
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
});
