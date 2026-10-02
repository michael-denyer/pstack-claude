// The system prompt sections the extension sets on every agent start.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../plugins/pstack/pi/config.ts";
import { install } from "../../plugins/pstack/pi/index.ts";
import { PARALLEL_CALLS, piToolsNote } from "../../plugins/pstack/pi/prompt.ts";
import { fakeCtx, fakePi, pluginRoot, world } from "./harness.mjs";

const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const tools = piToolsNote(pluginRoot);
const always = { "pstack-parallel-calls": PARALLEL_CALLS, "pstack-pi-tools": tools };

let w;
afterEach(() => w?.cleanup());

function setup(opts = {}, overrides = {}) {
  w = world(opts);
  const pi = fakePi();
  install(pi.api, { ...w.settings, ...overrides });
  return { pi, ctx: fakeCtx({ cwd: w.cwd }) };
}

async function sectionsAfterStart(pi, ctx) {
  const event = { prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
  await pi.emit("before_agent_start", event, ctx);
  return event.systemPromptOptions.sections;
}

describe("before_agent_start", () => {
  test("injects the mandate when there is no sheet", async () => {
    const { pi, ctx } = setup();
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-session-start": mandate });
  });

  test("injects the mandate and the full sheet on every agent start", async () => {
    const sheet = "arena runners: opus, fable, sonnet\nsession hook: on\n";
    const { pi, ctx } = setup({ sheet });
    for (let i = 0; i < 2; i++) {
      expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-session-start": mandate, "pstack-models": sheet });
    }
  });

  test("session hook: off drops the mandate but keeps the sheet and the tool mapping pointer", async () => {
    const sheet = "swarm workers: opus\nsession hook: off\n";
    const { pi, ctx } = setup({ sheet });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-models": sheet });
  });

  test("a child pi gets the sheet but not the mandate", async () => {
    const sheet = "swarm workers: opus\n";
    const { pi, ctx } = setup({ sheet }, { depth: 1 });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-models": sheet });
  });

  test("the tool mapping pointer names the installed pi-tools.md, which exists", () => {
    const file = join(pluginRoot, "skills/poteto-mode/references/pi-tools.md");
    expect(tools).toContain(file);
    expect(readFileSync(file, "utf8")).toContain("# Pi tool mapping");
  });

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
});
