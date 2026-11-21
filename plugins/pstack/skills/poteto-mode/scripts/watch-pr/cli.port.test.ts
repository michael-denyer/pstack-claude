import { describe, expect, it } from "bun:test";
import { type CliRuntime, main, parseArgs } from "./cli.ts";
import { WatchDeadline } from "./deadline.ts";
import { fakeReader } from "./fakes.test-helper.ts";
import { unsettledSuiteChecks } from "./github.ts";
import type { GitHubReader } from "./types.ts";

const silentIo = { stdout: () => {}, stderr: () => {} };

describe("--expect-app", () => {
  it("collects each named app into the polling options", () => {
    expect(
      parseArgs(
        ["--expect-app", "azure-pipelines", "--expect-app", "circleci-checks"],
        silentIo
      ).polling.expectedApps
    ).toEqual(["azure-pipelines", "circleci-checks"]);
    expect(parseArgs([], silentIo).polling.expectedApps).toBeUndefined();
  });

  it("rejects a value that is not a GitHub App slug as usage", async () => {
    for (const value of ["", "Azure Pipelines", "azure_pipelines", "-azure"]) {
      const stderr: string[] = [];
      const runtime = {
        reader: fakeReader(),
        deadline: new WatchDeadline(0, () => 0),
        clock: {
          now: () => 0,
          observedAt: () => "2026-07-26T00:00:00.000Z",
          async sleep() {},
        },
        stdout: () => {},
        stderr: (text: string) => stderr.push(text),
      } satisfies CliRuntime;
      expect(await main(["--expect-app", value], runtime)).toBe(64);
      expect(stderr.join("")).toContain("a GitHub App slug");
    }
  });

  it("names the uncounted apps and the flag in the pretty READY lines", async () => {
    const reader: GitHubReader = fakeReader({
      facts: { reviewDecision: null },
    });
    reader.unsettledSuites = async (_context, head, checksRead, expectedApps) =>
      unsettledSuiteChecks(
        [
          {
            total_count: 1,
            check_suites: [
              {
                head_sha: head,
                status: "queued",
                conclusion: null,
                app: { slug: "azure-pipelines", name: "Azure Pipelines" },
                latest_check_runs_count: 0,
              },
            ],
          },
        ],
        head,
        checksRead,
        expectedApps
      );
    const stdout: string[] = [];
    const runtime = {
      reader,
      deadline: new WatchDeadline(0, () => 0),
      clock: {
        now: () => 0,
        observedAt: () => "2026-07-26T00:00:00.000Z",
        async sleep() {
          throw new Error("test unexpectedly slept");
        },
      },
      stdout: (text: string) => stdout.push(text),
      stderr: () => {},
    } satisfies CliRuntime;
    expect(
      await main(
        ["--owner", "owner", "--repo", "repo", "--pr", "1", "--pretty"],
        runtime
      )
    ).toBe(0);
    expect(stdout.join("")).toContain(
      "\nqueuedWithoutRuns=Azure Pipelines (azure-pipelines)\nnote=these apps queued a check suite and started no runs, so they were not counted; if one runs CI for this repository, rerun with --expect-app <slug>\n"
    );
  });
});
