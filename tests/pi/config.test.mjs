// The settings the extension derives from its flags, environment, and model sheet.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentTypes } from "../../plugins/pstack/pi/agent-files.ts";
import { checkEffort, defaultSettings, parseSheet, readSheet, resolveModel } from "../../plugins/pstack/pi/config.ts";
import { chmodDeniesReads } from "../session-hook-sheets.mjs";

test("depth comes from the reader on each use and PI_CODING_AGENT_DIR moves the sheet", () => {
  let flag = 0;
  const settings = defaultSettings(() => flag, "/tmp/pi-agent-x");
  expect(settings.depth).toBe(0);
  flag = 2;
  expect(settings.depth).toBe(2);
  expect(settings.agentDir).toBe("/tmp/pi-agent-x");
  expect(defaultSettings(() => 0, "").agentDir).toBe(join(homedir(), ".pi", "agent"));
});

test.each(["openai", "openai-codex"])("OpenAI aliases prefer the 6.2 model in %s when its catalog lists it", (provider) => {
  const settings = defaultSettings(() => 0);
  const parent = `${provider}/parent`;
  for (const [alias, preferred, fallback] of [
    ["opus", "gpt-6.2-sol", "gpt-6.1-sol"], ["sonnet", "gpt-6.2-sol", "gpt-6.1-sol"], ["fable", "gpt-6.2-astra", "gpt-6-astra"],
  ]) {
    const catalog = { find: (p, id) => p === provider && id === preferred ? { id } : undefined };
    expect(resolveModel(alias, settings, undefined, parent, catalog)).toBe(`${provider}/${preferred}`);
    expect(resolveModel(alias, settings, undefined, parent, { find: () => undefined })).toBe(`${provider}/${fallback}`);
    expect(resolveModel(alias, settings, parseSheet(`pi models: ${alias}=custom/model`), parent, catalog)).toBe("custom/model");
  }
});

test("only an exact pi ask tool: off line turns the ask tool off", () => {
  expect(parseSheet("bug-fix: opus\r\npi ask tool: off\r\n").askToolOff).toBe(true);
  for (const sheet of ["bug-fix: opus\n", "pi ask tool: on\n", "pi ask tool: off \n", "ask tool: off\n", "session hook: off\n"]) {
    expect({ sheet, off: parseSheet(sheet).askToolOff }).toEqual({ sheet, off: false });
  }
});

test("only an exact pi agent tools: off line turns the agent tools off", () => {
  expect(parseSheet("bug-fix: opus\r\npi agent tools: off\r\n").agentToolsOff).toBe(true);
  for (const sheet of ["bug-fix: opus\n", "pi agent tools: on\n", "pi agent tools: off \n", "agent tools: off\n", "pi ask tool: off\n"]) {
    expect({ sheet, off: parseSheet(sheet).agentToolsOff }).toEqual({ sheet, off: false });
  }
});

test("only an exact pi agent host: hc line moves agents into hc terminals", () => {
  expect(parseSheet("bug-fix: opus\r\npi agent host: hc\r\n").hcHost).toBe(true);
  for (const sheet of ["bug-fix: opus\n", "pi agent host: rpc\n", "pi agent host: hc \n", "agent host: hc\n", "pi agent tools: off\n"]) {
    expect({ sheet, hc: parseSheet(sheet).hcHost }).toEqual({ sheet, hc: false });
  }
});

test("an agent file loads as pstack:<name> with its body and model, and an effort is checked against models.json", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-agents-"));
  try {
    const models = { available: [], efforts: ["low"], pi: { fallback: "anthropic", models: {} } };
    writeFileSync(join(root, "models.json"), JSON.stringify(models));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "slow.md"), "---\nmodel: opus\n---\nbody\n");
    const settings = { pluginRoot: root, modelsFile: join(root, "models.json"), agentDir: root };
    expect(loadAgentTypes(settings).get("pstack:slow")).toEqual({ file: join(root, "agents", "slow.md"), body: "body", model: "opus" });
    expect(checkEffort("low", settings)).toBe("low");
    expect(() => checkEffort("medium", settings)).toThrow('effort "medium" is not one of low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!chmodDeniesReads)("a sheet in a directory that cannot be searched reads as absent until it can", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-sheet-"));
  try {
    writeFileSync(join(dir, "pstack-models.md"), "session hook: off\n");
    chmodSync(dir, 0o000);
    expect(readSheet(dir)).toBeUndefined();
    chmodSync(dir, 0o700);
    expect(readSheet(dir)).toMatchObject({ hookOff: true });
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A directory with an agent sheet and, where the test makes one, a git
// repository with a committed sheet. The agent sheet loses to the committed
// one whenever the working directory can name the repository root.
function sheetDirs() {
  const dir = mkdtempSync(join(tmpdir(), "pstack-project-sheet-"));
  const agent = join(dir, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "pstack-models.md"), "pi models: opus=agent/model\n");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "pstack-models.md"), "pi models: opus=project/model\n");
  return { dir, agent, repo };
}

test("a sheet committed at the git root replaces the agent sheet, from a subdirectory", () => {
  const { dir, agent, repo } = sheetDirs();
  try {
    expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
    const deep = join(repo, "sub", "deep");
    mkdirSync(deep, { recursive: true });
    expect(readSheet(agent, deep)?.piModels.get("opus")).toBe("project/model");
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("project/model");
    // Without a working directory the agent sheet stands, as before.
    expect(readSheet(agent)?.piModels.get("opus")).toBe("agent/model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("repeated reads for one working directory run git once and reread the sheet", () => {
  const { dir, agent, repo } = sheetDirs();
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = join(dir, "bin");
  const log = join(dir, "git-calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  try {
    expect(spawnSync(realGit, ["init", "-q", repo]).status).toBe(0);
    process.env.PATH = `${bin}:${path}`;
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("project/model");
    writeFileSync(join(repo, ".claude", "pstack-models.md"), "pi models: opus=edited/model\n");
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("edited/model");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a working directory that is not a repository checks itself, then the agent sheet", () => {
  const { dir, agent, repo } = sheetDirs();
  try {
    // No git init: the directory itself is the root, as in the session hook.
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("project/model");
    rmSync(join(repo, ".claude", "pstack-models.md"));
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("agent/model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a committed sheet in UTF-16 LE reads like a user's sheet", () => {
  const { dir, agent, repo } = sheetDirs();
  try {
    writeFileSync(join(repo, ".claude", "pstack-models.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("pi models: opus=wide/model\n", "utf16le")]));
    expect(readSheet(agent, repo)?.piModels.get("opus")).toBe("wide/model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
