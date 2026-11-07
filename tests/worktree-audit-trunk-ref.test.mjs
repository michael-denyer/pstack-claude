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

for (const kind of ["tag", "branch"]) {
  test(`a ${kind} named origin/main cannot make an unmerged worktree safe`, () => withRepo(({ repo, wt, git, row }) => {
    git(wt, "commit", "--allow-empty", "-m", "unmerged work");
    git(repo, kind, "origin/main", "refs/heads/topic");
    const result = row();
    assert.equal(result.MERGED, "no");
    assert.equal(result.BUCKET, "review");
  }));
}

test("an annotated tag cannot shadow the advertised non-main trunk", () => withRepo(({ repo, wt, git, row, trunk }) => {
  git(wt, "commit", "--allow-empty", "-m", "unmerged work");
  git(repo, "tag", "-a", `origin/${trunk}`, "refs/heads/topic", "-m", "tag, not trunk");
  assert.equal(row().BUCKET, "review");
}, "release/trunk"));

test("a stale tag cannot hide a real trunk merge", () => withRepo(({ repo, wt, git, row }) => {
  git(repo, "tag", "origin/main");
  git(wt, "commit", "--allow-empty", "-m", "landed work");
  git(repo, "merge", "--ff-only", "refs/heads/topic");
  git(repo, "push", "origin", "main");
  const result = row();
  assert.equal(result.MERGED, "YES");
  assert.equal(result.BUCKET, "safe");
}));

test("an unmerged branch without a colliding ref still needs review", () => withRepo(({ wt, git, row }) => {
  git(wt, "commit", "--allow-empty", "-m", "unmerged work");
  assert.equal(row().BUCKET, "review");
}));

test("a clean trunk ancestor without a collision remains safe", () => withRepo(({ row }) => {
  assert.equal(row().BUCKET, "safe");
}));
