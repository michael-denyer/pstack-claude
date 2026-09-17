// The shipped SessionStart command, run for real against a temp HOME: the
// mandate is injected unless ~/.claude/pstack-models.md says `session hook: off`.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const command = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8")).hooks.SessionStart[0].hooks[0]
  .command;
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");

function runHook(sheet) {
  const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
  if (sheet !== null) {
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude/pstack-models.md"), sheet);
  }
  try {
    const r = spawnSync("bash", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("SessionStart hook", () => {
  test("injects the mandate when no sheet exists", () => {
    expect(runHook(null)).toEqual({ status: 0, out: mandate, err: "" });
  });

  test("injects the mandate when the sheet has no session hook line", () => {
    expect(runHook("bug-fix: claude-fable-5-1\n")).toEqual({ status: 0, out: mandate, err: "" });
  });

  test("injects the mandate when the sheet says on", () => {
    expect(runHook("bug-fix: claude-fable-5-1\nsession hook: on\n")).toEqual({ status: 0, out: mandate, err: "" });
  });

  test("injects nothing when the sheet says off", () => {
    expect(runHook("bug-fix: claude-fable-5-1\nsession hook: off\n")).toEqual({ status: 0, out: "", err: "" });
  });
});
