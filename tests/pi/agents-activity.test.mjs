// What a user can see of a running agent: list_agents activity, the footer
// status line, and /pstack-agents.
import { describe, expect, test } from "bun:test";

import { listAgents, restore, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

const lsStep = { toolStart: { name: "bash", args: { command: "ls   -la\n/tmp" } } };
const launch = (pi, ctx, description = "watch me") => pi.call("agent", { description, prompt: "go", run_in_background: true }, ctx);
const recordingUi = () => {
  const ui = { notices: [], statuses: [], notify: (text, level) => ui.notices.push({ text, level }), setStatus: (key, text) => ui.statuses.push({ key, text }) };
  return ui;
};

describe("agent activity", () => {
  test("a running agent lists its tool call with a one-line summary, then what it said, and an ended one lists none", async () => {
    const { pi, ctx } = setup({ script: { default: [lsStep, { sleep: 300 }, { toolEnd: "bash" }, { reply: "all   done\nsecond line" }, { sleep: 600 }] } });
    await launch(pi, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].activity?.tool);
    const [during] = await listAgents(pi, ctx);
    expect(during.activity.tool).toEqual({ name: "bash", args: "ls -la /tmp", running: true });
    expect(Date.parse(during.activity.at)).not.toBeNaN();

    await waitFor(async () => (await listAgents(pi, ctx))[0].activity?.said);
    const [after] = await listAgents(pi, ctx);
    expect(after.activity.said).toBe("all done");
    expect(after.activity.tool).toEqual({ name: "bash", args: "ls -la /tmp", running: false });

    await waitFor(() => pi.messages.length === 1);
    const [ended] = await listAgents(pi, ctx);
    expect(ended.status).toBe("completed");
    expect(ended).not.toHaveProperty("activity");
  });

  test("a tool call summarizes by command, then pattern, then path, then its JSON, capped at 80 characters", async () => {
    const ui = recordingUi();
    const calls = [
      { name: "bash", args: { command: "ls", pattern: "p", path: "src" } },
      { name: "grep", args: { pattern: "TODO", path: "src" } },
      { name: "read", args: { path: "/a/b.ts", file_path: "/x.ts" } },
      { name: "edit", args: { file_path: "/c.ts" } },
      { name: "custom", args: { n: 1 } },
      { name: "bash", args: { command: "x".repeat(200) } },
    ];
    const { pi, ctx } = setup({ script: { default: [...calls.map((call) => ({ toolStart: call })), { sleep: 30000 }] }, ctx: { hasUI: true, ui } });
    await launch(pi, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].activity?.tool.args.startsWith("xxx"));
    const shown = ui.statuses.map((s) => s.text?.replace(/^pstack: 1 running · \S+ /, ""));
    expect(shown).toEqual(expect.arrayContaining(["bash: ls", "grep: TODO", "read: /a/b.ts", "edit: /c.ts", 'custom: {"n":1}']));
    const { tool } = (await listAgents(pi, ctx))[0].activity;
    expect(tool.args).toBe(`${"x".repeat(79)}…`);
  });

  test("parallel tool calls end by call id, so one ending leaves the other running", async () => {
    const read = (id, path) => ({ toolStart: { name: "read", args: { path }, id } });
    const { pi, ctx } = setup({ script: { default: [read("c1", "a.ts"), read("c2", "b.ts"), { toolEnd: { name: "read", id: "c1" } }, { sleep: 300 }, { toolEnd: { name: "read", id: "c2" } }, { sleep: 30000 }] } });
    await launch(pi, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].activity?.tool.args === "b.ts");
    await new Promise((r) => setTimeout(r, 100));
    expect((await listAgents(pi, ctx))[0].activity.tool).toEqual({ name: "read", args: "b.ts", running: true });
    await waitFor(async () => (await listAgents(pi, ctx))[0].activity.tool.running === false);
    expect((await listAgents(pi, ctx))[0].activity.tool).toEqual({ name: "read", args: "b.ts", running: false });
  });

  test("a tool event missing its fields is skipped and the run still completes", async () => {
    const { pi, ctx } = setup({
      script: { default: [{ raw: '{"type":"tool_execution_start"}\n{"type":"tool_execution_end","toolName":5}\n' }, { reply: "survived" }] },
    });
    await launch(pi, ctx);
    await waitFor(() => pi.messages.length === 1);
    expect(pi.messages[0].message.content).toContain("status: completed");
    expect(pi.messages[0].message.content).toContain("survived");
  });

  test("activity is never sent as a message or written as a session entry", async () => {
    const { pi, ctx } = setup({ script: { default: [lsStep, { reply: "said something" }, { sleep: 30000 }] } });
    await launch(pi, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].activity?.said);
    expect(pi.messages).toEqual([]);
    expect(pi.userMessages).toEqual([]);
    expect(JSON.stringify(pi.entries)).not.toContain("ls -la");
    expect(JSON.stringify(pi.entries)).not.toContain("activity");
  });
});

describe("status line", () => {
  test("shows the count and the latest activity while an agent runs, and clears when it ends", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { sleep: 400 }, { reply: "done" }] }, ctx: { hasUI: true, ui } });
    const { details } = await launch(pi, ctx);
    const id8 = details.agentId.slice(0, 8);
    await waitFor(() => ui.statuses.some((s) => s.text === `pstack: 1 running · ${id8} bash: ls -la /tmp`));
    expect(ui.statuses[0]).toEqual({ key: "pstack-agents", text: `pstack: 1 running` });

    await waitFor(() => pi.messages.length === 1);
    expect(ui.statuses.at(-1)).toEqual({ key: "pstack-agents", text: undefined });
  });

  test("counts every running agent", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [{ sleep: 30000 }] }, ctx: { hasUI: true, ui } });
    await launch(pi, ctx, "one");
    await launch(pi, ctx, "two");
    expect(ui.statuses.at(-1).text).toBe("pstack: 2 running");
  });

  test("is never set in a child, whose depth is above zero", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { reply: "done" }] }, settings: { depth: 1 }, ctx: { hasUI: true, ui } });
    await launch(pi, ctx);
    await waitFor(() => pi.messages.length === 1);
    expect(ui.statuses).toEqual([]);
  });

  test("is never set without a UI", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { reply: "done" }] }, ctx: { hasUI: false, ui } });
    await launch(pi, ctx);
    await waitFor(() => pi.messages.length === 1);
    expect(ui.statuses).toEqual([]);
  });

  test("shows an agent that send_message resumes after a reload, before any new agent call", async () => {
    const { w, pi, ctx } = setup({ script: { default: [lsStep, { sleep: 300 }, { reply: "done" }] } });
    const { details } = await pi.call("agent", { description: "again", prompt: "go" }, ctx);
    const ui = recordingUi();
    const reloaded = await restore(w, pi.entries, "reload", { hasUI: true, ui });
    await reloaded.call("send_message", { to: details.agentId, message: "more" }, ctx);

    await waitFor(() => ui.statuses.some((s) => s.text?.endsWith("bash: ls -la /tmp")));
    await waitFor(() => reloaded.messages.length === 1);
    expect(ui.statuses.at(-1)).toEqual({ key: "pstack-agents", text: undefined });
  });

  test("clears at session_shutdown", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { sleep: 30000 }] }, ctx: { hasUI: true, ui } });
    await launch(pi, ctx);
    await waitFor(() => ui.statuses.some((s) => s.text?.includes("bash")));
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(ui.statuses.at(-1)).toEqual({ key: "pstack-agents", text: undefined });
  });
});

describe("/pstack-agents", () => {
  const run = (pi, ctx) => pi.commands.get("pstack-agents").handler("", ctx);

  test("says so when no agent has run", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ ctx: { ui } });
    await run(pi, ctx);
    expect(ui.notices).toEqual([{ text: "No pstack agents in this session.", level: "info" }]);
  });

  test("shows a running agent's activity and how to follow its transcript, without messaging the model", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { toolEnd: "bash" }, { reply: "halfway" }, { sleep: 30000 }] }, ctx: { ui } });
    const { details } = await launch(pi, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].sessionFile && (await listAgents(pi, ctx))[0].activity?.said);
    const [{ sessionFile }] = await listAgents(pi, ctx);
    await run(pi, ctx);

    const [{ text, level }] = ui.notices;
    expect(level).toBe("info");
    expect(text).toContain(`${details.agentId} running: watch me`);
    expect(text).toContain("last: bash: ls -la /tmp");
    expect(text).not.toContain("now:");
    expect(text).toContain("said: halfway");
    expect(text).toContain(`transcript: ${sessionFile}`);
    expect(text).toContain(`tail -f ${sessionFile}`);
    expect(pi.messages).toEqual([]);
    expect(pi.userMessages).toEqual([]);
  });

  test("shows an ended agent with pi --export and no activity", async () => {
    const ui = recordingUi();
    const { pi, ctx } = setup({ script: { default: [lsStep, { reply: "done" }] }, ctx: { ui } });
    await pi.call("agent", { description: "finished", prompt: "go" }, ctx);
    const [{ sessionFile }] = await listAgents(pi, ctx);
    await run(pi, ctx);

    const [{ text }] = ui.notices;
    expect(text).toContain("completed: finished");
    expect(text).toContain(`pi --export ${sessionFile}`);
    expect(text).not.toContain("tail -f");
    expect(text).not.toContain("said:");
    expect(text).not.toContain("last:");
  });
});
