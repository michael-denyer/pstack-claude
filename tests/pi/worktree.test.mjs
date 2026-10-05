// settleWorktree against real git state: it must never drop a commit the agent
// made. Then the agent tool's worktree isolation over it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureWorktree, planWorktree, settleWorktree } from "../../plugins/pstack/pi/worktree.ts";
import { gitRepo, resultText, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

function commitIn(path, file) {
  writeFileSync(join(path, file), "important\n");
  for (const args of [["add", file], ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-m", `add ${file}`]]) {
    const r = spawnSync("git", args, { cwd: path, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  }
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).stdout.trim();
}

test("a commit on the agent branch is kept even when the worktree is detached at the base afterwards", () => {
  const { w } = setup();
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
  const { w } = setup();
  gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2b");
  ensureWorktree(wt);
  spawnSync("git", ["checkout", "--detach"], { cwd: wt.path });
  commitIn(wt.path, "work.txt");
  ensureWorktree(wt);

  expect(settleWorktree(wt)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
});

test("a commit made on a detached HEAD and left behind by checking the branch out again is kept, through the reflog", () => {
  const { w } = setup();
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
  const { w } = setup();
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
  const { w } = setup();
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
  const { w } = setup();
  const git = gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2c");
  ensureWorktree(wt);
  ensureWorktree(wt);

  expect(settleWorktree(wt)).toBe(false);
  expect(existsSync(wt.path)).toBe(false);
  expect(git("branch", "--list", wt.branch)).toBe("");
});

test("a cleanly removed worktree is re-created on resume, and a missing one needs no cleanup", () => {
  const { w } = setup();
  gitRepo(w.cwd);
  const wt = planWorktree(w.cwd, "c2g");
  expect(settleWorktree(wt)).toBe(false);
  ensureWorktree(wt);
  expect(settleWorktree(wt)).toBe(false);
  ensureWorktree(wt);
  expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, encoding: "utf8" }).stdout.trim()).toBe(wt.base);
});

test("a parent session already in a linked worktree gets its own child worktree", () => {
  const { w } = setup();
  const git = gitRepo(w.cwd);
  const parent = join(dirname(w.cwd), "parent-worktree");
  git("worktree", "add", "-q", "-b", "parent", parent);
  const wt = planWorktree(parent, "c2h");
  ensureWorktree(wt);
  ensureWorktree(wt);
  expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, encoding: "utf8" }).stdout.trim()).toBe(wt.base);
  expect(settleWorktree(wt)).toBe(false);
});

// Whatever sits at a retained path, only this agent's registered linked
// worktree may run a writer or be cleaned up.
describe("a path that is not the agent's linked worktree", () => {
  const rejected = (fn) => expect(fn).toThrow(/not the expected linked worktree/);
  const link = (target, path) => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  };
  const replaced = (git, wt) => {
    ensureWorktree(wt);
    git("worktree", "remove", wt.path);
    mkdirSync(wt.path, { recursive: true });
    writeFileSync(join(wt.path, "keep.txt"), "do not remove\n");
  };

  test("an ordinary directory, which git resolves to the primary checkout, is rejected", () => {
    const { w } = setup();
    gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id1");
    mkdirSync(wt.path, { recursive: true });
    expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: wt.path, encoding: "utf8" }).stdout.trim()).toBe(w.cwd);
    rejected(() => ensureWorktree(wt));
  });

  test("an unrelated repository is rejected and left as it was", () => {
    const { w } = setup();
    gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id2");
    mkdirSync(wt.path, { recursive: true });
    const other = gitRepo(wt.path);
    const head = other("rev-parse", "HEAD");
    rejected(() => ensureWorktree(wt));
    expect(other("rev-parse", "HEAD")).toBe(head);
  });

  test("a link to the primary checkout is rejected", () => {
    const { w } = setup();
    gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id3");
    link(w.cwd, wt.path);
    rejected(() => ensureWorktree(wt));
  });

  test("a link to another agent's worktree is rejected and that worktree survives", () => {
    const { w } = setup();
    gitRepo(w.cwd);
    const other = planWorktree(w.cwd, "id4-other");
    ensureWorktree(other);
    const wt = planWorktree(w.cwd, "id4");
    link(other.path, wt.path);
    rejected(() => ensureWorktree(wt));
    expect(existsSync(other.path)).toBe(true);
  });

  test("an unregistered gitdir file pointing at the primary repository is rejected", () => {
    const { w } = setup();
    gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id5");
    mkdirSync(wt.path, { recursive: true });
    writeFileSync(join(wt.path, ".git"), `gitdir: ${join(w.cwd, ".git").replaceAll("\\", "/")}\n`);
    rejected(() => ensureWorktree(wt));
  });

  test("a removed worktree replaced by a plain directory cannot be resumed, and its files stay", () => {
    const { w } = setup();
    const git = gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id6");
    replaced(git, wt);
    rejected(() => ensureWorktree(wt));
    expect(readFileSync(join(wt.path, "keep.txt"), "utf8")).toBe("do not remove\n");
  });

  test("cleanup refuses a replacement directory without deleting its files or the branch", () => {
    const { w } = setup();
    const git = gitRepo(w.cwd);
    const wt = planWorktree(w.cwd, "id7");
    replaced(git, wt);
    rejected(() => settleWorktree(wt));
    expect(readFileSync(join(wt.path, "keep.txt"), "utf8")).toBe("do not remove\n");
    expect(git("branch", "--list", wt.branch)).toContain(wt.branch);
  });
});

describe("worktree isolation", () => {
  test("runs in its own worktree and removes it when the agent changed nothing", async () => {
    const { w, pi, ctx } = setup();
    const git = gitRepo(w.cwd);
    const result = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const id = result.details.agentId;
    const path = join(w.cwd, ".claude", "worktrees", `agent-${id}`);
    expect(w.invocations()[0].cwd).toBe(path);
    expect(resultText(result)).toContain("no changes; removed");
    expect(existsSync(path)).toBe(false);
    expect(git("branch", "--list", `worktree-agent-${id}`)).toBe("");
  });

  test("keeps a worktree with changes and reports its path and branch", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ touch: "new-file" }, { reply: "wrote" }] } });
    const git = gitRepo(w.cwd);
    const result = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const id = result.details.agentId;
    const path = join(w.cwd, ".claude", "worktrees", `agent-${id}`);
    expect(resultText(result)).toContain(`worktree: ${path} (branch worktree-agent-${id})`);
    expect(existsSync(join(path, "new-file"))).toBe(true);
    expect(git("branch", "--list", `worktree-agent-${id}`)).toContain(`worktree-agent-${id}`);
  });

  test("a failed agent's worktree with changes is kept and reported like a completed one's", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ touch: "partial" }, { exit: 3 }] } });
    gitRepo(w.cwd);
    const result = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const path = join(w.cwd, ".claude", "worktrees", `agent-${result.details.agentId}`);
    expect(result.details.status).toBe("failed");
    expect(resultText(result)).toContain(`worktree: ${path} (branch worktree-agent-${result.details.agentId})`);
    expect(existsSync(join(path, "partial"))).toBe(true);
  });

  test("a resume whose worktree cannot be re-created fails with a notice", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ touch: "kept" }, { reply: "ok" }] } });
    gitRepo(w.cwd);
    const { details } = await pi.call("agent", { description: "w", prompt: "first", isolation: "worktree" }, ctx);
    rmSync(w.invocations()[0].cwd, { recursive: true, force: true });

    const err = await pi.call("send_message", { to: details.agentId, message: "again" }, ctx).catch((e) => e);
    expect(err.message).toContain("git worktree add");
    await waitFor(() => pi.entries.at(-1).data.status === "failed");
    expect(pi.entries.at(-1).data.finalText).toContain("git worktree add");
    expect(w.invocations()).toHaveLength(1);
  });

  test("outside a git repo it is an error and nothing runs", async () => {
    const { w, pi, ctx } = setup();
    mkdirSync(join(w.cwd, "sub"));
    const err = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, { ...ctx, cwd: join(w.cwd, "sub") }).catch((e) => e);
    expect(err.message).toContain("git rev-parse");
    expect(w.invocations()).toEqual([]);
  });
});
