#!/usr/bin/env node
// Read-only worktree prune audit. Classifies every git worktree by size, merge
// state, uncommitted work, remote/PR state, and the most recent chat that
// operated in it, then prints a table sorted by size with a suggested bucket.
// Never deletes anything; deletion stays a human-gated step in the playbook.
//
//   node worktree-audit.mjs [repo-path] [transcripts-path ...]
//
// Without a transcripts path it scans every runtime's transcripts directory
// that exists: Claude Code's projects under $CLAUDE_CONFIG_DIR, Codex's sessions
// and archived_sessions under $CODEX_HOME, and Pi's sessions and pstack subagent
// sessions under $PI_CODING_AGENT_DIR (defaults: ~/.claude, ~/.codex, ~/.pi/agent).
//
// Every probe yields a Fact, { known: true, value } or { known: false }. A hold
// bucket needs only its own fact; `safe` needs every fact known.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { candidates, rethrowUnlessRemoved } from "../../reflect/scripts/find-transcript.mjs";

const known = (value) => ({ known: true, value });
const UNKNOWN = Object.freeze({ known: false });
const probe = (read) => {
  try {
    return known(read());
  } catch {
    return UNKNOWN;
  }
};
const bind = (fact, next) => (fact.known ? next(fact.value) : UNKNOWN);

const DAY = 86400;
const RECENT_DAYS = 4;
const HEADER = ["SIZE", "AGE", "MERGED", "DIRTY", "REMOTE", "PR", "LAST_CHAT", "BUCKET", "WORKTREE"];
// Merged and closed PRs drop out of gh's default open-only listing.
const GH_PR_LIST = ["pr", "list", "--author", "@me", "--state", "all", "--limit", "1000",
  "--json", "number,state,headRefName,headRefOid"];

export function classify(facts) {
  const { dirty, pr, recent, ancestry, head } = facts;
  if (dirty.known && dirty.value.wip > 0) return "hold-wip";
  if (pr.known && pr.value?.state === "OPEN") return "hold-open-pr";
  if (recent.known && recent.value) return "verify-recent-chat";
  if (Object.values(facts).some((fact) => !fact.known)) return "review";
  if (ancestry.value) return "safe";
  if (pr.value?.state === "MERGED" && pr.value.headRefOid === head.value) return "safe";
  return "review";
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .replace(/\n+$/, "");
}

const runGh = (args, cwd) =>
  execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// `--porcelain -z` output: NUL-separated fields, one record per worktree, the
// primary worktree first.
export function parseWorktrees(output) {
  const worktrees = [];
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) worktrees.push({ path: field.slice("worktree ".length), prunable: false });
    else if (field.startsWith("prunable")) worktrees.at(-1).prunable = true;
  }
  return worktrees;
}

export function defaultTranscriptRoots({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const claude = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
  const codex = env.CODEX_HOME || join(home, ".codex");
  const piAgent = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const copilot = join(env.COPILOT_HOME || join(home, ".copilot"), "session-state");
  const found = [claude, join(codex, "sessions"), join(codex, "archived_sessions"),
    join(piAgent, "sessions"), join(piAgent, "pstack"), copilot].filter((root) => exists(root));
  return found.length ? found : [claude];
}

// A dangling or looping link cannot spell a path that exists. Any other failure
// propagates so the caller leaves the worktree's chat fact unknown.
function symlinkTargets(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isSymbolicLink()).flatMap((entry) => {
    const link = join(dir, entry.name);
    try {
      return [[link, realpathSync(link)]];
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ELOOP") return [];
      throw error;
    }
  });
}

// Git reports a worktree by its resolved path, while a session may name it
// through a symlink in an ancestor directory, as macOS spells /private/tmp/x
// as /tmp/x. A worktree whose directory is gone keeps git's spelling.
export function pathSpellings(path, linksIn = symlinkTargets) {
  let resolved;
  try {
    resolved = realpathSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return [path];
    throw error;
  }
  const spellings = new Set([path, resolved]);
  for (let dir = dirname(resolved); ; dir = dirname(dir)) {
    for (const [link, target] of linksIn(dir)) {
      if (resolved === target || resolved.startsWith(target + sep)) spellings.add(link + resolved.slice(target.length));
    }
    if (dir === dirname(dir)) break;
  }
  return [...spellings];
}

// A transcript names a worktree up to a boundary byte or the end of the JSON
// string, never a bare prefix, so `/x/candidate` does not inherit a chat that
// ran in `/x/candidate-long`. Only JSONL is scanned, so the path appears
// JSON-escaped and a `\` after it opens the escape of a quote, backslash, or
// control byte. `.` counts only before another boundary (a sentence-final
// path), because `/x/candidate.bak` is a plausible sibling. `*`, `$`, and `{`
// stay out: they extend a path by glob or expansion.
const BOUNDARY = new Set(Buffer.from("/\\\"' `:;),|&<>]}"));
const DOT = ".".charCodeAt(0);
const bounded = (text, at) => at === text.length || BOUNDARY.has(text[at]);
function mentions(text, needle) {
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if (bounded(text, end) || (text[end] === DOT && bounded(text, end + 1))) return true;
  }
  return false;
}

// Git on Windows may spell a path with forward slashes while the session uses backslashes.
function transcriptNeedles(spellings) {
  const forms = spellings.flatMap((spelling) => (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(spelling)
    ? [spelling.replaceAll("\\", "/"), spelling.replaceAll("/", "\\")]
    : [spelling]));
  return [...new Set(forms)].map((form) => Buffer.from(JSON.stringify(form).slice(1, -1)));
}

// `spellings` maps each worktree path to every spelling a session could use.
export function lastChats(roots, spellings) {
  const needles = [...spellings].map(([path, forms]) => [path, transcriptNeedles(forms)]);
  const latest = new Map();
  for (const { path: file, mtime: mtimeMs } of roots.flatMap((root) => candidates(root, Infinity))) {
    const mtime = Math.floor(mtimeMs / 1000);
    let text;
    try {
      text = readFileSync(file);
    } catch (error) {
      rethrowUnlessRemoved(error);
      continue;
    }
    for (const [path, forms] of needles) {
      if (mtime > (latest.get(path) ?? 0) && forms.some((needle) => mentions(text, needle))) latest.set(path, mtime);
    }
  }
  return latest;
}

// The trunk is whatever the remote says it is; main only when it publishes no
// usable HEAD.
function trunkName(repo) {
  const advertised = probe(() => git(repo, "ls-remote", "--symref", "origin", "HEAD"));
  return (advertised.known && /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(advertised.value)?.[1]) || "main";
}

function isAncestor(repo, head, trunk) {
  try {
    git(repo, "merge-base", "--is-ancestor", head, `origin/${trunk}`);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function dirtyState(path) {
  const lines = git(path, "status", "--porcelain").split("\n").filter(Boolean);
  const scratch = lines.filter((line) => line.startsWith("??")).length;
  return { wip: lines.length - scratch, scratch };
}

function remoteState(path, branch, head) {
  const sha = git(path, "for-each-ref", "--format=%(objectname)", `refs/remotes/origin/${branch}`);
  if (!sha) return "no-remote";
  if (sha === head) return "pushed";
  return `ahead${git(path, "rev-list", "--count", `origin/${branch}..HEAD`)}`;
}

export function duSize(output) {
  return output.trim().split(/\s/)[0];
}

function size(path) {
  try {
    return duSize(execFileSync("du", ["-sh", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch {
    return "?";
  }
}

// Orders du's human-readable sizes the way `sort -h` does.
function sizeKey(label) {
  const match = /^(\d+(?:\.\d+)?)([KMGTPE]?)/.exec(label);
  if (!match) return 0;
  return Number(match[1]) * 1024 ** (match[2] ? "KMGTPE".indexOf(match[2]) + 1 : 0);
}

function dirtyLabel({ wip, scratch }) {
  if (wip > 0) return `wip:${wip}`;
  return scratch > 0 ? `scratch:${scratch}` : "clean";
}

function auditWorktree(path, { repo, trunk, fetched, prs, chats, now }) {
  const head = probe(() => git(path, "rev-parse", "HEAD"));
  const age = bind(head, () => probe(() => Math.trunc((now - Number(git(path, "log", "-1", "--format=%ct", "HEAD"))) / DAY)));
  const ancestry = bind(head, (sha) => probe(() => isAncestor(repo, sha, trunk)));
  const dirty = probe(() => dirtyState(path));
  const branch = probe(() => {
    const name = git(path, "rev-parse", "--abbrev-ref", "HEAD");
    return name === "HEAD" ? null : name;
  });
  const remote = bind(branch, (name) => (name === null ? known("detached") : probe(() => remoteState(path, name, head.value))));
  const pr = bind(prs, (list) => bind(branch, (name) => known(list.find((entry) => name !== null && entry.headRefName === name) ?? null)));
  const lastChat = chats.get(path);
  const recent = bind(lastChat, (ts) => known(ts !== null && Math.trunc((now - ts) / DAY) <= RECENT_DAYS));
  const bucket = classify({ trunk: fetched, head, age, ancestry, dirty, remote, pr, recent });
  return [
    size(path),
    age.known ? `${age.value}d` : "?",
    ancestry.known ? (ancestry.value ? "YES" : "no") : "?",
    dirty.known ? dirtyLabel(dirty.value) : "unknown",
    remote.known ? remote.value : "unknown",
    pr.known && pr.value ? `#${pr.value.number}/${pr.value.state}` : "-",
    lastChat.known && lastChat.value !== null ? new Date(lastChat.value * 1000).toISOString().slice(0, 10) : "-",
    bucket,
    path,
  ];
}

// Discovery failures keep the table printing, but leave their facts unknown so
// no row they touch can reach `safe`.
export function audit({
  repo,
  transcripts,
  gh = runGh,
  warn = (line) => console.error(line),
  now = Math.floor(Date.now() / 1000),
}) {
  const discover = (read, message) => {
    try {
      return known(read());
    } catch (error) {
      warn(`warn: ${message}: ${String(error.stderr ?? "").trim() || error.message}`);
      return UNKNOWN;
    }
  };
  const trunk = trunkName(repo);
  // An explicit refspec updates the ref even where a single-branch clone does not track it.
  const fetched = discover(
    () => git(repo, "fetch", "origin", `+refs/heads/${trunk}:refs/remotes/origin/${trunk}`),
    `could not fetch origin/${trunk}; merged column may be stale`,
  );
  const prs = discover(() => {
    const list = JSON.parse(gh(GH_PR_LIST, repo));
    if (!Array.isArray(list)) throw new Error("gh returned JSON that is not an array");
    return list;
  }, "gh pr list failed; PR column will be empty");

  const worktrees = parseWorktrees(git(repo, "worktree", "list", "--porcelain", "-z")).slice(1);
  const live = worktrees.filter((worktree) => !worktree.prunable).map((worktree) => worktree.path);
  // Worktrees share ancestors, so each directory's links are read once.
  const links = new Map();
  const linksIn = (dir) => links.get(dir) ?? links.set(dir, symlinkTargets(dir)).get(dir);
  const spellings = new Map(live.map((path) => [
    path,
    discover(() => pathSpellings(path, linksIn), `could not resolve the spellings of ${path}; LAST_CHAT column will be empty`),
  ]));
  const scanFailed = "transcript scan failed; LAST_CHAT column will be empty";
  const missing = discover(
    () => transcripts.filter((root) => !statSync(root, { throwIfNoEntry: false })?.isDirectory()),
    scanFailed,
  );
  // Every root must be readable: a chat the scan could not see might be recent.
  const found = bind(missing, (roots) => {
    for (const root of roots) warn(`warn: ${root} not found; LAST_CHAT column will be empty`);
    if (roots.length) return UNKNOWN;
    const knownSpellings = new Map([...spellings].filter(([, fact]) => fact.known).map(([path, fact]) => [path, fact.value]));
    return discover(() => lastChats(transcripts, knownSpellings), scanFailed);
  });
  const chats = new Map(live.map((path) => [
    path,
    bind(spellings.get(path), () => bind(found, (latest) => known(latest.get(path) ?? null))),
  ]));

  const context = { repo, trunk, fetched, prs, chats, now };
  const rows = worktrees.map(({ path, prunable }) =>
    prunable ? ["-", "?", "-", "-", "-", "-", "-", "prunable", path] : auditWorktree(path, context),
  );
  rows.sort((a, b) => sizeKey(b[0]) - sizeKey(a[0]) || (a.join("\t") < b.join("\t") ? 1 : -1));
  return [HEADER, ...rows].map((row) => `${row.join("\t")}\n`).join("");
}

function main(argv) {
  const [repoArg, ...transcriptsArgs] = argv;
  const repo = probe(() => git(repoArg || process.cwd(), "rev-parse", "--show-toplevel"));
  if (!repo.known) {
    console.error("not in a git repo; pass a repo path");
    return 1;
  }
  const transcripts = transcriptsArgs.length ? transcriptsArgs : defaultTranscriptRoots();
  process.stdout.write(audit({ repo: repo.value, transcripts }));
  return 0;
}

// node leaves argv[1] unresolved and may set it to a non-file (`node -e ... arg`).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2));
}
