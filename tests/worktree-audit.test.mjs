import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { audit, classify } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs");

const known = (value) => ({ known: true, value });
const unknown = { known: false };
const HEAD = "a".repeat(40);

describe("classify", () => {
  const ancestor = {
    trunk: known(true),
    head: known(HEAD),
    age: known(3),
    ancestry: known(true),
    dirty: known({ wip: 0, scratch: 0 }),
    remote: known("pushed"),
    pr: known(null),
    recent: known(false),
  };
  const mergedPr = { ...ancestor, ancestry: known(false), pr: known({ number: 8, state: "MERGED", headRefOid: HEAD }) };
  const allUnknown = Object.fromEntries(Object.keys(ancestor).map((name) => [name, unknown]));
  const wip = known({ wip: 1, scratch: 0 });
  const openPr = known({ number: 7, state: "OPEN", headRefOid: HEAD });

  test.each([
    ["an ancestor of the trunk", ancestor, "safe"],
    ["an ancestor with only untracked scratch", { ...ancestor, dirty: known({ wip: 0, scratch: 2 }) }, "safe"],
    ["a merged PR whose head is the worktree HEAD", mergedPr, "safe"],
    ["commits beyond a merged PR head", { ...mergedPr, head: known("b".repeat(40)) }, "review"],
    ["a closed PR whose head is the worktree HEAD", { ...mergedPr, pr: known({ number: 9, state: "CLOSED", headRefOid: HEAD }) }, "review"],
    ["neither an ancestor nor a merged PR", { ...ancestor, ancestry: known(false) }, "review"],
    ["tracked uncommitted work", { ...ancestor, dirty: wip }, "hold-wip"],
    ["an open PR", { ...ancestor, pr: openPr }, "hold-open-pr"],
    ["a chat within four days", { ...ancestor, recent: known(true) }, "verify-recent-chat"],
    ["tracked work with an open PR and a recent chat", { ...ancestor, dirty: wip, pr: openPr, recent: known(true) }, "hold-wip"],
    ["an open PR with a recent chat", { ...ancestor, pr: openPr, recent: known(true) }, "hold-open-pr"],
    ["tracked work while every other fact is unknown", { ...allUnknown, dirty: wip }, "hold-wip"],
    ["an open PR while every other fact is unknown", { ...allUnknown, pr: openPr }, "hold-open-pr"],
    ["a recent chat while every other fact is unknown", { ...allUnknown, recent: known(true) }, "verify-recent-chat"],
  ])("%s -> %s", (_, facts, bucket) => {
    expect(classify(facts)).toBe(bucket);
  });

  for (const [label, facts] of [["ancestor", ancestor], ["merged PR", mergedPr]]) {
    for (const name of Object.keys(facts)) {
      test(`an unknown ${name} keeps a ${label} out of safe`, () => {
        expect(classify({ ...facts, [name]: unknown })).toBe("review");
      });
    }
  }
});

const fixtures = [];
const locked = [];
afterEach(() => {
  for (const path of locked.splice(0)) chmodSync(path, 0o755);
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(worktree, message, content = `${message}\n`) {
  const file = `${message.replaceAll(" ", "-")}.txt`;
  writeFileSync(join(worktree, file), content);
  git("-C", worktree, "add", file);
  git("-C", worktree, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
}

// A seed repo with a bare remote and a clone, so trunk resolution and the fetch run for real.
function createFixture({ trunk = "main", cloneArgs = [] } = {}) {
  // git reports resolved worktree paths; macOS tmpdir() sits behind the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-test-")));
  fixtures.push(root);
  const seed = join(root, "seed");
  git("init", `--initial-branch=${trunk}`, seed);
  commit(seed, "base");
  git("-C", seed, "branch", "other");
  const remote = join(root, "remote.git");
  git("clone", "--bare", seed, remote);
  const repo = join(root, "repo");
  git("clone", ...cloneArgs, remote, repo);
  const transcripts = join(root, "transcripts");
  mkdirSync(transcripts);
  return { root, repo, remote, transcripts };
}

function addWorktree(fixture, name, ...args) {
  const path = join(fixture.root, name);
  git("-C", fixture.repo, "worktree", "add", ...(args.length ? args : ["-b", name]), path);
  return path;
}

function writeTranscript(fixture, rel, worktree, mtimeSeconds) {
  const path = join(fixture.transcripts, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ type: "user", cwd: worktree })}\n`);
  if (mtimeSeconds) utimesSync(path, mtimeSeconds, mtimeSeconds);
}

function runAudit(fixture, { prs = [], gh, transcripts = fixture.transcripts } = {}) {
  const warnings = [];
  const calls = [];
  const output = audit({
    repo: fixture.repo,
    transcripts,
    warn: (line) => warnings.push(line),
    gh: gh ?? ((args, cwd) => {
      calls.push({ args, cwd });
      return JSON.stringify(prs);
    }),
  });
  const [header, ...lines] = output.trimEnd().split("\n");
  return { header, rows: lines.map((line) => line.split("\t")), warnings, calls };
}

const rowFor = (rows, worktree) => rows.find((row) => row.at(-1) === worktree);
const ymd = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
const head = (worktree) => git("-C", worktree, "rev-parse", "HEAD");

test("audits every worktree of a fixture repo end to end", () => {
  const fixture = createFixture();
  const now = Math.floor(Date.now() / 1000);

  const ancestor = addWorktree(fixture, "ancestor");
  const spaced = addWorktree(fixture, "with spaces", "-b", "spaced");
  const detached = addWorktree(fixture, "detached", "--detach");
  const landed = addWorktree(fixture, "landed");
  commit(landed, "landed on trunk");
  git("-C", landed, "push", "origin", "HEAD:main");
  const merged = addWorktree(fixture, "merged");
  commit(merged, "squash merged", "x".repeat(512 * 1024));
  git("-C", merged, "push", "origin", "merged");
  const open = addWorktree(fixture, "open");
  const dirty = addWorktree(fixture, "dirty");
  commit(dirty, "tracked");
  writeFileSync(join(dirty, "tracked.txt"), "changed\n");
  const scratch = addWorktree(fixture, "scratch");
  writeFileSync(join(scratch, "notes.txt"), "scratch\n");
  const chatted = addWorktree(fixture, "chatted-long");
  const prefix = addWorktree(fixture, "chatted");
  writeTranscript(fixture, "-proj/session/subagents/workflows/wf_1/agent-a.jsonl", chatted);
  const stale = addWorktree(fixture, "stale");
  const staleAt = now - 10 * 86400;
  writeTranscript(fixture, "-proj/old.jsonl", stale, staleAt);
  const broken = addWorktree(fixture, "broken");
  chmodSync(join(fixture.repo, ".git/worktrees/broken/index"), 0o000);
  const gone = addWorktree(fixture, "gone");
  rmSync(gone, { recursive: true });

  const { header, rows, warnings, calls } = runAudit(fixture, {
    prs: [
      { number: 7, state: "OPEN", headRefName: "open", headRefOid: head(open) },
      { number: 8, state: "MERGED", headRefName: "merged", headRefOid: head(merged) },
    ],
  });

  expect(header).toBe("SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE");
  expect(warnings).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0].args.join(" ")).toContain("--state all");
  expect(rows[0].at(-1)).toBe(merged);
  const today = ymd(now);
  const columns = (worktree) => rowFor(rows, worktree).slice(1);
  expect(columns(ancestor)).toEqual(["0d", "YES", "clean", "no-remote", "-", "-", "safe", ancestor]);
  expect(columns(spaced)).toEqual(["0d", "YES", "clean", "no-remote", "-", "-", "safe", spaced]);
  expect(columns(detached)).toEqual(["0d", "YES", "clean", "detached", "-", "-", "safe", detached]);
  expect(columns(landed)).toEqual(["0d", "YES", "clean", "no-remote", "-", "-", "safe", landed]);
  expect(columns(merged)).toEqual(["0d", "no", "clean", "pushed", "#8/MERGED", "-", "safe", merged]);
  expect(columns(open)).toEqual(["0d", "YES", "clean", "no-remote", "#7/OPEN", "-", "hold-open-pr", open]);
  expect(columns(dirty)).toEqual(["0d", "no", "wip:1", "no-remote", "-", "-", "hold-wip", dirty]);
  expect(columns(scratch)).toEqual(["0d", "YES", "scratch:1", "no-remote", "-", "-", "safe", scratch]);
  expect(columns(chatted)).toEqual(["0d", "YES", "clean", "no-remote", "-", today, "verify-recent-chat", chatted]);
  expect(columns(prefix)).toEqual(["0d", "YES", "clean", "no-remote", "-", "-", "safe", prefix]);
  expect(columns(stale)).toEqual(["0d", "YES", "clean", "no-remote", "-", ymd(staleAt), "safe", stale]);
  expect(columns(broken)).toEqual(["0d", "YES", "unknown", "no-remote", "-", "-", "review", broken]);
  expect(rowFor(rows, gone)).toEqual(["-", "?", "-", "-", "-", "-", "-", "prunable", gone]);
  expect(rows).toHaveLength(13);
});

describe("a discovery failure keeps an ancestor out of safe", () => {
  const failures = [
    ["the trunk fetch", (fixture) => {
      git("-C", fixture.repo, "remote", "set-url", "origin", join(fixture.root, "missing.git"));
      return {};
    }, /could not fetch origin\/main/],
    ["gh", () => ({ gh: () => { throw new Error("gh: not logged in"); } }), /gh pr list failed.*not logged in/],
    ["gh output that is not JSON", () => ({ gh: () => "rate limited" }), /gh pr list failed/],
    ["gh output that is not a list", () => ({ gh: () => "{}" }), /gh pr list failed/],
    ["a missing transcripts directory", (fixture) => ({ transcripts: join(fixture.root, "absent") }), /absent not found/],
    ["an unreadable transcripts directory", (fixture) => {
      const project = join(fixture.transcripts, "-proj");
      mkdirSync(project);
      chmodSync(project, 0o000);
      locked.push(project);
      return {};
    }, /transcript scan failed/],
  ];

  test.each(failures)("%s", (_, inject, warning) => {
    const fixture = createFixture();
    const ancestor = addWorktree(fixture, "ancestor");
    const { rows, warnings } = runAudit(fixture, inject(fixture));
    const row = rowFor(rows, ancestor);
    expect(row[2]).toBe("YES");
    expect(row[7]).toBe("review");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(warning);
  });
});

describe("the trunk comes from the remote", () => {
  const assertAncestorSafe = (fixture) => {
    const ancestor = addWorktree(fixture, "ancestor");
    const { rows, warnings } = runAudit(fixture);
    expect(warnings).toEqual([]);
    const row = rowFor(rows, ancestor);
    expect([row[2], row[7]]).toEqual(["YES", "safe"]);
  };

  for (const cachedHead of [true, false]) {
    test(`a non-main trunk with cached HEAD ${cachedHead}`, () => {
      const fixture = createFixture({ trunk: "release" });
      if (!cachedHead) git("-C", fixture.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      assertAncestorSafe(fixture);
    });
  }

  test("a trunk the single-branch clone does not track", () => {
    const fixture = createFixture({ trunk: "release", cloneArgs: ["--single-branch", "--branch", "other"] });
    expect(git("-C", fixture.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/release")).toBe("");
    assertAncestorSafe(fixture);
  });

  test("main when the remote advertises an unknown HEAD", () => {
    const fixture = createFixture();
    git("--git-dir", fixture.remote, "symbolic-ref", "HEAD", "refs/heads/missing");
    git("-C", fixture.repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    assertAncestorSafe(fixture);
  });
});

test("the CLI exits 1 outside a git repo", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-outside-")));
  fixtures.push(outside);
  const result = spawnSync("node", [script, outside, outside], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("not in a git repo; pass a repo path\n");
});
