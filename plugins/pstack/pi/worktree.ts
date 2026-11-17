import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";

export const worktreeSchema = Type.Object({ repo: Type.String(), path: Type.String(), branch: Type.String(), base: Type.String(), owner: Type.Optional(Type.String()) });
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
    owner: randomUUID(),
    path: join(repo, ".claude", "worktrees", `agent-${agentId}`),
    branch: `worktree-agent-${agentId}`,
    base: git(repo, ["rev-parse", "HEAD"]),
  };
}

// An existing path can be a leftover directory, a replacement repository, or
// a link to another checkout. None is permission to run an isolated writer there.
function assertWorktree(wt: Worktree, created = false): void {
  const invalid = () => new Error(`not the expected linked worktree: ${wt.path.slice(0, 200)}`);
  if (!lstatSync(wt.path).isDirectory()) throw invalid();
  const root = realpathSync(wt.path);
  if (root === realpathSync(wt.repo) || root !== realpathSync(git(wt.path, ["rev-parse", "--show-toplevel"]))) throw invalid();
  const commonDir = (cwd: string) => realpathSync(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (commonDir(wt.path) !== commonDir(wt.repo)) throw invalid();
  const registered = git(wt.repo, ["worktree", "list", "--porcelain", "-z"]).split("\0").some((field) => {
    if (!field.startsWith("worktree ")) return false;
    try {
      return realpathSync(field.slice("worktree ".length)) === root;
    } catch {
      return false;
    }
  });
  if (!registered) throw invalid();

  // The private Git directory stays with the registered worktree across moves and is deleted on removal.
  const marker = join(git(wt.path, ["rev-parse", "--absolute-git-dir"]), "pstack-owner");
  if (wt.owner) {
    if (created) writeFileSync(marker, wt.owner, { flag: "wx", mode: 0o600 });
    else if (!existsSync(marker) || readFileSync(marker, "utf8") !== wt.owner) throw invalid();
  } else if (git(wt.path, ["branch", "--show-current"]) !== wt.branch) {
    // Older session records have no owner marker. Only their recorded branch identifies a retained checkout.
    throw invalid();
  }
}

// Creates the worktree on first use and re-creates it for a resume after a
// clean finish removed it. A retained path is checked before any child starts.
export function ensureWorktree(wt: Worktree): void {
  const created = !existsSync(wt.path);
  if (created) {
    const branchExists = git(wt.repo, ["branch", "--list", wt.branch]) !== "";
    git(wt.repo, branchExists ? ["worktree", "add", wt.path, wt.branch] : ["worktree", "add", wt.path, "-b", wt.branch, wt.base]);
  }
  assertWorktree(wt, created);
}

// True when the agent left anything behind and the worktree stays. Ignored
// files count: a build the agent produced is its output too, and a fresh
// checkout has none. Commits are counted from the branch and from every
// commit HEAD's reflog visited, since an agent can commit on a detached HEAD
// and move away, which leaves the commit reachable only from the reflog.
export function settleWorktree(wt: Worktree): boolean {
  if (!existsSync(wt.path)) return false;
  assertWorktree(wt);
  // A display preference must not hide output from automatic cleanup.
  const dirty = git(wt.path, ["status", "--porcelain", "--untracked-files=normal", "--ignored"]) !== "";
  // The reflog goes in on stdin: a long one would overflow an argument list.
  const visited = git(wt.path, ["log", "-g", "--format=%H", "HEAD"]);
  const ahead = git(wt.path, ["rev-list", "--count", "--stdin"], `${visited}\nrefs/heads/${wt.branch}\n^${wt.base}\n`) !== "0";
  if (dirty || ahead) return true;
  git(wt.repo, ["worktree", "remove", wt.path]);
  git(wt.repo, ["branch", "-D", wt.branch]);
  return false;
}
