// The settings the extension derives from its flags, environment, and model sheet.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, loadAgentTypes, readSheet } from "../../plugins/pstack/pi/config.ts";
import { chmodDeniesReads } from "../session-hook-sheets.mjs";

test("depth comes from the reader on each use and PI_CODING_AGENT_DIR moves the sheet", () => {
  let flag = 0;
  const settings = defaultSettings(() => flag, { PI_CODING_AGENT_DIR: "/tmp/pi-agent-x", HOME: "/nowhere" });
  expect(settings.depth).toBe(0);
  flag = 2;
  expect(settings.depth).toBe(2);
  expect(settings.agentDir).toBe("/tmp/pi-agent-x");
  expect(defaultSettings(() => 0, {}).agentDir).toBe(join(homedir(), ".pi", "agent"));
});

test("an agent file's effort is checked against the efforts list in models.json", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-agents-"));
  try {
    const models = { available: [], efforts: ["low"], pi: { fallback: "anthropic", models: {} } };
    writeFileSync(join(root, "models.json"), JSON.stringify(models));
    mkdirSync(join(root, "agents"));
    writeFileSync(join(root, "agents", "slow.md"), "---\neffort: low\n---\nbody\n");
    const settings = { pluginRoot: root, modelsFile: join(root, "models.json") };
    expect(loadAgentTypes(settings).get("pstack:slow")).toEqual({ body: "body", model: undefined, effort: "low" });
    writeFileSync(join(root, "agents", "slow.md"), "---\neffort: medium\n---\nbody\n");
    expect(() => loadAgentTypes(settings)).toThrow('pstack:slow: effort "medium" is not one of low');
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
