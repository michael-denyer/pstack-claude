import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { candidates, findTranscript, openingPrompt } from "../plugins/pstack/skills/reflect/scripts/find-transcript.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/reflect/scripts/find-transcript.mjs");
const noNode = spawnSync("node", ["--version"]).status !== 0;

const meta = JSON.stringify({ type: "bridge-session", sessionId: "abc" });
const summary = JSON.stringify({ type: "summary", summary: "earlier work" });
const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const userString = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const assistant = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "reflect-"));
  fixtures.push(dir);
  return dir;
}

function transcript(dir, rel, lines, mtimeSeconds) {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

describe("find-transcript", () => {
  test("the opening prompt is the first user record, not the first line", async () => {
    const dir = tempDir();
    const path = transcript(dir, "a.jsonl", [meta, summary, assistant, user("fix the flaky login test")], 100);
    expect(await openingPrompt(path)).toBe("fix the flaky login test");
  });

  test("string content and multi-block content both yield the prompt text", async () => {
    const dir = tempDir();
    const plain = transcript(dir, "plain.jsonl", [meta, userString("plain prompt")], 100);
    const blocks = transcript(
      dir,
      "blocks.jsonl",
      [meta, JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "<reminder/>" }, { type: "text", text: "real prompt" }] } })],
      100,
    );
    expect(await openingPrompt(plain)).toBe("plain prompt");
    expect(await openingPrompt(blocks)).toContain("real prompt");
  });

  test("a transcript with no user record has no opening prompt", async () => {
    const dir = tempDir();
    const path = transcript(dir, "meta-only.jsonl", [meta, summary], 100);
    expect(await openingPrompt(path)).toBeNull();
  });

  test("candidates cover flat, nested, and subagent layouts, newest first", () => {
    const dir = tempDir();
    const flat = transcript(dir, "flat.jsonl", [meta], 100);
    const nested = transcript(dir, "n1/n1.jsonl", [meta], 300);
    const sub = transcript(dir, "n1/subagents/child.jsonl", [meta], 200);
    writeFileSync(join(dir, "notes.txt"), "not a transcript");
    expect(candidates(dir)).toEqual([nested, sub, flat]);
  });

  test("findTranscript returns the newest transcript whose opening prompt carries the fragment", async () => {
    const dir = tempDir();
    transcript(dir, "old.jsonl", [meta, user("review issue 59")], 100);
    const newer = transcript(dir, "new/new.jsonl", [meta, user("review issue 59 and related points")], 200);
    transcript(dir, "other.jsonl", [meta, user("unrelated")], 300);
    expect(await findTranscript(dir, "issue 59")).toBe(newer);
    expect(await findTranscript(dir, "nothing matches this")).toBeNull();
  });

  test("a truncated trailing line does not abort the scan", async () => {
    const dir = tempDir();
    const live = join(dir, "live.jsonl");
    writeFileSync(live, `${meta}\n{"type":"us`);
    utimesSync(live, 200, 200);
    const older = transcript(dir, "older.jsonl", [meta, user("resume the audit")], 100);
    expect(await openingPrompt(live)).toBeNull();
    expect(await findTranscript(dir, "resume the audit")).toBe(older);
  });

  test("the CLI prints the path and exits 1 when nothing matches", () => {
    const dir = tempDir();
    const path = transcript(dir, "s/s.jsonl", [meta, user("ship the release")], 100);
    const hit = spawnSync("node", [script, dir, "ship the"], { encoding: "utf8" });
    expect(hit.status).toBe(0);
    expect(hit.stdout.trim()).toBe(path);
    const miss = spawnSync("node", [script, dir, "absent"], { encoding: "utf8" });
    expect(miss.status).toBe(1);
    expect(miss.stderr).toContain("no transcript");
  });

  // node resolves the script's own URL through symlinks but not argv[1]; bun resolves both.
  test.skipIf(noNode)(
    "the CLI runs under node through a symlinked path (skipped without node)",
    () => {
      const dir = tempDir();
      const path = transcript(dir, "s/s.jsonl", [meta, user("ship the release")], 100);
      symlinkSync(dirname(script), join(dir, "link"));
      const linked = join(dir, "link", basename(script));
      const hit = spawnSync("node", [linked, dir, "ship the"], { encoding: "utf8" });
      expect(hit.status).toBe(0);
      expect(hit.stdout.trim()).toBe(path);
      const miss = spawnSync("node", [linked, dir, "absent"], { encoding: "utf8" });
      expect(miss.status).toBe(1);
      expect(miss.stderr).toContain("no transcript");
    },
  );

  test.skipIf(noNode)(
    "imports under node when argv[1] is not a file (skipped without node)",
    () => {
      const run = spawnSync(
        "node",
        ["-e", `import(${JSON.stringify(script)}).then((m) => console.log(typeof m.findTranscript))`, "not-a-file"],
        { encoding: "utf8" },
      );
      expect(run.stderr).toBe("");
      expect(run.stdout.trim()).toBe("function");
    },
  );
});
