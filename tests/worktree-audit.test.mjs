import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { defaultSettings, PSTACK_STATE_DIR } from "../plugins/pstack/pi/config.ts";
import { audit, classify, defaultTranscriptRoots, duSize, lastChats, pathSpellings } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";
import { removeDuring } from "./remove-during.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs");
// node's ESM loader takes a file URL, not a drive-lettered path.
const scriptUrl = pathToFileURL(script).href;
const noNode = spawnSync("node", ["--version"]).status !== 0;
// Windows ignores chmod, so a directory cannot be made unreadable.
const noChmod = process.platform === "win32";
// The audit keys rows by git's spelling, which is forward-slashed on Windows.
const gitPath = (path) => path.replaceAll(sep, "/");
// Windows denies symlinkSync without the symlink privilege.
const noSymlinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), "worktree-audit-symlink-"));
  try {
    symlinkSync(dir, join(dir, "link"));
    return false;
  } catch (error) {
    if (error.code === "EPERM") return true;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

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
  // Windows git reports long names where realpathSync keeps 8.3 ones like RUNNER~1.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "worktree-audit-test-")));
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
  return gitPath(path);
}

function writeTranscript(fixture, rel, worktree, mtimeSeconds) {
  const path = join(fixture.transcripts, rel);
  mkdirSync(dirname(path), { recursive: true });
  // A Windows session records its cwd with backslashes while git reports forward slashes.
  writeFileSync(path, `${JSON.stringify({ type: "user", cwd: worktree.replaceAll("/", sep) })}\n`);
  if (mtimeSeconds) utimesSync(path, mtimeSeconds, mtimeSeconds);
}

function runAudit(fixture, { prs = [], gh, transcripts = [fixture.transcripts] } = {}) {
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
  writeFileSync(join(fixture.repo, ".git/worktrees/broken/index"), "not an index\n");
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

test("a Pi session in a second transcripts root marks the worktree it ran in as a recent chat", () => {
  const fixture = createFixture();
  const piChatted = addWorktree(fixture, "pi-chatted");
  const quiet = addWorktree(fixture, "quiet");
  const sessions = join(fixture.root, "pi-agent/sessions");
  // Pi names the session directory after the cwd with its leading "/" or "C:/" removed.
  const cwdSlug = piChatted.replace(/^[^/]*\//, "").replaceAll("/", "-");
  const session = join(sessions, `--${cwdSlug}--`, "2026-10-01T00-00-00-000Z_s.jsonl");
  mkdirSync(dirname(session), { recursive: true });
  writeFileSync(
    session,
    [
      { type: "session", version: 3, id: "s", timestamp: "2026-10-01T00:00:00.000Z", cwd: piChatted },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const { rows, warnings } = runAudit(fixture, { transcripts: [fixture.transcripts, sessions] });
  expect(warnings).toEqual([]);
  expect(rowFor(rows, piChatted).slice(6, 8)).toEqual([ymd(Math.floor(Date.now() / 1000)), "verify-recent-chat"]);
  expect(rowFor(rows, quiet).slice(6, 8)).toEqual(["-", "safe"]);
});

for (const dir of ["sessions", "archived_sessions"]) {
  test(`a Codex session in ~/.codex/${dir} marks the worktree it ran in as a recent chat`, () => {
    const fixture = createFixture();
    const chatted = addWorktree(fixture, "codex-chatted");
    const session = join(fixture.root, ".codex", dir, "2026/10/05/rollout.jsonl");
    mkdirSync(dirname(session), { recursive: true });
    writeFileSync(session, `${JSON.stringify({ type: "session_meta", payload: { cwd: chatted } })}\n`);
    const transcripts = defaultTranscriptRoots({ env: {}, home: fixture.root });
    expect(transcripts).toEqual([join(fixture.root, ".codex", dir)]);
    const { rows, warnings } = runAudit(fixture, { transcripts });
    expect(warnings).toEqual([]);
    expect(rowFor(rows, chatted).slice(6, 8)).toEqual([ymd(Math.floor(Date.now() / 1000)), "verify-recent-chat"]);
  });
}

describe("lastChats matches a path as JSONL spells it, never a sibling's prefix", () => {
  const scan = (path, cwd, spellings = [path]) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-chats-")));
    fixtures.push(root);
    mkdirSync(join(root, "2026/10/05"), { recursive: true });
    writeFileSync(join(root, "2026/10/05/rollout.jsonl"), `${JSON.stringify({ cwd })}\n`);
    return lastChats([root], new Map([[path, spellings]])).has(path);
  };

  test.each([
    ["a POSIX path", "/repo/worktree", "/repo/worktree"],
    ["a path with a quote", '/repo/with"quote', '/repo/with"quote'],
    ["a path with a tab", "/repo/with\ttab", "/repo/with\ttab"],
    ["Windows backslashes", String.raw`C:\repo\worktree`, String.raw`C:\repo\worktree`],
    ["Git's forward-slash spelling of a Windows path", "C:/repo/worktree", String.raw`C:\repo\worktree`],
    ["a file under a Windows worktree", "C:/repo/worktree", String.raw`C:\repo\worktree\src\index.ts`],
    ["a UNC checkout", "//server/share/worktree", String.raw`\\server\share\worktree`],
    ["a double-quoted path inside a command", "/repo/worktree", 'cd "/repo/worktree" && ls'],
    ["a single-quoted path inside a command", "/repo/worktree", "cd '/repo/worktree' && ls"],
    ["a path followed by a space", "/repo/worktree", "cd /repo/worktree && ls"],
    ["a path followed by a tab", "/repo/worktree", "ls\t/repo/worktree\tsrc"],
    ["a path followed by a newline", "/repo/worktree", "cd /repo/worktree\nls"],
    ["a quoted Windows path inside a command", "C:/repo/worktree", String.raw`cd "C:\repo\worktree" && dir`],
    ["a path in backticks", "/repo/worktree", "the worktree `/repo/worktree` is done"],
    ["a path followed by a colon", "/repo/worktree", "/repo/worktree:12"],
    ["a path followed by a semicolon", "/repo/worktree", "cd /repo/worktree;ls"],
    ["a path closing a Markdown link", "/repo/worktree", "[wt](/repo/worktree)"],
    ["a path followed by a comma", "/repo/worktree", "removed /repo/worktree, done"],
    ["a path followed by a pipe", "/repo/worktree", "ls /repo/worktree|wc"],
    ["a path followed by an ampersand", "/repo/worktree", "cd /repo/worktree&&ls"],
    ["a path followed by a process substitution", "/repo/worktree", "diff /repo/worktree<(git status)"],
    ["a path followed by a redirect", "/repo/worktree", "ls /repo/worktree>out"],
    ["a Windows path followed by a semicolon", "C:/repo/worktree", String.raw`cd C:\repo\worktree;dir`],
    ["a path ending a sentence", "/repo/worktree", "Two commits in /repo/worktree. Files: x"],
    ["a path ending a line with a period", "/repo/worktree", "removed /repo/worktree.\nnext"],
    ["a path ending the text with a period", "/repo/worktree", "see /repo/worktree."],
    ["a path closing a bracket", "/repo/worktree", "[cmd /repo/worktree]"],
    ["a path closing a shell default", "/repo/worktree", "${WT:-/repo/worktree}"],
  ])("finds %s", (_, path, cwd) => {
    expect(scan(path, cwd)).toBe(true);
  });

  test("finds a second spelling of the path", () => {
    expect(scan("/repo/worktree", "cd /mnt/worktree && ls", ["/repo/worktree", "/mnt/worktree"])).toBe(true);
  });

  test.each([
    ["/repo/worktree", "/repo/worktree-long/file.ts"],
    ["C:/repo/worktree", String.raw`C:\repo\worktree-long\src\file.ts`],
    ["/repo/worktree", 'cd "/repo/worktree-long" && ls'],
    ["/repo/worktree", "cd /repo/worktree-long && ls"],
    ["/repo/worktree", "cd /repo/worktree.bak"],
    ["/repo/worktree", "/repo/worktree.bak/x"],
    ["/repo/worktree", "/repo/worktree_2 ls"],
    ["C:/repo/worktree", "C:/repo/worktree.bak/x"],
    ["/repo/worktree", "ls /repo/worktree*"],
    ["/repo/worktree", "/repo/worktree$suffix"],
    ["/repo/worktree", "cp /repo/worktree{a,b} ."],
  ])("does not match %s in %s", (path, cwd) => {
    expect(scan(path, cwd)).toBe(false);
  });
});

describe("pathSpellings", () => {
  test("a worktree whose directory is gone keeps git's spelling", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-gone-")));
    fixtures.push(root);
    expect(pathSpellings(join(root, "missing/worktree"))).toEqual([join(root, "missing/worktree")]);
  });

  describe.skipIf(noSymlinks)("a worktree under a symlinked ancestor", () => {
    const layout = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-links-")));
      fixtures.push(root);
      mkdirSync(join(root, "real/worktree"), { recursive: true });
      symlinkSync(join(root, "real"), join(root, "link"));
      return root;
    };

    test("git's resolved spelling gains the spelling through the symlink", () => {
      const root = layout();
      expect(pathSpellings(join(root, "real/worktree"))).toContain(join(root, "link/worktree"));
    });

    test("the symlink spelling gains the resolved spelling", () => {
      const root = layout();
      expect(pathSpellings(join(root, "link/worktree"))).toContain(join(root, "real/worktree"));
    });

    test("a dangling or looping link in an ancestor is not a spelling and not a failure", () => {
      const root = layout();
      const before = pathSpellings(join(root, "real/worktree"));
      symlinkSync(join(root, "missing"), join(root, "dangling"));
      symlinkSync(join(root, "loop"), join(root, "loop"));
      expect(pathSpellings(join(root, "real/worktree"))).toEqual(before);
    });

    test("a symlink reached through another symlink composes with it", () => {
      const root = layout();
      mkdirSync(join(root, "real/deep/worktree"), { recursive: true });
      symlinkSync(join(root, "real/deep"), join(root, "real/inner"));
      expect(pathSpellings(join(root, "real/deep/worktree"))).toContain(join(root, "link/inner/worktree"));
    });

    test("a link back to its own ancestor spells the worktree once through it", () => {
      const root = layout();
      symlinkSync(root, join(root, "real/up"));
      expect(pathSpellings(join(root, "real/worktree"))).toContain(join(root, "real/up/real/worktree"));
    });

    test("the spellings do not match a sibling in the chat scan", () => {
      const root = layout();
      const worktree = join(root, "real/worktree");
      mkdirSync(join(root, "chats"));
      writeFileSync(join(root, "chats/a.jsonl"), `${JSON.stringify({ cwd: join(root, "link/worktree-long/file.ts") })}\n`);
      expect(lastChats([join(root, "chats")], new Map([[worktree, pathSpellings(worktree)]])).has(worktree)).toBe(false);
    });

    test("the audit holds a worktree whose only chat named it through the symlink", () => {
      const fixture = createFixture();
      const worktree = addWorktree(fixture, "real/worktree");
      symlinkSync(join(fixture.root, "real"), join(fixture.root, "link"));
      writeTranscript(fixture, "-proj/session.jsonl", join(fixture.root, "link/worktree"));
      const { rows, warnings } = runAudit(fixture);
      expect(warnings).toEqual([]);
      expect(rowFor(rows, worktree).slice(6, 8)).toEqual([ymd(Math.floor(Date.now() / 1000)), "verify-recent-chat"]);
    });

    test("the audit holds a worktree whose only chat named it through two composed symlinks", () => {
      const fixture = createFixture();
      const worktree = addWorktree(fixture, "real/deep/worktree");
      symlinkSync(join(fixture.root, "real"), join(fixture.root, "link"));
      symlinkSync(join(fixture.root, "real/deep"), join(fixture.root, "real/inner"));
      writeTranscript(fixture, "-proj/session.jsonl", join(fixture.root, "link/inner/worktree"));
      const { rows, warnings } = runAudit(fixture);
      expect(warnings).toEqual([]);
      expect(rowFor(rows, worktree).slice(6, 8)).toEqual([ymd(Math.floor(Date.now() / 1000)), "verify-recent-chat"]);
    });
  });
});

describe("default transcripts roots", () => {
  const home = "/home/u";
  const claude = "/home/u/.claude/projects";
  // These paths are POSIX literals, which path.join spells with backslashes on Windows.
  const roots = ({ exists, ...options }) =>
    defaultTranscriptRoots({ ...options, home, exists: (path) => exists(gitPath(path)) }).map(gitPath);

  test("every runtime directory that exists, Pi's under PI_CODING_AGENT_DIR when set", () => {
    const present = new Set([claude, "/home/u/.codex/sessions", "/pi/sessions", "/pi/pstack", "/home/u/.pi/agent/sessions"]);
    const exists = (path) => present.has(path);
    expect(roots({ env: { PI_CODING_AGENT_DIR: "/pi" }, exists })).toEqual([
      claude,
      "/home/u/.codex/sessions",
      "/pi/sessions",
      "/pi/pstack",
    ]);
    expect(roots({ env: {}, exists })).toEqual([claude, "/home/u/.codex/sessions", "/home/u/.pi/agent/sessions"]);
  });

  test("Codex's sessions and archived_sessions, under CODEX_HOME when set", () => {
    const present = new Set(["/home/u/.codex/sessions", "/home/u/.codex/archived_sessions", "/cx/sessions", "/cx/archived_sessions"]);
    const exists = (path) => present.has(path);
    expect(roots({ env: {}, exists })).toEqual(["/home/u/.codex/sessions", "/home/u/.codex/archived_sessions"]);
    expect(roots({ env: { CODEX_HOME: "/cx" }, exists })).toEqual(["/cx/sessions", "/cx/archived_sessions"]);
  });

  test("Claude Code's projects under CLAUDE_CONFIG_DIR when set", () => {
    const exists = (path) => path === claude || path === "/cc/projects";
    expect(roots({ env: { CLAUDE_CONFIG_DIR: "/cc" }, exists })).toEqual(["/cc/projects"]);
  });

  test("Claude Code's directory when no runtime directory exists, so the audit warns about it", () => {
    expect(roots({ env: {}, exists: () => false })).toEqual([claude]);
  });

  test.each([
    ["PI_CODING_AGENT_DIR", { PI_CODING_AGENT_DIR: "/pi" }],
    ["the default agent directory", {}],
  ])("the Pi roots are where the extension keeps sessions and agent state under %s", (_, env) => {
    const { agentDir } = defaultSettings(() => 0, env);
    const roots = defaultTranscriptRoots({ env, home: homedir(), exists: () => true });
    expect(roots).toEqual(expect.arrayContaining([join(agentDir, "sessions"), join(agentDir, PSTACK_STATE_DIR)]));
  });
});

test.skipIf(noNode)("a transcript removed after it was listed drops out of the chat scan (skipped without node)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-audit-test-")));
  fixtures.push(dir);
  const chat = (name, mtimeSeconds) => {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify({ cwd: "/x/wt" })}\n`);
    utimesSync(path, mtimeSeconds, mtimeSeconds);
    return path;
  };
  chat("kept.jsonl", 100);
  const removed = chat("removed.jsonl", 200);
  // Removed once candidates() has stat-ed it, so only lastChats' own read sees it gone.
  const body = `const { lastChats } = await import(${JSON.stringify(scriptUrl)});
    console.log(JSON.stringify([...lastChats([${JSON.stringify(dir)}], new Map([["/x/wt", ["/x/wt"]]]))]));`;
  const run = removeDuring("statSync", removed, [removed], body);
  expect(run.stderr).toBe("");
  expect(JSON.parse(run.stdout)).toEqual([["/x/wt", 100]]);
});

test.skipIf(noNode)("a session resumed during the scan keeps its active worktree out of safe", () => {
  const fixture = createFixture();
  const worktree = addWorktree(fixture, "resumed");
  const old = Math.floor(Date.now() / 1000) - 10 * 86400;
  writeTranscript(fixture, "resumed.jsonl", worktree, old);
  const session = join(fixture.transcripts, "resumed.jsonl");
  const body = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const stat = fs.statSync;
    let resumed = false;
    fs.statSync = (path, ...args) => {
      const result = stat(path, ...args);
      if (path === ${JSON.stringify(session)} && !resumed) {
        resumed = true;
        fs.appendFileSync(path, JSON.stringify({ cwd: ${JSON.stringify(worktree)}, message: "resume" }) + "\\n");
      }
      return result;
    };
    syncBuiltinESMExports();
    const { audit } = await import(${JSON.stringify(scriptUrl)});
    console.log(audit({ repo: ${JSON.stringify(fixture.repo)}, transcripts: [${JSON.stringify(fixture.transcripts)}], gh: () => "[]" }));
  `;
  const run = spawnSync("node", ["--input-type=module", "-e", body], { encoding: "utf8" });
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  const row = run.stdout.trim().split("\n")[1].split("\t");
  expect(row.slice(6, 8)).toEqual([ymd(Math.floor(Date.now() / 1000)), "verify-recent-chat"]);
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
    ["a missing transcripts directory", (fixture) => ({ transcripts: [fixture.transcripts, join(fixture.root, "absent")] }), /^warn: \S+[\\/]absent not found; LAST_CHAT column will be empty$/],
  ];
  const chmodFailures = [
    ["an unreadable transcripts directory", (fixture) => {
      const project = join(fixture.transcripts, "-proj");
      mkdirSync(project);
      chmodSync(project, 0o000);
      locked.push(project);
      return {};
    }, /transcript scan failed/],
    ["a transcripts directory with an inaccessible parent", (fixture) => {
      const project = join(fixture.transcripts, "-proj");
      mkdirSync(project);
      chmodSync(fixture.transcripts, 0o000);
      locked.push(fixture.transcripts);
      return { transcripts: [project] };
    }, /transcript scan failed.*EACCES/],
    // Execute-only: git still reaches the worktree, but its symlinks cannot be listed.
    ["a worktree ancestor that cannot be listed", (fixture) => {
      chmodSync(fixture.root, 0o111);
      locked.push(fixture.root);
      return {};
    }, /^warn: could not resolve the spellings of \S+\/ancestor; LAST_CHAT column will be empty: EACCES/],
  ];

  const keepsAncestorOutOfSafe = (_, inject, warning) => {
    const fixture = createFixture();
    const ancestor = addWorktree(fixture, "ancestor");
    const { rows, warnings } = runAudit(fixture, inject(fixture));
    const row = rowFor(rows, ancestor);
    expect(row[2]).toBe("YES");
    expect(row[7]).toBe("review");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(warning);
  };
  test.each(failures)("%s", keepsAncestorOutOfSafe);
  test.skipIf(noChmod).each(chmodFailures)("%s", keepsAncestorOutOfSafe);

  test("every missing transcripts directory is named", () => {
    const fixture = createFixture();
    const absent = ["absent-a", "absent-b"].map((name) => join(fixture.root, name));
    const { warnings } = runAudit(fixture, { transcripts: [absent[0], fixture.transcripts, absent[1]] });
    expect(warnings).toEqual(absent.map((root) => `warn: ${root} not found; LAST_CHAT column will be empty`));
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

test.each([
  ["568K\t/x/wt\n", "568K"],
  ["  0B\t/x/wt\n", "0B"],
  [" 48M\t/x/wt\n", "48M"],
])("reads the size from du output %j", (output, expected) => {
  expect(duSize(output)).toBe(expected);
});
