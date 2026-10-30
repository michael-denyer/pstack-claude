import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    const result = spawnSync("node", [cli], { env: { ...process.env, CODEX_HOME: home, CODEX_THREAD_ID: "current", ...env }, encoding: "utf8" });
    expect(result.stderr).toBe("");
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  return { home, sessions, file, write, run };
}

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
