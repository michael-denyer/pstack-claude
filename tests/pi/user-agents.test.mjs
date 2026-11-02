// Agent definitions read from the user folder as well as the plugin's agents/.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentBody, flag, listAgents, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

const writeUserAgent = (w, name, text) => {
  mkdirSync(w.settings.userAgentsDir, { recursive: true });
  writeFileSync(join(w.settings.userAgentsDir, name), text);
};

describe("user agent definitions", () => {
  test("a file in the user folder adds a pstack: type whose body is the child's system prompt", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "---\ndescription: mine\n---\nYou are my scout.\n");
    await pi.call("agent", { description: "s", prompt: "x", subagent_type: "pstack:scout" }, ctx);
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    expect(w.invocations().map((inv) => inv.systemPrompt)).toEqual(["You are my scout.", agentBody("agents/poteto-agent.md")]);
  });

  test("a user file named like a plugin agent file replaces it and leaves the other plugin agents alone", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "poteto-agent.md", "---\nname: poteto-agent\n---\nMy poteto.\n");
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    await pi.call("agent", { description: "c", prompt: "x", subagent_type: "pstack:comment-sicko" }, ctx);
    expect(w.invocations().map((inv) => inv.systemPrompt)).toEqual(["My poteto.", agentBody("agents/comment-sicko.md")]);
  });

  test("the unknown subagent_type error lists the user types too", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "Scout.\n");
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "scout" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown subagent_type "scout"');
    for (const t of ["general-purpose", "pstack:poteto-agent", "pstack:scout"]) expect(err.message).toContain(t);
    expect(w.invocations()).toEqual([]);
  });

  test("a missing folder, a file that is not .md, and a directory or dangling link named like an agent file add nothing", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "a", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    mkdirSync(join(w.settings.userAgentsDir, "dir.md"), { recursive: true });
    writeUserAgent(w, "notes.txt", "not an agent\n");
    symlinkSync(join(w.agentDir, "nowhere"), join(w.settings.userAgentsDir, "dangling.md"));
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "pstack:notes" }, ctx).catch((e) => e);
    // The plugin's own agent files come and go; only what the skipped entries would have added is pinned.
    const list = err.message.split("Valid types: ")[1];
    expect(list.startsWith("general-purpose, ")).toBe(true);
    expect(list).toContain("pstack:poteto-agent");
    expect(list.endsWith(".")).toBe(true);
    for (const skipped of ["notes", "dir", "dangling"]) expect(list).not.toContain(`pstack:${skipped}`);
    expect(w.invocations()).toHaveLength(1);
  });

  test("a user folder that is a file is skipped, not an error", async () => {
    const { w, pi, ctx } = setup();
    writeFileSync(w.settings.userAgentsDir, "a file where the folder belongs");
    await pi.call("agent", { description: "p", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    expect(w.invocations()).toHaveLength(1);
  });

  test("a resume whose system prompt file is gone writes it again from the user file", async () => {
    const { w, pi, ctx } = setup();
    writeUserAgent(w, "scout.md", "Scout v1.\n");
    await pi.call("agent", { description: "s", prompt: "first", subagent_type: "pstack:scout" }, ctx);
    rmSync(join(w.agentDir, "pstack", "parent-session", "prompts"), { recursive: true });
    await pi.call("send_message", { to: "s", message: "again" }, ctx);
    await waitFor(async () => (await listAgents(pi, ctx))[0].status === "completed" && w.invocations().length === 2);
    const [first, second] = w.invocations();
    expect(second.systemPrompt).toBe("Scout v1.");
    expect(flag(second, "--append-system-prompt")).toBe(flag(first, "--append-system-prompt"));
  });
});
