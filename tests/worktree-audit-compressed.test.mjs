import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { audit, lastChats } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

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

import { candidates } from "../plugins/pstack/skills/reflect/scripts/find-transcript.mjs";

const hasZstd = spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
const decodedTest = hasZstd ? test : test.skip;
const auditUrl = new URL("../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs", import.meta.url).href;
const compressed = (text) => execFileSync("zstd", ["-q", "-c"], { input: text, stdio: ["pipe", "pipe", "pipe"] });
const jsonl = (cwd) => JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n";
const spellings = (path) => new Map([[path, [path]]]);

function withLogs(run) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-compressed-"));
  try { run(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function withoutDecoder(dir, path) {
  const code = `import(${JSON.stringify(auditUrl)}).then(({ lastChats }) => {
    try {
      console.log(JSON.stringify([...lastChats([${JSON.stringify(dir)}], new Map([[${JSON.stringify(path)}, [${JSON.stringify(path)}]]]))]));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  });`;
  const env = { PATH: "" };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return spawnSync(process.execPath, ["--eval", code], { env, encoding: "utf8" });
}

test("the transcript finder still enumerates only plain JSONL by default", () => withLogs((dir) => {
  writeFileSync(join(dir, "plain.jsonl"), "");
  writeFileSync(join(dir, "compressed.jsonl.zst"), "");
  assert.deepEqual(candidates(dir).map(({ path }) => path), [join(dir, "plain.jsonl")]);
}));

test("audit enumeration opts into compressed rollouts at the requested depth", () => withLogs((dir) => {
  const nested = join(dir, "2026", "11", "07");
  mkdirSync(nested, { recursive: true });
  const deep = join(nested, "session.jsonl.zst");
  writeFileSync(deep, "");
  writeFileSync(join(dir, "other.gz"), "");
  assert.deepEqual(candidates(dir, Infinity, { includeCompressed: true }).map(({ path }) => path), [deep]);
  assert.deepEqual(candidates(dir, 2, { includeCompressed: true }), []);
}));

decodedTest("a recent compressed rollout contributes its path and timestamp", () => withLogs((dir) => {
  const path = "/workspace/with spaces/项目";
  const file = join(dir, "session.jsonl.zst");
  writeFileSync(file, compressed(jsonl(path)));
  utimesSync(file, 1700000000, 1700000000);
  assert.equal(lastChats([dir], spellings(path)).get(path), 1700000000);
}));

decodedTest("a newer compressed rollout wins over an older plain transcript", () => withLogs((dir) => {
  const path = "/workspace/project";
  const plain = join(dir, "old.jsonl");
  const packed = join(dir, "new.jsonl.zst");
  writeFileSync(plain, jsonl(path));
  writeFileSync(packed, compressed(jsonl(path)));
  utimesSync(plain, 1700000000, 1700000000);
  utimesSync(packed, 1700000100, 1700000100);
  assert.equal(lastChats([dir], spellings(path)).get(path), 1700000100);
}));

decodedTest("all concatenated zstd frames are scanned, not just the first", () => withLogs((dir) => {
  const path = "/workspace/project";
  writeFileSync(join(dir, "session.jsonl.zst"), Buffer.concat([
    compressed(jsonl("/unrelated")), compressed(jsonl(path)),
  ]));
  assert.equal(lastChats([dir], spellings(path)).has(path), true);
}));

decodedTest("compressed sibling prefixes do not count as worktree activity", () => withLogs((dir) => {
  const path = "/workspace/project";
  writeFileSync(join(dir, "session.jsonl.zst"), compressed(jsonl(`${path}-other`)));
  assert.equal(lastChats([dir], spellings(path)).size, 0);
}));

decodedTest("a corrupt compressed rollout is an error, not an empty history", () => withLogs((dir) => {
  writeFileSync(join(dir, "broken.jsonl.zst"), "not a zstd frame");
  assert.throws(() => lastChats([dir], spellings("/workspace/project")), /cannot decode/);
}));

decodedTest("a truncated later frame fails even after an intact first frame", () => withLogs((dir) => {
  const frame = compressed(jsonl("/workspace/project"));
  writeFileSync(join(dir, "truncated.jsonl.zst"), Buffer.concat([
    compressed(jsonl("/unrelated")), frame.subarray(0, frame.length - 2),
  ]));
  assert.throws(() => lastChats([dir], spellings("/workspace/project")), /cannot decode/);
}));

test("an unavailable decoder is not swallowed as a removed transcript", () => withLogs((dir) => {
  writeFileSync(join(dir, "session.jsonl.zst"), "decoder must be present before reading this");
  const result = withoutDecoder(dir, "/workspace/project");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot decode.*zstd must be available/);
}));

test("plain JSONL remains readable without zstd on PATH", () => withLogs((dir) => {
  const path = "/workspace/project";
  writeFileSync(join(dir, "session.jsonl"), jsonl(path));
  const result = withoutDecoder(dir, path);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0][0], path);
}));

decodedTest("the full audit holds a worktree mentioned only in a compressed rollout", () => withRepo(({ wt, transcripts, row }) => {
  writeFileSync(join(transcripts, "session.jsonl.zst"), compressed(jsonl(wt)));
  assert.equal(row().BUCKET, "verify-recent-chat");
}));

test("the full audit leaves a failed compressed scan unknown", () => withRepo(({ repo, transcripts }) => {
  writeFileSync(join(transcripts, "broken.jsonl.zst"), "broken");
  const warnings = [];
  const output = audit({ repo, transcripts: [transcripts], gh: () => "[]", warn: (s) => warnings.push(s) });
  const [header, line] = output.trimEnd().split("\n").map((s) => s.split("\t"));
  assert.equal(line[header.indexOf("BUCKET")], "review");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /transcript scan failed.*cannot decode/);
}));
