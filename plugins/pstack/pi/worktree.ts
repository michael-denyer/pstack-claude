import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";

export const worktreeSchema = Type.Object({ repo: Type.String(), path: Type.String(), branch: Type.String(), base: Type.String() });
export type Worktree = Static<typeof worktreeSchema>;

// The error message ends up in an agent's final text, so it stays short. The
// buffer is sized for a long reflog, which the default 1 MB is not.
function git(cwd: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ").slice(0, 200)} failed: ${(r.stderr || r.error?.message || "").trim().slice(0, 1000)}`);
  return r.stdout.trim();
}

export function planWorktree(cwd: string, agentId: string): Worktree {
  const repo = git(cwd, ["rev-parse", "--show-toplevel"]);
  return {
    repo,
    path: join(repo, ".claude", "worktrees", `agent-${agentId}`),
    branch: `worktree-agent-${agentId}`,
    base: git(repo, ["rev-parse", "HEAD"]),
  };
}

// Creates the worktree on first use and re-creates it for a resume after a
// clean finish removed it.
export function ensureWorktree(wt: Worktree): void {
  if (existsSync(wt.path)) return;
  const branchExists = git(wt.repo, ["branch", "--list", wt.branch]) !== "";
  git(wt.repo, branchExists ? ["worktree", "add", wt.path, wt.branch] : ["worktree", "add", wt.path, "-b", wt.branch, wt.base]);
}

// True when the agent left anything behind and the worktree stays. Ignored
// files count: a build the agent produced is its output too, and a fresh
// checkout has none. Commits are counted from the branch and from every
// commit HEAD's reflog visited, since an agent can commit on a detached HEAD
// and move away, which leaves the commit reachable only from the reflog.
export function settleWorktree(wt: Worktree): boolean {
  if (!existsSync(wt.path)) return false;
  const dirty = git(wt.path, ["status", "--porcelain", "--ignored"]) !== "";
  // The reflog goes in on stdin: a long one would overflow an argument list.
  const visited = git(wt.path, ["log", "-g", "--format=%H", "HEAD"]);
  const ahead = git(wt.path, ["rev-list", "--count", "--stdin"], `${visited}\nrefs/heads/${wt.branch}\n^${wt.base}\n`) !== "0";
  if (dirty || ahead) return true;
  git(wt.repo, ["worktree", "remove", wt.path]);
  git(wt.repo, ["branch", "-D", wt.branch]);
  return false;
}
