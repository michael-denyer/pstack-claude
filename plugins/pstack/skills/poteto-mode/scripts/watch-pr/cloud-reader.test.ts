// watch-pr in a Claude Code cloud session: GraphQL and gh pr checks are
// refused, REST answers. The fake gh serves the REST shapes GitHub returned for
// PR 528 on 2026-11-23, and the proxy's ccr/review_threads route in the shape
// a cloud session returned for PR 529 that day.
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

const FAKE_GH = `
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const scenario = process.env.WATCH_FIXTURE;
appendFileSync(process.env.WATCH_CALLS, JSON.stringify(args) + '\\n');
const refuse = () => {
  // gh 2.105 prints a hint block on stderr before the error.
  console.error('hint: if you need to wait for this pull request to be reviewed, use gh event listen');
  console.error('gh: GitHub GraphQL is not available from Claude Code sessions; use the REST API (gh api repos/{owner}/{repo}/...). (HTTP 403)');
  process.exit(1);
};
if ((args[0] === 'api' && args[1] === 'graphql') || args[0] === 'pr') refuse();
const path = args.filter(a => !a.startsWith('--')).slice(1).join(' ');
const prefix = 'repos/owner/repo/';
const run = (name, conclusion, suite = 1, started = '2026-11-23T10:00:00Z') => ({ name, status: conclusion ? 'completed' : 'in_progress', conclusion: conclusion ?? null, details_url: 'https://github.com/owner/repo/actions/runs/' + suite + '/job/' + name, started_at: started, check_suite: { id: suite }, app: { slug: 'github-actions' } });
let value;
if (path === prefix + 'pulls/1') {
  value = { state: 'open', merged_at: null, draft: false, mergeable: true,
    mergeable_state: scenario === 'blocked' ? 'blocked' : 'clean',
    head: { sha: 'head', ref: 'feature', repo: { name: 'repo', owner: { login: 'owner' } } },
    base: { ref: 'main', sha: 'base' } };
} else if (path === prefix + 'pulls/1/reviews?per_page=100') {
  value = scenario === 'full-page'
    ? [Array.from({ length: 100 }, () => ({ user: { login: 'reviewer' }, state: 'APPROVED' }))]
    : [[
      { user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'reviewer' }, state: scenario === 'changes-requested' ? 'COMMENTED' : 'APPROVED' },
    ]];
} else if (path === prefix + 'git/ref/heads/main') {
  value = { object: { sha: 'base' } };
} else if (path === prefix + 'commits/head/check-runs?per_page=100') {
  const runs = scenario === 'failing' ? [run('build', 'success'), run('test', 'failure')]
    : scenario === 'pending' ? [run('build', 'success'), run('test')]
    // A cancelled run of a workflow run that a newer one of the same workflow and event replaced.
    : scenario === 'replaced' ? [run('build', 'cancelled', 2, '2026-11-23T09:00:00Z'), run('build', 'success'), run('test', 'success')]
    // Two jobs of one workflow run, started in the same second, one still running.
    : scenario === 'tie' ? [run('build', 'success'), run('build'), run('test', 'success')]
    : scenario === 'codeql' ? [run('build', 'success'), run('test', 'success'), run('Analyze (javascript)', null, 3)]
    : scenario === 'copilot-agent' ? [run('build', 'success'), run('test', 'success'), run('copilot-pull-request-reviewer', null, 4)]
    : [run('build', 'success'), run('test', 'success')];
  value = [{ total_count: scenario === 'short-page' ? runs.length + 1 : runs.length, check_runs: runs }];
} else if (path === prefix + 'actions/runs?head_sha=head&per_page=100') {
  value = [{ total_count: 4, workflow_runs: [
    { id: 1, check_suite_id: 1, name: 'CI', event: 'pull_request', path: '.github/workflows/ci.yml' },
    { id: 2, check_suite_id: 2, name: 'CI', event: 'pull_request', path: '.github/workflows/ci.yml' },
    { id: 3, check_suite_id: 3, name: 'CodeQL', event: 'dynamic', path: 'dynamic/github-code-scanning/codeql' },
    { id: 4, check_suite_id: 4, name: 'Running Copilot Code Review', event: 'dynamic', path: 'dynamic/agents/copilot-pull-request-reviewer' },
  ] }];
} else if (path === prefix + 'commits/head/status?per_page=100') {
  value = [{ state: 'pending', total_count: 0, statuses: [] }];
} else if (path === prefix + 'pulls/1/ccr/review_threads') {
  const thread = { resolved: scenario !== 'unresolved', outdated: false, path: 'a.ts', line: 3, comment_ids: [11] };
  value = scenario === 'thread-shape' ? { threads: [thread] } : [thread];
} else if (path === prefix + 'pulls/1/comments?per_page=100') {
  const comment = (id) => ({ id, in_reply_to_id: null, body: 'Handle the empty list', created_at: '2026-11-23T10:15:30Z', path: 'a.ts', line: 3, user: { login: 'reviewer' } });
  // 12 starts a thread the route did not return.
  value = [scenario === 'missing-thread' ? [comment(11), comment(12)] : [comment(11)]];
} else if (path === prefix + 'commits/head/check-suites?per_page=100') {
  value = [{ total_count: 1, check_suites: [{ id: 1, head_sha: 'head', status: 'completed', conclusion: 'success', app: { slug: 'github-actions', name: 'GitHub Actions' }, latest_check_runs_count: 2 }] }];
} else { console.error('unexpected fixture command: ' + JSON.stringify(args)); process.exit(1); }
console.log(JSON.stringify(value));
`;

function watch(scenario: string, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "watch-cloud-"));
  directories.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!${process.execPath}\n${FAKE_GH}`);
  chmodSync(join(bin, "gh"), 0o755);
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { main } from ${JSON.stringify(join(import.meta.dir, "cli.ts"))}; process.exitCode = await main(process.argv.slice(2));\n`
  );
  const callsFile = join(dir, "calls.jsonl");
  writeFileSync(callsFile, "");
  const result = spawnSync(
    process.execPath,
    [
      entry,
      "--owner",
      "owner",
      "--repo",
      "repo",
      "--pr",
      "1",
      "--timeout",
      "2",
      ...extra,
    ],
    {
      encoding: "utf8",
      timeout: 6000,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        WATCH_FIXTURE: scenario,
        WATCH_CALLS: callsFile,
      },
    }
  );
  const calls = readFileSync(callsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  const out = result.stdout.trim().split("\n");
  return {
    status: result.status,
    verdict: JSON.parse(out[out.length - 1]),
    calls,
  };
}

it("reads the PR over REST after the session refuses GraphQL, and asks GraphQL once", () => {
  const { status, verdict, calls } = watch("clean", ["--status-only"]);
  expect(status).toBe(0);
  expect(verdict.kind).toBe("STATUS");
  expect(verdict.rows[0]).toMatchObject({
    facts: {
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      headRefOid: "head",
      baseRefOid: "base",
      state: "OPEN",
      isDraft: false,
    },
    threads: [],
    ci: { kind: "ci-clean", failed: [], pending: [] },
  });
  expect(
    verdict.rows[0].ci.all.map((check: { name: string }) => check.name)
  ).toEqual(["build", "test"]);
  expect(
    calls.filter((args) => args[1] === "graphql" || args[0] === "pr")
  ).toHaveLength(1);
});

it("reports a clean PR with resolved threads as ready", () => {
  const { status, verdict } = watch("clean");
  expect(status).toBe(0);
  expect(verdict.kind).toBe("READY");
});

it("keeps an unresolved thread from the proxy's route, with its first comment", () => {
  const { verdict } = watch("unresolved", ["--status-only"]);
  expect(verdict.rows[0].threads).toEqual([
    expect.objectContaining({
      id: "comment-11",
      firstComment: expect.objectContaining({
        authorLogin: "reviewer",
        body: "Handle the empty list",
        path: "a.ts",
        line: 3,
      }),
    }),
  ]);
  expect(watch("unresolved").verdict.kind).not.toBe("READY");
});

it("a reviewer's later approval replaces their earlier request for changes, and a comment does not", () => {
  expect(
    watch("clean", ["--status-only"]).verdict.rows[0].facts.reviewDecision
  ).toBe("APPROVED");
  expect(
    watch("changes-requested", ["--status-only"]).verdict.rows[0].facts
      .reviewDecision
  ).toBe("CHANGES_REQUESTED");
});

it("reports failing and pending check runs from REST", () => {
  expect(watch("failing", ["--status-only"]).verdict.rows[0].ci).toMatchObject({
    kind: "ci-failing",
    failed: [expect.objectContaining({ name: "test" })],
  });
  expect(watch("pending", ["--status-only"]).verdict.rows[0].ci).toMatchObject({
    kind: "ci-pending",
    pending: [expect.objectContaining({ name: "test" })],
  });
});

it("keeps only the newest run per name, workflow, and event, as gh pr checks does", () => {
  const { verdict } = watch("replaced", ["--status-only"]);
  expect(verdict.rows[0].ci).toMatchObject({ kind: "ci-clean", failed: [] });
  expect(
    verdict.rows[0].ci.all.map(
      (check: { name: string; workflow: string }) =>
        `${check.name}/${check.workflow}`
    )
  ).toEqual(["build/CI", "test/CI"]);
});

it("counts CodeQL's dynamic workflow, as GitHub's rollup does, and leaves out Copilot's review agent", () => {
  expect(watch("codeql", ["--status-only"]).verdict.rows[0].ci).toMatchObject({
    kind: "ci-pending",
    pending: [expect.objectContaining({ name: "Analyze (javascript)" })],
  });
  expect(
    watch("copilot-agent", ["--status-only"]).verdict.rows[0].ci
  ).toMatchObject({ kind: "ci-clean" });
});

it("a same-second tie between jobs of one workflow run goes to the one still running", () => {
  expect(watch("tie", ["--status-only"]).verdict.rows[0].ci).toMatchObject({
    kind: "ci-pending",
    pending: [expect.objectContaining({ name: "build" })],
  });
});

it("never reports ready when a thread is missing from the route or a list page is full", () => {
  for (const [scenario, detail] of [
    ["missing-thread", "review comment 12"],
    ["full-page", "the last page is full"],
  ] as const) {
    const { verdict } = watch(scenario);
    expect({ scenario, kind: verdict.kind }).not.toEqual({
      scenario,
      kind: "READY",
    });
    expect(JSON.stringify(verdict)).toContain(detail);
  }
});

it("never reports ready when a page is short or the thread route has another shape", () => {
  for (const scenario of ["short-page", "thread-shape"]) {
    const { verdict } = watch(scenario);
    expect({ scenario, kind: verdict.kind }).not.toEqual({
      scenario,
      kind: "READY",
    });
    expect(JSON.stringify(verdict)).toContain(
      scenario === "short-page" ? "total_count" : "ccr/review_threads"
    );
  }
});

it("a blocked merge state stays a merge gate over REST", () => {
  const { verdict } = watch("blocked");
  expect(verdict.kind).not.toBe("READY");
  expect(JSON.stringify(verdict)).toContain("merge-blocked");
});
