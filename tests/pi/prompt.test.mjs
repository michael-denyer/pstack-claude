// The system prompt sections the extension sets on every agent start.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sheetCases } from "../session-hook-sheets.mjs";
import { pluginRoot, useWorld } from "./harness.mjs";

const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const piTools = join(pluginRoot, "skills/poteto-mode/references/pi-tools.md");
const always = {
  "pstack-parallel-calls":
    "If you intend to call multiple tools and there are no dependencies between the calls, make all of the independent calls in the same response, otherwise you MUST wait for previous calls to finish first to determine the dependent values.",
  "pstack-pi-tools": `pstack skills are written for Claude Code. When one names a Claude Code tool (Agent, Skill, AskUserQuestion, Bash), a bundled skill, or a Claude model, read ${piTools} for the Pi equivalent before following it.`,
};

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

  for (const { name, sheet, off } of sheetCases) {
    test(`${off ? "drops" : "keeps"} the mandate when the sheet has ${name}`, async () => {
      const { pi, ctx } = setup({ sheet });
      const sections = await sectionsAfterStart(pi, ctx);
      expect(sections["pstack-session-start"]).toBe(off ? undefined : mandate);
    });
  }

  test("a child pi gets the sheet but not the mandate", async () => {
    const sheet = "swarm workers: opus\n";
    const { pi, ctx } = setup({ sheet, settings: { depth: 1 } });
    expect(await sectionsAfterStart(pi, ctx)).toEqual({ ...always, "pstack-models": sheet });
  });

  test("the tool mapping pointer names the installed pi-tools.md, which exists", async () => {
    const { pi, ctx } = setup();
    expect((await sectionsAfterStart(pi, ctx))["pstack-pi-tools"]).toContain(piTools);
    expect(readFileSync(piTools, "utf8")).toContain("# Pi tool mapping");
  });
});
