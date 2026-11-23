import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function run(scenario: string, extra: string[] = [], path?: string) {
  const dir = mkdtempSync(join(tmpdir(), "watch-transport-"));
  directories.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const scenario = process.env.WATCH_FIXTURE;
appendFileSync(process.env.WATCH_CALLS, JSON.stringify(args) + '\\n');
if (scenario === 'slow') {
  writeFileSync(process.env.WATCH_PID, String(process.pid));
  await new Promise(resolve => setTimeout(resolve, 2000));
}
const noCi = scenario.startsWith('no-ci');
const fail = (stderr) => { console.error(stderr); process.exit(1); };
let value;
if (scenario === 'graphql-rate-limited' && args[0] === 'api' && args[1] === 'graphql') {
  fail('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)');
} else if (args.some(a => a.includes('query PullRequestFacts'))) {
  value = { data: { repository: { pullRequest: { headRefOid: 'head', baseRef: { target: { oid: 'base' } }, mergeable: 'MERGEABLE', mergeStateStatus: scenario === 'no-ci-blocked' ? 'BLOCKED' : 'CLEAN', reviewDecision: noCi ? null : 'APPROVED', headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergedAt: null, isDraft: false } } } };
} else if (args[0] === 'pr' && args[1] === 'checks') {
  if (scenario === 'no-ci-unauthorized') fail('HTTP 401: Bad credentials (https://api.github.com/graphql)');
  if (noCi) fail("no checks reported on the 'feature' branch");
  value = [scenario === 'pending' ? { name: 'ci', state: 'IN_PROGRESS', bucket: 'pending', description: '', link: '', workflow: '' } : { name: 'ci', state: 'SUCCESS', bucket: 'pass', description: '', link: '', workflow: '' }];
} else if (args.some(a => a.includes('query PrCheckRollup'))) {
  if (scenario === 'no-ci-rollup-fails') fail('HTTP 502: Bad Gateway (https://api.github.com/graphql)');
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: null } }] } } } } };
} else if (args.some(a => a.endsWith('/check-suites?per_page=100'))) {
  if (scenario === 'unsupported-gh') fail('unknown flag: --slurp');
  if (scenario === 'no-ci-suites-fail') fail('HTTP 403: check suites unavailable');
  if (!args.includes('--paginate') || !args.includes('--slurp')) fail('fixture serves only paginated, slurped check suites');
  const suites = {
    'no-ci-owner-approval': [{ head_sha: 'head', status: 'completed', conclusion: 'action_required', app: { slug: 'github-actions' }, latest_check_runs_count: 0 }],
    'no-ci-idle-app': [{ head_sha: 'head', status: 'queued', conclusion: null, app: { slug: 'claude' }, latest_check_runs_count: 0 }],
    'superseded-beside-reported': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'cancelled', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 3 },
      { id: 31, head_sha: 'head', status: 'completed', conclusion: 'cancelled', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { id: 32, head_sha: 'head', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 1 },
      { id: 33, head_sha: 'head', status: 'completed', conclusion: 'success', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 3 },
    ],
    'gated-beside-reported': [
      { head_sha: 'head', status: 'completed', conclusion: 'action_required', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { head_sha: 'head', status: 'completed', conclusion: 'action_required', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { head_sha: 'head', status: 'completed', conclusion: 'success', app: { slug: 'microsoft-github-policy-service', name: 'Microsoft GitHub Policy Service' }, latest_check_runs_count: 1 },
    ],
    'startup-current': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'no-ci-startup-current': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'no-ci-startup-superseded': [
      { id: 31, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { id: 33, head_sha: 'head', status: 'completed', conclusion: 'success', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'no-ci-startup-pending': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { id: 31, head_sha: 'head', status: 'in_progress', conclusion: null, app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'no-ci-startup-racing': [
      { id: 31, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'no-ci-startup-neutral': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { id: 31, head_sha: 'head', status: 'completed', conclusion: 'neutral', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
    ],
    'reported-startup-pending': [
      { id: 30, head_sha: 'head', status: 'completed', conclusion: 'startup_failure', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 0 },
      { id: 31, head_sha: 'head', status: 'in_progress', conclusion: null, app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 2 },
    ],
  }[scenario] ?? [];
  value = [{ total_count: suites.length, check_suites: suites }];
} else if (args.some(a => a.includes('/actions/runs?head_sha=head'))) {
  if (!['startup-current', 'no-ci-startup-current', 'no-ci-startup-superseded', 'no-ci-startup-pending', 'no-ci-startup-racing', 'no-ci-startup-neutral', 'reported-startup-pending'].includes(scenario))
    throw new Error('unexpected workflow-run lookup');
  if (scenario === 'no-ci-startup-racing') {
    value = [{ total_count: 0, workflow_runs: [] }];
  } else if (scenario === 'no-ci-startup-superseded') {
    value = [{
      total_count: 3,
      workflow_runs: [
        {
          id: 99,
          workflow_id: 99,
          check_suite_id: 999,
          event: 'pull_request',
          head_sha: 'head',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-11-19T10:02:00Z',
          name: 'Unrelated',
          html_url: 'https://github.com/owner/repo/actions/runs/99',
        },
        {
          id: 11,
          workflow_id: 20,
          check_suite_id: 33,
          event: 'pull_request',
          head_sha: 'head',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-11-19T10:01:00Z',
          name: 'CI',
          html_url: 'https://github.com/owner/repo/actions/runs/11',
        },
        {
          id: 10,
          workflow_id: 20,
          check_suite_id: 31,
          event: 'pull_request',
          head_sha: 'head',
          status: 'completed',
          conclusion: 'startup_failure',
          created_at: '2026-11-19T10:00:00Z',
          name: 'CI',
          html_url: 'https://github.com/owner/repo/actions/runs/10',
        },
      ],
    }];
  } else if (scenario === 'no-ci-startup-pending' || scenario === 'reported-startup-pending') {
    value = [{
      total_count: 2,
      workflow_runs: [{
        id: 11,
        workflow_id: 20,
        check_suite_id: 31,
        event: 'pull_request',
        head_sha: 'head',
        status: 'in_progress',
        conclusion: null,
        created_at: '2026-11-19T10:01:00Z',
        name: 'CI',
        html_url: 'https://github.com/owner/repo/actions/runs/11',
      }, {
        id: 10,
        workflow_id: 20,
        check_suite_id: 30,
        event: 'pull_request',
        head_sha: 'head',
        status: 'completed',
        conclusion: 'startup_failure',
        created_at: '2026-11-19T10:00:00Z',
        name: 'CI',
        html_url: 'https://github.com/owner/repo/actions/runs/10',
      }],
    }];
  } else if (scenario === 'no-ci-startup-neutral') {
    value = [{
      total_count: 2,
      workflow_runs: [
        {
          id: 11,
          workflow_id: 20,
          check_suite_id: 31,
          event: 'pull_request',
          head_sha: 'head',
          status: 'completed',
          conclusion: 'neutral',
          created_at: '2026-11-19T10:01:00Z',
          name: 'CI',
          html_url: 'https://github.com/owner/repo/actions/runs/11',
        },
        {
          id: 10,
          workflow_id: 20,
          check_suite_id: 30,
          event: 'pull_request',
          head_sha: 'head',
          status: 'completed',
          conclusion: 'startup_failure',
          created_at: '2026-11-19T10:00:00Z',
          name: 'CI',
          html_url: 'https://github.com/owner/repo/actions/runs/10',
        },
      ],
    }];
  } else {
  value = [{
    total_count: 1,
    workflow_runs: [{
      id: 10,
      workflow_id: 20,
      check_suite_id: 30,
      event: 'pull_request',
      head_sha: 'head',
      status: 'completed',
      conclusion: 'startup_failure',
      created_at: '2026-11-19T10:00:00Z',
      name: 'CI',
      html_url: 'https://github.com/owner/repo/actions/runs/10',
    }],
  }];
  }
} else if (noCi && args.some(a => a.includes('query PrCommitStatuses'))) {
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: null } }] } } } } };
} else if (args[0] === 'pr' && args[1] === 'list') {
  value = [{ number: 1, headRefName: 'main', baseRefName: 'main', headRepository: { name: 'repo', nameWithOwner: 'fork/repo' }, headRepositoryOwner: { login: 'fork' } }];
} else if (args[0] === 'repo' && args[1] === 'view') {
  value = { defaultBranchRef: { name: 'main' } };
} else if (args.some(a => a.includes('query ReviewThreads'))) {
  const after = args.find(a => a.startsWith('after='));
  const thread = (n, resolved) => ({ id: 't' + n, isResolved: resolved, comments: { nodes: [] } });
  const paginated = scenario === 'threads' || scenario === 'stuck-cursor';
  value = { data: { repository: { pullRequest: { reviewThreads: {
    nodes: paginated ? (after ? [thread(100, false)] : Array.from({length: 100}, (_, n) => thread(n, true))) : [],
    pageInfo: { hasNextPage: paginated && (!after || scenario === 'stuck-cursor'), endCursor: paginated ? 'next' : null }
  } } } } };
} else if (args.some(a => a.includes('query PrCommitStatuses'))) {
  value = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: 'head', statusCheckRollup: { state: 'SUCCESS' } } }] } } } } };
} else { throw new Error('unexpected fixture command: ' + JSON.stringify(args)); }
console.log(JSON.stringify(value));
`
  );
  chmodSync(gh, 0o755);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))}; process.exitCode = await main(process.argv.slice(2));\n`
  );
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(callsFile, "");
  const pidFile = join(dir, "pid");
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    [entry, "--owner", "owner", "--repo", "repo", "--pr", "1", ...extra],
    {
      encoding: "utf8",
      timeout: 6000,
      env: {
        PATH: path ?? `${bin}:${process.env.PATH}`,
        WATCH_FIXTURE: scenario,
        WATCH_CALLS: callsFile,
        WATCH_PID: pidFile,
      },
    }
  );
  return {
    ...result,
    elapsed: performance.now() - started,
    calls: readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]),
    pidFile,
  };
}

it("reads page two before reporting unresolved review threads", () => {
  const result = run("threads");
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: { kind: "review-threads", threads: [{ id: "t100" }] },
  });
  expect(
    result.calls.filter((args) => args.includes("after=next"))
  ).toHaveLength(1);
});

it("rejects a repeating page cursor instead of looping or silently truncating", () => {
  const result = run("stuck-cursor", ["--max-query-errors", "1"]);
  expect(result.status).toBe(7);
  expect(
    result.calls.filter((args) =>
      args.some((arg) => arg.includes("ReviewThreads"))
    )
  ).toHaveLength(2);
});

it("keeps a fork main branch distinct from destination main during stack discovery", () => {
  const result = run("fork", ["--stack", "--status-only"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "STATUS",
    rows: [{ context: { number: 1 } }],
  });
});

const verdicts = (stdout: string): unknown[] =>
  stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);

// The no-ci fixtures replay what gh returned for a mergeable PR in a repository
// with no checks configured: `gh pr checks` exits 1 with "no checks reported"
// and the head commit's statusCheckRollup is null.
it("reports a first sighting of no checks on a status-only pass", () => {
  for (const scenario of ["no-ci", "no-ci-idle-app"]) {
    const result = run(scenario, ["--status-only", "--max-query-errors", "1"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      kind: "STATUS",
      terminal: true,
      rows: [{ kind: "open", ci: { kind: "ci-unreported" } }],
    });
  }
});

it("reads the head's check suites only when no check has failed or is pending", () => {
  const readsSuites = (scenario: string) => {
    const result = run(scenario, ["--status-only", "--max-query-errors", "1"]);
    expect(result.status).toBe(0);
    return result.calls.some((args) =>
      args.some((arg) => arg.includes("/check-suites"))
    );
  };
  expect(readsSuites("no-ci")).toBe(true);
  expect(readsSuites("threads")).toBe(true);
  expect(readsSuites("pending")).toBe(false);
});

// Confirming no checks takes 60 seconds of wall time, so a test on the real
// clock can only show the wait. A loaded machine fits fewer polls into the
// deadline, so this asserts what each poll said and not how many there were.
it("keeps a PR with no checks waiting through short-interval polls until the deadline", () => {
  for (const scenario of ["no-ci", "no-ci-blocked"]) {
    const result = run(scenario, [
      "--max-query-errors",
      "1",
      "--interval",
      "0.05",
      "--timeout",
      "2",
    ]);
    expect(result.status).toBe(5);
    const emitted = verdicts(result.stdout);
    for (const wait of emitted.slice(0, -1))
      expect(wait).toMatchObject({
        kind: "WAITING",
        reason: { kind: "checks-unreported" },
      });
    expect(emitted.at(-1)).toMatchObject({ kind: "TIMEOUT" });
  }
});

it("fails closed when the check queries fail instead of reporting no checks", () => {
  for (const scenario of [
    "no-ci-unauthorized",
    "no-ci-rollup-fails",
    "no-ci-suites-fail",
  ]) {
    const result = run(scenario, ["--status-only", "--max-query-errors", "1"]);
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      kind: "BLOCKER",
      blocker: { kind: "status-query" },
    });
  }
});

it("blocks on approval-gated Actions instead of reporting a repository without CI", () => {
  const result = run("no-ci-owner-approval", ["--max-query-errors", "1"]);
  expect(result.status).toBe(4);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "failing-checks",
      ci: {
        kind: "ci-failing",
        source: "check-suites",
        failed: [{ reportedState: "ACTION_REQUIRED" }],
      },
    },
  });
  expect(result.stdout).toContain("maintainer approval");
});

// Replays microsoft/TypeScript#64949 as read on 2026-11-19: another app reported
// one passing check while two Actions suites waited for approval with no runs.
it("blocks on approval-gated Actions beside another app's passing check", () => {
  const result = run("gated-beside-reported", ["--max-query-errors", "1"]);
  expect(result.status).toBe(4);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "failing-checks",
      ci: {
        kind: "ci-failing",
        failed: [
          {
            source: "check-suites",
            name: "GitHub Actions check suite",
            reportedState: "ACTION_REQUIRED",
          },
          {
            source: "check-suites",
            name: "GitHub Actions check suite",
            reportedState: "ACTION_REQUIRED",
          },
        ],
      },
    },
  });
});

it("stops on the first suite read when gh lacks --slurp", () => {
  const result = run("unsupported-gh", ["--timeout", "2"]);
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      failures: 1,
      failure: {
        kind: "unsupported-gh",
        retryable: false,
        detail: expect.stringContaining("Upgrade GitHub CLI to 2.48"),
      },
    },
  });
  expect(result.calls.filter((args) => args.includes("--slurp"))).toHaveLength(
    1
  );
  const pretty = run("unsupported-gh", ["--timeout", "2", "--pretty"]);
  expect(pretty.stdout).toContain("action=upgrade GitHub CLI");
});

it("still retries a GraphQL 403 that can clear, such as a secondary rate limit", () => {
  const result = run("graphql-rate-limited", ["--timeout", "2"]);
  expect(result.status).toBe(5);
  expect(JSON.parse(result.stdout.trim().split("\n")[0])).toMatchObject({
    kind: "RETRY",
    failure: { kind: "command-exit", retryable: true },
  });
});

// Replays the shape of grafana/grafana#138293 and #138385: every reported
// check passed, and a cancelled run (even with zero check runs) does not
// trigger a workflow-run lookup or block readiness.
it("reports ready beside a cancelled or failed run that a later run replaced", () => {
  const result = run("superseded-beside-reported", ["--max-query-errors", "1"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ kind: "READY" });
  expect(
    result.calls.some((args) =>
      args.some((arg) => arg.includes("/actions/runs?head_sha=head"))
    )
  ).toBe(false);
});

it("blocks on a current startup failure with no reported check runs", () => {
  const result = run("startup-current", ["--max-query-errors", "1"]);
  expect(result.status).toBe(4);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "failing-checks",
      ci: { failed: [{ reportedState: "STARTUP_FAILURE" }] },
    },
  });
  expect(
    result.calls.some((args) =>
      args.some((arg) => arg.includes("/actions/runs?head_sha=head"))
    )
  ).toBe(true);
});

it("blocks on a current startup failure with no checks and does not duplicate it", () => {
  const result = run("no-ci-startup-current", ["--max-query-errors", "1"]);
  expect(result.status).toBe(4);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "failing-checks",
      ci: { failed: [{ reportedState: "STARTUP_FAILURE" }] },
    },
  });
  expect(JSON.parse(result.stdout.trim()).blocker.ci.failed).toHaveLength(1);
});

it("clears no-checks only for a same-identity success and ignores unrelated success", () => {
  const result = run("no-ci-startup-superseded", [
    "--status-only",
    "--max-query-errors",
    "1",
  ]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "STATUS",
    rows: [{ ci: { kind: "ci-unreported" } }],
  });
});

it("keeps a no-checks pending successor blocked", () => {
  const result = run("no-ci-startup-pending", ["--status-only"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "STATUS",
    rows: [{ ci: { kind: "ci-pending" } }],
  });
});

it("fails closed on no-checks workflow evidence that is racing or unavailable", () => {
  const result = run("no-ci-startup-racing", ["--max-query-errors", "1"]);
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    blocker: { kind: "status-query" },
  });
});

it("keeps a no-checks startup failure beside a later neutral run", () => {
  const result = run("no-ci-startup-neutral", ["--max-query-errors", "1"]);
  expect(result.status).toBe(4);
  expect(result.stdout).toContain("STARTUP_FAILURE");
});

it("keeps a newer pending workflow visible when its suite count is stale", () => {
  const result = run("reported-startup-pending", ["--status-only"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"kind":"ci-pending"');
});

it("exits 7 with a JSON verdict when gh is not on PATH", () => {
  const result = run("missing-gh", [], "/nonexistent");
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({
    kind: "BLOCKER",
    exitCode: 7,
    blocker: {
      kind: "status-query",
      failures: 1,
      failure: { kind: "spawn-failed", retryable: false },
    },
  });
});

it("cancels an in-flight command at the CLI deadline", () => {
  const result = run("slow", ["--timeout", "0.25"]);
  expect(result.status).toBe(5);
  expect(result.elapsed).toBeLessThan(1500);
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ kind: "TIMEOUT" });
  const pid = Number(readFileSync(result.pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
