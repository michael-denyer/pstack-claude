// The system prompt sections the extension sets on every agent start.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PARALLEL_CALLS, piToolsNote } from "../../plugins/pstack/pi/prompt.ts";
import { pluginRoot, useWorld } from "./harness.mjs";

const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const tools = piToolsNote(pluginRoot);
const always = { "pstack-parallel-calls": PARALLEL_CALLS, "pstack-pi-tools": tools };

const setup = useWorld();

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
    const { pi, ctx } = setup({ sheet, settings: { depth: 1 } });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-models": sheet });
  });

  test("the tool mapping pointer names the installed pi-tools.md, which exists", () => {
    const file = join(pluginRoot, "skills/poteto-mode/references/pi-tools.md");
    expect(tools).toContain(file);
    expect(readFileSync(file, "utf8")).toContain("# Pi tool mapping");
  });
});
