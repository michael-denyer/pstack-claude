// Session-start injection, shutdown cleanup, and the paths: auto-load note.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSettings } from "../../plugins/pstack/pi/config.ts";
import { install } from "../../plugins/pstack/pi/index.ts";
import { alive, fakeCtx, fakePi, pluginRoot, waitFor, world } from "./harness.mjs";

const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");

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
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ "pstack-session-start": mandate });
  });

  test("injects the mandate and the full sheet on every agent start", async () => {
    const sheet = "arena runners: opus, fable, sonnet\nsession hook: on\n";
    const { pi, ctx } = setup({ sheet });
    for (let i = 0; i < 2; i++) {
      expect(await sectionsAfterStart(pi, ctx)).toEqual({ "pstack-session-start": mandate, "pstack-models": sheet });
    }
  });

  test("session hook: off drops the mandate but keeps the sheet", async () => {
    const sheet = "swarm workers: opus\nsession hook: off\n";
    const { pi, ctx } = setup({ sheet });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ "pstack-models": sheet });
  });

  test("a child pi gets the sheet but not the mandate", async () => {
    const sheet = "swarm workers: opus\n";
    const { pi, ctx } = setup({ sheet }, { isChild: true });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ "pstack-models": sheet });
  });

  test("PSTACK_PI_CHILD=1 marks a child and PI_CODING_AGENT_DIR moves the sheet", () => {
    const env = { PI_CODING_AGENT_DIR: "/tmp/pi-agent-x", PSTACK_PI_BIN: "/bin/fake", HOME: "/nowhere" };
    const parent = defaultSettings(env);
    expect(parent.isChild).toBe(false);
    expect(parent.agentDir).toBe("/tmp/pi-agent-x");
    expect(parent.pi).toEqual({ command: "/bin/fake", args: [] });
    expect(parent.childEnv.PSTACK_PI_CHILD).toBe("1");
    expect(defaultSettings({ ...env, PSTACK_PI_CHILD: "1" }).isChild).toBe(true);
    expect(defaultSettings({}).agentDir).toBe(join(homedir(), ".pi", "agent"));
  });
});

describe("session_shutdown", () => {
  test("stops every running agent without a notice, and a second shutdown is a no-op", async () => {
    const { pi, ctx } = setup({ script: { default: [{ grandchild: true }, { sleep: 30000 }] } });
    await pi.call("agent", { description: "one", prompt: "x", run_in_background: true }, ctx);
    await pi.call("agent", { description: "two", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => w.log().filter((r) => r.kind === "grandchild").length === 2);

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    for (const r of w.log()) expect(alive(r.pid)).toBe(false);
    const listed = JSON.parse((await pi.call("list_agents", {}, ctx)).content[0].text);
    expect(listed.map((a) => a.status)).toEqual(["stopped", "stopped"]);
    expect(pi.messages).toEqual([]);

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(pi.messages).toEqual([]);
  });
});

describe("paths: auto-load note", () => {
  const result = (toolName, path, extra = {}) => ({
    toolName,
    toolCallId: "t",
    input: { path },
    content: [{ type: "text", text: "file body" }],
    isError: false,
    details: undefined,
    ...extra,
  });

  test("the first matching file gets a one-line note naming the skill, once per session", async () => {
    const { pi, ctx } = setup();
    const [skip] = await pi.emit("tool_result", result("read", "notes.md"), ctx);
    expect(skip).toBeUndefined();
    const [failed] = await pi.emit("tool_result", result("read", "src/a.ts", { isError: true }), ctx);
    expect(failed).toBeUndefined();

    const [first] = await pi.emit("tool_result", result("edit", join(ctx.cwd, "src/deep/b.tsx")), ctx);
    expect(first.content[0]).toEqual({ type: "text", text: "file body" });
    const note = first.content[1].text;
    expect(note).toContain("src/deep/b.tsx");
    expect(note).toContain("typescript-best-practices");
    expect(note).toContain(join(pluginRoot, "skills/typescript-best-practices/SKILL.md"));
    expect(note.split("\n")).toHaveLength(1);

    const [again] = await pi.emit("tool_result", result("write", "src/c.ts"), ctx);
    expect(again).toBeUndefined();
  });

  test("non-file tools never get the note", async () => {
    const { pi, ctx } = setup();
    const [r] = await pi.emit("tool_result", result("bash", "src/a.ts"), ctx);
    expect(r).toBeUndefined();
  });
});
