// What the agent tool registers and the child command a call produces.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { install } from "../../plugins/pstack/pi/index.ts";
import { chmodDeniesReads } from "../session-hook-sheets.mjs";
import { agentBody, agentEntry, fakeCtx, fakePi, flag, gitRepo, listAgents, recordWith, restore, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

describe("agent tool", () => {
  test("a tool's prompt snippet does not repeat the name Pi already prints before it", () => {
    const { pi } = setup();
    const snippets = [...pi.tools.values()].filter((t) => t.promptSnippet);
    expect(snippets.map((t) => t.name)).toContain("agent");
    for (const t of snippets) expect(t.promptSnippet.toLowerCase().startsWith(`${t.name}:`)).toBe(false);
  });

  test("every pstack tool is model-only, so Pi declares it to the model in every codemode mode and never defers it", () => {
    const { pi } = setup();
    const exposures = Object.fromEntries([...pi.tools.values()].map((t) => [t.name, t.exposure]));
    expect(exposures).toEqual({
      agent: "model-only",
      send_message: "model-only",
      list_agents: "model-only",
      stop_agent: "model-only",
      ask_user_question: "model-only",
      schedule_wakeup: "model-only",
    });
  });

  test("readonly runs the child without the edit and write tools", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "r", prompt: "x", readonly: true }, ctx);
    await pi.call("agent", { description: "w", prompt: "x" }, ctx);
    const [ro, rw] = w.invocations();
    expect(flag(ro, "--exclude-tools")).toBe("edit,write");
    expect(flag(rw, "--exclude-tools")).toBeNull();
    expect(pi.tools.get("agent").parameters.properties.readonly.type).toBe("boolean");
  });

  test("agents nest at most three layers below the main session, as on Claude Code", async () => {
    const { w } = setup();
    const excludedAt = async (depth, params = {}) => {
      const pi = fakePi();
      install(pi.api, { ...w.settings, depth });
      await pi.call("agent", { description: "d", prompt: "x", ...params }, fakeCtx({ cwd: w.cwd }));
      return flag(w.invocations().at(-1), "--exclude-tools");
    };
    expect(await excludedAt(0)).toBeNull();
    expect(await excludedAt(1)).toBeNull();
    expect(await excludedAt(2)).toBe("agent");
    expect(await excludedAt(2, { readonly: true })).toBe("edit,write,agent");
  });

  test("every pstack agent type reaches its child with its own agent file as the system prompt", async () => {
    const { w, pi, ctx } = setup();
    const files = {
      "pstack:poteto-agent": "agents/poteto-agent.md",
      "pstack:comment-sicko": "agents/comment-sicko.md",
      "pstack:poteto-agent-high": "effort-agents/poteto-agent-high.md",
      "pstack:effort-low": "effort-agents/effort-low.md",
    };
    for (const type of Object.keys(files)) await pi.call("agent", { description: type, prompt: "x", subagent_type: type }, ctx);
    expect(w.invocations().map((inv) => inv.systemPrompt)).toEqual(Object.values(files).map(agentBody));
  });

  test("unknown subagent_type is an error listing every valid type", async () => {
    const { w, pi, ctx } = setup();
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "poteto-agent" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown subagent_type "poteto-agent"');
    for (const t of ["general-purpose", "pstack:poteto-agent", "pstack:comment-sicko", "pstack:effort-high", "pstack:poteto-agent-xhigh"]) {
      expect(err.message).toContain(t);
    }
    expect(w.invocations()).toEqual([]);
  });

  test("an effort agent passes its body as a 0600 system prompt file and its effort as --thinking; others run at the parent's level", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "e", prompt: "x", subagent_type: "pstack:effort-xhigh" }, ctx);
    await pi.call("agent", { description: "g", prompt: "x", subagent_type: "general-purpose" }, ctx);
    const [effort, general] = w.invocations();

    expect(flag(effort, "--thinking")).toBe("xhigh");
    expect(effort.systemPrompt).toBe(agentBody("effort-agents/effort-xhigh.md"));
    expect(statSync(flag(effort, "--append-system-prompt")).mode & 0o777).toBe(0o600);
    expect(flag(general, "--thinking")).toBe("medium");
    expect(flag(general, "--append-system-prompt")).toBeNull();
  });

  test("a resume whose system prompt file is gone writes it again, since pi would append the missing path as the prompt text", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "p", prompt: "first", subagent_type: "pstack:poteto-agent" }, ctx);
    rmSync(join(w.agentDir, "pstack", "parent-session", "prompts"), { recursive: true });
    await pi.call("send_message", { to: "p", message: "again" }, ctx);
    await waitFor(() => pi.messages.length === 1);
    const [first, second] = w.invocations();
    expect(second.systemPrompt).toBe(agentBody("agents/poteto-agent.md"));
    expect(flag(second, "--append-system-prompt")).toBe(flag(first, "--append-system-prompt"));
    expect(statSync(flag(second, "--append-system-prompt")).mode & 0o777).toBe(0o600);
  });

  test("a resume whose system prompt file is gone and whose type no longer has one fails, and no child starts", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "p", prompt: "first", subagent_type: "pstack:poteto-agent" }, ctx);
    rmSync(join(w.agentDir, "pstack", "parent-session", "prompts"), { recursive: true });
    const removedType = recordWith(pi.entries.at(-1).data, { agent: { subagentType: "pstack:removed" } });

    const resumed = await restore(w, [agentEntry(removedType)]);
    const err = await resumed.call("send_message", { to: "p", message: "again" }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('its type "pstack:removed" no longer provides one');
    expect(w.invocations()).toHaveLength(1);
    expect((await listAgents(resumed, ctx)).map((a) => a.status)).toEqual(["failed"]);
  });

  test("a system prompt file that cannot be written fails the launch before a worktree or its branch is made", async () => {
    const { w, pi, ctx } = setup();
    const git = gitRepo(w.cwd);
    const state = join(w.agentDir, "pstack", "parent-session");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "prompts"), "a file where the prompts directory belongs");

    const err = await pi.call("agent", { description: "wt", prompt: "x", subagent_type: "pstack:poteto-agent", isolation: "worktree" }, ctx).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
    expect(git("branch", "--list").split("\n")).toHaveLength(1);
    expect(w.invocations()).toEqual([]);
  });
});

describe("model resolution", () => {
  const modelOf = (inv) => flag(inv, "--model");

  test("alias, sheet override, inherit-parent, auto, pass-through, and no parent model", async () => {
    const { w, pi, ctx } = setup({ sheet: "default effort: session\npi models: sonnet=openai/sheet-sonnet, haiku=openai/sheet-haiku\n" });
    for (const model of ["opus", "sonnet", "inherit-parent", "auto", "openai/gpt-x", undefined]) {
      await pi.call("agent", { description: "m", prompt: "x", model }, ctx);
    }
    await pi.call("agent", { description: "m", prompt: "x" }, fakeCtx({ cwd: w.cwd, model: null }));
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, fakeCtx({ cwd: w.cwd, model: null }));
    expect(w.invocations().map(modelOf)).toEqual([
      "anthropic/fixture-opus",
      "openai/sheet-sonnet",
      "anthropic/parent-model",
      "anthropic/parent-model",
      "openai/gpt-x",
      "anthropic/parent-model",
      null,
      "anthropic/fixture-opus",
    ]);
  });

  test("a family name resolves in the table of the parent's provider, and in the fallback table on any other", async () => {
    const { w, pi } = setup({ sheet: "pi models: haiku=anthropic/sheet-haiku\n" });
    const on = (provider) => fakeCtx({ cwd: w.cwd, model: { provider, id: "parent" } });
    for (const model of ["opus", "fable", "haiku"]) await pi.call("agent", { description: "m", prompt: "x", model }, on("openai-codex"));
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, on("openrouter"));
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, on("constructor"));
    expect(w.invocations().map(modelOf)).toEqual([
      "openai-codex/fixture-opus",
      "openai-codex/fixture-fable",
      "anthropic/sheet-haiku",
      "anthropic/fixture-opus",
      "anthropic/fixture-opus",
    ]);
  });

  test.skipIf(!chmodDeniesReads)("an unreadable sheet leaves the default model until it is readable again", async () => {
    const { w, pi, ctx } = setup({ sheet: "pi models: sonnet=openai/sheet-sonnet\n" });
    const sheet = join(w.agentDir, "pstack-models.md");
    chmodSync(sheet, 0o000);
    await pi.call("agent", { description: "m", prompt: "x", model: "sonnet" }, ctx);
    chmodSync(sheet, 0o600);
    await pi.call("agent", { description: "m", prompt: "x", model: "sonnet" }, ctx);
    expect(w.invocations().map(modelOf)).toEqual(["anthropic/fixture-sonnet", "openai/sheet-sonnet"]);
  });

  test("an unknown alias is an error naming the valid values", async () => {
    const { w, pi, ctx } = setup();
    const err = await pi.call("agent", { description: "m", prompt: "x", model: "opus @xhigh" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown model "opus @xhigh"');
    expect(err.message).toContain("opus, fable, sonnet, haiku, inherit-parent, auto");
    expect(w.invocations()).toEqual([]);
  });
});
