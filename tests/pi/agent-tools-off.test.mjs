// pi agent tools: off leaves agent, send_message, list_agents and stop_agent, and the sleep guard
// tied to running agents, to another extension; the rest of the extension is unchanged.
import { describe, expect, test } from "bun:test";

import { useWorld } from "./harness.mjs";

const setup = useWorld();
const agentTools = ["agent", "send_message", "list_agents", "stop_agent"];
const toolCallHandlers = async (pi, ctx) => (await pi.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, ctx)).length;

describe("pi agent tools", () => {
  test("without the line, the four agent tools and the sleep guard are registered", async () => {
    const { pi, ctx } = setup({ sheet: "bug-fix: opus\n" });
    expect(agentTools.map((name) => pi.tools.has(name))).toEqual([true, true, true, true]);
    expect(await toolCallHandlers(pi, ctx)).toBe(1);
  });

  test("pi agent tools: off registers none of them and no sleep guard, and changes nothing else", async () => {
    const { pi, ctx } = setup({ sheet: "bug-fix: opus\npi agent tools: off\n" });
    expect(agentTools.map((name) => pi.tools.has(name))).toEqual([false, false, false, false]);
    expect(await toolCallHandlers(pi, ctx)).toBe(0);
    expect(pi.tools.has("ask_user_question")).toBe(true);
    expect(pi.tools.has("schedule_wakeup")).toBe(true);
    expect(pi.commands.has("loop")).toBe(true);
    expect(pi.commands.has("pstack-agents")).toBe(true);
    const event = { prompt: "hi", systemPrompt: "", systemPromptOptions: { sections: {} } };
    await pi.emit("before_agent_start", event, ctx);
    expect(Object.keys(event.systemPromptOptions.sections)).toContain("pstack-pi-tools");
  });

  test("pi agent tools: on counts as absent", () => {
    const { pi } = setup({ sheet: "pi agent tools: on\n" });
    expect(agentTools.every((name) => pi.tools.has(name))).toBe(true);
  });
});
