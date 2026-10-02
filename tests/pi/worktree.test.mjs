// settleWorktree against real git state: it must never drop a commit the agent made.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureWorktree, planWorktree, settleWorktree } from "../../plugins/pstack/pi/worktree.ts";
import { gitRepo, world } from "./harness.mjs";

let w;
afterEach(() => w?.cleanup());

function commitIn(path, file) {
  writeFileSync(join(path, file), "important\n");
  for (const args of [["add", file], ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-m", `add ${file}`]]) {
    const r = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).stdout.trim();
}

test("a commit on the agent branch is kept even when the worktree is detached at the base afterwards", () => {
  w = world();
  const git = gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2");
  ensureWorktree(wt);
  const sha = commitIn(wt.path, "work.txt");
  spawnSync("git", ["checkout", "--detach", wt.base], { cwd: wt.path });

  expect(settleWorktree(wt)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
  expect(git("branch", "--list", wt.branch)).toContain(wt.branch);
  expect(git("branch", "--contains", sha)).toContain(wt.branch);
});

test("a commit on a detached HEAD inside the worktree keeps it too", () => {
  w = world();
  gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2b");
  ensureWorktree(wt);
  spawnSync("git", ["checkout", "--detach"], { cwd: wt.path });
  commitIn(wt.path, "work.txt");

  expect(settleWorktree(wt)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
});

test("a commit made on a detached HEAD and left behind by checking the branch out again is kept, through the reflog", () => {
  w = world();
  gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2d");
  ensureWorktree(wt);
  spawnSync("git", ["checkout", "--detach"], { cwd: wt.path });
  const sha = commitIn(wt.path, "work.txt");
  spawnSync("git", ["checkout", wt.branch], { cwd: wt.path });
  expect(spawnSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: wt.path, encoding: "utf8" }).stdout.trim()).toBe(wt.branch);
  expect(spawnSync("git", ["branch", "--contains", sha], { cwd: wt.path, encoding: "utf8" }).stdout.trim()).toBe("");

  expect(settleWorktree(wt)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
  expect(spawnSync("git", ["cat-file", "-t", sha], { cwd: w.cwd }).status).toBe(0);
});

test("output written only to a gitignored path keeps the worktree", () => {
  w = world();
  const git = gitRepo(w.cwd);
  writeFileSync(join(w.cwd, ".gitignore"), "build/\n");
  git("add", ".gitignore");
  git("commit", "-q", "-m", "ignore build");
  const wt = planWorktree(w.cwd, "c2e");
  ensureWorktree(wt);
  mkdirSync(join(wt.path, "build"));
  writeFileSync(join(wt.path, "build", "out.bin"), "x");

  expect(settleWorktree(wt)).toBe(true);
  expect(existsSync(join(wt.path, "build", "out.bin"))).toBe(true);
});

test("a reflog longer than an argument list allows still settles, and a git error names only a short command", () => {
  w = world();
  gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2f");
  ensureWorktree(wt);
  const logFile = spawnSync("git", ["rev-parse", "--git-path", "logs/HEAD"], { cwd: wt.path, encoding: "utf8" }).stdout.trim();
  const entry = `${wt.base} ${wt.base} t <t@example.com> 1700000000 +0000\tcheckout: moving\n`;
  appendFileSync(logFile, entry.repeat(40000));
  // 25 000 forty-character ids is over a megabyte, past the argument limit.
  expect(spawnSync("git", ["log", "-g", "--format=%H", "HEAD"], { cwd: wt.path, encoding: "utf8" }).stdout.split("\n").length).toBeGreaterThan(25000);

  expect(settleWorktree(wt)).toBe(false);
  expect(existsSync(wt.path)).toBe(false);

  const err = (() => {
    try {
      settleWorktree({ ...wt, path: w.cwd, branch: "no-such-branch" });
    } catch (e) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err.message.length).toBeLessThan(400);
});

test("a clean worktree still on its branch at the base is removed with its branch", () => {
  w = world();
  const git = gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2c");
  ensureWorktree(wt);

  expect(settleWorktree(wt)).toBe(false);
  expect(existsSync(wt.path)).toBe(false);
  expect(git("branch", "--list", wt.branch)).toBe("");
});
