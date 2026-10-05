// The settings the extension derives from its flags and environment.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { defaultSettings, readSheet } from "../../plugins/pstack/pi/config.ts";
import { chmodDeniesReads } from "../session-hook-sheets.mjs";

test("depth comes from the reader on each use and PI_CODING_AGENT_DIR moves the sheet", () => {
  let flag = 0;
  const settings = defaultSettings(() => flag, { PI_CODING_AGENT_DIR: "/tmp/pi-agent-x", HOME: "/nowhere" });
  expect(settings.depth).toBe(0);
  flag = 2;
  expect(settings.depth).toBe(2);
  expect(settings.agentDir).toBe("/tmp/pi-agent-x");
  expect(settings.childEnv).toBeUndefined();
  expect(defaultSettings(() => 0, {}).agentDir).toBe(join(homedir(), ".pi", "agent"));
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
