// The settings the extension derives from its environment.
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../plugins/pstack/pi/config.ts";

test("PSTACK_PI_DEPTH counts the layers below the main session and PI_CODING_AGENT_DIR moves the sheet", () => {
  const env = { PI_CODING_AGENT_DIR: "/tmp/pi-agent-x", HOME: "/nowhere" };
  const parent = defaultSettings(env);
  expect(parent.depth).toBe(0);
  expect(parent.agentDir).toBe("/tmp/pi-agent-x");
  expect(parent.childEnv.PSTACK_PI_DEPTH).toBe("1");
  const child = defaultSettings(parent.childEnv);
  expect(child.depth).toBe(1);
  expect(child.childEnv.PSTACK_PI_DEPTH).toBe("2");
  expect(defaultSettings({}).agentDir).toBe(join(homedir(), ".pi", "agent"));
});
