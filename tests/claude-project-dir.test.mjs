import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectDir, projectDirName } from "../plugins/pstack/skills/reflect/scripts/claude-project-dir.mjs";

const script = join(import.meta.dir, "../plugins/pstack/skills/reflect/scripts/claude-project-dir.mjs");
const noNode = spawnSync("node", ["--version"]).status !== 0;

// Claude Code 2.1.296 created this directory for a session started in LONG.
const LONG = `/private/tmp/ccd-long-café/${Array.from({ length: 14 }, (_, i) => `segment_${String(i + 1).padStart(2, "0")}.dir/`).join("")}end`;
const LONG_NAME =
  "-private-tmp-ccd-long-caf--segment-01-dir-segment-02-dir-segment-03-dir-segment-04-dir-segment-05-dir-segment-06-dir-segment-07-dir-segment-08-dir-segment-09-dir-segment-10-dir-segment-11-dir-segment--ukf6rm";

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(...names) {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  fixtures.push(dir);
  for (const name of names) mkdirSync(join(dir, "projects", name), { recursive: true });
  return dir;
}

describe("projectDirName", () => {
  test("turns every character other than an ASCII letter or digit into -", () => {
    expect(projectDirName("/private/tmp/coat_opus48_440")).toBe("-private-tmp-coat-opus48-440");
    expect(projectDirName("/home/oscar/.cache/x")).toBe("-home-oscar--cache-x");
    expect(projectDirName("/Users/you/café")).toBe("-Users-you-caf-");
  });

  test("cuts a name past 200 characters and adds Claude Code's hash of the path", () => {
    expect(projectDirName(LONG)).toBe(LONG_NAME);
  });
});

describe("projectDir", () => {
  test("finds the derived directory under CLAUDE_CONFIG_DIR", () => {
    const config = configDir("-private-tmp-coat-opus48-440");
    expect(projectDir("/private/tmp/coat_opus48_440", { CLAUDE_CONFIG_DIR: config })).toBe(
      join(config, "projects", "-private-tmp-coat-opus48-440"),
    );
  });

  test("uses CLAUDE_CODE_PROJECT_DIR_NAME only when CLAUDE_CONFIG_DIR is set", () => {
    const config = configDir("work", "-srv-app");
    expect(projectDir("/srv/app", { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: "work" })).toBe(
      join(config, "projects", "work"),
    );
    const home = mkdtempSync(join(tmpdir(), "claude-home-"));
    fixtures.push(home);
    mkdirSync(join(home, ".claude", "projects", "-srv-app"), { recursive: true });
    expect(projectDir("/srv/app", { HOME: home, CLAUDE_CODE_PROJECT_DIR_NAME: "work" })).toBe(
      join(home, ".claude", "projects", "-srv-app"),
    );
  });

  test("ignores a CLAUDE_CODE_PROJECT_DIR_NAME Claude Code would reject", () => {
    const config = configDir("-srv-app", "my.proj", "nul", "x".repeat(65));
    for (const chosen of ["my.proj", "NUL", "x".repeat(65), ""]) {
      expect(projectDir("/srv/app", { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: chosen })).toBe(
        join(config, "projects", "-srv-app"),
      );
    }
  });

  test("finds this session's directory by CLAUDE_CODE_SESSION_ID after the shell moves to another project", () => {
    const id = "9a212143-d801-496d-b0ce-50ad2a68b9a2";
    const config = configDir("-srv-app", "-Users-you-start", "-Users-you-nested");
    writeFileSync(join(config, "projects", "-Users-you-start", `${id}.jsonl`), "");
    const env = { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: id };
    expect(projectDir("/srv/app", env)).toBe(join(config, "projects", "-Users-you-start"));
    rmSync(join(config, "projects", "-Users-you-start", `${id}.jsonl`));
    mkdirSync(join(config, "projects", "-Users-you-nested", id));
    writeFileSync(join(config, "projects", "-Users-you-nested", id, `${id}.jsonl`), "");
    expect(projectDir("/srv/app", env)).toBe(join(config, "projects", "-Users-you-nested"));
  });

  // Claude Code's Workflow tool keeps <id>/workflows/ under the shell's current project.
  test("skips another project's <id>/ directory that holds no transcript", () => {
    const id = "784a5677-0000-0000-0000-000000000000";
    // Both orders, so the result cannot depend on the order readdir lists them in.
    for (const [decoy, home] of [["-Users-you-aaa", "-Users-you-zzz"], ["-Users-you-zzz", "-Users-you-aaa"]]) {
      const config = configDir(`${decoy}/${id}/workflows/scripts`, home);
      writeFileSync(join(config, "projects", home, `${id}.jsonl`), "");
      expect(projectDir("/srv/app", { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: id })).toBe(
        join(config, "projects", home),
      );
    }
  });

  test("derives the name when the session id is unknown or not a file name", () => {
    const config = configDir("-srv-app", "..");
    for (const id of ["0f0f0f0f-0000-0000-0000-000000000000", "../projects", ""]) {
      expect(projectDir("/srv/app", { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: id })).toBe(
        join(config, "projects", "-srv-app"),
      );
    }
  });

  test("falls back to the one long directory that shares the first 200 characters", () => {
    const changedHash = `${LONG_NAME.slice(0, 201)}zzzzz`;
    const config = configDir(changedHash);
    expect(projectDir(LONG, { CLAUDE_CONFIG_DIR: config })).toBe(join(config, "projects", changedHash));
    mkdirSync(join(config, "projects", `${LONG_NAME.slice(0, 201)}yyyyy`));
    expect(projectDir(LONG, { CLAUDE_CONFIG_DIR: config })).toBeNull();
  });

  test("returns null when no directory exists", () => {
    expect(projectDir("/private/tmp/coat_opus48_440", { CLAUDE_CONFIG_DIR: configDir() })).toBeNull();
    expect(projectDir(LONG, { CLAUDE_CONFIG_DIR: join(configDir(), "missing") })).toBeNull();
  });
});

describe.skipIf(noNode)("claude-project-dir.mjs", () => {
  test("prints the directory for the current workspace, or exits 1", () => {
    const workspace = realpathSync(configDir());
    const config = configDir(projectDirName(workspace));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "" };
    const found = spawnSync("node", [script], { cwd: workspace, env, encoding: "utf8" });
    expect([found.status, found.stdout.trim()]).toEqual([0, join(config, "projects", projectDirName(workspace))]);
    const missing = spawnSync("node", [script, config], { env, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("no Claude Code transcripts directory");
    const removed = join(workspace, "removed");
    mkdirSync(join(config, "projects", projectDirName(removed)));
    const gone = spawnSync("node", [script, removed], { env, encoding: "utf8" });
    expect([gone.status, gone.stdout.trim()]).toEqual([0, join(config, "projects", projectDirName(removed))]);
  });

  test("prints this session's directory without an argument, and the named workspace's with one", () => {
    const id = "1b2c3d4e-0000-0000-0000-000000000000";
    const workspace = realpathSync(configDir());
    const config = configDir("-Users-you-start", projectDirName(workspace));
    writeFileSync(join(config, "projects", "-Users-you-start", `${id}.jsonl`), "");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: id };
    const session = spawnSync("node", [script], { cwd: workspace, env, encoding: "utf8" });
    expect([session.status, session.stdout.trim()]).toEqual([0, join(config, "projects", "-Users-you-start")]);
    const named = spawnSync("node", [script, workspace], { env, encoding: "utf8" });
    expect([named.status, named.stdout.trim()]).toEqual([0, join(config, "projects", projectDirName(workspace))]);
  });
});
