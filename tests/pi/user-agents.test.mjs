// Agent definitions read from pstack-agents in the Pi agent directory as well as the plugin's agents/.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentBody, flag, listAgents, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

const userDir = (w) => join(w.agentDir, "pstack-agents");
const writeUserAgent = (w, name, text) => {
  mkdirSync(userDir(w), { recursive: true });
  writeFileSync(join(userDir(w), name), text);
};
const validTypes = (err) => err.message.split("Valid types: ")[1].slice(0, -1).split(", ");

describe("user agent definitions", () => {
  test("a file in pstack-agents adds a type under its bare file name whose body is the child's system prompt", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "---\ndescription: mine\n---\nYou are my scout.\n");
    await pi.call("agent", { description: "s", prompt: "x", subagent_type: "scout" }, ctx);
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    expect(w.invocations().map((inv) => inv.systemPrompt)).toEqual(["You are my scout.", agentBody("agents/poteto-agent.md")]);
  });

  test("a user file never replaces a type: poteto-agent.md adds poteto-agent beside pstack:poteto-agent, and general-purpose.md is skipped", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "poteto-agent.md", "---\nname: poteto-agent\n---\nMy poteto.\n");
    writeUserAgent(w, "general-purpose.md", "Not the default.\n");
    await pi.call("agent", { description: "u", prompt: "x", subagent_type: "poteto-agent" }, ctx);
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    await pi.call("agent", { description: "g", prompt: "x" }, ctx);
    expect(w.invocations().map((inv) => inv.systemPrompt)).toEqual(["My poteto.", agentBody("agents/poteto-agent.md"), null]);
  });

  test("Pi's own agents folder, which other subagent extensions read, adds nothing", async () => {
    const { w, pi, ctx } = setup();
    mkdirSync(join(w.agentDir, "agents"));
    writeFileSync(join(w.agentDir, "agents", "scout.md"), "---\nname: scout\ntools: read, grep, find, ls\nmodel: claude-haiku-4-5\n---\nRecon.\n");
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "scout" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown subagent_type "scout"');
    expect(validTypes(err).filter((t) => t.endsWith("scout"))).toEqual([]);
    expect(w.invocations()).toEqual([]);
  });

  test("the unknown subagent_type error lists the user types too", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "Scout.\n");
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "nope" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown subagent_type "nope"');
    expect(validTypes(err)).toEqual(expect.arrayContaining(["general-purpose", "pstack:poteto-agent", "scout"]));
    expect(w.invocations()).toEqual([]);
  });

  test("a missing folder, and an entry that is not a readable .md file, is hidden, or has a colon in its name, add nothing and break no shipped type", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "a", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    mkdirSync(join(userDir(w), "dir.md"), { recursive: true });
    writeUserAgent(w, "notes.txt", "not an agent\n");
    symlinkSync(join(w.agentDir, "nowhere"), join(userDir(w), "dangling.md"));
    symlinkSync(join(userDir(w), "loop.md"), join(userDir(w), "loop.md"));
    writeUserAgent(w, "locked.md", "Locked.\n");
    chmodSync(join(userDir(w), "locked.md"), 0o000);
    writeUserAgent(w, "pstack:extra.md", "Extra.\n");
    writeUserAgent(w, "._scout.md", "AppleDouble sidecar.\n");
    writeUserAgent(w, ".md", "Nameless.\n");
    await pi.call("agent", { description: "b", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "notes" }, ctx).catch((e) => e);
    const types = validTypes(err);
    expect(types).toContain("pstack:poteto-agent");
    for (const skipped of ["notes", "dir", "dangling", "loop", "locked", "pstack:extra", "._scout", ""]) expect(types).not.toContain(skipped);
    expect(w.invocations()).toHaveLength(2);
  });

  test("a pstack-agents that is a file or a looping link is skipped, not an error", async () => {
    const { w, pi, ctx } = setup();
    writeFileSync(userDir(w), "a file where the folder belongs");
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    rmSync(userDir(w));
    symlinkSync(userDir(w), userDir(w));
    await pi.call("agent", { description: "q", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    expect(w.invocations()).toHaveLength(2);
  });

  test("a resume whose system prompt file is gone writes it again from the user file", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "Scout v1.\n");
    await pi.call("agent", { description: "s", prompt: "first", subagent_type: "scout" }, ctx);
    rmSync(join(w.agentDir, "pstack", "parent-session", "prompts"), { recursive: true });
    await pi.call("send_message", { to: "s", message: "again" }, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].status === "completed" && w.invocations().length === 2);
    const [first, second] = w.invocations();
    expect(second.systemPrompt).toBe("Scout v1.");
    expect(flag(second, "--append-system-prompt")).toBe(flag(first, "--append-system-prompt"));
  });
});
