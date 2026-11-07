import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

function withRepo(run, trunk = "main") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-audit-regression-")));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const wt = join(root, "worktree");
  const transcripts = join(root, "transcripts");
  const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(repo);
    mkdirSync(transcripts);
    git(root, "init", "--bare", `--initial-branch=${trunk}`, origin);
    git(repo, "init", `--initial-branch=${trunk}`);
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    git(repo, "commit", "--allow-empty", "-m", "base");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", trunk);
    git(repo, "worktree", "add", "-b", "topic", wt);
    const row = (prs = []) => {
      const warnings = [];
      const output = audit({ repo, transcripts: [transcripts], gh: () => JSON.stringify(prs), warn: (s) => warnings.push(s) });
      assert.deepEqual(warnings, []);
      const [header, line] = output.trimEnd().split("\n");
      return Object.fromEntries(header.split("\t").map((name, i) => [name, line.split("\t")[i]]));
    };
    run({ root, repo, origin, wt, transcripts, git, row, trunk });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const state of ["CLOSED", "MERGED"]) {
  test(`an older open PR is held even when a newer ${state} PR matches first`, () => withRepo(({ wt, git, row }) => {
    const headRefOid = git(wt, "rev-parse", "HEAD");
    const result = row([
      { number: 12, state, headRefName: "topic", headRefOid },
      { number: 11, state: "OPEN", headRefName: "topic", headRefOid },
    ]);
    assert.equal(result.BUCKET, "hold-open-pr");
    assert.equal(result.PR, "#11/OPEN");
  }));
}

test("an open PR already first in the response remains held", () => withRepo(({ row }) => {
  const result = row([
    { number: 12, state: "OPEN", headRefName: "topic" },
    { number: 11, state: "CLOSED", headRefName: "topic" },
  ]);
  assert.equal(result.BUCKET, "hold-open-pr");
  assert.equal(result.PR, "#12/OPEN");
}));

test("an unrelated open PR does not hold a clean branch", () => withRepo(({ row }) => {
  const result = row([
    { number: 12, state: "OPEN", headRefName: "topic-other" },
    { number: 11, state: "CLOSED", headRefName: "topic" },
  ]);
  assert.equal(result.BUCKET, "safe");
  assert.equal(result.PR, "#11/CLOSED");
}));

test("without an open PR, the first matching record stays authoritative", () => withRepo(({ wt, git, row }) => {
  git(wt, "commit", "--allow-empty", "-m", "not on trunk");
  const headRefOid = git(wt, "rev-parse", "HEAD");
  const result = row([
    { number: 12, state: "CLOSED", headRefName: "topic", headRefOid },
    { number: 11, state: "MERGED", headRefName: "topic", headRefOid },
  ]);
  assert.equal(result.BUCKET, "review");
  assert.equal(result.PR, "#12/CLOSED");
}));

test("a detached worktree does not pick a branch's open PR", () => withRepo(({ wt, git, row }) => {
  git(wt, "checkout", "--detach");
  const result = row([{ number: 12, state: "OPEN", headRefName: "topic" }]);
  assert.equal(result.BUCKET, "safe");
  assert.equal(result.PR, "-");
}));

test("untracked output keeps its stronger hold when a later PR is open", () => withRepo(({ wt, row }) => {
  writeFileSync(join(wt, "output.txt"), "keep me");
  const result = row([
    { number: 12, state: "CLOSED", headRefName: "topic" },
    { number: 11, state: "OPEN", headRefName: "topic" },
  ]);
  assert.equal(result.BUCKET, "hold-untracked");
  assert.equal(result.PR, "#11/OPEN");
}));
