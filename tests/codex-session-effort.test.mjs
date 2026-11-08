import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/codex-session-effort.mjs", import.meta.url));
const made = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = (type, payload) => JSON.stringify({ type, payload }) + "\n";
const meta = (id = "current") => row("session_meta", { id });
const start = (turn_id) => row("event_msg", { type: "task_started", turn_id });
const context = (turn_id, effort) => row("turn_context", { turn_id, effort, model: "model-name-is-not-an-effort" });
const complete = (turn_id) => row("event_msg", { type: "task_complete", turn_id });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pstack-codex-effort-"));
  made.push(home);
  const sessions = join(home, "sessions/2026/10/30");
  mkdirSync(sessions, { recursive: true });
  const file = (id = "current", directory = sessions) => join(directory, `rollout-2026-10-30-${id}.jsonl`);
  const write = (text, id = "current") => writeFileSync(file(id), text);
  const run = (env = {}) => {
    const result = spawnSync("node", [cli], { env: { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: "", CODEX_THREAD_ID: "current", ...env }, encoding: "utf8" });
    expect(result.stderr).toBe("");
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  return { home, sessions, file, write, run };
}

function selectRollout(home, path, id = "current") {
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, reasoning_effort TEXT DEFAULT 'low')");
    db.query("INSERT OR REPLACE INTO threads (id, rollout_path) VALUES (?, ?)").run(id, path);
  } finally {
    db.close();
  }
}

for (const retired of [start("old"), start("old") + context("old", "high")]) {
  test(`reads the indexed replacement after revert when the retired log has ${retired.includes("turn_context") ? "a stale effort" : "no effort"}`, () => {
    const { home, file, write, run } = fixture();
    write(meta() + retired);
    const replacement = file("current_new-rollout");
    writeFileSync(replacement, meta() + start("new") + context("new", "max"));
    selectRollout(home, replacement);
    expect(run()).toEqual({ status: 0, value: { effort: "max" } });
  });
}

test("does not guess which retained rollout is current without an index", () => {
  const { file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  writeFileSync(file("current_new-rollout"), meta() + start("new") + context("new", "max"));
  expect(run().value.effort).toBeNull();
});

test("follows a changed index on the next call even when the original log is absent", () => {
  const { home, file, run } = fixture();
  const first = file("current_first-rollout");
  const second = file("current_second-rollout");
  writeFileSync(first, meta() + start("first") + context("first", "high"));
  writeFileSync(second, meta() + start("second") + context("second", "max"));
  selectRollout(home, second);
  expect(run().value).toEqual({ effort: "max" });
  selectRollout(home, first);
  expect(run().value).toEqual({ effort: "high" });
});

test("reads the configured SQLite home instead of a retained index in CODEX_HOME", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  selectRollout(home, file());
  const sqliteHome = join(home, "sqlite");
  mkdirSync(sqliteHome);
  const replacement = file("current_new-rollout");
  writeFileSync(replacement, meta() + start("new") + context("new", "max"));
  selectRollout(sqliteHome, replacement);
  expect(run({ CODEX_SQLITE_HOME: sqliteHome }).value).toEqual({ effort: "max" });
});

test("falls back to a unique legacy log when the index has only another thread", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("new") + context("new", "max"));
  write(meta("other") + start("other") + context("other", "low"), "other");
  selectRollout(home, file("other"), "other");
  expect(run().value).toEqual({ effort: "max" });
});

for (const [name, text] of [
  ["a missing file", null],
  ["another thread", meta("other") + start("new") + context("new", "max")],
  ["a completed turn", meta() + start("new") + context("new", "max") + complete("new")],
  ["a turn without context", meta() + start("new")],
]) test(`does not use a retired log or a saved effort when the index selects ${name}`, () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  const replacement = file("current_new-rollout");
  if (text !== null) writeFileSync(replacement, text);
  selectRollout(home, replacement);
  expect(run().value.effort).toBeNull();
});

test("does not use a retired log when the current rollout is compressed", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  const replacement = file("current_new-rollout") + ".zst";
  writeFileSync(replacement, "compressed rollout fixture");
  expect(run().value.effort).toBeNull();
  selectRollout(home, replacement);
  expect(run().value.effort).toBeNull();
});

test("does not fall back when the state database is corrupt, unsupported, or ambiguous", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  const path = join(home, "state_5.sqlite");
  writeFileSync(path, "not a SQLite database");
  expect(run().value.effort).toBeNull();
  rmSync(path);
  new Database(path).close();
  expect(run().value.effort).toBeNull();
  selectRollout(home, file());
  writeFileSync(join(home, "state_6.sqlite"), readFileSync(path));
  expect(run().value.effort).toBeNull();
});

test("uses legacy logs without node:sqlite but refuses to bypass an existing index", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("new") + context("new", "max"));
  const env = { NODE_OPTIONS: "--no-experimental-sqlite" };
  expect(run(env).value).toEqual({ effort: "max" });
  selectRollout(home, file());
  expect(run(env).value.effort).toBeNull();
});

test("reads a current path from WAL without changing the database or its journal", () => {
  const { home, file, run } = fixture();
  const replacement = file("current_new-rollout");
  writeFileSync(replacement, meta() + start("new") + context("new", "max"));
  const path = join(home, "state_5.sqlite");
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
    db.query("INSERT INTO threads VALUES (?, ?)").run("current", replacement);
    const before = [readFileSync(path), readFileSync(path + "-wal")];
    expect(run().value).toEqual({ effort: "max" });
    expect([readFileSync(path), readFileSync(path + "-wal")]).toEqual(before);
  } finally {
    db.close();
  }
});

test("refuses an effort if a revert changes the index while the log is read", () => {
  const { home, file, write, run } = fixture();
  write(meta() + start("old") + context("old", "high"));
  const replacement = file("current_new-rollout");
  writeFileSync(replacement, meta() + start("new") + context("new", "max"));
  selectRollout(home, file());
  const preload = join(home, "revert.mjs");
  writeFileSync(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { DatabaseSync } from "node:sqlite";
    const read = fs.createReadStream;
    fs.createReadStream = (...args) => {
      const stream = read(...args);
      stream.once("end", () => {
        const db = new DatabaseSync(${JSON.stringify(join(home, "state_5.sqlite"))});
        db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(${JSON.stringify(replacement)}, "current");
        db.close();
      });
      return stream;
    };
    syncBuiltinESMExports();
  `);
  expect(run({ NODE_OPTIONS: `--import=${JSON.stringify(preload)}` }).value.effort).toBeNull();
});

test("reads the active turn from the exact thread, ignoring newer unrelated logs and message text", () => {
  const { write, run } = fixture();
  write(meta() + start("first") + context("first", "max") + complete("first") + start("second") +
    context("second", "high") + row("response_item", { text: 'private secret\u2028{\"effort\":\"low\"}' }));
  write(meta("other") + start("newer") + context("newer", "low"), "other");
  expect(run()).toEqual({ status: 0, value: { effort: "high" } });
});

test("rereads a changed effort on the next turn instead of caching it", () => {
  const { write, run } = fixture();
  const first = meta() + start("first") + context("first", "max");
  write(first);
  expect(run().value).toEqual({ effort: "max" });
  write(first + complete("first") + start("second") + context("second", "medium"));
  expect(run().value).toEqual({ effort: "medium" });
});

for (const [name, text] of [
  ["a completed turn", meta() + start("old") + context("old", "max") + complete("old")],
  ["a new turn without context", meta() + start("old") + context("old", "max") + start("new")],
  ["context from another turn", meta() + start("new") + context("old", "max")],
  ["a different thread", meta("other") + start("new") + context("new", "max")],
  ["no start event", meta() + context("new", "max")],
  ["a model default", meta() + start("new") + context("new", null)],
  ["an unknown effort", meta() + start("new") + context("new", "guess")],
  ["a partial trailing record", meta() + start("new") + context("new", "max") + '{"type":"event_msg"'],
]) test(`does not infer effort from ${name}`, () => {
  const { write, run } = fixture();
  write(text);
  const result = run();
  expect(result.status).toBe(1);
  expect(result.value.effort).toBeNull();
  expect(JSON.stringify(result.value)).not.toContain("secret");
});

test("requires the current thread identity and a unique runtime log", () => {
  const { sessions, write, run } = fixture();
  write(meta() + start("new") + context("new", "max"));
  expect(run({ CODEX_THREAD_ID: "" }).status).toBe(1);
  expect(run({ CODEX_THREAD_ID: "../current" }).status).toBe(1);
  expect(run({ CODEX_THREAD_ID: "missing" }).status).toBe(1);
  writeFileSync(join(sessions, "rollout-duplicate-current.jsonl"), meta() + start("new") + context("new", "low"));
  expect(run().status).toBe(1);
});

test("does not follow a symlink to a different thread's log", () => {
  const { file, write, run } = fixture();
  write(meta() + start("new") + context("new", "max"), "other");
  symlinkSync(file("other"), file());
  expect(run().status).toBe(1);
});

test("runs through a linked skill installation", () => {
  const { home, write } = fixture();
  write(meta() + start("new") + context("new", "max"));
  const linked = join(home, "linked-helper.mjs");
  symlinkSync(cli, linked);
  const result = spawnSync("node", [linked], { env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: "current" }, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('{"effort":"max"}');
});
