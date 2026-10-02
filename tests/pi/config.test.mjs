// The settings the extension derives from its flags and environment.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../plugins/pstack/pi/config.ts";

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
